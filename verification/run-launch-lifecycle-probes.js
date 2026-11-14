import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
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
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-r3-lifecycle-probe-"));
  const report = {
    executedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    probes: {},
  };

  // Spawn an independent "user-owned" process (headless node timer) to verify plugin NEVER kills non-owned PIDs
  const userProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  const externalUserPid = userProc.pid;

  try {
    await win32.prewarmResidentHelper();

    // 1. bg_launch(powershell Start-Process charmap.exe) -> completed -> bg_job_control(action="close")
    const queueA = new DshJobQueue({
      workspaceRoot: path.join(tmpRoot, "ws-a"),
      settings: { hoverActiveThresholdMs: 0, closeCompletedLaunchOnShutdown: false },
    });
    const toolsA = toolMap(createTools(queueA));

    const launched1 = await toolsA.get("bg_launch").execute({
      taskId: "probe_launch_close_01",
      executable: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process charmap.exe; Start-Sleep -Milliseconds 300"],
      windowMode: "hidden",
      waitForHwndMs: 4500,
    });
    assert.equal(launched1.status, "completed");
    assert.ok(launched1.ownedPid > 0);
    const childPid1 = launched1.ownedPid;
    const beforeClose = await win32.getProcessInfo(childPid1);
    assert.equal(beforeClose.exists, true, "Child charmap must exist before close");

    const closed1 = await toolsA.get("bg_job_control").execute({
      action: "close",
      taskId: "probe_launch_close_01",
      reason: "probe explicit close",
    });
    assert.equal(closed1.status, "closed");
    await new Promise((r) => setTimeout(r, 250));
    const afterClose = await win32.getProcessInfo(childPid1);
    assert.equal(afterClose.exists, false, "Child charmap must NOT exist after bg_job_control.close");

    report.probes.explicit_close_after_completed = {
      initialStatus: launched1.status,
      ownedPid: childPid1,
      ownedPids: launched1.ownedPids,
      childExistsBeforeClose: beforeClose.exists,
      statusAfterClose: closed1.status,
      childExistsAfterClose: afterClose.exists,
    };
    console.log("[LifecycleProbe explicit_close] PASSED pid=", childPid1);

    // 2. releaseAllOnShutdown with closeCompletedLaunchOnShutdown=false (default) preserves completed launch,
    //    and external user PID is untouched; then explicit close cleans up.
    const launched2 = await toolsA.get("bg_launch").execute({
      taskId: "probe_shutdown_preserve_02",
      executable: "charmap.exe",
      windowMode: "hidden",
      waitForHwndMs: 3000,
    });
    assert.equal(launched2.status, "completed");
    const childPid2 = launched2.ownedPid;
    try {
      await queueA.releaseAllOnShutdown("probe_shutdown_default_false");
      const afterShutdownFalse = await win32.getProcessInfo(childPid2);
      assert.equal(afterShutdownFalse.exists, true, "Default closeCompletedLaunchOnShutdown=false should preserve completed launch");
      assert.equal((await win32.getProcessInfo(externalUserPid)).exists, true, "External user PID must remain untouched");

      const closed2 = await toolsA.get("bg_job_control").execute({
        action: "close",
        taskId: "probe_shutdown_preserve_02",
      });
      assert.equal(closed2.status, "closed");
      await new Promise((r) => setTimeout(r, 200));
      const afterExplicitClose2 = await win32.getProcessInfo(childPid2);
      assert.equal(afterExplicitClose2.exists, false);

      report.probes.shutdown_default_false = {
        ownedPid: childPid2,
        existsAfterShutdownFalse: afterShutdownFalse.exists,
        existsAfterExplicitClose: afterExplicitClose2.exists,
        externalUserPidUntouched: (await win32.getProcessInfo(externalUserPid)).exists,
      };
      console.log("[LifecycleProbe shutdown_default_false] PASSED pid=", childPid2);
    } finally {
      await win32.terminateProcessTree(childPid2);
    }

    // 3. releaseAllOnShutdown with closeCompletedLaunchOnShutdown=true closes completed launch automatically
    const queueB = new DshJobQueue({
      workspaceRoot: path.join(tmpRoot, "ws-b"),
      settings: { hoverActiveThresholdMs: 0, closeCompletedLaunchOnShutdown: true },
    });
    const toolsB = toolMap(createTools(queueB));
    const launched3 = await toolsB.get("bg_launch").execute({
      taskId: "probe_shutdown_close_03",
      executable: "charmap.exe",
      windowMode: "hidden",
      waitForHwndMs: 3000,
    });
    assert.equal(launched3.status, "completed");
    const childPid3 = launched3.ownedPid;
    try {
      await queueB.releaseAllOnShutdown("probe_shutdown_true");
      await new Promise((r) => setTimeout(r, 250));
      const rec3 = queueB.inspect("probe_shutdown_close_03");
      const afterShutdownTrue = await win32.getProcessInfo(childPid3);
      assert.equal(rec3.status, "closed");
      assert.equal(afterShutdownTrue.exists, false, "closeCompletedLaunchOnShutdown=true must close completed launch on shutdown");
      assert.equal((await win32.getProcessInfo(externalUserPid)).exists, true, "External user PID must remain untouched");

      report.probes.shutdown_setting_true = {
        ownedPid: childPid3,
        statusAfterShutdownTrue: rec3.status,
        existsAfterShutdownTrue: afterShutdownTrue.exists,
        externalUserPidUntouched: (await win32.getProcessInfo(externalUserPid)).exists,
      };
      console.log("[LifecycleProbe shutdown_setting_true] PASSED pid=", childPid3);
    } finally {
      await win32.terminateProcessTree(childPid3);
    }

    await fsp.writeFile(
      path.join(__dirname, "launch-lifecycle-probe-results.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8"
    );
    console.log("\nLAUNCH LIFECYCLE PROBES PASSED.");
  } finally {
    await win32.terminateProcessTree(externalUserPid);
    win32.shutdownResidentHelper();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  win32.shutdownResidentHelper();
  console.error("\nLAUNCH LIFECYCLE PROBE FAILED:", err);
  process.exit(1);
});
