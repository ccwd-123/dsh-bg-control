import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { DshJobQueue } from "../lib/job-queue.js";
import { createTools, TOOL_SPECS } from "../lib/tools.js";
import { evaluateFocusConflict } from "../lib/focus-guard.js";
import win32 from "../lib/win32-bridge.js";
import pluginEntry from "../lib/index.js";

const REPO_ROOT = path.resolve(__dirname, "..");

async function test(name, fn) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("OK\n");
}

function toolMap(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.name, t);
  return m;
}

const IDLE_PROBE = async () => ({
  foreground: { hwnd: 99999, rootOwnerHwnd: 99999, pid: 99999, processName: "PI-Desktop", title: "PI-Desktop" },
  cursor: { hoverHwnd: 99999, hoverRootHwnd: 99999, hoverInfo: { pid: 99999, processName: "PI-Desktop" } },
  userIdleMs: 5000,
  instances: [],
});

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-bg-test-"));
  try {
    await test("1. TOOL_SPECS defines all 7 required DSH tools with exact bg_* names and DSH defineTool schemas", async () => {
      const names = TOOL_SPECS.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "bg_cli",
        "bg_ipc",
        "bg_job_control",
        "bg_launch",
        "bg_query_state",
        "bg_verify",
        "bg_window_msg",
      ]);
      for (const spec of TOOL_SPECS) {
        const expectedPrefix = `Exact tool name: ${spec.name};`;
        assert.ok(spec.description.startsWith(expectedPrefix), `Missing prefix on ${spec.name}`);
      }
    });

    await test("2. Hard Focus Guard rejects foreground hwnd/pid/process/hover/multi-instance", async () => {
      const fgState = {
        foreground: { hwnd: 1001, rootOwnerHwnd: 1000, pid: 4242, processName: "notepad", title: "Untitled" },
        cursor: { x: 10, y: 10, hoverHwnd: 2002, hoverRootHwnd: 2000, hoverInfo: { pid: 5151, processName: "calc" } },
        userIdleMs: 200,
        instances: [
          { hwnd: 1001, rootOwnerHwnd: 1000, pid: 4242, processName: "notepad", isForeground: true },
          { hwnd: 3001, rootOwnerHwnd: 3000, pid: 6161, processName: "calc", isForeground: false },
          { hwnd: 3002, rootOwnerHwnd: 3002, pid: 6262, processName: "calc", isForeground: false },
        ],
      };

      const r1 = evaluateFocusConflict(fgState, { hwnd: 1001 });
      assert.equal(r1.allowed, false);
      assert.equal(r1.conflict, true);
      assert.equal(r1.status, "human_intervened");

      const r2 = evaluateFocusConflict(fgState, { pid: 4242 });
      assert.equal(r2.allowed, false);
      assert.equal(r2.conflict, true);

      const r3 = evaluateFocusConflict(fgState, { processName: "notepad.exe" });
      assert.equal(r3.allowed, false);
      assert.equal(r3.conflict, true);

      const r4 = evaluateFocusConflict(fgState, { pid: 5151 });
      assert.equal(r4.allowed, false);
      assert.match(r4.conflictReason, /hovering/);

      const r5 = evaluateFocusConflict(fgState, { processName: "calc" }, { requirePinnedInstance: true, checkMouseHover: false });
      assert.equal(r5.allowed, false);
      assert.match(r5.conflictReason, /Multiple instances/);

      const rOk = evaluateFocusConflict(fgState, { hwnd: 3001, pid: 6161 });
      assert.equal(rOk.allowed, true);
      assert.equal(rOk.conflict, false);
    });

    await test("3. Hard Focus Guard blocks bg_launch / bg_cli (with & without target) / bg_ipc / bg_window_msg", async () => {
      let executed = false;
      const mockProbe = async () => ({
        foreground: { hwnd: 888, rootOwnerHwnd: 888, pid: 777, processName: "targetapp", title: "Active" },
        cursor: { hoverHwnd: 888, hoverRootHwnd: 888, hoverInfo: { pid: 777, processName: "targetapp" } },
        userIdleMs: 100,
        instances: [{ hwnd: 888, rootOwnerHwnd: 888, pid: 777, processName: "targetapp", isForeground: true }],
      });

      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: mockProbe });
      const tools = toolMap(
        createTools(queue, {
          probe: mockProbe,
          launchBackgroundProcess: async () => { executed = true; return { ok: true, pid: 999, hwnd: 999 }; },
          runBackgroundCli: async () => { executed = true; return { exitCode: 0, stdout: "", stderr: "" }; },
          postDirectedWindowMessage: async () => { executed = true; return { ok: true }; },
          fetch: async () => { executed = true; return new Response("ok"); },
        })
      );

      const resLaunch = await tools.get("bg_launch").execute({ executable: "targetapp.exe", taskId: "guard_launch" });
      assert.equal(resLaunch.status, "human_intervened");
      assert.equal(resLaunch.conflict, true);
      assert.equal(executed, false);

      const resCliWithTarget = await tools.get("bg_cli").execute({ command: "echo", targetPid: 777, taskId: "guard_cli_target" });
      assert.equal(resCliWithTarget.status, "human_intervened");
      assert.equal(executed, false);

      // P0-5: bg_cli without target & without backgroundOnly cannot complete
      const resCliNoTarget = await tools.get("bg_cli").execute({ command: "echo", taskId: "guard_cli_no_target" });
      assert.equal(resCliNoTarget.status, "human_intervened");
      assert.equal(executed, false);

      // P0-5: bg_cli without target WITH backgroundOnly=true under foreground conflict MUST refuse
      const resCliBgOnly = await tools.get("bg_cli").execute({ command: "echo", backgroundOnly: true, taskId: "guard_cli_bgonly" });
      assert.equal(resCliBgOnly.status, "human_intervened");
      assert.equal(executed, false);

      // P0-5: bg_ipc without target under foreground conflict MUST refuse
      const resIpcNoTarget = await tools.get("bg_ipc").execute({ protocol: "http", url: "http://127.0.0.1:9999/x", taskId: "guard_ipc_no_target" });
      assert.equal(resIpcNoTarget.status, "human_intervened");
      assert.equal(executed, false);

      const resIpcBgOnly = await tools.get("bg_ipc").execute({ protocol: "http", url: "http://127.0.0.1:9999/x", backgroundOnly: true, taskId: "guard_ipc_bgonly" });
      assert.equal(resIpcBgOnly.status, "human_intervened");
      assert.equal(executed, false);

      const resMsg = await tools.get("bg_window_msg").execute({ hwnd: 888, pid: 777, msgName: "WM_CLOSE", taskId: "guard_msg" });
      assert.equal(resMsg.status, "human_intervened");
      assert.equal(resMsg.conflict, true);
      assert.equal(executed, false);

      await assert.rejects(
        () => tools.get("bg_window_msg").execute({ hwnd: 0xffff, pid: 777, msg: 16 }),
        /non-broadcast/
      );

      // P0-4: normal window mode rejected even when idle
      const idleQueue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const idleTools = toolMap(createTools(idleQueue, { probe: IDLE_PROBE }));
      const resNormal = await idleTools.get("bg_launch").execute({
        executable: "otherapp.exe",
        windowMode: "normal",
        taskId: "deny_normal",
      });
      assert.equal(resNormal.status, "failed");
      assert.match(resNormal.error, /hidden|minimized|forbidden/i);

      // P0-4: COM keepHidden=false rejected
      await assert.rejects(
        () => idleTools.get("bg_ipc").execute({ protocol: "com", progId: "Scripting.Dictionary", method: "Count", keepHidden: false, backgroundOnly: true }),
        /prohibited/
      );
    });

    await test("4. Real Windows bg_query_state & bg_verify", async () => {
      if (!win32.IS_WINDOWS) return;
      const queue = new DshJobQueue({ workspaceRoot: tmpRoot });
      const tools = toolMap(createTools(queue));

      const stateRes = await tools.get("bg_query_state").execute({});
      assert.equal(stateRes.status, "completed");
      assert.ok(typeof stateRes.userIdleMs === "number");

      const verifyRes = await tools.get("bg_verify").execute({
        program: "node",
        comProgId: "Scripting.Dictionary",
      });
      assert.equal(verifyRes.status, "completed");
      assert.equal(verifyRes.channels.cli.available, true);
      assert.equal(verifyRes.channels.com.available, true);
      assert.ok(verifyRes.recommendedOrder.includes("cli"));
      assert.ok(verifyRes.recommendedOrder.includes("ipc:com"));
    });

    await test("5. bg_cli execution + artifact hash consistency + path traversal blocked", async () => {
      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const tools = toolMap(createTools(queue, { probe: IDLE_PROBE }));
      const sampleOut = path.join(tmpRoot, "external-produced.txt");
      await fsp.writeFile(sampleOut, "generated-by-target\n", "utf8");

      const res = await tools.get("bg_cli").execute({
        taskId: "cli_ok_01",
        command: process.execPath,
        args: ["-e", "console.log('hello-bg-cli')"],
        backgroundOnly: true,
        outputFile: sampleOut,
        outputName: "artifact.txt",
      });

      assert.equal(res.status, "completed");
      assert.equal(res.conflict, false);
      assert.ok(res.artifacts.some((a) => a.relativePath === "logs/cli_ok_01.log"));
      assert.ok(res.artifacts.some((a) => a.relativePath === "output/cli_ok_01/stdout.txt"));
      assert.ok(res.artifacts.some((a) => a.relativePath === "output/cli_ok_01/artifact.txt"));

      const resultFile = path.join(tmpRoot, "result_cli_ok_01.json");
      const sidecarFile = path.join(tmpRoot, "result_cli_ok_01.sha256");
      assert.ok(fs.existsSync(resultFile));
      assert.ok(fs.existsSync(sidecarFile));

      const resultJson = JSON.parse(await fsp.readFile(resultFile, "utf8"));
      assert.equal(resultJson.status, "completed");
      // Verify every artifact hash & byte count matches disk exactly
      for (const art of resultJson.artifacts) {
        const diskBuf = await fsp.readFile(path.join(tmpRoot, art.relativePath));
        const diskSha = crypto.createHash("sha256").update(diskBuf).digest("hex");
        assert.equal(art.bytes, diskBuf.length, `bytes mismatch on ${art.relativePath}`);
        assert.equal(art.sha256, diskSha, `sha256 mismatch on ${art.relativePath}`);
      }
      // Verify sidecar sha256 matches final result_cli_ok_01.json on disk
      const resultBuf = await fsp.readFile(resultFile);
      const expectedResultSha = crypto.createHash("sha256").update(resultBuf).digest("hex");
      const sidecarText = await fsp.readFile(sidecarFile, "utf8");
      assert.ok(sidecarText.startsWith(expectedResultSha));

      // P0-3: path traversal via outputName must fail and write nothing outside workspace
      const escapedTarget = path.resolve(tmpRoot, "..", "dsh_escaped_test.txt");
      await fsp.rm(escapedTarget, { force: true });
      const resEscape = await tools.get("bg_cli").execute({
        taskId: "cli_escape_01",
        command: process.execPath,
        args: ["-e", "console.log('x')"],
        backgroundOnly: true,
        outputFile: sampleOut,
        outputName: "../../../dsh_escaped_test.txt",
      });
      assert.equal(resEscape.status, "failed");
      assert.match(resEscape.error, /Invalid outputName|path separators/i);
      assert.equal(fs.existsSync(escapedTarget), false);
    });

    await test("6. job queue pause, checkpoint, resume, cancel ('cancelled') + host ctx.jobs forwarding", async () => {
      const hostCalls = [];
      const hostJobs = {
        submit: async (s) => { hostCalls.push(["submit", s.taskId]); return { jobId: `host_${s.taskId}` }; },
        pause: async (id) => { hostCalls.push(["pause", id]); },
        resume: async (id) => { hostCalls.push(["resume", id]); },
        cancel: async (id) => { hostCalls.push(["cancel", id]); },
      };

      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const tools = toolMap(createTools(queue, { probe: IDLE_PROBE, disableVisibleWindowWatch: true }));

      const started = await tools.get("bg_cli").execute(
        {
          taskId: "cli_pause_01",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 500)"],
          backgroundOnly: true,
          async: true,
        },
        { jobs: hostJobs }
      );

      assert.equal(started.taskId, "cli_pause_01");
      assert.ok(["running", "pending"].includes(started.status));
      assert.equal(started.hostJobId, "host_cli_pause_01");

      await new Promise((r) => setTimeout(r, 150));
      const paused = await tools.get("bg_job_control").execute(
        { action: "pause", taskId: "cli_pause_01", checkpoint: { step: 2 } },
        { jobs: hostJobs }
      );
      assert.equal(paused.status, "paused");
      assert.equal(paused.checkpoint.step, 2);

      const resumed = await tools.get("bg_job_control").execute(
        { action: "resume", taskId: "cli_pause_01" },
        { jobs: hostJobs }
      );
      assert.equal(resumed.status, "running");

      const cancelled = await tools.get("bg_job_control").execute(
        { action: "cancel", taskId: "cli_pause_01", reason: "test_interrupt" },
        { jobs: hostJobs }
      );
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.error, "test_interrupt");
      assert.ok(hostCalls.some(([op]) => op === "submit"));
      assert.ok(hostCalls.some(([op]) => op === "pause"));
      assert.ok(hostCalls.some(([op]) => op === "resume"));
      assert.ok(hostCalls.some(([op]) => op === "cancel"));
    });

    await test("7. bg_ipc localhost HTTP, Named Pipe, COM allowlist & WScript.Shell refusal", async () => {
      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const tools = toolMap(createTools(queue, { probe: IDLE_PROBE }));

      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, method: req.method }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;

      try {
        const httpRes = await tools.get("bg_ipc").execute({
          taskId: "ipc_http_01",
          protocol: "http",
          url: `http://127.0.0.1:${port}/ping`,
          body: { hello: "dsh" },
          backgroundOnly: true,
        });
        assert.equal(httpRes.status, "completed");
        assert.equal(httpRes.result.response.data.ok, true);
      } finally {
        server.close();
      }

      if (win32.IS_WINDOWS) {
        const pipeName = `dsh_test_pipe_${process.pid}_${Date.now()}`;
        const pipePath = `\\\\.\\pipe\\${pipeName}`;
        const pipeServer = net.createServer((socket) => {
          socket.on("data", (d) => {
            socket.end(JSON.stringify({ echo: d.toString("utf8").trim() }));
          });
        });
        await new Promise((resolve) => pipeServer.listen(pipePath, resolve));
        try {
          const pipeRes = await tools.get("bg_ipc").execute({
            taskId: "ipc_pipe_01",
            protocol: "pipe",
            pipeName,
            payload: { ping: 1 },
            backgroundOnly: true,
          });
          assert.equal(pipeRes.status, "completed");
          assert.ok(pipeRes.result.response.response.echo);
        } finally {
          pipeServer.close();
        }

        const comRes = await tools.get("bg_ipc").execute({
          taskId: "ipc_com_01",
          protocol: "com",
          progId: "Scripting.Dictionary",
          method: "Add",
          args: ["k1", "v1"],
          backgroundOnly: true,
        });
        assert.equal(comRes.status, "completed");
        assert.equal(comRes.result.response.ok, true);

        // P1-11: high-risk WScript.Shell refused when not in allowlist
        const comDenied = await tools.get("bg_ipc").execute({
          taskId: "ipc_com_denied",
          protocol: "com",
          progId: "WScript.Shell",
          method: "Run",
          args: ["cmd.exe"],
          backgroundOnly: true,
        });
        assert.equal(comDenied.status, "failed");
        assert.match(comDenied.error, /allowlist/i);
      }
    });

    await test("8. lib/index.js apply(ctx, config) registers 7 tools, systemPrompt section, and ctx.jobs bridge on DSH Cordis context", async () => {
      const registeredTools = [];
      const registeredSections = [];
      const effects = [];
      let controllerAttached = false;
      const startedHostJobs = [];

      const mockHostJobs = {
        attachController: (label) => {
          controllerAttached = label === "dsh-bg-control";
          return () => { controllerAttached = false; };
        },
        start: (spec) => {
          startedHostJobs.push(spec);
          const handle = { append: () => {}, updateProgress: () => {} };
          spec.run(handle);
          return `dsh_job_${startedHostJobs.length}`;
        },
      };

      const mockDshCtx = {
        tools: {
          register: (t) => {
            registeredTools.push(t);
            return () => {
              const idx = registeredTools.indexOf(t);
              if (idx >= 0) registeredTools.splice(idx, 1);
            };
          },
        },
        systemPrompt: {
          section: (sec) => {
            registeredSections.push(sec);
            return () => {};
          },
        },
        inject: (deps, fn) => {
          if (deps.includes("jobs")) {
            fn({
              jobs: mockHostJobs,
              effect: (cb) => { effects.push(cb()); },
            });
          }
        },
        effect: (cb) => {
          effects.push(cb());
        },
      };

      const applied = pluginEntry.apply(mockDshCtx, { defaultWindowMode: "hidden" });
      assert.equal(pluginEntry.name, "dsh-bg-control");
      assert.deepEqual(pluginEntry.inject, ["tools", "systemPrompt"]);
      assert.equal(registeredTools.length, 7);
      assert.equal(registeredSections.length, 1);
      assert.equal(registeredSections[0].name, "tool:bg-control");
      assert.equal(controllerAttached, true);
      assert.ok(applied.queue);

      for (const dispose of effects.reverse()) {
        if (typeof dispose === "function") dispose();
      }
      assert.equal(registeredTools.length, 0);
      assert.equal(controllerAttached, false);
    });

    await test("9. DSH 0.2.2-rc.1 bundle compliance: package.json, cordis.patch.yml, zero pi.* globals, zero NtSuspendProcess", async () => {
      const pkg = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
      assert.equal(pkg.name, "dsh-bg-control");
      assert.equal(pkg.version, "0.2.0");
      assert.equal(pkg.type, "module");
      assert.equal(pkg.main, "lib/index.js");
      assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
      assert.equal(pkg.engines?.dsh, ">=0.2.2-rc.1 <0.2.3-0");
      assert.equal(pkg.peerDependencies?.["@deepseek-ai/dsh"], ">=0.2.2-rc.1 <0.2.3-0");
      assert.equal(pkg.peerDependencies?.["@deepseek-ai/cordis"], "~4.1.0");
      assert.equal(pkg.engines?.piDesktop, undefined);
      assert.equal(fs.existsSync(path.join(REPO_ROOT, "manifest.json")), false);

      const patchYml = await fsp.readFile(path.join(REPO_ROOT, "cordis.patch.yml"), "utf8");
      assert.match(patchYml, /name:\s*dsh-bg-control/);

      const w32Src = await fsp.readFile(path.join(REPO_ROOT, "lib", "win32-bridge.js"), "utf8");
      assert.equal(/NtSuspendProcess/.test(w32Src), false, "NtSuspendProcess must not be present in win32-bridge.js");
      assert.match(w32Src, /NtResumeProcess/);
    });

    await test("10. P0-6 & P0-7: releaseAllOnShutdown resumes suspended ownedPid and never touches targetPid", async () => {
      const calls = [];
      const mockWin32 = {
        ...win32,
        suspendOrResumeProcess: async (pid, action) => {
          calls.push({ op: "suspendOrResume", pid, action });
          return { ok: true };
        },
        terminateProcessTree: async (pid) => {
          calls.push({ op: "terminate", pid });
          return { ok: true };
        },
      };

      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE, win32: mockWin32 });
      const job = await queue.submit({
        taskId: "shutdown_owned_01",
        kind: "cli",
        async: true,
        targetPid: 11111, // external user targetPid
        run: async (jobCtx) => {
          jobCtx.setOwnedProcess(22222, null); // plugin-owned child PID
          await new Promise((resolve, reject) => {
            jobCtx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        },
      });
      assert.equal(job.targetPid, 11111);
      assert.equal(job.ownedPid, 22222);

      await queue.pause("shutdown_owned_01");
      assert.ok(calls.some((c) => c.op === "suspendOrResume" && c.pid === 22222 && c.action === "suspend"));
      assert.equal(calls.some((c) => c.pid === 11111), false);

      calls.length = 0;
      await queue.releaseAllOnShutdown("test_stop");
      // Assert stop() called resume (not suspend) on ownedPid=22222, and never touched targetPid=11111
      assert.ok(calls.some((c) => c.op === "suspendOrResume" && c.pid === 22222 && c.action === "resume"));
      assert.equal(calls.some((c) => c.action === "suspend"), false);
      assert.equal(calls.some((c) => c.pid === 11111), false);
      assert.equal(queue.jobs.get("shutdown_owned_01").suspendedProcess, false);
    });

    await test("11. P1-10: bg_ipc HTTP timeoutMs=300 aborts and external 3xx redirect is refused", async () => {
      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const tools = toolMap(createTools(queue, { probe: IDLE_PROBE }));

      const server = http.createServer((req, res) => {
        if (req.url === "/slow") {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200);
              res.end("late");
            }
          }, 2500);
          return;
        }
        if (req.url === "/redir-ext") {
          res.writeHead(302, { Location: "https://example.com/evil" });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end("ok");
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;

      try {
        const t0 = Date.now();
        const timeoutRes = await tools.get("bg_ipc").execute({
          taskId: "ipc_http_timeout",
          protocol: "http",
          url: `http://127.0.0.1:${port}/slow`,
          timeoutMs: 300,
          backgroundOnly: true,
        });
        const elapsed = Date.now() - t0;
        assert.equal(timeoutRes.status, "failed");
        assert.ok(elapsed < 1500, `Expected ~300ms timeout, took ${elapsed}ms`);

        const redirRes = await tools.get("bg_ipc").execute({
          taskId: "ipc_http_redir",
          protocol: "http",
          url: `http://127.0.0.1:${port}/redir-ext`,
          backgroundOnly: true,
        });
        assert.equal(redirRes.status, "failed");
        assert.match(redirRes.error, /non-local host/i);
      } finally {
        server.closeAllConnections?.();
        server.close();
      }
    });

    await test("12. P1-12 & P1-14: log cap truncation + DSH session isolated fallback directory", async () => {
      const { deliverTaskArtifacts } = await import("../lib/artifacts.js");
      const fakeDshHome = path.join(tmpRoot, "dsh-home-12");
      const mockDshCtx = {
        homeDir: fakeDshCtxHome(fakeDshHome),
        workingDirectory: {},
      };
      function fakeDshCtxHome(p) { return p; }
      const manyLines = Array.from({ length: 20050 }, (_, i) => `line-${i}`);
      const res = await deliverTaskArtifacts({
        dshCtx: mockDshCtx,
        sessionId: "sess_abc",
        taskId: "cap_fallback_01",
        payload: { taskId: "cap_fallback_01", status: "completed", progress: 1 },
        logLines: manyLines,
        callChain: [],
      });
      assert.equal(res.workspaceResolution, "dsh_session_isolated_fallback");
      assert.equal(res.resultPayload.workspaceResolution, "dsh_session_isolated_fallback");
      assert.equal(res.resultPayload.logsTruncated, true);
      assert.ok(res.workspaceRoot.startsWith(fakeDshHome));
    });

    await test("13. P2-17 & P2-19: duplicate taskId handling + defaultWindowMode/hoverActiveThresholdMs settings", async () => {
      const launchedModes = [];
      const queue = new DshJobQueue({
        workspaceRoot: tmpRoot,
        probe: IDLE_PROBE,
        settings: { defaultWindowMode: "minimized", hoverActiveThresholdMs: 300 },
      });
      const tools = toolMap(
        createTools(queue, {
          probe: IDLE_PROBE,
          launchBackgroundProcess: async (p) => {
            launchedModes.push(p.windowMode);
            return { ok: true, status: "completed", pid: 4444, hwnd: 5555, processName: "app" };
          },
        })
      );

      const first = await tools.get("bg_launch").execute({ executable: "app.exe", taskId: "dup_01" });
      assert.equal(first.status, "completed");
      assert.equal(launchedModes[0], "minimized");

      await assert.rejects(
        () => tools.get("bg_launch").execute({ executable: "app.exe", taskId: "dup_01" }),
        /Duplicate taskId/
      );

      const suffixed = await tools.get("bg_launch").execute({
        executable: "app.exe",
        taskId: "dup_01",
        allowDuplicateSuffix: true,
      });
      assert.ok(suffixed.taskId.startsWith("dup_01_"));
    });

    await test("14. P0-A & P2-D: sanitizeTaskId/sanitizeOutputName reject traversal, trailing dots ('a.'), and Windows reserved names", async () => {
      let ran = false;
      const wsClean = path.join(tmpRoot, "ws-p2d");
      await fsp.mkdir(wsClean, { recursive: true });
      const queue = new DshJobQueue({ workspaceRoot: wsClean, probe: IDLE_PROBE });
      const tools = toolMap(
        createTools(queue, {
          probe: IDLE_PROBE,
          runBackgroundCli: async () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; },
          launchBackgroundProcess: async () => { ran = true; return { ok: true, pid: 1, hwnd: 1 }; },
        })
      );
      for (const badId of ["..", ".", "../evil", "a/b", "a\\b", "bad id", "", "a.", "CON", "NUL", "COM1", "LPT1.txt"]) {
        await assert.rejects(
          () => tools.get("bg_cli").execute({ taskId: badId, command: "echo", backgroundOnly: true }),
          /Invalid taskId/
        );
        await assert.rejects(
          () => tools.get("bg_launch").execute({ taskId: badId, executable: "charmap.exe" }),
          /Invalid taskId/
        );
      }
      assert.equal(ran, false);
      assert.equal(fs.existsSync(path.join(wsClean, "output", "a.")), false);
      assert.equal(fs.existsSync(path.join(wsClean, "logs", "a..log")), false);

      const { sanitizeOutputName } = await import("../lib/artifacts.js");
      for (const badOut of ["a.", "CON", "NUL.txt", "COM2", "LPT9.log"]) {
        assert.throws(() => sanitizeOutputName(badOut), /Invalid outputName/);
      }
    });

    await test("15. P0-A: Windows junction/symlink reparse escape is rejected in artifacts", async () => {
      const { deliverTaskArtifacts, copyOutputFileToWorkspace, listOutputFilesForTask } = await import("../lib/artifacts.js");
      const wsDir = path.join(tmpRoot, "ws-junc");
      const outsideDir = path.join(tmpRoot, "outside-junc");
      await fsp.mkdir(path.join(wsDir, "output"), { recursive: true });
      await fsp.mkdir(outsideDir, { recursive: true });
      const junctionPath = path.join(wsDir, "output", "junc_task");
      fs.symlinkSync(outsideDir, junctionPath, win32.IS_WINDOWS ? "junction" : "dir");

      const sampleFile = path.join(tmpRoot, "junc-src.txt");
      await fsp.writeFile(sampleFile, "secret", "utf8");

      await assert.rejects(
        () => copyOutputFileToWorkspace(wsDir, sampleFile, "junc_task", "leak.txt"),
        /symlink|junction|reparse/i
      );
      await assert.rejects(
        () => listOutputFilesForTask(wsDir, "junc_task"),
        /symlink|junction|reparse/i
      );
      await assert.rejects(
        () =>
          deliverTaskArtifacts({
            workspaceRoot: wsDir,
            taskId: "junc_task",
            payload: { taskId: "junc_task", status: "completed", progress: 1 },
            logLines: ["test"],
            callChain: [],
            inlineOutputs: [{ name: "escape.txt", content: "nope" }],
          }),
        /symlink|junction|reparse/i
      );
      assert.equal(fs.existsSync(path.join(outsideDir, "escape.txt")), false);
      assert.equal(fs.existsSync(path.join(outsideDir, "leak.txt")), false);
    });

    await test("16. P1-C & P1-E: DSH session workingDirectory binding, session mismatch isolation, and write error non-fallback", async () => {
      const { deliverTaskArtifacts, writeTextArtifact } = await import("../lib/artifacts.js");
      const wsDir = path.join(tmpRoot, "ws-session");
      const dshHomeDir = path.join(tmpRoot, "dsh-home-session");
      await fsp.mkdir(wsDir, { recursive: true });
      await fsp.mkdir(dshHomeDir, { recursive: true });

      const liveSession = { id: "sess_live_1" };
      const liveAgent = { id: "sess_live_1", session: liveSession };
      const mockDshCtx = {
        homeDir: dshHomeDir,
        agents: new Map([["sess_live_1", liveAgent]]),
        workingDirectory: {
          ensure: async (agent) => (agent.session.id === "sess_live_1" ? wsDir : null),
          get: (session) => (session.id === "sess_live_1" ? wsDir : null),
        },
      };

      const mismatchRes = await deliverTaskArtifacts({
        dshCtx: mockDshCtx,
        sessionId: "sess_other_2",
        taskId: "sess_mismatch_01",
        payload: { taskId: "sess_mismatch_01", status: "completed", progress: 1 },
        logLines: ["hello"],
        callChain: [],
      });
      assert.equal(mismatchRes.workspaceResolution, "dsh_session_isolated_fallback");
      assert.ok(mismatchRes.workspaceRoot.startsWith(dshHomeDir));
      assert.equal(fs.existsSync(path.join(wsDir, "result_sess_mismatch_01.json")), false);

      const mockFailingWriter = {
        writeText: async () => {
          throw new Error("Host writeText permission denied");
        },
      };
      await assert.rejects(
        () =>
          writeTextArtifact(
            mockFailingWriter,
            wsDir,
            "output/fail_01/test.txt",
            "data",
            "dsh_session_working_directory",
            wsDir
          ),
        /permission denied/i
      );
      assert.equal(fs.existsSync(path.join(wsDir, "output", "fail_01", "test.txt")), false);
    });

    await test("17. P0-B: bg_launch tracks descendant ownedPids and pause/cancel operate on full ownedPids tree", async () => {
      const calls = [];
      const mockWin32 = {
        ...win32,
        querySystemState: IDLE_PROBE,
        suspendOrResumeProcess: async (pid, action) => {
          calls.push({ op: "suspendOrResume", pid, action });
          return { ok: true };
        },
        terminateProcessTree: async (pid) => {
          calls.push({ op: "terminate", pid });
          return { ok: true };
        },
      };
      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE, win32: mockWin32 });
      const tools = toolMap(
        createTools(queue, {
          probe: IDLE_PROBE,
          win32: mockWin32,
          launchBackgroundProcess: async () => ({
            ok: true,
            status: "completed",
            pid: 30002,
            ownedRootPid: 30001,
            ownedPids: [30001, 30002],
            hwnd: 77777,
            processName: "charmap",
          }),
        })
      );
      const launched = await tools.get("bg_launch").execute({
        taskId: "launch_tree_01",
        executable: "powershell.exe",
        args: ["-Command", "Start-Process charmap.exe"],
      });
      assert.equal(launched.status, "completed");
      assert.equal(launched.ownedPid, 30002);
      assert.deepEqual(launched.ownedPids.sort(), [30001, 30002]);

      // Explicit bg_job_control(action="close") closes a completed launch job by ownedPids (never targetPid)
      const closedCompleted = await tools.get("bg_job_control").execute({
        action: "close",
        taskId: "launch_tree_01",
        reason: "explicit close test",
      });
      assert.equal(closedCompleted.status, "closed");
      assert.ok(calls.some((c) => c.op === "terminate" && c.pid === 30001));
      assert.ok(calls.some((c) => c.op === "terminate" && c.pid === 30002));

      // releaseAllOnShutdown with default closeCompletedLaunchOnShutdown=false preserves completed job
      calls.length = 0;
      await tools.get("bg_launch").execute({
        taskId: "launch_preserve_02",
        executable: "charmap.exe",
      });
      await queue.releaseAllOnShutdown("shutdown_preserve_test");
      assert.equal(queue.inspect("launch_preserve_02").status, "completed");
      assert.equal(calls.some((c) => c.op === "terminate"), false);

      // releaseAllOnShutdown with closeCompletedLaunchOnShutdown=true closes completed job
      const queueCloseOnStop = new DshJobQueue({
        workspaceRoot: tmpRoot,
        probe: IDLE_PROBE,
        win32: mockWin32,
        settings: { closeCompletedLaunchOnShutdown: true },
      });
      const toolsCloseOnStop = toolMap(
        createTools(queueCloseOnStop, {
          probe: IDLE_PROBE,
          win32: mockWin32,
          launchBackgroundProcess: async () => ({
            ok: true,
            status: "completed",
            pid: 40002,
            ownedRootPid: 40001,
            ownedPids: [40001, 40002],
            hwnd: 77778,
            processName: "charmap",
          }),
        })
      );
      await toolsCloseOnStop.get("bg_launch").execute({ taskId: "launch_auto_close", executable: "charmap.exe" });
      calls.length = 0;
      await queueCloseOnStop.releaseAllOnShutdown("shutdown_close_true");
      assert.equal(queueCloseOnStop.inspect("launch_auto_close").status, "closed");
      assert.ok(calls.some((c) => c.op === "terminate" && c.pid === 40001));
      assert.ok(calls.some((c) => c.op === "terminate" && c.pid === 40002));

      // Verify queue pause/cancel/shutdown on active running job touches full ownedPids tree and never touches targetPid
      const activeJob = await queue.submit({
        taskId: "tree_ctrl_01",
        kind: "launch",
        async: true,
        targetPid: 99991,
        run: async (jobCtx) => {
          jobCtx.setOwnedProcess(30002, 77777, "charmap", [30001, 30002]);
          await new Promise((resolve, reject) => {
            jobCtx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        },
      });
      assert.deepEqual(activeJob.ownedPids.sort(), [30001, 30002]);
      calls.length = 0;
      await queue.pause("tree_ctrl_01");
      assert.ok(calls.some((c) => c.op === "suspendOrResume" && c.pid === 30001 && c.action === "suspend"));
      assert.ok(calls.some((c) => c.op === "suspendOrResume" && c.pid === 30002 && c.action === "suspend"));
      assert.equal(calls.some((c) => c.pid === 99991), false);

      calls.length = 0;
      await queue.releaseAllOnShutdown("test_tree_stop");
      assert.ok(calls.some((c) => c.op === "suspendOrResume" && c.pid === 30001 && c.action === "resume"));
      assert.ok(calls.some((c) => c.op === "suspendOrResume" && c.pid === 30002 && c.action === "resume"));
      assert.ok(calls.some((c) => c.op === "terminate" && c.pid === 30001));
      assert.ok(calls.some((c) => c.op === "terminate" && c.pid === 30002));
      assert.equal(calls.some((c) => c.pid === 99991), false);
    });

    await test("18. P1-D: bg_ipc removes attachActive/quitOnExit and rejects them if passed", async () => {
      const specIpc = TOOL_SPECS.find((t) => t.name === "bg_ipc");
      assert.equal(specIpc.schema.properties.attachActive, undefined);
      assert.equal(specIpc.schema.properties.quitOnExit, undefined);

      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const tools = toolMap(createTools(queue, { probe: IDLE_PROBE }));

      await assert.rejects(
        () => tools.get("bg_ipc").execute({ protocol: "com", progId: "Scripting.Dictionary", method: "Count", attachActive: true, backgroundOnly: true }),
        /attachActive/i
      );
      await assert.rejects(
        () => tools.get("bg_ipc").execute({ protocol: "com", progId: "Scripting.Dictionary", method: "Count", quitOnExit: false, backgroundOnly: true }),
        /quitOnExit/i
      );
      await assert.rejects(
        () => win32.invokeComIpc({ progId: "Scripting.Dictionary", method: "Count", attachActive: true }),
        /attachActive/i
      );
      await assert.rejects(
        () => win32.invokeComIpc({ progId: "Scripting.Dictionary", method: "Count", quitOnExit: false }),
        /quitOnExit/i
      );
    });

    await test("19. P0-A: bg_window_msg resolves true OS processName (blocks forged/omitted WebView2/Edge/host, allows real non-browser)", async () => {
      let postCount = 0;
      const osProbe = async (q) => {
        const h = Number(q?.hwnd);
        if (h === 5050) {
          return {
            foreground: { hwnd: 99999, rootOwnerHwnd: 99999, pid: 99999, processName: "PI-Desktop" },
            cursor: { hoverHwnd: 99999, hoverRootHwnd: 99999, hoverInfo: { pid: 99999, processName: "PI-Desktop" } },
            userIdleMs: 5000,
            instances: [{ hwnd: 5050, rootOwnerHwnd: 5050, pid: 6060, processName: "msedge", title: "Edge", isForeground: false }],
          };
        }
        if (h === 5051) {
          return {
            foreground: { hwnd: 99999, rootOwnerHwnd: 99999, pid: 99999, processName: "PI-Desktop" },
            cursor: { hoverHwnd: 99999, hoverRootHwnd: 99999, hoverInfo: { pid: 99999, processName: "PI-Desktop" } },
            userIdleMs: 5000,
            instances: [{ hwnd: 5051, rootOwnerHwnd: 5051, pid: 6061, processName: "msedgewebview2", title: "WebView2", isForeground: false }],
          };
        }
        if (h === 5052) {
          return {
            foreground: { hwnd: 99999, rootOwnerHwnd: 99999, pid: 99999, processName: "PI-Desktop" },
            cursor: { hoverHwnd: 99999, hoverRootHwnd: 99999, hoverInfo: { pid: 99999, processName: "PI-Desktop" } },
            userIdleMs: 5000,
            instances: [{ hwnd: 5052, rootOwnerHwnd: 5052, pid: 6062, processName: "charmap", title: "Character Map", isForeground: false }],
          };
        }
        return {
          foreground: { hwnd: 99999, rootOwnerHwnd: 99999, pid: 99999, processName: "PI-Desktop" },
          cursor: { hoverHwnd: 99999, hoverRootHwnd: 99999, hoverInfo: { pid: 99999, processName: "PI-Desktop" } },
          userIdleMs: 5000,
          instances: [{ hwnd: 5053, rootOwnerHwnd: 5053, pid: 6063, processName: "", title: "Unknown", isForeground: false }],
        };
      };
      const queue = new DshJobQueue({ workspaceRoot: tmpRoot, probe: osProbe });
      const tools = toolMap(
        createTools(queue, {
          probe: osProbe,
          postDirectedWindowMessage: async (p) => {
            postCount++;
            return { ok: true, hwnd: p.hwnd, verifiedPid: p.pid };
          },
        })
      );

      // Case 1: Omitted processName on msedge -> unsupported, postFn not called
      const rOmitted = await tools.get("bg_window_msg").execute({
        taskId: "browser_omitted_01",
        hwnd: 5050,
        pid: 6060,
        msgName: "WM_NULL",
      });
      assert.equal(rOmitted.status, "unsupported");
      assert.equal(rOmitted.conflict, false);
      assert.equal(rOmitted.result.verifiedProcessName, "msedge");
      assert.equal(postCount, 0);

      // Case 2: Forged processName="notepad.exe" on msedgewebview2 -> unsupported, postFn not called
      const rForgedWv2 = await tools.get("bg_window_msg").execute({
        taskId: "browser_forged_wv2",
        hwnd: 5051,
        pid: 6061,
        processName: "notepad.exe",
        msgName: "WM_NULL",
      });
      assert.equal(rForgedWv2.status, "unsupported");
      assert.equal(rForgedWv2.result.verifiedProcessName, "msedgewebview2");
      assert.equal(rForgedWv2.result.processNameMismatch, true);
      assert.equal(postCount, 0);

      // Case 3: Unresolvable OS processName -> fail-closed unsupported_unverified_target, postFn not called
      const rUnverified = await tools.get("bg_window_msg").execute({
        taskId: "browser_unverified_03",
        hwnd: 5053,
        pid: 6063,
        processName: "notepad.exe",
        msgName: "WM_NULL",
      });
      assert.equal(rUnverified.status, "unsupported_unverified_target");
      assert.equal(postCount, 0);

      // Case 4: PID mismatch -> rejected immediately
      await assert.rejects(
        () => tools.get("bg_window_msg").execute({ hwnd: 5052, pid: 1111, msgName: "WM_NULL" }),
        /PID mismatch/i
      );
      assert.equal(postCount, 0);

      // Case 5: Real non-browser charmap with mismatched caller processName -> allowed using verifiedProcessName="charmap"
      const rCharmap = await tools.get("bg_window_msg").execute({
        taskId: "nonbrowser_mismatch_ok",
        hwnd: 5052,
        pid: 6062,
        processName: "notepad.exe",
        msgName: "WM_NULL",
      });
      assert.equal(rCharmap.status, "completed");
      assert.equal(rCharmap.result.verifiedProcessName, "charmap");
      assert.equal(rCharmap.result.processNameMismatch, true);
      assert.equal(postCount, 1);
    });

    await test("20. DSH Schemastery Config validation & default values", async () => {
      const defaults = pluginEntry.Config({});
      assert.equal(defaults.defaultWindowMode, "hidden");
      assert.equal(defaults.hoverActiveThresholdMs, 1500);
      assert.deepEqual(defaults.comAllowlist, ["Scripting.Dictionary"]);
      assert.equal(defaults.closeCompletedLaunchOnShutdown, false);

      const custom = pluginEntry.Config({
        defaultWindowMode: "minimized",
        hoverActiveThresholdMs: 2500,
        comAllowlist: ["Scripting.Dictionary"],
        closeCompletedLaunchOnShutdown: true,
      });
      assert.equal(custom.defaultWindowMode, "minimized");
      assert.equal(custom.hoverActiveThresholdMs, 2500);
      assert.equal(custom.closeCompletedLaunchOnShutdown, true);
    });

    await test("21. P1-C: COM isolation cases A-G (strict fail-closed on uncertain/incomplete/existing, Quit on verified new)", async () => {
      const makeRunner = (adapter) => {
        let visSpy = false;
        let invSpy = false;
        let quitSpy = false;
        const wrapped = {
          getActiveObject: adapter.getActiveObject,
          createNew: async (progId) => {
            const inst = await adapter.createNew(progId);
            if (!inst) return null;
            return {
              ...inst,
              setVisible: async (v) => {
                visSpy = true;
                if (inst.setVisible) await inst.setVisible(v);
              },
              invoke: async (m, a) => {
                invSpy = true;
                return inst.invoke ? inst.invoke(m, a) : "16.0";
              },
              quit: async () => {
                quitSpy = true;
                if (inst.quit) await inst.quit();
              },
            };
          },
        };
        const q = new DshJobQueue({ workspaceRoot: tmpRoot, probe: IDLE_PROBE });
        const t = toolMap(createTools(q, { probe: IDLE_PROBE, comAllowlist: ["FakeExcel.Application"], comAdapter: wrapped }));
        return {
          exec: (taskId) =>
            t.get("bg_ipc").execute({
              taskId,
              protocol: "com",
              progId: "FakeExcel.Application",
              method: "get:Version",
              backgroundOnly: true,
            }),
          spies: () => ({ visSpy, invSpy, quitSpy }),
        };
      };

      // A. getActiveObject throws generic error; createNew returns Hwnd=1234/Pid=5678 -> unsupported_unverified_com
      const caseA = makeRunner({
        getActiveObject: async () => {
          throw new Error("RPC_E_CALL_REJECTED or generic COM error");
        },
        createNew: async () => ({ getHwnd: () => 1234, getPid: () => 5678 }),
      });
      const resA = await caseA.exec("com_case_a");
      assert.equal(resA.status, "unsupported_unverified_com");
      assert.equal(resA.result.activeCheck, "uncertain");
      assert.equal(resA.result.createdNew, false);
      assert.equal(resA.result.visibleSet, false);
      assert.equal(resA.result.invoked, false);
      assert.equal(resA.result.quitCalled, false);
      assert.deepEqual(caseA.spies(), { visSpy: false, invSpy: false, quitSpy: false });

      // B. getActiveObject throws MK_E_UNAVAILABLE (0x800401E3); createNew returns Hwnd=1234/Pid=5678 -> completed
      let visValB = null;
      const caseB = makeRunner({
        getActiveObject: async () => {
          const e = new Error("Operation unavailable (Exception from HRESULT: 0x800401E3 (MK_E_UNAVAILABLE))");
          e.hresult = -2147221021;
          throw e;
        },
        createNew: async () => ({
          getHwnd: () => 1234,
          getPid: () => 5678,
          setVisible: async (v) => { visValB = v; },
        }),
      });
      const resB = await caseB.exec("com_case_b");
      assert.equal(resB.status, "completed");
      assert.equal(resB.result.response.activeCheck, "none");
      assert.equal(resB.result.response.createdNew, true);
      assert.equal(resB.result.response.visibleSet, true);
      assert.equal(resB.result.response.invoked, true);
      assert.equal(resB.result.response.quitCalled, true);
      assert.equal(visValB, false);
      assert.deepEqual(caseB.spies(), { visSpy: true, invSpy: true, quitSpy: true });

      // C. activeFound=true, activeHwnd=0, activePid=0; createNew returns Hwnd=1234/Pid=5678 -> unsupported_unverified_com
      const caseC = makeRunner({
        getActiveObject: async () => ({ exists: true, hwnd: 0, pid: 0 }),
        createNew: async () => ({ getHwnd: () => 1234, getPid: () => 5678 }),
      });
      const resC = await caseC.exec("com_case_c");
      assert.equal(resC.status, "unsupported_unverified_com");
      assert.equal(resC.result.activeCheck, "found");
      assert.equal(resC.result.createdNew, false);
      assert.equal(resC.result.visibleSet, false);
      assert.equal(resC.result.invoked, false);
      assert.equal(resC.result.quitCalled, false);
      assert.deepEqual(caseC.spies(), { visSpy: false, invSpy: false, quitSpy: false });

      // D. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=2002/Pid=0 -> unsupported_unverified_com
      const caseD = makeRunner({
        getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
        createNew: async () => ({ getHwnd: () => 2002, getPid: () => 0 }),
      });
      const resD = await caseD.exec("com_case_d");
      assert.equal(resD.status, "unsupported_unverified_com");
      assert.equal(resD.result.activeCheck, "found");
      assert.equal(resD.result.createdNew, false);
      assert.equal(resD.result.visibleSet, false);
      assert.equal(resD.result.invoked, false);
      assert.equal(resD.result.quitCalled, false);
      assert.deepEqual(caseD.spies(), { visSpy: false, invSpy: false, quitSpy: false });

      // E. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=2002/Pid=4001 -> unsupported_existing_instance
      const caseE = makeRunner({
        getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
        createNew: async () => ({ getHwnd: () => 2002, getPid: () => 4001 }),
      });
      const resE = await caseE.exec("com_case_e");
      assert.equal(resE.status, "unsupported_existing_instance");
      assert.equal(resE.result.activeCheck, "found");
      assert.equal(resE.result.createdNew, false);
      assert.equal(resE.result.visibleSet, false);
      assert.equal(resE.result.invoked, false);
      assert.equal(resE.result.quitCalled, false);
      assert.deepEqual(caseE.spies(), { visSpy: false, invSpy: false, quitSpy: false });

      // F. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=2002/Pid=5002 -> completed
      let visValF = null;
      const caseF = makeRunner({
        getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
        createNew: async () => ({
          getHwnd: () => 2002,
          getPid: () => 5002,
          setVisible: async (v) => { visValF = v; },
        }),
      });
      const resF = await caseF.exec("com_case_f");
      assert.equal(resF.status, "completed");
      assert.equal(resF.result.response.activeCheck, "found");
      assert.equal(resF.result.response.createdNew, true);
      assert.equal(resF.result.response.visibleSet, true);
      assert.equal(resF.result.response.invoked, true);
      assert.equal(resF.result.response.quitCalled, true);
      assert.equal(visValF, false);
      assert.deepEqual(caseF.spies(), { visSpy: true, invSpy: true, quitSpy: true });

      // G. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=1001/Pid=5002 -> unsupported_existing_instance
      const caseG = makeRunner({
        getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
        createNew: async () => ({ getHwnd: () => 1001, getPid: () => 5002 }),
      });
      const resG = await caseG.exec("com_case_g");
      assert.equal(resG.status, "unsupported_existing_instance");
      assert.equal(resG.result.activeCheck, "found");
      assert.equal(resG.result.createdNew, false);
      assert.equal(resG.result.visibleSet, false);
      assert.equal(resG.result.invoked, false);
      assert.equal(resG.result.quitCalled, false);
      assert.deepEqual(caseG.spies(), { visSpy: false, invSpy: false, quitSpy: false });
    });

    await test("22. P0-B: Plan Mode & Approval enforcement (only list/inspect are plan-safe; close/launch/cli refused in Plan Mode)", async () => {
      const jcSpec = TOOL_SPECS.find((t) => t.name === "bg_job_control");
      assert.ok(jcSpec.schema.properties.action.enum.includes("close"));
      assert.deepEqual(jcSpec.planSafeActions, ["list", "inspect"]);

      const planActiveCtx = {
        planMode: {
          selectedActive: () => true,
        },
      };
      const queue = new DshJobQueue({ dshCtx: planActiveCtx, workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const tools = toolMap(createTools(queue, { probe: IDLE_PROBE }));
      const execInPlan = { agent: { id: "agent_1", session: { id: "sess_1" } } };

      // Read-only tools and bg_job_control(action="list") succeed in Plan Mode
      const listRes = await tools.get("bg_job_control").execute({ action: "list" }, execInPlan);
      assert.equal(listRes.status, "completed");

      const queryRes = await tools.get("bg_query_state").execute({}, execInPlan);
      assert.equal(queryRes.status, "completed");

      // Mutating actions (bg_job_control close/cancel/pause, bg_launch, bg_cli, bg_ipc, bg_window_msg) MUST be refused in Plan Mode
      await assert.rejects(
        () => tools.get("bg_job_control").execute({ action: "close", taskId: "any_id" }, execInPlan),
        /not permitted while Plan Mode is active/i
      );
      await assert.rejects(
        () => tools.get("bg_launch").execute({ executable: "charmap.exe" }, execInPlan),
        /not permitted while Plan Mode is active/i
      );
      await assert.rejects(
        () => tools.get("bg_cli").execute({ command: "node", args: ["-v"], backgroundOnly: true }, execInPlan),
        /not permitted while Plan Mode is active/i
      );

      // DSH ctx.approval rejection blocks mutating tool execution
      const approvalDeniedCtx = {
        approval: {
          approvalStateOf: () => ({ turnOpen: true }),
          request: async () => "rejected",
        },
      };
      const queueApproval = new DshJobQueue({ dshCtx: approvalDeniedCtx, workspaceRoot: tmpRoot, probe: IDLE_PROBE });
      const toolsApproval = toolMap(createTools(queueApproval, { probe: IDLE_PROBE }));
      await assert.rejects(
        () => toolsApproval.get("bg_launch").execute({ executable: "charmap.exe" }, execInPlan),
        /denied by DSH approval policy/i
      );
    });

    console.log("\nALL DSH BACKGROUND CONTROL TESTS PASSED (22/22).");
  } finally {
    win32.shutdownResidentHelper();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  win32.shutdownResidentHelper();
  console.error("\nTEST FAILED:", err);
  process.exit(1);
});
