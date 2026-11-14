import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { DshJobQueue } from "../lib/job-queue.js";
import { createTools } from "../lib/tools.js";
import { deliverTaskArtifacts, writeTextArtifact } from "../lib/artifacts.js";
import win32 from "../lib/win32-bridge.js";

function toolMap(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.name, t);
  return m;
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-r2-probe-"));
  const report = {
    executedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    probes: {},
  };

  try {
    await win32.prewarmResidentHelper();

    const wsRoot = path.join(tmpRoot, "workspace");
    await fsp.mkdir(wsRoot, { recursive: true });
    // Use hoverActiveThresholdMs: 0 for deterministic local probe execution without mouse-idle flakiness
    const queue = new DshJobQueue({
      workspaceRoot: wsRoot,
      settings: { hoverActiveThresholdMs: 0 },
    });
    const tools = toolMap(createTools(queue));

    // T1: taskId = "..", "a.", "CON" refusal before any disk write
    const rejectedTaskIds = {};
    for (const badId of ["..", "a.", "CON"]) {
      let errMsg = null;
      try {
        await tools.get("bg_cli").execute({
          taskId: badId,
          command: process.execPath,
          args: ["-e", "console.log('should-not-run')"],
          backgroundOnly: true,
        });
      } catch (e) {
        errMsg = e.message;
      }
      assert.ok(errMsg && /Invalid taskId/i.test(errMsg), `Expected Invalid taskId error for ${badId}, got ${errMsg}`);
      rejectedTaskIds[badId] = errMsg;
    }
    assert.equal(fs.existsSync(path.join(tmpRoot, "result_..json")), false);
    assert.equal(fs.existsSync(path.join(wsRoot, "output", "a.")), false);
    assert.equal(fs.existsSync(path.join(wsRoot, "logs", "a..log")), false);
    report.probes.T1_taskid_traversal = {
      rejected: true,
      error: rejectedTaskIds[".."],
      rejectedTaskIds,
      filesWritten: false,
    };
    console.log("[T1 taskId='..','a.','CON'] rejected:", JSON.stringify(rejectedTaskIds));

    // T2: Real Windows junction escape rejection
    const juncWs = path.join(tmpRoot, "junc-ws");
    const juncOutside = path.join(tmpRoot, "junc-outside");
    await fsp.mkdir(path.join(juncWs, "output"), { recursive: true });
    await fsp.mkdir(juncOutside, { recursive: true });
    const juncLink = path.join(juncWs, "output", "junc_probe");
    fs.symlinkSync(juncOutside, juncLink, win32.IS_WINDOWS ? "junction" : "dir");
    let juncErr = null;
    try {
      await deliverTaskArtifacts({
        workspaceRoot: juncWs,
        taskId: "junc_probe",
        payload: { taskId: "junc_probe", status: "completed", progress: 1 },
        logLines: ["probe"],
        callChain: [],
        inlineOutputs: [{ name: "escape.txt", content: "blocked" }],
      });
    } catch (e) {
      juncErr = e.message;
    }
    assert.ok(juncErr && /symlink|junction|reparse/i.test(juncErr), `Expected junction error, got ${juncErr}`);
    assert.equal(fs.existsSync(path.join(juncOutside, "escape.txt")), false);
    // Remove junction cleanly before rm
    await fsp.rm(juncLink, { recursive: false, force: true });
    report.probes.T2_windows_junction_escape = {
      rejected: true,
      error: juncErr,
      outsideFileCreated: false,
    };
    console.log("[T2 junction_escape] rejected:", juncErr);

    // T3: Real powershell.exe Start-Process charmap.exe descendant tree hide + ownedPids cleanup
    const treeRes = await tools.get("bg_launch").execute({
      taskId: "probe_ps_charmap_tree",
      executable: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process charmap.exe; Start-Sleep -Milliseconds 300"],
      windowMode: "hidden",
      waitForHwndMs: 4500,
    });
    console.log("[T3 descendant_launch]", JSON.stringify({
      status: treeRes.status,
      ownedPid: treeRes.ownedPid,
      ownedPids: treeRes.ownedPids,
      hwnd: treeRes.hwnd,
      processName: treeRes.result?.processName,
      visible: treeRes.result?.visible,
    }));
    const childCharmapPid = treeRes.ownedPid;
    try {
      assert.equal(treeRes.status, "completed", `Expected completed, got ${treeRes.status}: ${treeRes.error || treeRes.conflictReason || ""}`);
      assert.ok(Array.isArray(treeRes.ownedPids) && treeRes.ownedPids.length >= 2, `Expected >=2 ownedPids, got ${JSON.stringify(treeRes.ownedPids)}`);
      assert.ok(Number(treeRes.hwnd) > 0, "Expected non-null charmap hwnd");
      assert.match(String(treeRes.result?.processName || ""), /charmap/i);
      assert.equal(treeRes.result?.visible, false, "Descendant charmap window should be hidden");
    } finally {
      for (const p of treeRes.ownedPids || []) {
        await win32.terminateProcessTree(p);
      }
      if (childCharmapPid) await win32.terminateProcessTree(childCharmapPid);
    }
    await new Promise((r) => setTimeout(r, 250));
    const afterTreeInfo = childCharmapPid ? await win32.getProcessInfo(childCharmapPid) : { exists: false };
    assert.equal(afterTreeInfo.exists, false, "Descendant charmap process must be terminated");
    report.probes.T3_descendant_launch_charmap = {
      status: treeRes.status,
      ownedPid: treeRes.ownedPid,
      ownedPids: treeRes.ownedPids,
      hwnd: treeRes.hwnd,
      boundProcessName: treeRes.result?.processName,
      visibleAfterHide: treeRes.result?.visible,
      descendantTerminated: !afterTreeInfo.exists,
    };

    // T4: DSH session mismatch isolation + writeText failure non-fallback
    const sessActiveDir = path.join(tmpRoot, "sess-active-ws");
    const sessDshHome = path.join(tmpRoot, "sess-dsh-home");
    await fsp.mkdir(sessActiveDir, { recursive: true });
    await fsp.mkdir(sessDshHome, { recursive: true });
    const liveAgentA = { id: "session-A", session: { id: "session-A" } };
    const mockDshCtx = {
      homeDir: sessDshHome,
      agents: new Map([["session-A", liveAgentA]]),
      workingDirectory: {
        ensure: async (a) => (a.session.id === "session-A" ? sessActiveDir : null),
        get: (s) => (s.id === "session-A" ? sessActiveDir : null),
      },
      writeText: async () => {
        throw new Error("Simulated host writeText refusal");
      },
    };
    const mismatchDelivered = await deliverTaskArtifacts({
      dshCtx: mockDshCtx,
      sessionId: "session-B",
      taskId: "probe_sess_mismatch",
      payload: { taskId: "probe_sess_mismatch", status: "completed", progress: 1 },
      logLines: ["session mismatch test"],
      callChain: [],
    });
    assert.equal(mismatchDelivered.workspaceResolution, "dsh_session_isolated_fallback");
    assert.equal(fs.existsSync(path.join(sessActiveDir, "result_probe_sess_mismatch.json")), false);

    let fsWriteErr = null;
    try {
      await writeTextArtifact(
        mockDshCtx,
        sessActiveDir,
        "output/no_fallback/test.txt",
        "should not fall back",
        "dsh_session_working_directory",
        sessActiveDir
      );
    } catch (e) {
      fsWriteErr = e.message;
    }
    assert.ok(fsWriteErr && /Simulated host writeText refusal/.test(fsWriteErr));
    assert.equal(fs.existsSync(path.join(sessActiveDir, "output", "no_fallback", "test.txt")), false);
    report.probes.T4_session_mismatch_and_non_fallback = {
      mismatchResolution: mismatchDelivered.workspaceResolution,
      activeWorkspaceUntouched: true,
      fsWriteErrorPropagated: fsWriteErr,
      fallbackWriteOccurred: false,
    };
    console.log("[T4 session_mismatch & fs_non_fallback] OK");

    // T5: 25ms bg_cli visible GUI watch on WinForms window (with honest note on <25ms flash window)
    const t5Start = Date.now();
    const guiWatchRes = await tools.get("bg_cli").execute({
      taskId: "probe_cli_25ms_gui",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text='DSH25msProbe'; $f.Show(); [System.Windows.Forms.Application]::Run($f)",
      ],
      backgroundOnly: true,
      timeoutMs: 8000,
    });
    const t5Ms = Date.now() - t5Start;
    assert.equal(guiWatchRes.status, "human_intervened");
    assert.equal(guiWatchRes.conflict, true);
    report.probes.T5_cli_25ms_gui_watch = {
      status: guiWatchRes.status,
      conflict: guiWatchRes.conflict,
      elapsedMs: t5Ms,
      conflictReason: guiWatchRes.conflictReason,
      limitationNote: "Polling interval is 25ms (+ immediate onSpawn scan and pre-exit scan); sub-25ms transient flash windows cannot be preempted before OS draw.",
    };
    console.log("[T5 cli_25ms_gui_watch] killed in", t5Ms, "ms");

    // T6: COM isolated instance + browser bg_window_msg refusal
    const comRes = await tools.get("bg_ipc").execute({
      taskId: "probe_com_isolated",
      protocol: "com",
      progId: "Scripting.Dictionary",
      method: "Add",
      args: ["probeKey", "probeVal"],
      backgroundOnly: true,
    });
    assert.equal(comRes.status, "completed");
    assert.equal(comRes.result.response.createdNew, true);

    let attachRejected = false;
    try {
      await tools.get("bg_ipc").execute({
        protocol: "com",
        progId: "Scripting.Dictionary",
        method: "Count",
        attachActive: true,
        backgroundOnly: true,
      });
    } catch {
      attachRejected = true;
    }
    assert.equal(attachRejected, true);

    const browserState = await tools.get("bg_query_state").execute({ processName: "msedge" });
    const liveEdge = (browserState.instances || []).find((i) => Number(i.hwnd) > 0 && Number(i.pid) > 0);
    const browserHwnd = liveEdge ? Number(liveEdge.hwnd) : 987654;
    const browserPid = liveEdge ? Number(liveEdge.pid) : 98765;
    const browserRes = await tools.get("bg_window_msg").execute({
      taskId: "probe_browser_refusal",
      hwnd: browserHwnd,
      pid: browserPid,
      processName: liveEdge ? liveEdge.processName : "msedge.exe",
      msgName: "WM_NULL",
    });
    assert.equal(browserRes.status, "unsupported");
    assert.equal(browserRes.conflict, false);
    report.probes.T6_com_isolation_and_browser_refusal = {
      comCreatedNew: comRes.result.response.createdNew,
      attachActiveRejected: attachRejected,
      liveBrowserDetected: Boolean(liveEdge),
      browserRefusalStatus: browserRes.status,
      browserRefusalError: browserRes.error,
    };
    console.log("[T6 com_isolation & browser_refusal] OK (liveBrowserDetected=" + Boolean(liveEdge) + ")");

    await fsp.writeFile(
      path.join(__dirname, "targeted-probe-results.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8"
    );
    console.log("\nALL ROUND 2 TARGETED PROBES PASSED.");
  } finally {
    win32.shutdownResidentHelper();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  win32.shutdownResidentHelper();
  console.error("\nTARGETED PROBE FAILED:", err);
  process.exit(1);
});
