import win32 from "./win32-bridge.js";

function normalizeProcName(name) {
  return String(name || "").trim().replace(/\.exe$/i, "").toLowerCase();
}

const HOST_SHELL_PROCS = new Set(["deepseek harness", "deepseek-harness", "dsh", "electron", "pi-desktop"]);

/**
 * Evaluate a pre-captured OS state snapshot against target identifiers or global foreground state.
 * Pure & deterministic so it can be unit-tested with mock snapshots and enforced on live Win32 snapshots.
 */
function evaluateFocusConflict(state, target = {}, options = {}) {
  const fg = state?.foreground || null;
  const cursor = state?.cursor || null;
  const userIdleMs = Number.isFinite(Number(state?.userIdleMs)) ? Number(state.userIdleMs) : 999999;
  const instances = Array.isArray(state?.instances) ? state.instances : [];
  const hoverThresholdMs = Number.isFinite(Number(options.hoverActiveThresholdMs))
    ? Number(options.hoverActiveThresholdMs)
    : 1500;
  const checkMouseHover = options.checkMouseHover !== false;

  const targetPid = Number(target.pid) > 0 ? Number(target.pid) : null;
  const targetHwnd = Number(target.hwnd) > 0 ? Number(target.hwnd) : null;
  const targetProc = normalizeProcName(target.processName);
  const inferredProc = normalizeProcName(target.inferredProcessName);

  const fgHwnd = fg?.hwnd ? Number(fg.hwnd) : null;
  const fgRoot = fg?.rootOwnerHwnd ? Number(fg.rootOwnerHwnd) : fgHwnd;
  const fgPid = fg?.pid ? Number(fg.pid) : null;
  const fgProc = normalizeProcName(fg?.processName);

  // 0. Require either an explicit target or explicit backgroundOnly=true
  const hasExplicitTarget = Boolean(targetPid || targetHwnd || targetProc);
  if (!hasExplicitTarget && options.requireTargetOrBackgroundOnly && options.backgroundOnly !== true) {
    return {
      allowed: false,
      conflict: true,
      status: "human_intervened",
      conflictReason: "No targetPid/targetHwnd/targetProcessName specified and backgroundOnly is not true.",
      nextAction: "Specify targetPid/targetHwnd/targetProcessName or pass backgroundOnly=true.",
      foreground: fg,
      userIdleMs,
      instances,
    };
  }

  // 1. Direct HWND match with foreground window or its root owner
  if (targetHwnd && fgHwnd) {
    if (targetHwnd === fgHwnd || (fgRoot && targetHwnd === fgRoot)) {
      return {
        allowed: false,
        conflict: true,
        status: "human_intervened",
        conflictReason: `Target hwnd ${targetHwnd} owns foreground focus ("${fg?.title || fg?.processName || "unknown"}").`,
        nextAction: "Pause automation and wait for the user to move focus away from the target window before resuming.",
        foreground: fg,
        userIdleMs,
        instances,
      };
    }
    const matchedInst = instances.find((inst) => Number(inst.hwnd) === targetHwnd);
    if (matchedInst && (matchedInst.isForeground || (fgRoot && Number(matchedInst.rootOwnerHwnd) === fgRoot))) {
      return {
        allowed: false,
        conflict: true,
        status: "human_intervened",
        conflictReason: `Target hwnd ${targetHwnd} (root owner ${matchedInst.rootOwnerHwnd}) shares foreground focus.`,
        nextAction: "Pause automation and wait for the user to finish interacting with the target window.",
        foreground: fg,
        userIdleMs,
        instances,
      };
    }
  }

  // 2. Direct PID match with foreground window
  if (targetPid && fgPid && targetPid === fgPid) {
    return {
      allowed: false,
      conflict: true,
      status: "human_intervened",
      conflictReason: `Target PID ${targetPid} (${fg?.processName || "process"}) currently owns foreground focus.`,
      nextAction: "Pause automation and wait for user confirmation or focus switch.",
      foreground: fg,
      userIdleMs,
      instances,
    };
  }

  // 3. Process name (explicit or inferred) match with foreground window
  const procToMatch = targetProc || inferredProc;
  if (procToMatch && fgProc && procToMatch === fgProc) {
    return {
      allowed: false,
      conflict: true,
      status: "human_intervened",
      conflictReason: `Target process "${target.processName || target.inferredProcessName}" currently owns foreground window "${fg?.title || ""}" (PID ${fgPid}, HWND ${fgHwnd}).`,
      nextAction: "Do not steal focus or interact while user is using the target application.",
      foreground: fg,
      userIdleMs,
      instances,
    };
  }

  // 4. Multi-instance disambiguation check when neither pid nor hwnd was pinned
  if (options.requirePinnedInstance && !targetPid && !targetHwnd && instances.length > 1) {
    return {
      allowed: false,
      conflict: true,
      status: "human_intervened",
      conflictReason: `Multiple instances (${instances.length}) matched "${target.processName || target.titlePattern}". Specify pid or hwnd instead of picking arbitrarily.`,
      nextAction: "Ask the user which PID/HWND instance to bind before retrying.",
      foreground: fg,
      userIdleMs,
      instances,
    };
  }

  // 5. Active mouse hover over target window while user is actively providing input
  if (checkMouseHover && cursor && userIdleMs < hoverThresholdMs) {
    const hoverHwnd = cursor.hoverHwnd ? Number(cursor.hoverHwnd) : null;
    const hoverRoot = cursor.hoverRootHwnd ? Number(cursor.hoverRootHwnd) : null;
    const hoverPid = cursor.hoverInfo?.pid ? Number(cursor.hoverInfo.pid) : null;
    const hoverProc = normalizeProcName(cursor.hoverInfo?.processName);

    const hoverMatchesTarget =
      (targetHwnd && (hoverHwnd === targetHwnd || hoverRoot === targetHwnd)) ||
      (targetPid && hoverPid === targetPid) ||
      (procToMatch && hoverProc && hoverProc === procToMatch);

    if (hoverMatchesTarget) {
      return {
        allowed: false,
        conflict: true,
        status: "human_intervened",
        conflictReason: `User cursor is actively hovering over target window (idle ${userIdleMs}ms < ${hoverThresholdMs}ms).`,
        nextAction: "Pause automation until user mouse activity leaves the target window.",
        foreground: fg,
        userIdleMs,
        instances,
      };
    }
  }

  // 6. Global foreground activity guard when running without explicit target (backgroundOnly=true)
  if (!hasExplicitTarget && options.globalForegroundGuard) {
    if (state?.foregroundConflict === true) {
      return {
        allowed: false,
        conflict: true,
        status: "human_intervened",
        conflictReason: "Global foreground conflict detected by probe.",
        nextAction: "Wait for foreground interaction to complete before running background task.",
        foreground: fg,
        userIdleMs,
        instances,
      };
    }
    if (fg && fgHwnd && !HOST_SHELL_PROCS.has(fgProc) && userIdleMs < hoverThresholdMs) {
      return {
        allowed: false,
        conflict: true,
        status: "human_intervened",
        conflictReason: `User is actively interacting in foreground window "${fg.title || fg.processName || "unknown"}" (PID ${fgPid}, idle ${userIdleMs}ms < ${hoverThresholdMs}ms).`,
        nextAction: "Wait for user foreground activity to pause or bind a specific background target.",
        foreground: fg,
        userIdleMs,
        instances,
      };
    }
  }

  return {
    allowed: true,
    conflict: false,
    status: "running",
    conflictReason: "",
    nextAction: "",
    foreground: fg,
    userIdleMs,
    instances,
  };
}

/**
 * Hard Focus Guard: queries live OS state (or injected probe) and strictly refuses
 * execution when the target owns foreground focus, active hover, or global conflict.
 */
async function enforceFocusGuard(target = {}, options = {}) {
  const probe = typeof options.probe === "function" ? options.probe : win32.querySystemState;
  const state = await probe(
    {
      pid: target.pid,
      hwnd: target.hwnd,
      processName: target.processName,
      titlePattern: target.titlePattern,
    },
    { signal: options.signal }
  );
  const verdict = evaluateFocusConflict(state, target, options);
  return {
    ...verdict,
    state,
  };
}

export {
  normalizeProcName,
  evaluateFocusConflict,
  enforceFocusGuard,
};
export default {
  normalizeProcName,
  evaluateFocusConflict,
  enforceFocusGuard,
};
