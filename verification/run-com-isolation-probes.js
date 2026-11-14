import assert from "node:assert/strict";
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

async function runMockCase(tmpRoot, caseId, adapterSpec) {
  const idleProbe = async () => ({
    foreground: { hwnd: 99999, rootOwnerHwnd: 99999, pid: 99999, processName: "PI-Desktop", title: "PI-Desktop" },
    cursor: { hoverHwnd: 99999, hoverRootHwnd: 99999, hoverInfo: { pid: 99999, processName: "PI-Desktop" } },
    userIdleMs: 5000,
    instances: [],
  });

  let spyVisibleSet = false;
  let spyVisibleArg = undefined;
  let spyInvoked = false;
  let spyQuitCalled = false;

  const comAdapter = {
    getActiveObject: adapterSpec.getActiveObject,
    createNew: async (progId) => {
      const raw = await adapterSpec.createNew(progId);
      if (!raw) return null;
      return {
        ...raw,
        setVisible: async (v) => {
          spyVisibleSet = true;
          spyVisibleArg = v;
        },
        invoke: async () => {
          spyInvoked = true;
          return "16.0";
        },
        quit: async () => {
          spyQuitCalled = true;
        },
      };
    },
  };

  const queue = new DshJobQueue({
    workspaceRoot: path.join(tmpRoot, `ws-${caseId}`),
    probe: idleProbe,
  });
  const tools = toolMap(
    createTools(queue, {
      probe: idleProbe,
      comAllowlist: ["FakeExcel.Application"],
      comAdapter,
    })
  );

  const jobRes = await tools.get("bg_ipc").execute({
    taskId: `probe_com_${caseId}`,
    protocol: "com",
    progId: "FakeExcel.Application",
    method: "get:Version",
    backgroundOnly: true,
  });

  const payload = jobRes.status === "completed" ? jobRes.result.response : jobRes.result;
  return {
    status: jobRes.status,
    activeCheck: payload.activeCheck,
    activeHwnd: payload.activeHwnd,
    activePid: payload.activePid,
    newHwnd: payload.newHwnd,
    newPid: payload.newPid,
    createdNew: payload.createdNew,
    visibleSet: payload.visibleSet,
    invoked: payload.invoked,
    quitCalled: payload.quitCalled,
    spyVisibleSet,
    spyVisibleArg,
    spyInvoked,
    spyQuitCalled,
  };
}

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-r4-com-probe-"));
  const report = {
    executedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    probes: {
      cases_A_to_G: {},
    },
  };

  try {
    await win32.prewarmResidentHelper();

    // A. getActiveObject throws generic error; createNew returns Hwnd=1234/Pid=5678 -> unsupported_unverified_com
    const resA = await runMockCase(tmpRoot, "A_generic_error", {
      getActiveObject: async () => {
        throw new Error("RPC_E_CALL_REJECTED: generic COM query failure");
      },
      createNew: async () => ({ getHwnd: () => 1234, getPid: () => 5678 }),
    });
    assert.equal(resA.status, "unsupported_unverified_com");
    assert.equal(resA.activeCheck, "uncertain");
    assert.equal(resA.createdNew, false);
    assert.equal(resA.visibleSet, false);
    assert.equal(resA.invoked, false);
    assert.equal(resA.quitCalled, false);
    assert.equal(resA.spyVisibleSet || resA.spyInvoked || resA.spyQuitCalled, false);
    report.probes.cases_A_to_G.A_generic_error = resA;

    // B. getActiveObject throws MK_E_UNAVAILABLE (0x800401E3); createNew returns Hwnd=1234/Pid=5678 -> completed
    const resB = await runMockCase(tmpRoot, "B_mk_e_unavailable_new", {
      getActiveObject: async () => {
        const err = new Error("Operation unavailable (Exception from HRESULT: 0x800401E3 (MK_E_UNAVAILABLE))");
        err.hresult = -2147221021;
        throw err;
      },
      createNew: async () => ({ getHwnd: () => 1234, getPid: () => 5678 }),
    });
    assert.equal(resB.status, "completed");
    assert.equal(resB.activeCheck, "none");
    assert.equal(resB.createdNew, true);
    assert.equal(resB.visibleSet, true);
    assert.equal(resB.spyVisibleArg, false);
    assert.equal(resB.invoked, true);
    assert.equal(resB.quitCalled, true);
    report.probes.cases_A_to_G.B_mk_e_unavailable_new = resB;

    // C. activeFound=true, activeHwnd=0, activePid=0; createNew returns Hwnd=1234/Pid=5678 -> unsupported_unverified_com
    const resC = await runMockCase(tmpRoot, "C_active_incomplete_id", {
      getActiveObject: async () => ({ exists: true, hwnd: 0, pid: 0 }),
      createNew: async () => ({ getHwnd: () => 1234, getPid: () => 5678 }),
    });
    assert.equal(resC.status, "unsupported_unverified_com");
    assert.equal(resC.activeCheck, "found");
    assert.equal(resC.createdNew, false);
    assert.equal(resC.visibleSet, false);
    assert.equal(resC.invoked, false);
    assert.equal(resC.quitCalled, false);
    assert.equal(resC.spyVisibleSet || resC.spyInvoked || resC.spyQuitCalled, false);
    report.probes.cases_A_to_G.C_active_incomplete_id = resC;

    // D. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=2002/Pid=0 -> unsupported_unverified_com
    const resD = await runMockCase(tmpRoot, "D_new_missing_pid", {
      getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
      createNew: async () => ({ getHwnd: () => 2002, getPid: () => 0 }),
    });
    assert.equal(resD.status, "unsupported_unverified_com");
    assert.equal(resD.activeCheck, "found");
    assert.equal(resD.createdNew, false);
    assert.equal(resD.visibleSet, false);
    assert.equal(resD.invoked, false);
    assert.equal(resD.quitCalled, false);
    assert.equal(resD.spyVisibleSet || resD.spyInvoked || resD.spyQuitCalled, false);
    report.probes.cases_A_to_G.D_new_missing_pid = resD;

    // E. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=2002/Pid=4001 -> unsupported_existing_instance
    const resE = await runMockCase(tmpRoot, "E_same_pid_diff_hwnd", {
      getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
      createNew: async () => ({ getHwnd: () => 2002, getPid: () => 4001 }),
    });
    assert.equal(resE.status, "unsupported_existing_instance");
    assert.equal(resE.activeCheck, "found");
    assert.equal(resE.createdNew, false);
    assert.equal(resE.visibleSet, false);
    assert.equal(resE.invoked, false);
    assert.equal(resE.quitCalled, false);
    assert.equal(resE.spyVisibleSet || resE.spyInvoked || resE.spyQuitCalled, false);
    report.probes.cases_A_to_G.E_same_pid_diff_hwnd = resE;

    // F. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=2002/Pid=5002 -> completed
    const resF = await runMockCase(tmpRoot, "F_verified_new_isolated", {
      getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
      createNew: async () => ({ getHwnd: () => 2002, getPid: () => 5002 }),
    });
    assert.equal(resF.status, "completed");
    assert.equal(resF.activeCheck, "found");
    assert.equal(resF.createdNew, true);
    assert.equal(resF.visibleSet, true);
    assert.equal(resF.spyVisibleArg, false);
    assert.equal(resF.invoked, true);
    assert.equal(resF.quitCalled, true);
    report.probes.cases_A_to_G.F_verified_new_isolated = resF;

    // G. activeFound=true, activeHwnd=1001, activePid=4001; createNew returns Hwnd=1001/Pid=5002 -> unsupported_existing_instance
    const resG = await runMockCase(tmpRoot, "G_same_hwnd_diff_pid", {
      getActiveObject: async () => ({ exists: true, hwnd: 1001, pid: 4001 }),
      createNew: async () => ({ getHwnd: () => 1001, getPid: () => 5002 }),
    });
    assert.equal(resG.status, "unsupported_existing_instance");
    assert.equal(resG.activeCheck, "found");
    assert.equal(resG.createdNew, false);
    assert.equal(resG.visibleSet, false);
    assert.equal(resG.invoked, false);
    assert.equal(resG.quitCalled, false);
    assert.equal(resG.spyVisibleSet || resG.spyInvoked || resG.spyQuitCalled, false);
    report.probes.cases_A_to_G.G_same_hwnd_diff_pid = resG;

    console.log("[ComProbe cases_A_to_G] PASSED (A..G)");

    // Real Scripting.Dictionary (inprocWindowless)
    const queueReal = new DshJobQueue({
      workspaceRoot: path.join(tmpRoot, "ws-real"),
      settings: { hoverActiveThresholdMs: 0 },
    });
    const toolsReal = toolMap(createTools(queueReal));
    const dictRes = await toolsReal.get("bg_ipc").execute({
      taskId: "probe_real_dict",
      protocol: "com",
      progId: "Scripting.Dictionary",
      method: "Add",
      args: ["k", "v"],
      backgroundOnly: true,
    });
    assert.equal(dictRes.status, "completed");
    assert.equal(dictRes.result?.response?.activeCheck, "none");
    assert.equal(dictRes.result?.response?.createdNew, true);
    assert.equal(dictRes.result?.response?.inprocWindowless, true);
    assert.equal(dictRes.result?.response?.visibleSet, false);
    assert.equal(dictRes.result?.response?.invoked, true);
    assert.equal(dictRes.result?.response?.quitCalled, false);
    report.probes.real_scripting_dictionary = dictRes.result?.response;
    console.log("[ComProbe real_scripting_dictionary] PASSED");

    // Real Excel/WPS availability & default allowlist refusal check (read-only, never activating user WPS/Excel)
    const verifyUiCom = {};
    for (const progId of ["Excel.Application", "Word.Application", "KET.Application", "KWPS.Application"]) {
      const v = await win32.verifyChannels({ comProgId: progId });
      verifyUiCom[progId] = Boolean(v?.channels?.com?.available);
    }
    const wpsBefore = await win32.querySystemState({ processName: "wps", maxInstances: 20 });
    const wpsPidsBefore = (wpsBefore.processes || []).map((p) => p.pid).sort((a, b) => a - b);
    const wpsWinsBefore = (wpsBefore.instances || []).map((w) => ({ hwnd: w.hwnd, pid: w.pid, visible: w.visible, title: w.title }));

    const excelDenyRes = await toolsReal.get("bg_ipc").execute({
      taskId: "probe_default_deny_excel",
      protocol: "com",
      progId: "Excel.Application",
      method: "get:Version",
      backgroundOnly: true,
    });
    const kwpsDenyRes = await toolsReal.get("bg_ipc").execute({
      taskId: "probe_default_deny_kwps",
      protocol: "com",
      progId: "KWPS.Application",
      method: "get:Version",
      backgroundOnly: true,
    });
    const defaultExcelRefused = excelDenyRes.status === "failed" && /allowlist/i.test(excelDenyRes.error || "");
    const defaultKwpsRefused = kwpsDenyRes.status === "failed" && /allowlist/i.test(kwpsDenyRes.error || "");
    assert.equal(defaultExcelRefused, true);
    assert.equal(defaultKwpsRefused, true);

    const wpsAfter = await win32.querySystemState({ processName: "wps", maxInstances: 20 });
    const wpsPidsAfter = (wpsAfter.processes || []).map((p) => p.pid).sort((a, b) => a - b);
    const wpsWinsAfter = (wpsAfter.instances || []).map((w) => ({ hwnd: w.hwnd, pid: w.pid, visible: w.visible, title: w.title }));
    assert.deepEqual(wpsPidsAfter, wpsPidsBefore);
    assert.deepEqual(wpsWinsAfter, wpsWinsBefore);

    report.probes.real_excel_wps = {
      status: "not_run_no_excel_wps_readonly_allowlist_verified",
      checkedProgIds: verifyUiCom,
      defaultExcelRefused,
      defaultKwpsRefused,
      wpsPidsCount: wpsPidsBefore.length,
      windowsUnchanged: true,
      note: "Microsoft Excel is not installed (Excel.Application resolves to WPS et.exe /Automation); live WPS processes are active so UI COM activation was not executed to avoid mutating user environment. Default comAllowlist=['Scripting.Dictionary'] refuses Excel.Application and KWPS.Application.",
    };
    console.log("[ComProbe real_excel_wps] not_run_no_excel_wps_readonly_allowlist_verified");

    await fsp.writeFile(
      path.join(__dirname, "com-isolation-probe-results.json"),
      JSON.stringify(report, null, 2) + "\n",
      "utf8"
    );
    console.log("\nCOM ISOLATION PROBES PASSED.");
  } finally {
    win32.shutdownResidentHelper();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  win32.shutdownResidentHelper();
  console.error("\nCOM ISOLATION PROBE FAILED:", err);
  process.exit(1);
});
