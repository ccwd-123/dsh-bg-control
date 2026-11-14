import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_DIR = path.resolve(__dirname, "..");
const OLD_PI_PLUGIN_DIR = process.env.OLD_PI_PLUGIN_DIR || "";
const DSH_CLI = process.env.DSH_CLI || "";
const DSH_ANCHOR = process.env.DSH_ANCHOR || "";
const DESKTOP_PROFILE_DIR = process.env.DSH_DESKTOP_PROFILE || path.join(os.homedir(), ".dsh", "profiles", "desktop");

function snapshotDirState(dirPath) {
  if (!fs.existsSync(dirPath)) return { exists: false };
  const files = {};
  for (const name of ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"]) {
    const full = path.join(dirPath, name);
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      const buf = fs.readFileSync(full);
      files[name] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      };
    }
  }
  return { exists: true, files };
}

function runDshCli(args, dshHome, cwd = PLUGIN_DIR) {
  const res = spawnSync(process.execPath, [DSH_CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  return {
    command: `node "${DSH_CLI}" ${args.join(" ")}`,
    exitCode: res.status ?? -1,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

async function bootDshProfileAndInspect(dshHome, profileName, executeTools = false) {
  process.env.DSH_HOME = dshHome;
  const dshRequire = createRequire(DSH_ANCHOR);
  const appBootUrl = pathToFileURL(dshRequire.resolve("@deepseek-ai/dsh-app-boot")).href;
  const profileBootUrl = pathToFileURL(
    path.join(path.dirname(DSH_CLI), "profile-boot.js")
  ).href;

  const { loadLayeredEnv } = await import(appBootUrl);
  const { runProfile } = await import(profileBootUrl);

  const booted = await runProfile({
    environment: loadLayeredEnv("dsh"),
    profile: profileName,
    patchFiles: [],
    args: [],
  });

  try {
    const { ctx } = booted;
    const entries = [...ctx.loader.entries()].map((entry) => ({
      id: entry.id,
      name: entry.options.name,
      disabled: Boolean(entry.disabled),
      fiberState: entry.fiber?.state ?? null,
    }));
    const ourEntry = entries.find((e) => e.name === "dsh-bg-control");
    const failedEntries = entries.filter((e) => !e.disabled && e.fiberState !== 2);

    const toolsSvc = ctx.get("tools");
    const visibleToolDefs = toolsSvc ? toolsSvc.definitions() : [];
    const allToolNames = visibleToolDefs.map((d) => d.name).sort();
    const bgToolNames = allToolNames.filter((n) => n.startsWith("bg_"));

    const toolCallResults = {};
    if (executeTools && toolsSvc) {
      const wsTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-e2e-ws-"));
      try {
        // 1. bg_query_state
        const qDef = toolsSvc.executable("bg_query_state");
        const qRes = await qDef.execute({ taskId: "dsh_e2e_query" }, {});
        toolCallResults.bg_query_state = {
          status: qRes.status,
          userIdleMs: qRes.userIdleMs,
          foregroundProcess: qRes.foreground?.processName || null,
        };

        // 2. bg_verify
        const vDef = toolsSvc.executable("bg_verify");
        const vRes = await vDef.execute(
          { taskId: "dsh_e2e_verify", program: "node", comProgId: "Scripting.Dictionary" },
          {}
        );
        toolCallResults.bg_verify = {
          status: vRes.status,
          cliAvailable: vRes.channels?.cli?.available,
          comAvailable: vRes.channels?.com?.available,
          recommendedOrder: vRes.recommendedOrder,
        };

        // 3. bg_job_control (list)
        const jcDef = toolsSvc.executable("bg_job_control");
        const listBefore = await jcDef.execute({ action: "list" }, {});
        toolCallResults.bg_job_control_list_initial = {
          status: listBefore.status,
          count: listBefore.count,
        };

        // 4. bg_launch (charmap.exe hidden) + bg_window_msg (WM_NULL) + bg_job_control (close)
        const launchDef = toolsSvc.executable("bg_launch");
        const launchRes = await launchDef.execute(
          {
            taskId: "dsh_e2e_charmap",
            executable: "charmap.exe",
            windowMode: "hidden",
            waitForHwndMs: 3000,
            hoverActiveThresholdMs: 0,
          },
          {}
        );
        assert.equal(launchRes.status, "completed");
        assert.ok(launchRes.ownedPid > 0 && launchRes.hwnd > 0);

        const msgDef = toolsSvc.executable("bg_window_msg");
        const msgRes = await msgDef.execute(
          {
            taskId: "dsh_e2e_wm_null",
            hwnd: launchRes.hwnd,
            pid: launchRes.ownedPid,
            msgName: "WM_NULL",
            hoverActiveThresholdMs: 0,
          },
          {}
        );
        assert.equal(msgRes.status, "completed");

        const closeRes = await jcDef.execute(
          {
            action: "close",
            taskId: "dsh_e2e_charmap",
            reason: "DSH E2E verification close",
          },
          {}
        );
        assert.equal(closeRes.status, "closed");

        toolCallResults.bg_launch_window_msg_and_close = {
          launchStatus: launchRes.status,
          ownedPid: launchRes.ownedPid,
          ownedPids: launchRes.ownedPids,
          hwnd: launchRes.hwnd,
          windowMsgStatus: msgRes.status,
          verifiedProcessName: msgRes.result?.verifiedProcessName,
          closeStatus: closeRes.status,
        };

        // 5. bg_cli
        const cliDef = toolsSvc.executable("bg_cli");
        const cliRes = await cliDef.execute(
          {
            taskId: "dsh_e2e_cli",
            command: process.execPath,
            args: ["-e", "console.log('dsh-cordis-cli-ok')"],
            backgroundOnly: true,
            hoverActiveThresholdMs: 0,
          },
          {}
        );
        assert.equal(cliRes.status, "completed");
        toolCallResults.bg_cli = {
          status: cliRes.status,
          exitCode: cliRes.result?.exitCode,
          stdoutPreview: (cliRes.result?.stdoutPreview || "").trim(),
        };

        // 6. bg_ipc (COM Scripting.Dictionary)
        const ipcDef = toolsSvc.executable("bg_ipc");
        const ipcRes = await ipcDef.execute(
          {
            taskId: "dsh_e2e_ipc_com",
            protocol: "com",
            progId: "Scripting.Dictionary",
            method: "Add",
            args: ["dshKey", "dshVal"],
            backgroundOnly: true,
            hoverActiveThresholdMs: 0,
          },
          {}
        );
        assert.equal(ipcRes.status, "completed");
        toolCallResults.bg_ipc = {
          status: ipcRes.status,
          createdNew: ipcRes.result?.response?.createdNew,
          inprocWindowless: ipcRes.result?.response?.inprocWindowless,
        };
      } finally {
        await fsp.rm(wsTmp, { recursive: true, force: true });
      }
    }

    return {
      fiberState: ctx.fiber.state,
      ourPluginEntry: ourEntry,
      failedEntries,
      totalRegisteredTools: allToolNames.length,
      bgToolNames,
      toolCallResults,
    };
  } finally {
    await booted.ctx.fiber.dispose();
  }
}

async function main() {
  const desktopBefore = snapshotDirState(DESKTOP_PROFILE_DIR);
  const dshHome1 = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-home-e2e-1-"));
  const dshHome2 = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-home-e2e-2-"));

  const report = {
    executedAt: new Date().toISOString(),
    dshCliPath: DSH_CLI,
    dshVersion: null,
    nodeVersion: process.version,
    steps: {},
  };

  try {
    const verRun = runDshCli(["--version"], dshHome1);
    report.dshVersion = verRun.stdout;
    assert.equal(verRun.exitCode, 0);
    if (OLD_PI_PLUGIN_DIR) {
      const step6ALockfileOnly = runDshCli(
        ["plugin", "--profile", "compat-old", "add", "--lockfile-only", OLD_PI_PLUGIN_DIR],
        dshHome1
      );
      const step6AFullAdd = runDshCli(
        ["plugin", "--profile", "compat-old-full", "add", OLD_PI_PLUGIN_DIR],
        dshHome1
      );
      assert.notEqual(step6ALockfileOnly.exitCode, 0, "Old PI plugin must fail in DSH plugin manager");
      assert.notEqual(step6AFullAdd.exitCode, 0, "Old PI plugin full add must also fail in DSH plugin manager");
      assert.match(
        step6ALockfileOnly.stderr + "\n" + step6ALockfileOnly.stdout,
        /cannot resolve profile bundle "dsh.bg-control"/i
      );
      report.steps.step6A_baseline_reproduction = {
        lockfileOnlyCommand: step6ALockfileOnly.command,
        lockfileOnlyExitCode: step6ALockfileOnly.exitCode,
        lockfileOnlyStderrSummary: step6ALockfileOnly.stderr.slice(0, 600),
        fullAddCommand: step6AFullAdd.command,
        fullAddExitCode: step6AFullAdd.exitCode,
        fullAddStderrSummary: step6AFullAdd.stderr.slice(0, 600),
        reproducedCannotResolveBundle: true,
      };
      console.log("[Step 6.A] Reproduced old plugin failure: cannot resolve profile bundle \"dsh.bg-control\"");
    } else {
      report.steps.step6A_baseline_reproduction = { skipped: true, reason: "OLD_PI_PLUGIN_DIR is not set" };
      console.log("[Step 6.A] Baseline reproduction skipped (OLD_PI_PLUGIN_DIR is not set).");
    }

    // === Step 6.B: Install & boot new DSH Cordis bundle in compat-test ===
    const step6BAdd = runDshCli(
      ["plugin", "--profile", "compat-test", "add", PLUGIN_DIR],
      dshHome1
    );
    assert.equal(step6BAdd.exitCode, 0, `dsh plugin add failed: ${step6BAdd.stderr}`);

    const step6BLockfileOnly = runDshCli(
      ["plugin", "--profile", "compat-test", "add", "--lockfile-only", PLUGIN_DIR],
      dshHome1
    );
    assert.equal(step6BLockfileOnly.exitCode, 0, `dsh plugin add --lockfile-only failed: ${step6BLockfileOnly.stderr}`);

    const profileDir = path.join(dshHome1, "profiles", "compat-test");
    const profilePkg = JSON.parse(await fsp.readFile(path.join(profileDir, "package.json"), "utf8"));
    assert.ok(profilePkg.dependencies?.["dsh-bg-control"], "dsh-bg-control missing from profile dependencies");
    assert.ok(
      Array.isArray(profilePkg.dsh?.profile?.bundles) &&
        profilePkg.dsh.profile.bundles.includes("dsh-bg-control"),
      "dsh-bg-control missing from dsh.profile.bundles"
    );

    const dumpRun = runDshCli(["--profile", "compat-test", "--dump-config"], dshHome1);
    assert.equal(dumpRun.exitCode, 0);
    assert.match(dumpRun.stdout, /id:\s*dsh-bg-control/);
    assert.match(dumpRun.stdout, /name:\s*dsh-bg-control/);

    // Also test a CLI subprocess boot using a temporary headless profile (headless-test)
    const initHeadlessRun = runDshCli(
      ["--profile", "headless-test", "--from-default-profile", "headless", "--dump-config"],
      dshHome1
    );
    assert.equal(initHeadlessRun.exitCode, 0);
    const addHeadlessPlugin = runDshCli(
      ["plugin", "--profile", "headless-test", "add", PLUGIN_DIR],
      dshHome1
    );
    assert.equal(addHeadlessPlugin.exitCode, 0);
    const bootHeadlessHelp = runDshCli(
      ["--profile", "headless-test", "--help"],
      dshHome1
    );
    assert.equal(bootHeadlessHelp.exitCode, 0, `headless-test boot --help failed: ${bootHeadlessHelp.stderr}`);

    // === Step 6.B & 6.C: Boot compat-test via runProfile and execute all 7 bg_* tools ===
    const bootAndTools = await bootDshProfileAndInspect(dshHome1, "compat-test", true);
    assert.equal(bootAndTools.ourPluginEntry?.fiberState, 2, "dsh-bg-control fiber must be active (state=2)");
    assert.equal(bootAndTools.failedEntries.length, 0, `Boot had failed entries: ${JSON.stringify(bootAndTools.failedEntries)}`);
    assert.deepEqual(bootAndTools.bgToolNames, [
      "bg_cli",
      "bg_ipc",
      "bg_job_control",
      "bg_launch",
      "bg_query_state",
      "bg_verify",
      "bg_window_msg",
    ]);

    report.steps.step6B_install_and_boot = {
      addCommand: step6BAdd.command,
      addExitCode: step6BAdd.exitCode,
      lockfileOnlyCommand: step6BLockfileOnly.command,
      lockfileOnlyExitCode: step6BLockfileOnly.exitCode,
      profilePackageJson: profilePkg,
      dumpConfigExitCode: dumpRun.exitCode,
      dumpConfigPluginSnippet: dumpRun.stdout
        .split(/\r?\n/)
        .filter((l) => l.includes("dsh-bg-control"))
        .join("\n"),
      headlessCliBootCommand: bootHeadlessHelp.command,
      headlessCliBootExitCode: bootHeadlessHelp.exitCode,
       headlessCliBootStdoutPreview: bootHeadlessHelp.stdout.slice(0, 300),
      inProcessBoot: {
        fiberState: bootAndTools.fiberState,
        ourPluginEntry: bootAndTools.ourPluginEntry,
        failedEntriesCount: bootAndTools.failedEntries.length,
      },
    };
    report.steps.step6C_live_tools = {
      bgToolNames: bootAndTools.bgToolNames,
      totalRegisteredToolsInProfile: bootAndTools.totalRegisteredTools,
      toolCallResults: bootAndTools.toolCallResults,
      llmTurnNote: "Model-driven LLM chat turn was not executed (no API key configured in isolated DSH_HOME); all 7 tools were invoked directly through the booted DSH ToolRegistry (ctx.get('tools').executable(name).execute).",
    };
    console.log("[Step 6.B & 6.C] Profile compat-test booted with 0 load errors; all 7 bg_* tools verified live.");

    // === Step 6.E: npm pack -> dist/dsh-bg-control-0.2.0.tgz & clean DSH_HOME #2 install ===
    const distDir = path.join(PLUGIN_DIR, "dist");
    await fsp.mkdir(distDir, { recursive: true });
    const packRes = spawnSync(
      "cmd.exe",
      ["/d", "/s", "/c", "npm pack --pack-destination dist"],
      {
        cwd: PLUGIN_DIR,
        encoding: "utf8",
        windowsHide: true,
      }
    );
    assert.equal(packRes.status, 0, `npm pack failed: ${packRes.stderr || packRes.error?.message}`);
    const tgzPath = path.join(distDir, "dsh-bg-control-0.2.0.tgz");
    assert.equal(fs.existsSync(tgzPath), true, "Expected dist/dsh-bg-control-0.2.0.tgz to exist");

    // Inspect tarball contents with tar -ztvf
    const tarListRes = spawnSync("tar.exe", ["-ztvf", tgzPath], {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(tarListRes.status, 0);
    const tarLines = (tarListRes.stdout || "").split(/\r?\n/).filter(Boolean);
    const forbiddenMatches = tarLines.filter(
      (line) =>
        /package\/(node_modules|\.git|\.env|dist)\b/i.test(line) ||
        /^l/.test(line.trim())
    );
    assert.equal(forbiddenMatches.length, 0, `Found forbidden entries in tgz: ${forbiddenMatches.join(", ")}`);

    // Install from .tgz in clean isolated DSH_HOME #2
    const tgzAddRun = runDshCli(
      ["plugin", "--profile", "compat-tgz", "add", tgzPath],
      dshHome2
    );
    assert.equal(tgzAddRun.exitCode, 0, `tgz install failed: ${tgzAddRun.stderr}`);

    const tgzDumpRun = runDshCli(["--profile", "compat-tgz", "--dump-config"], dshHome2);
    assert.equal(tgzDumpRun.exitCode, 0);
    assert.match(tgzDumpRun.stdout, /name:\s*dsh-bg-control/);

    const tgzBoot = await bootDshProfileAndInspect(dshHome2, "compat-tgz", false);
    assert.equal(tgzBoot.ourPluginEntry?.fiberState, 2);
    assert.equal(tgzBoot.failedEntries.length, 0);
    assert.equal(tgzBoot.bgToolNames.length, 7);

    report.steps.step6E_tgz_package_and_install = {
      tgzPath,
      tgzBytes: fs.statSync(tgzPath).size,
      tarEntryCount: tarLines.length,
      forbiddenEntriesCount: forbiddenMatches.length,
      tgzInstallCommand: tgzAddRun.command,
      tgzInstallExitCode: tgzAddRun.exitCode,
      tgzDumpConfigExitCode: tgzDumpRun.exitCode,
      tgzBootOurPluginEntry: tgzBoot.ourPluginEntry,
      tgzBootFailedEntriesCount: tgzBoot.failedEntries.length,
      tgzBgToolNames: tgzBoot.bgToolNames,
    };
    console.log("[Step 6.E] .tgz package created and verified in clean isolated DSH_HOME #2.");

    const desktopAfter = snapshotDirState(DESKTOP_PROFILE_DIR);
    assert.deepEqual(desktopAfter, desktopBefore, "User desktop profile must NEVER be modified!");
    report.steps.desktop_profile_untouched = {
      desktopProfileDir: DESKTOP_PROFILE_DIR,
      unchanged: true,
      snapshot: desktopAfter,
    };

    const outJsonPath = path.join(__dirname, "dsh-host-e2e-results.json");
    await fsp.writeFile(outJsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log("\nALL DSH 0.2.2-rc.1 HOST E2E VERIFICATIONS PASSED.");
  } finally {
    const { win32 } = await import("../lib/index.js");
    win32.shutdownResidentHelper();
    await fsp.rm(dshHome1, { recursive: true, force: true });
    await fsp.rm(dshHome2, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\nDSH HOST E2E VERIFICATION FAILED:", err);
  process.exit(1);
});
