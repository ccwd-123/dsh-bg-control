import { z } from "./dsh-host.js";
import { DshJobQueue } from "./job-queue.js";
import { createTools, TOOL_SPECS } from "./tools.js";
import win32 from "./win32-bridge.js";
import focusGuard from "./focus-guard.js";
import artifacts from "./artifacts.js";

export const name = "dsh-bg-control";

export const inject = ["tools", "systemPrompt"];

export const Config = z.object({
  defaultWindowMode: z
    .union(["hidden", "minimized"])
    .default("hidden")
    .description("Default window mode for bg_launch ('hidden' or 'minimized'). Normal/visible windows are forbidden."),
  hoverActiveThresholdMs: z
    .number()
    .min(100)
    .max(60000)
    .default(1500)
    .description("User input idle threshold in ms below which cursor hover over a target window triggers a focus conflict."),
  comAllowlist: z
    .array(z.string())
    .default(["Scripting.Dictionary"])
    .description("Allowlisted Windows COM ProgIDs for bg_ipc(protocol='com'). Default only allows Scripting.Dictionary."),
  closeCompletedLaunchOnShutdown: z
    .boolean()
    .default(false)
    .description("Whether plugin teardown automatically terminates completed bg_launch processes (default false; use bg_job_control action='close' to close explicitly)."),
});

const SYSTEM_PROMPT_SECTION_TEXT = [
  "## Windows Background Control (dsh-bg-control)",
  "- Available tools: `bg_query_state`, `bg_verify`, `bg_launch`, `bg_cli`, `bg_ipc`, `bg_window_msg`, `bg_job_control`.",
  "- Channel priority: 1) `bg_cli` (headless CLI), 2) `bg_ipc` (allowlisted COM / Named Pipe / localhost HTTP), 3) `bg_launch` (`hidden` / `minimized` only), 4) `bg_window_msg` (directed non-browser Win32 `PostMessage`).",
  "- Hard Foreground Focus Guard: never steal user focus or send input when the target window owns foreground focus or active cursor hover (status: \"human_intervened\").",
  "- Browser & Host Boundary: `bg_window_msg` verifies live `HWND -> PID -> ProcessName` and refuses `msedge`, `msedgewebview2`, `chrome`, `firefox`, `electron`, `dsh`, etc. Use DSH's isolated browser/CDP tools for web tasks.",
  "- Process Lifecycle: `bg_job_control(action=\"close\")` closes only plugin-launched `ownedPids` and never touches external `targetPid`.",
].join("\n");

function normalizeSettings(raw = {}) {
  const mode = String(raw?.defaultWindowMode || "hidden").trim().toLowerCase();
  const hoverMs = Number(raw?.hoverActiveThresholdMs);
  const allowlist = Array.isArray(raw?.comAllowlist) && raw.comAllowlist.length > 0
    ? raw.comAllowlist.map((s) => String(s).trim()).filter(Boolean)
    : ["Scripting.Dictionary"];
  return {
    defaultWindowMode: mode === "minimized" ? "minimized" : "hidden",
    hoverActiveThresholdMs: Number.isFinite(hoverMs) && hoverMs >= 100 ? hoverMs : 1500,
    comAllowlist: allowlist,
    closeCompletedLaunchOnShutdown: raw?.closeCompletedLaunchOnShutdown === true,
  };
}

export function apply(ctx, config = {}) {
  const settings = normalizeSettings(config);
  const queue = new DshJobQueue({
    dshCtx: ctx,
    settings,
  });

  if (ctx?.systemPrompt && typeof ctx.systemPrompt.section === "function") {
    ctx.systemPrompt.section({
      name: "tool:bg-control",
      order: 3050,
      interpolate: false,
      text: SYSTEM_PROMPT_SECTION_TEXT,
    });
  }

  const tools = createTools(queue);
  const disposers = [];
  if (ctx?.tools && typeof ctx.tools.register === "function") {
    for (const tool of tools) {
      const dispose = ctx.tools.register(tool);
      if (typeof dispose === "function") disposers.push(dispose);
    }
  }

  if (typeof ctx?.inject === "function") {
    ctx.inject(["jobs"], (jobCtx) => {
      const hostJobs = jobCtx.jobs ?? jobCtx.get?.("jobs");
      let detachController;
      if (hostJobs && typeof hostJobs.attachController === "function") {
        try {
          detachController = hostJobs.attachController("dsh-bg-control");
        } catch {}
      }
      queue.setHostJobs(hostJobs);
      if (typeof jobCtx.effect === "function") {
        jobCtx.effect(() => () => {
          queue.setHostJobs(null);
          if (typeof detachController === "function") {
            try { detachController(); } catch {}
          }
        }, "dsh-bg-control:jobs");
      }
    });
  }

  if (typeof ctx?.effect === "function") {
    ctx.effect(() => () => {
      for (const d of disposers.splice(0)) {
        try { d(); } catch {}
      }
      queue.releaseAllOnShutdown("DSH plugin unloaded").catch(() => {});
      win32.shutdownResidentHelper();
    }, "dsh-bg-control:teardown");
  }

  return {
    name,
    queue,
    tools,
    settings,
  };
}

export {
  DshJobQueue,
  createTools,
  TOOL_SPECS,
  win32,
  focusGuard,
  artifacts,
  normalizeSettings,
};

export default {
  name,
  inject,
  Config,
  apply,
  DshJobQueue,
  createTools,
  TOOL_SPECS,
  win32,
  focusGuard,
  artifacts,
  normalizeSettings,
};
