import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { DshJobQueue } from "../lib/job-queue.js";
import { createTools } from "../lib/tools.js";
import win32 from "../lib/win32-bridge.js";

function toolMap(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.name, t);
  return m;
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-probe-"));
  const report = {
    executedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    probes: {},
  };

  try {
    const queue = new DshJobQueue({ workspaceRoot: tmpRoot });
    const tools = toolMap(createTools(queue));

    // B-10: Query performance (prewarm + warm timings)
    const tCold0 = Date.now();
    await win32.prewarmResidentHelper();
    const prewarmMs = Date.now() - tCold0;

    const queryTimingsMs = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const q = await tools.get("bg_query_state").execute({});
      queryTimingsMs.push(Date.now() - t0);
      assert.equal(q.status, "completed");
    }
    const maxWarmMs = Math.max(...queryTimingsMs);
    const avgWarmMs = Math.round(queryTimingsMs.reduce((a, b) => a + b, 0) / queryTimingsMs.length);
    report.probes.B10_query_performance = {
      prewarmColdMs: prewarmMs,
      warmRunsMs: queryTimingsMs,
      avgWarmMs,
      maxWarmMs,
      under800ms: maxWarmMs < 800,
    };
    console.log("[B-10] querySystemState prewarmMs=", prewarmMs, "warmRunsMs=", queryTimingsMs, "avg=", avgWarmMs, "max=", maxWarmMs);
    assert.ok(maxWarmMs < 800, `Expected warm query < 800ms, got ${maxWarmMs}ms`);

    // Wait briefly so userIdleMs > 1500ms if needed, or use real querySystemState
    // B-1 & B-7 & C-2: Real charmap.exe hidden launch + UTF-8 title + bg_window_msg WM_NULL & WM_CLOSE
    const charmapRes = await tools.get("bg_launch").execute({
      taskId: "probe_charmap_hidden",
      executable: "charmap.exe",
      windowMode: "hidden",
      waitForHwndMs: 3000,
    });
    console.log("[B-1 charmap]", JSON.stringify({
      status: charmapRes.status,
      ownedPid: charmapRes.ownedPid,
      hwnd: charmapRes.hwnd,
      title: charmapRes.result?.title,
    }));
    assert.equal(charmapRes.status, "completed", `Expected charmap completed, got ${charmapRes.status}: ${charmapRes.error || ""}`);
    assert.ok(Number(charmapRes.hwnd) > 0, "Expected non-null hwnd for hidden charmap");

    let charmapClosed = false;
    try {
      // Query charmap state & check UTF-8 Chinese title
      const charmapState = await tools.get("bg_query_state").execute({
        pid: charmapRes.ownedPid,
        hwnd: charmapRes.hwnd,
      });
      const winTitle = charmapState.instances?.[0]?.title || charmapRes.result?.title || "";
      const hasReplacementChar = winTitle.includes("\uFFFD");
      console.log("[B-7 utf8_title]", JSON.stringify({ winTitle, hasReplacementChar }));
      assert.equal(hasReplacementChar, false, `Found U+FFFD replacement char in title: ${winTitle}`);

      // C-2: bg_window_msg WM_NULL & WM_CLOSE on hidden charmap
      const msgNull = await tools.get("bg_window_msg").execute({
        taskId: "probe_charmap_wm_null",
        hwnd: charmapRes.hwnd,
        msgName: "WM_NULL",
      });
      console.log("[C-2 WM_NULL]", JSON.stringify({
        status: msgNull.status,
        verifiedPid: msgNull.verifiedPid,
        hwnd: msgNull.hwnd,
      }));
      assert.equal(msgNull.status, "completed");
      assert.equal(msgNull.verifiedPid, charmapRes.ownedPid);

      const msgClose = await tools.get("bg_window_msg").execute({
        taskId: "probe_charmap_wm_close",
        hwnd: charmapRes.hwnd,
        pid: charmapRes.ownedPid,
        msgName: "WM_CLOSE",
      });
      console.log("[C-2 WM_CLOSE]", JSON.stringify({
        status: msgClose.status,
        verifiedPid: msgClose.verifiedPid,
        hwnd: msgClose.hwnd,
      }));
      assert.equal(msgClose.status, "completed");
      await new Promise((r) => setTimeout(r, 900));
      const pInfo = await win32.getProcessInfo(charmapRes.ownedPid);
      charmapClosed = !pInfo.exists;
      report.probes.B1_B7_C2_charmap = {
        launchStatus: charmapRes.status,
        ownedPid: charmapRes.ownedPid,
        hwnd: charmapRes.hwnd,
        title: winTitle,
        hasReplacementChar,
        wmNullStatus: msgNull.status,
        wmNullVerifiedPid: msgNull.verifiedPid,
        wmCloseStatus: msgClose.status,
        exitedAfterWmClose: charmapClosed,
      };
    } finally {
      if (!charmapClosed && charmapRes.ownedPid) {
        await win32.terminateProcessTree(charmapRes.ownedPid);
      }
    }

    // B-1 part 2: Real notepad.exe (Win11 UWP stub check)
    const notepadRes = await tools.get("bg_launch").execute({
      taskId: "probe_notepad_uwp",
      executable: "notepad.exe",
      windowMode: "hidden",
      waitForHwndMs: 2500,
    });
    console.log("[B-1 notepad]", JSON.stringify({
      status: notepadRes.status,
      ownedPid: notepadRes.ownedPid,
      hwnd: notepadRes.hwnd,
      error: notepadRes.error,
    }));
    // On Win11 UWP Notepad, stub exits immediately -> unsupported_uwp; if classic Win32 Notepad exists on an OS, clean it up
    if (notepadRes.status !== "unsupported_uwp" && notepadRes.ownedPid) {
      await win32.terminateProcessTree(notepadRes.ownedPid);
    }
    assert.notEqual(notepadRes.status === "completed" && !notepadRes.hwnd, true, "Must never return completed with hwnd=null");
    report.probes.B1_notepad = {
      status: notepadRes.status,
      ownedPid: notepadRes.ownedPid,
      hwnd: notepadRes.hwnd,
      error: notepadRes.error,
    };

    // B-9: Real bg_launch args with spaces (C:\Temp\a b\file.txt)
    const argOutFile = path.join(tmpRoot, "argv-captured.json");
    const spaceArg = "C:\\Temp\\a b\\file.txt";
    const argLaunchRes = await tools.get("bg_launch").execute({
      taskId: "probe_space_args",
      executable: process.execPath,
      args: [
        "-e",
        "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
        argOutFile,
        spaceArg,
        "second arg with spaces",
      ],
      windowMode: "hidden",
      waitForHwndMs: 1200,
    });
    await new Promise((r) => setTimeout(r, 350));
    const capturedArgv = JSON.parse(await fsp.readFile(argOutFile, "utf8"));
    console.log("[B-9 space_args]", JSON.stringify({ capturedArgv }));
    assert.deepEqual(capturedArgv, [spaceArg, "second arg with spaces"]);
    report.probes.B9_space_args = {
      inputArgs: [spaceArg, "second arg with spaces"],
      capturedArgv,
    };

    // B-4 extra: Real bg_cli visible GUI window kill guard
    const cliProbeQueue = new DshJobQueue({ workspaceRoot: tmpRoot, settings: { hoverActiveThresholdMs: 0 } });
    const cliProbeTools = toolMap(createTools(cliProbeQueue));
    const guiCliRes = await cliProbeTools.get("bg_cli").execute({
      taskId: "probe_cli_visible_gui",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text='DSHProbeVisible'; $f.Show(); [System.Windows.Forms.Application]::Run($f)",
      ],
      backgroundOnly: true,
      timeoutMs: 8000,
    });
    console.log("[B-4 cli_visible_guard]", JSON.stringify({
      status: guiCliRes.status,
      conflict: guiCliRes.conflict,
      conflictReason: guiCliRes.conflictReason,
    }));
    assert.equal(guiCliRes.status, "human_intervened");
    assert.equal(guiCliRes.conflict, true);
    report.probes.B4_cli_visible_gui_guard = {
      status: guiCliRes.status,
      conflict: guiCliRes.conflict,
      conflictReason: guiCliRes.conflictReason,
    };

    // B-5: Real process suspend + releaseAllOnShutdown -> no process left suspended
    await cliProbeTools.get("bg_cli").execute({
      taskId: "probe_stop_unsuspend",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 500)"],
      backgroundOnly: true,
      async: true,
    });
    let spawnedPid = null;
    const waitSpawnDeadline = Date.now() + 3000;
    while (Date.now() < waitSpawnDeadline) {
      const cur = cliProbeQueue.inspect("probe_stop_unsuspend");
      if (cur?.ownedPid) {
        spawnedPid = cur.ownedPid;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(spawnedPid > 0, `Expected ownedPid to spawn, status=${cliProbeQueue.inspect("probe_stop_unsuspend")?.status}, conflict=${cliProbeQueue.inspect("probe_stop_unsuspend")?.conflictReason}`);
    await cliProbeTools.get("bg_job_control").execute({ action: "pause", taskId: "probe_stop_unsuspend" });
    const pausedInfo = cliProbeQueue.inspect("probe_stop_unsuspend");
    assert.equal(pausedInfo.status, "paused");
    const ownedPid = pausedInfo.ownedPid;
    await cliProbeQueue.releaseAllOnShutdown("probe_shutdown");
    const afterInfo = await win32.getProcessInfo(ownedPid);
    console.log("[B-5 stop_unsuspend]", JSON.stringify({ ownedPid, existsAfterStop: afterInfo.exists }));
    assert.equal(afterInfo.exists, false);
    report.probes.B5_stop_unsuspend = {
      ownedPid,
      pausedBeforeStop: true,
      existsAfterStop: afterInfo.exists,
    };

    // B-6: Verify artifact bytes & sha256 match final disk files
    const resultPath = path.join(tmpRoot, "result_probe_charmap_hidden.json");
    const sidecarPath = path.join(tmpRoot, "result_probe_charmap_hidden.sha256");
    const resultJson = JSON.parse(await fsp.readFile(resultPath, "utf8"));
    const sidecarText = await fsp.readFile(sidecarPath, "utf8");
    const resultFileBuf = await fsp.readFile(resultPath);
    const resultFileSha = crypto.createHash("sha256").update(resultFileBuf).digest("hex");
    assert.ok(sidecarText.startsWith(resultFileSha));
    for (const art of resultJson.artifacts) {
      const buf = await fsp.readFile(path.join(tmpRoot, art.relativePath));
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      assert.equal(art.bytes, buf.length);
      assert.equal(art.sha256, sha);
    }
    report.probes.B6_artifact_hashes = {
      resultPath: "result_probe_charmap_hidden.json",
      resultSha256: resultFileSha,
      sidecarMatches: sidecarText.startsWith(resultFileSha),
      artifactCount: resultJson.artifacts.length,
    };

    // Save verification evidence in repo verification/probe-results.json
    const verDir = path.resolve(__dirname);
    await fsp.mkdir(verDir, { recursive: true });
    await fsp.writeFile(path.join(verDir, "probe-results.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

    console.log("\nALL REAL WINDOWS PROBES PASSED.");
  } finally {
    win32.shutdownResidentHelper();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  win32.shutdownResidentHelper();
  console.error("\nPROBE FAILED:", err);
  process.exit(1);
});
