import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DshJobQueue } from "../lib/job-queue.js";
import { createTools } from "../lib/tools.js";
import win32 from "../lib/win32-bridge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function toolMap(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.name, t);
  return m;
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-browser-probe-"));
  const report = {
    executedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    probes: {},
  };

  try {
    await win32.prewarmResidentHelper();

    let postCallCount = 0;
    const spiedPost = async (params, opts) => {
      postCallCount++;
      return win32.postDirectedWindowMessage(params, opts);
    };

    const queue = new DshJobQueue({
      workspaceRoot: tmpRoot,
      settings: { hoverActiveThresholdMs: 0 },
    });
    const tools = toolMap(createTools(queue, { postDirectedWindowMessage: spiedPost }));

    const allState = await win32.querySystemState({ maxInstances: 40 });
    for (const proc of ["msedge", "msedgewebview2"]) {
      const q = await win32.querySystemState({ processName: proc, maxInstances: 15 });
      const candidates = (q.instances || []).filter(
        (inst) =>
          Number(inst.hwnd) > 0 &&
          Number(inst.pid) > 0 &&
          String(inst.processName || "").toLowerCase() === proc &&
          !inst.isForeground &&
          inst.rootOwnerHwnd !== allState.foreground?.rootOwnerHwnd
      );
      if (candidates.length > 0) {
        const target = candidates[0];
        const beforePosts = postCallCount;

        const forgedRes = await tools.get("bg_window_msg").execute({
          taskId: `probe_real_${proc}_forged`,
          hwnd: target.hwnd,
          pid: target.pid,
          processName: "notepad.exe",
          msgName: "WM_NULL",
        });
        assert.equal(forgedRes.status, "unsupported");
        assert.equal(forgedRes.conflict, false);
        assert.equal(forgedRes.result?.verifiedProcessName?.toLowerCase(), proc);
        assert.equal(forgedRes.result?.processNameMismatch, true);

        const omittedRes = await tools.get("bg_window_msg").execute({
          taskId: `probe_real_${proc}_omitted`,
          hwnd: target.hwnd,
          pid: target.pid,
          msgName: "WM_NULL",
        });
        assert.equal(omittedRes.status, "unsupported");
        assert.equal(omittedRes.conflict, false);
        assert.equal(omittedRes.result?.verifiedProcessName?.toLowerCase(), proc);

        const wv2LabelRes = await tools.get("bg_window_msg").execute({
          taskId: `probe_real_${proc}_wv2_label`,
          hwnd: target.hwnd,
          pid: target.pid,
          processName: "msedgewebview2",
          msgName: "WM_NULL",
        });
        assert.equal(wv2LabelRes.status, "unsupported");
        assert.equal(postCallCount, beforePosts, `postFn must NEVER be called for ${proc} window`);

        report.probes[`real_${proc}_window`] = {
          found: true,
          targetProcessName: target.processName,
          targetPid: target.pid,
          targetHwnd: target.hwnd,
          title: target.title,
          forgedNotepadStatus: forgedRes.status,
          omittedProcStatus: omittedRes.status,
          webview2LabelStatus: wv2LabelRes.status,
          postCallCountDuringBrowserTests: postCallCount - beforePosts,
        };
        console.log(`[BrowserProbe real_${proc}_window] PASSED hwnd=${target.hwnd} pid=${target.pid} postCalls=0`);
      } else {
        report.probes[`real_${proc}_window`] = {
          found: false,
          note: `No non-foreground ${proc} window found on host during probe.`,
        };
      }
    }

    const charmapRes = await tools.get("bg_launch").execute({
      taskId: "probe_charmap_nonbrowser",
      executable: "charmap.exe",
      windowMode: "hidden",
      waitForHwndMs: 3000,
    });
    assert.equal(charmapRes.status, "completed");
    assert.ok(Number(charmapRes.hwnd) > 0 && Number(charmapRes.ownedPid) > 0);
    try {
      const beforePosts = postCallCount;
      const msgRes = await tools.get("bg_window_msg").execute({
        taskId: "probe_charmap_forged_label",
        hwnd: charmapRes.hwnd,
        pid: charmapRes.ownedPid,
        processName: "notepad.exe",
        msgName: "WM_NULL",
      });
      assert.equal(msgRes.status, "completed");
      assert.equal(postCallCount, beforePosts + 1);
      assert.match(String(msgRes.result?.verifiedProcessName || ""), /charmap/i);
      assert.equal(msgRes.result?.processNameMismatch, true);

      let pidMismatchErr = null;
      try {
        await tools.get("bg_window_msg").execute({
          taskId: "probe_pid_mismatch",
          hwnd: charmapRes.hwnd,
          pid: charmapRes.ownedPid + 99999,
          msgName: "WM_NULL",
        });
      } catch (e) {
        pidMismatchErr = e.message;
      }
      assert.ok(pidMismatchErr && /PID mismatch/i.test(pidMismatchErr));

      report.probes.real_nonbrowser_charmap = {
        status: msgRes.status,
        verifiedPid: msgRes.verifiedPid,
        verifiedProcessName: msgRes.result?.verifiedProcessName,
        processNameMismatch: msgRes.result?.processNameMismatch,
        pidMismatchRejected: pidMismatchErr,
      };
      console.log("[BrowserProbe real_nonbrowser_charmap] PASSED verifiedProcessName=", msgRes.result?.verifiedProcessName);
    } finally {
      for (const p of charmapRes.ownedPids || [charmapRes.ownedPid]) {
        if (p) await win32.terminateProcessTree(p);
      }
    }

    await fsp.writeFile(
      path.join(__dirname, "browser-boundary-probe-results.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8"
    );
    console.log("\nBROWSER BOUNDARY PROBES PASSED.");
  } finally {
    win32.shutdownResidentHelper();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  win32.shutdownResidentHelper();
  console.error("\nBROWSER BOUNDARY PROBE FAILED:", err);
  process.exit(1);
});
