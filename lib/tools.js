import path from "node:path";
import { defineTool } from "./dsh-host.js";
import win32 from "./win32-bridge.js";
import { enforceFocusGuard } from "./focus-guard.js";
import { sanitizeOutputName } from "./artifacts.js";

const WIN32_MSG_MAP = {
  WM_NULL: 0x0000,
  WM_CLOSE: 0x0010,
  WM_KEYDOWN: 0x0100,
  WM_KEYUP: 0x0101,
  WM_CHAR: 0x0102,
  WM_COMMAND: 0x0111,
  WM_SYSCOMMAND: 0x0112,
  WM_USER: 0x0400,
  WM_APP: 0x8000,
};

function resolveWin32MsgId(msg, msgName) {
  if (Number.isFinite(Number(msg)) && Number(msg) >= 0) return Number(msg);
  if (typeof msgName === "string" && msgName.trim()) {
    const key = msgName.trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(WIN32_MSG_MAP, key)) {
      return WIN32_MSG_MAP[key];
    }
    const userMatch = /^WM_USER\s*\+\s*(\d+)$/i.exec(key);
    if (userMatch) return WIN32_MSG_MAP.WM_USER + Number(userMatch[1]);
    const appMatch = /^WM_APP\s*\+\s*(\d+)$/i.exec(key);
    if (appMatch) return WIN32_MSG_MAP.WM_APP + Number(appMatch[1]);
  }
  return NaN;
}

function inferProcessFromProgId(progId) {
  const s = String(progId || "").trim().toLowerCase();
  if (s.startsWith("excel.")) return "excel";
  if (s.startsWith("word.")) return "winword";
  if (s.startsWith("powerpoint.")) return "powerpnt";
  if (s.startsWith("ket.")) return "et";
  if (s.startsWith("kwps.") || s.startsWith("wps.")) return "wps";
  return "";
}

const BROWSER_PROCESS_NAMES = win32.BROWSER_HOST_BLOCKLIST || new Set([
  "msedge",
  "msedgewebview2",
  "chrome",
  "chrome_proxy",
  "chromium",
  "firefox",
  "brave",
  "opera",
  "vivaldi",
  "iexplore",
  "browser",
  "360se",
  "360chrome",
  "qqbrowser",
  "sogouexplorer",
  "ucbrowser",
  "arc",
  "waterfox",
  "librewolf",
  "tor",
  "electron",
  "deepseek harness",
  "deepseek-harness",
  "dsh",
  "pi-desktop",
]);

function normalizeExecutableName(name) {
  return String(name || "")
    .trim()
    .replace(/^.*[/\\]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function isBrowserProcessName(name) {
  const norm = normalizeExecutableName(name);
  return Boolean(norm && BROWSER_PROCESS_NAMES.has(norm));
}

function isLocalHttpUrl(urlObj) {
  const host = String(urlObj?.hostname || "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function toLosslessJson(val) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return null;
    return Object.is(val, -0) ? 0 : val;
  }
  if (typeof val === "string" || typeof val === "boolean") return val;
  if (Array.isArray(val)) {
    return val.map((item) => {
      const c = toLosslessJson(item);
      return c === undefined ? null : c;
    });
  }
  if (typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      const c = toLosslessJson(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return String(val);
}

const BG_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    taskId: { type: "string" },
    status: { type: "string" },
    conflict: { type: "boolean" },
    conflictReason: { type: "string" },
    nextAction: { type: "string" },
  },
};

function safeGetService(ctx, key) {
  if (!ctx) return undefined;
  if (typeof ctx.get === "function") {
    try {
      const val = ctx.get(key);
      if (val !== undefined) return val;
    } catch {}
  }
  try {
    return ctx[key];
  } catch {
    return undefined;
  }
}

function isPlanModeActive(dshCtx, exec) {
  const planSvc = safeGetService(exec, "planMode") ?? safeGetService(dshCtx, "planMode");
  if (!planSvc) return false;
  const session = exec?.agent?.session;
  if (session) {
    try {
      if (typeof planSvc.selectedActive === "function") return Boolean(planSvc.selectedActive(session));
      if (typeof planSvc.loggedActive === "function") return Boolean(planSvc.loggedActive(session));
    } catch {}
  }
  if (typeof planSvc.active === "boolean") return planSvc.active;
  return false;
}

function isPlanSafeCall(toolName, args) {
  if (toolName === "bg_query_state" || toolName === "bg_verify") return true;
  if (toolName === "bg_job_control") {
    const action = String(args?.action || "").trim().toLowerCase();
    return action === "list" || action === "inspect";
  }
  return false;
}

function assertPlanModeAllowed(dshCtx, exec, toolName, args) {
  if (!isPlanModeActive(dshCtx, exec)) return;
  if (isPlanSafeCall(toolName, args)) return;
  const detail = toolName === "bg_job_control" ? `${toolName}(action="${args?.action || ""}")` : toolName;
  throw new Error(
    `${detail} is not permitted while Plan Mode is active; only read-only actions (bg_query_state, bg_verify, bg_job_control action="list"|"inspect") are plan-safe.`
  );
}

async function enforceApprovalIfNeeded(dshCtx, exec, toolName, args, risk) {
  const isReadOnly = isPlanSafeCall(toolName, args);
  if (isReadOnly && risk === "low") return;
  const approvalSvc = safeGetService(exec, "approval") ?? safeGetService(dshCtx, "approval");
  if (!approvalSvc || typeof approvalSvc.request !== "function") return;
  const agent = exec?.agent;
  if (!agent?.session) return;
  let turnOpen = true;
  if (typeof approvalSvc.approvalStateOf === "function") {
    try {
      turnOpen = Boolean(approvalSvc.approvalStateOf(agent.session)?.turnOpen);
    } catch {
      turnOpen = false;
    }
  }
  if (!turnOpen) return;
  const outcome = await approvalSvc.request({
    agent,
    toolName,
    ...(exec?.callId !== undefined ? { callId: exec.callId } : {}),
    reason: `Execute background control tool ${toolName}`,
    signal: exec?.signal,
  });
  if (outcome !== "allowed-once") {
    throw new Error(`Tool "${toolName}" execution denied by DSH approval policy (outcome: ${outcome}).`);
  }
}

const TOOL_SPECS = [
  {
    name: "bg_query_state",
    description:
      'Exact tool name: bg_query_state; call ToolSearch for "dsh background control" if needed. Query real-time foreground window, active user input idle time, cursor hover target, multi-instance PID/HWND mapping, and detect foreground focus conflicts before any background action.',
    risk: "low",
    parameters: {
      pid: { type: "number", description: "Target process ID to inspect." },
      hwnd: { type: "number", description: "Target window handle (HWND) to inspect." },
      processName: { type: "string", description: "Target process name (e.g. 'charmap' or 'excel.exe')." },
      titlePattern: { type: "string", description: "Substring filter for window titles." },
      checkMouseHover: { type: "boolean", description: "Check if active cursor hover collides with target (default true)." },
      hoverActiveThresholdMs: { type: "number", description: "User idle threshold in ms below which hover triggers conflict (default from settings)." },
      requirePinnedInstance: { type: "boolean", description: "Flag conflict when multiple instances match without pid/hwnd." },
      taskId: { type: "string", description: "Optional taskId label for query record." },
    },
  },
  {
    name: "bg_verify",
    description:
      'Exact tool name: bg_verify; call ToolSearch for "dsh background control" if needed. Detect available non-intrusive background channels for a local program in strict priority order: CLI, COM/OLE, Named Pipe, local HTTP/MCP, CLI-Anything harness, and directed Win32 PostMessage.',
    risk: "low",
    parameters: {
      program: { type: "string", description: "Executable or CLI command name (e.g. 'ffmpeg', 'node', 'charmap')." },
      comProgId: { type: "string", description: "Optional Windows COM ProgID to probe (e.g. 'Scripting.Dictionary')." },
      pipeName: { type: "string", description: "Optional Windows Named Pipe name to probe." },
      httpUrl: { type: "string", description: "Optional localhost/127.0.0.1 HTTP health/MCP URL to probe." },
      pid: { type: "number", description: "Optional existing target PID." },
      hwnd: { type: "number", description: "Optional existing target HWND." },
      timeoutMs: { type: "number", description: "Optional HTTP probe timeout in ms." },
      taskId: { type: "string", description: "Optional taskId label for verify record." },
    },
  },
  {
    name: "bg_launch",
    description:
      'Exact tool name: bg_launch; call ToolSearch for "dsh background control" if needed. Launch a local program silently in Hidden or Minimized mode without stealing focus. Visible/normal windows cannot be requested by the model. Protected by the hard foreground focus guard.',
    risk: "medium",
    parameters: {
      executable: { type: "string", required: true, description: "Executable path or command name to launch." },
      args: { type: "array", items: { type: "string" }, description: "Command arguments (escaped per Windows CommandLineToArgvW)." },
      cwd: { type: "string", description: "Working directory." },
      windowMode: {
        type: "string",
        description: "Background window mode ('hidden' or 'minimized'; defaults to plugin setting defaultWindowMode). Normal/visible modes are forbidden.",
      },
      waitForHwndMs: { type: "number", description: "Milliseconds to poll top-level HWND via EnumWindows (default 2000)." },
      processName: { type: "string", description: "Optional process name for pre-launch foreground focus guard check." },
      pid: { type: "number", description: "Optional existing target PID for focus guard check." },
      hwnd: { type: "number", description: "Optional existing target HWND for focus guard check." },
      checkMouseHover: { type: "boolean", description: "Check active cursor hover before launch (default true)." },
      hoverActiveThresholdMs: { type: "number", description: "User idle threshold in ms for hover conflict." },
      async: { type: "boolean", description: "Return immediately with running/pending jobHandle." },
      taskId: { type: "string", description: "Optional unique caller-supplied taskId." },
      allowDuplicateSuffix: { type: "boolean", description: "Append unique suffix if taskId already exists." },
    },
  },
  {
    name: "bg_cli",
    description:
      'Exact tool name: bg_cli; call ToolSearch for "dsh background control" if needed. Execute a background CLI command or CLI-Anything harness silently with windowsHide=true, mandatory focus guard (requires targetPid/targetHwnd/targetProcessName or backgroundOnly=true), visible-window kill guard, pause/resume/cancel support, and artifact delivery.',
    risk: "medium",
    parameters: {
      command: { type: "string", required: true, description: "CLI binary or script to execute." },
      args: { type: "array", items: { type: "string" }, description: "CLI arguments." },
      cwd: { type: "string", description: "Working directory." },
      shell: { type: "boolean", description: "Run through shell (default false)." },
      env: { type: "object", additionalProperties: true, description: "Extra environment variables." },
      stdin: { type: "string", description: "Optional stdin text." },
      timeoutMs: { type: "number", description: "Execution timeout in ms (default 60000)." },
      maxOutputBytes: { type: "number", description: "Cap stdout/stderr capture bytes (default 10 MiB)." },
      targetPid: { type: "number", description: "Target PID guarded against foreground focus." },
      targetHwnd: { type: "number", description: "Target HWND guarded against foreground focus." },
      targetProcessName: { type: "string", description: "Target process name guarded against foreground focus." },
      backgroundOnly: { type: "boolean", description: "Set true when no target GUI exists; still enforces global foreground protection." },
      hoverActiveThresholdMs: { type: "number", description: "User idle threshold in ms for hover conflict." },
      outputFile: { type: "string", description: "Optional file produced by CLI to copy into output/<taskId>/." },
      outputName: { type: "string", description: "Optional plain basename inside output/<taskId>/ (no paths or '..')." },
      async: { type: "boolean", description: "Run asynchronously and return jobHandle immediately." },
      taskId: { type: "string", description: "Optional unique caller-supplied taskId." },
      allowDuplicateSuffix: { type: "boolean", description: "Append unique suffix if taskId already exists." },
    },
  },
  {
    name: "bg_ipc",
    description:
      'Exact tool name: bg_ipc; call ToolSearch for "dsh background control" if needed. Invoke an allowlisted Windows COM/OLE server (isolated hidden new instance + forced Quit cleanup), Windows Named Pipe, or localhost HTTP/MCP service (strict timeout and local-only redirects) with mandatory focus guard.',
    risk: "high",
    parameters: {
      protocol: {
        type: "string",
        required: true,
        enum: ["com", "http", "pipe"],
        description: "IPC transport protocol.",
      },
      progId: { type: "string", description: "Allowlisted COM ProgID (for protocol='com')." },
      method: { type: "string", description: "COM method name, or 'get:<Prop>' / 'set:<Prop>'." },
      args: { type: "array", items: { type: "json" }, description: "Arguments for COM method." },
      url: { type: "string", description: "Localhost/127.0.0.1 URL (for protocol='http')." },
      httpMethod: { type: "string", description: "HTTP verb (default POST when body is set, else GET)." },
      headers: { type: "object", additionalProperties: true, description: "HTTP headers." },
      body: { type: "json", description: "HTTP JSON object or string payload." },
      pipeName: { type: "string", description: "Named pipe name or \\\\.\\pipe\\... (for protocol='pipe')." },
      payload: { type: "json", description: "Payload to send over named pipe." },
      halfClose: { type: "boolean", description: "End write stream after sending pipe payload (default true)." },
      timeoutMs: { type: "number", description: "IPC timeout in ms (default 15000)." },
      targetPid: { type: "number", description: "Target PID for hard focus guard." },
      targetHwnd: { type: "number", description: "Target HWND for hard focus guard." },
      targetProcessName: { type: "string", description: "Target process name for hard focus guard." },
      backgroundOnly: { type: "boolean", description: "Set true when no target GUI exists; still enforces global foreground protection." },
      hoverActiveThresholdMs: { type: "number", description: "User idle threshold in ms for hover conflict." },
      async: { type: "boolean", description: "Run asynchronously via job queue." },
      taskId: { type: "string", description: "Optional unique caller-supplied taskId." },
      allowDuplicateSuffix: { type: "boolean", description: "Append unique suffix if taskId already exists." },
    },
  },
  {
    name: "bg_window_msg",
    description:
      'Exact tool name: bg_window_msg; call ToolSearch for "dsh background control" if needed. Send a strictly directed Win32 PostMessage to a specific verified non-browser HWND + PID (forbids SendInput, mouse_event, PyAutoGUI, broadcast, and user browser/host processes). Refuses immediately if the target window owns foreground focus or active hover.',
    risk: "medium",
    parameters: {
      hwnd: { type: "number", required: true, description: "Required specific target window handle (non-broadcast)." },
      pid: { type: "number", description: "Expected PID bound to hwnd (auto-verified via bg_query_state if omitted)." },
      processName: { type: "string", description: "Optional expected process name for focus guard." },
      msg: { type: "number", description: "Numeric Win32 message ID (e.g. 0 for WM_NULL, 16 for WM_CLOSE)." },
      msgName: { type: "string", description: "Named Win32 message (WM_NULL, WM_COMMAND, WM_SYSCOMMAND, WM_CHAR, WM_KEYDOWN, WM_KEYUP, WM_CLOSE, WM_USER+N, WM_APP+N)." },
      wParam: { type: "number", description: "Win32 WPARAM integer (default 0)." },
      lParam: { type: "number", description: "Win32 LPARAM integer (default 0)." },
      checkMouseHover: { type: "boolean", description: "Refuse if user cursor hovers actively over target window (default true)." },
      hoverActiveThresholdMs: { type: "number", description: "User idle threshold in ms for hover conflict." },
      taskId: { type: "string", description: "Optional unique caller-supplied taskId." },
      allowDuplicateSuffix: { type: "boolean", description: "Append unique suffix if taskId already exists." },
    },
  },
  {
    name: "bg_job_control",
    description:
      'Exact tool name: bg_job_control; call ToolSearch for "dsh background control" if needed. List, inspect, pause, resume, cancel, close (terminate plugin-owned processes of a completed/active job), or checkpoint background jobs in the plugin job queue.',
    risk: "low",
    planSafeActions: ["list", "inspect"],
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["list", "inspect", "pause", "resume", "cancel", "close", "checkpoint"],
        description: "Job control action.",
      },
      taskId: { type: "string", description: "Target taskId / jobHandle." },
      jobHandle: { type: "string", description: "Alias for taskId." },
      checkpoint: { type: "object", additionalProperties: true, description: "Breakpoint state object for pause/checkpoint." },
      reason: { type: "string", description: "Cancellation or close reason." },
      statusFilter: { type: "string", description: "Filter by job status when action='list'." },
      kindFilter: { type: "string", description: "Filter by job kind when action='list'." },
    },
  },
].map((spec) => ({
  ...spec,
  schema: {
    type: "object",
    properties: spec.parameters,
    required: Object.entries(spec.parameters)
      .filter(([, v]) => v.required === true)
      .map(([k]) => k),
  },
}));

function createTools(queue, options = {}) {
  const probe = options.probe || null;
  const bridge = options.win32 || win32;

  function getHoverThreshold(argVal) {
    if (Number.isFinite(Number(argVal))) return Number(argVal);
    if (Number.isFinite(Number(queue?.settings?.hoverActiveThresholdMs))) {
      return Number(queue.settings.hoverActiveThresholdMs);
    }
    return 1500;
  }

  function getDefaultWindowMode(argMode) {
    if (argMode !== undefined && argMode !== null && String(argMode).trim() !== "") {
      return String(argMode).trim().toLowerCase();
    }
    const cfg = String(queue?.settings?.defaultWindowMode || "hidden").trim().toLowerCase();
    return cfg === "minimized" ? "minimized" : "hidden";
  }

  const handlers = {
    bg_query_state: async (args = {}, rawCtx = {}) => {
      assertPlanModeAllowed(queue?.dshCtx, rawCtx, "bg_query_state", args);
      const ctx = queue.attachToContext(rawCtx);
      const target = {
        pid: args.pid,
        hwnd: args.hwnd,
        processName: args.processName,
        titlePattern: args.titlePattern,
      };
      const guard = await enforceFocusGuard(target, {
        probe: probe || bridge.querySystemState,
        checkMouseHover: args.checkMouseHover,
        hoverActiveThresholdMs: getHoverThreshold(args.hoverActiveThresholdMs),
        requirePinnedInstance: args.requirePinnedInstance,
        signal: ctx.signal,
      });

      const firstInst = guard.instances?.[0] || null;
      return {
        taskId: args.taskId || "query_state",
        status: guard.conflict ? "human_intervened" : "completed",
        pid: args.pid ?? firstInst?.pid ?? null,
        hwnd: args.hwnd ?? firstInst?.hwnd ?? null,
        progress: 1,
        conflict: guard.conflict,
        conflictReason: guard.conflictReason,
        nextAction: guard.nextAction,
        foreground: guard.foreground,
        cursor: guard.state?.cursor || null,
        userIdleMs: guard.userIdleMs,
        instances: guard.instances,
        processes: guard.state?.processes || [],
      };
    },

    bg_verify: async (args = {}, rawCtx = {}) => {
      assertPlanModeAllowed(queue?.dshCtx, rawCtx, "bg_verify", args);
      const ctx = queue.attachToContext(rawCtx);
      const verifyFn = options.verifyChannels || bridge.verifyChannels;
      const result = await verifyFn(
        {
          program: args.program,
          comProgId: args.comProgId,
          pipeName: args.pipeName,
          httpUrl: args.httpUrl,
          pid: args.pid,
          hwnd: args.hwnd,
          timeoutMs: args.timeoutMs,
        },
        { signal: ctx.signal }
      );
      return {
        taskId: args.taskId || "verify_channels",
        status: "completed",
        pid: args.pid ?? null,
        hwnd: args.hwnd ?? null,
        progress: 1,
        conflict: false,
        conflictReason: "",
        nextAction: result.hasSafeBackgroundPath
          ? `Use priority channel: ${result.recommendedOrder[0]}`
          : "No safe background path detected; inform user that safe background automation is unavailable.",
        ...result,
      };
    },

    bg_launch: async (args = {}, rawCtx = {}) => {
      assertPlanModeAllowed(queue?.dshCtx, rawCtx, "bg_launch", args);
      await enforceApprovalIfNeeded(queue?.dshCtx, rawCtx, "bg_launch", args, "medium");
      if (args.allowNormalWindow !== undefined || args.userPermittedNormal !== undefined) {
        throw new Error(
          "allowNormalWindow and userPermittedNormal parameters are prohibited; model-requested normal/visible windows are forbidden."
        );
      }
      const ctx = queue.attachToContext(rawCtx);
      const executable = String(args.executable || "").trim();
      if (!executable) throw new Error("executable is required");
      const windowMode = getDefaultWindowMode(args.windowMode);
      const inferredProc = args.processName || path.basename(executable).replace(/\.exe$/i, "");
      const launchFn = options.launchBackgroundProcess || bridge.launchBackgroundProcess;

      return ctx.jobs.submit({
        taskId: args.taskId,
        allowDuplicateSuffix: Boolean(args.allowDuplicateSuffix),
        kind: "launch",
        async: Boolean(args.async),
        target: {
          pid: args.pid,
          hwnd: args.hwnd,
          processName: inferredProc,
        },
        guardOptions: {
          probe: probe || bridge.querySystemState,
          checkMouseHover: args.checkMouseHover,
          hoverActiveThresholdMs: getHoverThreshold(args.hoverActiveThresholdMs),
        },
        run: async (jobCtx) => {
          if (windowMode !== "hidden" && windowMode !== "minimized") {
            throw new Error(
              `Unsupported windowMode "${windowMode}". Model-requested visible/normal windows are forbidden; only "hidden" or "minimized" is allowed.`
            );
          }
          jobCtx.chain("bg_launch.start", `executable=${executable} mode=${windowMode}`);
          jobCtx.log(`Launching ${executable} in ${windowMode} mode`);
          const launched = await launchFn(
            {
              executable,
              args: args.args,
              cwd: args.cwd,
              windowMode,
              waitForHwndMs: args.waitForHwndMs,
            },
            { signal: jobCtx.signal }
          );

          jobCtx.setOwnedProcess(
            launched.pid,
            launched.hwnd ?? null,
            launched.processName || inferredProc,
            launched.ownedPids
          );
          jobCtx.chain(
            "bg_launch.bound",
            `status=${launched.status || "completed"} ownedPid=${launched.pid} ownedPids=${JSON.stringify(launched.ownedPids || [])} proc=${launched.processName || ""} hwnd=${launched.hwnd ?? "null"}`
          );
          jobCtx.addInlineOutput("launch-info.json", JSON.stringify(launched, null, 2) + "\n");
          return launched;
        },
      });
    },

    bg_cli: async (args = {}, rawCtx = {}) => {
      assertPlanModeAllowed(queue?.dshCtx, rawCtx, "bg_cli", args);
      await enforceApprovalIfNeeded(queue?.dshCtx, rawCtx, "bg_cli", args, "medium");
      const ctx = queue.attachToContext(rawCtx);
      const command = String(args.command || "").trim();
      if (!command) throw new Error("command is required");
      const hasTargetGuard = Boolean(args.targetPid || args.targetHwnd || args.targetProcessName);
      const inferredProc = path.basename(command).replace(/\.(exe|cmd|bat|ps1)$/i, "");
      const runCliFn = options.runBackgroundCli || bridge.runBackgroundCli;
      const getVisibleWinsFn = options.getProcessVisibleWindows || bridge.getProcessVisibleWindows;

      return ctx.jobs.submit({
        taskId: args.taskId,
        allowDuplicateSuffix: Boolean(args.allowDuplicateSuffix),
        kind: "cli",
        async: Boolean(args.async),
        targetPid: args.targetPid ?? null,
        target: hasTargetGuard
          ? {
              pid: args.targetPid,
              hwnd: args.targetHwnd,
              processName: args.targetProcessName,
            }
          : {
              inferredProcessName: inferredProc,
            },
        guardOptions: {
          probe: probe || bridge.querySystemState,
          requireTargetOrBackgroundOnly: true,
          backgroundOnly: Boolean(args.backgroundOnly),
          globalForegroundGuard: !hasTargetGuard,
          hoverActiveThresholdMs: getHoverThreshold(args.hoverActiveThresholdMs),
        },
        run: async (jobCtx) => {
          if (args.outputName !== undefined && args.outputName !== null) {
            sanitizeOutputName(args.outputName);
          }
          jobCtx.chain("bg_cli.exec", `${command} ${(args.args || []).join(" ")}`.trim());
          jobCtx.log(`Executing CLI command silently: ${command}`);

          let childPid = null;
          let visibleWinConflict = null;
          let monitorTimer = null;
          let monitorActive = false;
          let scanPromise = null;

          const scanVisibleOnce = async (pid) => {
            if (options.disableVisibleWindowWatch || typeof getVisibleWinsFn !== "function" || !pid || visibleWinConflict) {
              return;
            }
            if (monitorActive && scanPromise) {
              await scanPromise;
              return;
            }
            monitorActive = true;
            scanPromise = (async () => {
              try {
                const scan = await getVisibleWinsFn(pid, { signal: jobCtx.signal });
                const wins = Array.isArray(scan?.windows) ? scan.windows : [];
                if (Array.isArray(scan?.pids) && scan.pids.length > 0) {
                  jobCtx.setOwnedProcess(pid, undefined, undefined, scan.pids);
                }
                if (wins.length > 0 && !visibleWinConflict) {
                  visibleWinConflict = {
                    conflict: true,
                    conflictReason: `CLI child PID ${pid} opened visible GUI window(s): ${wins.map((w) => `${w.hwnd}:${w.title || w.className}`).join(", ")}. Terminated to prevent focus steal.`,
                    nextAction: "Use bg_launch or a headless CLI flag instead.",
                    hwnd: wins[0].hwnd,
                  };
                  if (monitorTimer) {
                    clearInterval(monitorTimer);
                    monitorTimer = null;
                  }
                  await bridge.terminateProcessTree(pid);
                  if (Array.isArray(scan?.pids)) {
                    for (const p of scan.pids) {
                      if (p !== pid) {
                        try { await bridge.terminateProcessTree(p); } catch {}
                      }
                    }
                  }
                }
              } catch {
              } finally {
                monitorActive = false;
              }
            })();
            await scanPromise;
          };

          const startVisibleWindowWatch = (pid) => {
            if (options.disableVisibleWindowWatch || typeof getVisibleWinsFn !== "function") return;
            scanVisibleOnce(pid).catch(() => {});
            monitorTimer = setInterval(() => {
              scanVisibleOnce(pid).catch(() => {});
            }, 25);
            if (typeof monitorTimer.unref === "function") monitorTimer.unref();
          };

          let res;
          try {
            res = await runCliFn(
              {
                command,
                args: args.args,
                cwd: args.cwd,
                shell: args.shell,
                env: args.env,
                stdin: args.stdin,
                timeoutMs: args.timeoutMs,
                maxOutputBytes: args.maxOutputBytes,
              },
              {
                onSpawn: (pid) => {
                  childPid = pid;
                  jobCtx.setOwnedProcess(pid, null);
                  jobCtx.log(`Spawned owned background process PID=${pid}`);
                  startVisibleWindowWatch(pid);
                },
                onStdout: (chunk) => {
                  for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
                    jobCtx.log(`[stdout] ${line}`);
                  }
                },
                onStderr: (chunk) => {
                  for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
                    jobCtx.log(`[stderr] ${line}`);
                  }
                },
              },
              jobCtx.signal
            );
          } finally {
            if (monitorTimer) {
              clearInterval(monitorTimer);
              monitorTimer = null;
            }
          }

          if (scanPromise) {
            try { await scanPromise; } catch {}
          }
          if (!visibleWinConflict && childPid) {
            await scanVisibleOnce(childPid);
          }

          if (visibleWinConflict) {
            jobCtx.log(`VISIBLE WINDOW GUARD TRIGGERED: ${visibleWinConflict.conflictReason}`);
            jobCtx.chain("bg_cli.visible_window_guard", "killed_visible_gui");
            return visibleWinConflict;
          }
          if (res.stdout) {
            jobCtx.addInlineOutput("stdout.txt", res.stdout);
          }
          if (res.stderr) {
            jobCtx.addInlineOutput("stderr.txt", res.stderr);
          }
          if (args.outputFile) {
            jobCtx.addOutputFile(args.outputFile, args.outputName);
          }
          if (res.exitCode !== 0) {
            const err = new Error(`CLI command exited with code ${res.exitCode}: ${res.stderr || res.stdout}`);
            err.exitCode = res.exitCode;
            throw err;
          }
          return {
            ok: true,
            ownedPid: res.pid ?? childPid,
            hwnd: null,
            exitCode: res.exitCode,
            stdoutTruncated: Boolean(res.stdoutTruncated),
            stderrTruncated: Boolean(res.stderrTruncated),
            stdoutPreview: res.stdout.slice(0, 2000),
            stderrPreview: res.stderr.slice(0, 1000),
          };
        },
      });
    },

    bg_ipc: async (args = {}, rawCtx = {}) => {
      assertPlanModeAllowed(queue?.dshCtx, rawCtx, "bg_ipc", args);
      await enforceApprovalIfNeeded(queue?.dshCtx, rawCtx, "bg_ipc", args, "high");
      const ctx = queue.attachToContext(rawCtx);
      const protocol = String(args.protocol || "").toLowerCase();
      if (!["com", "http", "pipe"].includes(protocol)) {
        throw new Error(`Unsupported IPC protocol "${args.protocol}". Expected com | http | pipe.`);
      }
      if (protocol === "com") {
        if (args.attachActive !== undefined) {
          throw new Error("attachActive is prohibited and has been removed; COM IPC always creates an isolated hidden instance.");
        }
        if (args.quitOnExit !== undefined) {
          throw new Error("quitOnExit is prohibited and has been removed; COM IPC always calls Quit() on exit.");
        }
        if (args.keepHidden === false) {
          throw new Error("Visible COM automation (keepHidden=false) is prohibited for model invocations.");
        }
      }
      const hasTargetGuard = Boolean(args.targetPid || args.targetHwnd || args.targetProcessName);
      const inferredProc = protocol === "com" ? inferProcessFromProgId(args.progId) : "";

      return ctx.jobs.submit({
        taskId: args.taskId,
        allowDuplicateSuffix: Boolean(args.allowDuplicateSuffix),
        kind: `ipc_${protocol}`,
        async: Boolean(args.async),
        targetPid: args.targetPid ?? null,
        target: hasTargetGuard
          ? {
              pid: args.targetPid,
              hwnd: args.targetHwnd,
              processName: args.targetProcessName,
            }
          : {
              inferredProcessName: inferredProc,
            },
        guardOptions: {
          probe: probe || bridge.querySystemState,
          requireTargetOrBackgroundOnly: true,
          backgroundOnly: Boolean(args.backgroundOnly),
          globalForegroundGuard: !hasTargetGuard,
          hoverActiveThresholdMs: getHoverThreshold(args.hoverActiveThresholdMs),
        },
        run: async (jobCtx) => {
          jobCtx.chain("bg_ipc.dispatch", `protocol=${protocol}`);
          let responsePayload;

          if (protocol === "com") {
            const comFn = options.invokeComIpc || bridge.invokeComIpc;
            responsePayload = await comFn(
              {
                progId: args.progId,
                method: args.method,
                args: args.args,
                keepHidden: true,
                timeoutMs: args.timeoutMs,
              },
              {
                signal: jobCtx.signal,
                comAllowlist: options.comAllowlist || queue.settings?.comAllowlist || bridge.DEFAULT_COM_ALLOWLIST,
                allowVisibleCom: false,
                comAdapter: options.comAdapter,
              }
            );
            if (
              responsePayload?.ok === false &&
              (responsePayload.status === "unsupported_existing_instance" ||
                responsePayload.status === "unsupported_unverified_com")
            ) {
              jobCtx.addInlineOutput("ipc-response.json", JSON.stringify(responsePayload, null, 2) + "\n");
              jobCtx.log(`IPC (com) refused by isolation guard: ${responsePayload.status}`);
              return {
                ...responsePayload,
                protocol,
                response: responsePayload,
              };
            }
          } else if (protocol === "pipe") {
            const pipeFn = options.invokeNamedPipe || bridge.invokeNamedPipe;
            responsePayload = await pipeFn(args.pipeName, args.payload, {
              timeoutMs: args.timeoutMs,
              halfClose: args.halfClose,
              signal: jobCtx.signal,
            });
          } else if (protocol === "http") {
            const urlStr = String(args.url || "").trim();
            if (!urlStr) throw new Error("url is required for protocol='http'");
            const parsed = new URL(urlStr);
            if (!isLocalHttpUrl(parsed)) {
              throw new Error(`Refused non-local HTTP IPC URL "${urlStr}"; only localhost/127.0.0.1 allowed.`);
            }
            const method = String(args.httpMethod || (args.body !== undefined ? "POST" : "GET")).toUpperCase();
            const headers = { ...(args.headers || {}) };
            let body;
            if (args.body !== undefined && method !== "GET" && method !== "HEAD") {
              if (typeof args.body === "string") {
                body = args.body;
              } else {
                body = JSON.stringify(args.body);
                if (!headers["content-type"] && !headers["Content-Type"]) {
                  headers["Content-Type"] = "application/json";
                }
              }
            }
            const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 15000;
            const timeoutSig = AbortSignal.timeout(timeoutMs);
            const combinedSig = jobCtx.signal ? AbortSignal.any([jobCtx.signal, timeoutSig]) : timeoutSig;
            const fetchImpl = options.fetch || fetch;

            let currentUrl = urlStr;
            let resp = null;
            for (let hop = 0; hop <= 3; hop++) {
              resp = await fetchImpl(currentUrl, {
                method,
                headers,
                body,
                redirect: "manual",
                signal: combinedSig,
              });
              if (resp.status >= 300 && resp.status < 400) {
                const loc = resp.headers?.get?.("location");
                if (!loc) {
                  throw new Error(`HTTP redirect (${resp.status}) missing Location header`);
                }
                const nextUrl = new URL(loc, currentUrl);
                if (!isLocalHttpUrl(nextUrl)) {
                  throw new Error(`Refused HTTP redirect to non-local host: ${nextUrl.href}`);
                }
                if (hop === 3) {
                  throw new Error(`Too many local HTTP redirects (>3) from ${urlStr}`);
                }
                currentUrl = nextUrl.href;
                continue;
              }
              break;
            }

            const text = await resp.text();
            let data = text;
            try { data = JSON.parse(text); } catch {}
            responsePayload = {
              ok: resp.ok,
              status: resp.status,
              url: currentUrl,
              data,
            };
            if (!resp.ok) {
              throw new Error(`Local HTTP IPC failed (${resp.status}): ${text.slice(0, 500)}`);
            }
          }

          jobCtx.addInlineOutput("ipc-response.json", JSON.stringify(responsePayload, null, 2) + "\n");
          jobCtx.log(`IPC (${protocol}) succeeded`);
          return {
            ok: true,
            protocol,
            response: responsePayload,
          };
        },
      });
    },

    bg_window_msg: async (args = {}, rawCtx = {}) => {
      assertPlanModeAllowed(queue?.dshCtx, rawCtx, "bg_window_msg", args);
      await enforceApprovalIfNeeded(queue?.dshCtx, rawCtx, "bg_window_msg", args, "medium");
      const ctx = queue.attachToContext(rawCtx);
      const hwnd = Number(args.hwnd);
      if (!Number.isFinite(hwnd) || hwnd <= 0 || hwnd === 0xffff) {
        throw new Error("A valid specific non-broadcast target hwnd (> 0 and != 0xFFFF) is required");
      }
      const msgId = resolveWin32MsgId(args.msg, args.msgName);
      if (!Number.isFinite(msgId)) {
        throw new Error("Either numeric msg or valid msgName (e.g. WM_NULL, WM_COMMAND, WM_SYSCOMMAND, WM_CLOSE) is required");
      }

      const probeFn = probe || bridge.querySystemState;
      const preState = await probeFn({ hwnd }, { signal: ctx.signal });
      const matched =
        (preState?.instances || []).find((i) => Number(i.hwnd) === hwnd) ||
        (Number(preState?.windowInfo?.hwnd) === hwnd ? preState.windowInfo : null) ||
        (Number(preState?.foreground?.hwnd) === hwnd ? preState.foreground : null);

      const actualPid = Number(matched?.pid) > 0 ? Number(matched.pid) : null;
      const actualProcessName = String(matched?.processName || "").trim();
      const suppliedPid = args.pid !== undefined && args.pid !== null ? Number(args.pid) : null;
      if (suppliedPid !== null && (!Number.isFinite(suppliedPid) || suppliedPid <= 0)) {
        throw new Error("pid must be a positive integer when provided");
      }
      if (suppliedPid !== null && actualPid && suppliedPid !== actualPid) {
        throw new Error(`PID mismatch for HWND ${hwnd}: caller passed pid=${suppliedPid}, actual OS PID is ${actualPid}.`);
      }
      const boundPid = actualPid || suppliedPid;
      if (!boundPid) {
        throw new Error(
          `Cannot verify PID for HWND ${hwnd}. Call bg_query_state first or pass explicit pid.`
        );
      }

      const suppliedProcessName = String(args.processName || "").trim();
      const processNameMismatch = Boolean(
        suppliedProcessName &&
          actualProcessName &&
          normalizeExecutableName(suppliedProcessName) !== normalizeExecutableName(actualProcessName)
      );

      let precheckResult = null;
      if (!actualProcessName) {
        precheckResult = {
          ok: false,
          status: "unsupported_unverified_target",
          conflict: false,
          hwnd,
          pid: boundPid,
          verifiedPid: boundPid,
          verifiedProcessName: null,
          processNameMismatch: false,
          error: `Cannot verify actual OS processName for HWND ${hwnd} (PID ${boundPid}); PostMessage refused (fail-closed).`,
          nextAction: "Inspect the window with bg_query_state and ensure it is a running non-browser desktop window.",
        };
      } else if (isBrowserProcessName(actualProcessName)) {
        precheckResult = {
          ok: false,
          status: "unsupported",
          conflict: false,
          hwnd,
          pid: boundPid,
          verifiedPid: boundPid,
          verifiedProcessName: actualProcessName,
          processName: actualProcessName,
          processNameMismatch,
          ...(processNameMismatch ? { suppliedProcessName } : {}),
          error: `Directing Win32 PostMessage to browser/host process "${actualProcessName}" is unsupported; dsh-bg-control does not automate user browsers or host shells.`,
          nextAction: "Use DSH's isolated browser / CDP automation tools instead of driving user browser or host windows.",
        };
      }

      const postFn = options.postDirectedWindowMessage || bridge.postDirectedWindowMessage;

      return ctx.jobs.submit({
        taskId: args.taskId,
        allowDuplicateSuffix: Boolean(args.allowDuplicateSuffix),
        kind: "window_msg",
        targetPid: boundPid,
        verifiedPid: boundPid,
        hwnd,
        precheckResult,
        target: {
          hwnd,
          pid: boundPid,
          ...(actualProcessName ? { processName: actualProcessName } : {}),
        },
        guardOptions: {
          probe: probeFn,
          checkMouseHover: args.checkMouseHover,
          hoverActiveThresholdMs: getHoverThreshold(args.hoverActiveThresholdMs),
          requirePinnedInstance: true,
        },
        run: async (jobCtx) => {
          if (precheckResult) {
            return precheckResult;
          }
          if (!actualProcessName) {
            jobCtx.chain("bg_window_msg.verify", `unverified_process_name hwnd=${hwnd} pid=${boundPid}`);
            jobCtx.log(`Refused bg_window_msg: could not resolve actual OS processName for HWND ${hwnd} (PID ${boundPid})`);
            return {
              ok: false,
              status: "unsupported_unverified_target",
              conflict: false,
              hwnd,
              pid: boundPid,
              verifiedPid: boundPid,
              verifiedProcessName: null,
              processNameMismatch: false,
              error: `Cannot verify actual OS processName for HWND ${hwnd} (PID ${boundPid}); PostMessage refused (fail-closed).`,
              nextAction: "Inspect the window with bg_query_state and ensure it is a running non-browser desktop window.",
            };
          }
          if (processNameMismatch) {
            jobCtx.chain("bg_window_msg.identity_mismatch", `supplied=${suppliedProcessName} actual=${actualProcessName}`);
            jobCtx.log(`Caller supplied processName="${suppliedProcessName}" mismatches actual OS processName="${actualProcessName}" for HWND ${hwnd}; enforcing actual OS identity.`);
          }
          if (isBrowserProcessName(actualProcessName)) {
            jobCtx.chain("bg_window_msg.browser_boundary", `refused_actual:${actualProcessName}`);
            jobCtx.log(`Refused bg_window_msg targeting browser/host OS process "${actualProcessName}" (hwnd=${hwnd}, pid=${boundPid})`);
            return {
              ok: false,
              status: "unsupported",
              conflict: false,
              hwnd,
              pid: boundPid,
              verifiedPid: boundPid,
              verifiedProcessName: actualProcessName,
              processName: actualProcessName,
              processNameMismatch,
              ...(processNameMismatch ? { suppliedProcessName } : {}),
              error: `Directing Win32 PostMessage to browser/host process "${actualProcessName}" is unsupported; dsh-bg-control does not automate user browsers or host shells.`,
              nextAction: "Use DSH's isolated browser / CDP automation tools instead of driving user browser or host windows.",
            };
          }
          jobCtx.chain("bg_window_msg.post", `hwnd=${hwnd} verifiedPid=${boundPid} verifiedProc=${actualProcessName} msg=${msgId}`);
          jobCtx.log(`Posting directed Win32 message msg=${msgId} to hwnd=${hwnd} (verifiedPid=${boundPid}, verifiedProcessName=${actualProcessName})`);
          const res = await postFn(
            {
              hwnd,
              pid: boundPid,
              msg: msgId,
              wParam: args.wParam ?? 0,
              lParam: args.lParam ?? 0,
            },
            { signal: jobCtx.signal }
          );
          if (res?.status === "unsupported" || res?.status === "unsupported_unverified_target") {
            return {
              ...res,
              verifiedPid: res.verifiedPid ?? boundPid,
              verifiedProcessName: res.verifiedProcessName ?? actualProcessName,
              processNameMismatch,
              ...(processNameMismatch ? { suppliedProcessName } : {}),
            };
          }
          if (res?.conflict) {
            return {
              ...res,
              verifiedPid: res.verifiedPid ?? boundPid,
              verifiedProcessName: res.verifiedProcessName ?? actualProcessName,
              processNameMismatch,
              ...(processNameMismatch ? { suppliedProcessName } : {}),
            };
          }
          if (!res?.ok) {
            throw new Error(res?.error || `PostMessage failed for hwnd=${hwnd} msg=${msgId}`);
          }
          const finalVerifiedPid = res.verifiedPid ?? res.pid ?? boundPid;
          const finalVerifiedProc = res.verifiedProcessName || actualProcessName;
          if (isBrowserProcessName(finalVerifiedProc)) {
            return {
              ok: false,
              status: "unsupported",
              conflict: false,
              hwnd,
              pid: finalVerifiedPid,
              verifiedPid: finalVerifiedPid,
              verifiedProcessName: finalVerifiedProc,
              processNameMismatch,
              error: `Directing Win32 PostMessage to browser/host process "${finalVerifiedProc}" is unsupported.`,
            };
          }
          jobCtx.setVerifiedTarget(finalVerifiedPid, res.hwnd ?? hwnd);
          const outObj = {
            ...res,
            verifiedPid: finalVerifiedPid,
            verifiedProcessName: finalVerifiedProc,
            processNameMismatch,
            ...(processNameMismatch ? { suppliedProcessName } : {}),
          };
          jobCtx.addInlineOutput("window-msg.json", JSON.stringify(outObj, null, 2) + "\n");
          return outObj;
        },
      });
    },

    bg_job_control: async (args = {}, rawCtx = {}) => {
      assertPlanModeAllowed(queue?.dshCtx, rawCtx, "bg_job_control", args);
      const action = String(args.action || "").trim().toLowerCase();
      if (action !== "list" && action !== "inspect") {
        await enforceApprovalIfNeeded(queue?.dshCtx, rawCtx, "bg_job_control", args, "medium");
      }
      const ctx = queue.attachToContext(rawCtx);
      const targetId = String(args.taskId || args.jobHandle || "").trim();

      switch (action) {
        case "list": {
          const jobs = await ctx.jobs.list({
            status: args.statusFilter,
            kind: args.kindFilter,
          });
          return {
            taskId: "job_list",
            status: "completed",
            pid: null,
            hwnd: null,
            progress: 1,
            conflict: false,
            conflictReason: "",
            nextAction: "",
            count: jobs.length,
            jobs,
          };
        }
        case "inspect": {
          if (!targetId) throw new Error("taskId or jobHandle is required for action='inspect'");
          const rec = await ctx.jobs.inspect(targetId);
          if (!rec) throw new Error(`Job not found: ${targetId}`);
          return rec;
        }
        case "pause": {
          if (!targetId) throw new Error("taskId or jobHandle is required for action='pause'");
          return ctx.jobs.pause(targetId, args.checkpoint);
        }
        case "resume": {
          if (!targetId) throw new Error("taskId or jobHandle is required for action='resume'");
          return ctx.jobs.resume(targetId);
        }
        case "cancel": {
          if (!targetId) throw new Error("taskId or jobHandle is required for action='cancel'");
          return ctx.jobs.cancel(targetId, args.reason);
        }
        case "close": {
          if (!targetId) throw new Error("taskId or jobHandle is required for action='close'");
          return ctx.jobs.close(targetId, args.reason);
        }
        case "checkpoint": {
          if (!targetId) throw new Error("taskId or jobHandle is required for action='checkpoint'");
          return ctx.jobs.checkpoint(targetId, args.checkpoint || {});
        }
        default:
          throw new Error(`Unsupported bg_job_control action: ${action}`);
      }
    },
  };

  return TOOL_SPECS.map((spec) => {
    const handler = handlers[spec.name];
    const dshTool = defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: BG_TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [
          {
            type: "text",
            text: JSON.stringify(value, null, 2),
          },
        ],
      },
      isConcurrencySafe: (args) => isPlanSafeCall(spec.name, args),
      execute: async (args, exec) => {
        const res = await handler(args, exec);
        return toLosslessJson(res);
      },
    });

    const rawDshExecute = dshTool.execute.bind(dshTool);
    dshTool.execute = async (rawArgs = {}, rawExec = {}) => {
      // Check prohibited parameters before schema validation strips or rejects them
      if (spec.name === "bg_launch") {
        if (rawArgs?.allowNormalWindow !== undefined || rawArgs?.userPermittedNormal !== undefined) {
          throw new Error(
            "allowNormalWindow and userPermittedNormal parameters are prohibited; model-requested normal/visible windows are forbidden."
          );
        }
      }
      if (spec.name === "bg_ipc" && String(rawArgs?.protocol || "").toLowerCase() === "com") {
        if (rawArgs?.attachActive !== undefined) {
          throw new Error("attachActive is prohibited and has been removed; COM IPC always creates an isolated hidden instance.");
        }
        if (rawArgs?.quitOnExit !== undefined) {
          throw new Error("quitOnExit is prohibited and has been removed; COM IPC always calls Quit() on exit.");
        }
        if (rawArgs?.keepHidden === false) {
          throw new Error("Visible COM automation (keepHidden=false) is prohibited for model invocations.");
        }
      }
      const cleanArgs = toLosslessJson(rawArgs || {});
      return rawDshExecute(cleanArgs, rawExec);
    };
    dshTool.schema = spec.schema;
    dshTool.risk = spec.risk;
    if (spec.planSafeActions) {
      dshTool.planSafeActions = spec.planSafeActions;
    }
    return dshTool;
  });
}

export {
  TOOL_SPECS,
  WIN32_MSG_MAP,
  resolveWin32MsgId,
  isPlanModeActive,
  isPlanSafeCall,
  assertPlanModeAllowed,
  createTools,
};

export default {
  TOOL_SPECS,
  WIN32_MSG_MAP,
  resolveWin32MsgId,
  isPlanModeActive,
  isPlanSafeCall,
  assertPlanModeAllowed,
  createTools,
};
