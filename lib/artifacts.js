import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_LOG_LINES = 20000;
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MiB
const TASK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MIME_BY_EXT = {
  ".json": "application/json",
  ".sha256": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function isWindowsReservedName(name) {
  const str = String(name || "").trim();
  if (!str) return false;
  const stem = str.split(".")[0];
  return WINDOWS_RESERVED_NAME_RE.test(str) || WINDOWS_RESERVED_NAME_RE.test(stem);
}

function sanitizeTaskId(taskId) {
  if (typeof taskId !== "string") {
    throw new Error("Invalid taskId: must be a non-empty string.");
  }
  const trimmed = taskId.trim();
  if (
    !trimmed ||
    trimmed !== taskId ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("..") ||
    trimmed.endsWith(".") ||
    !TASK_ID_REGEX.test(trimmed) ||
    isWindowsReservedName(trimmed)
  ) {
    throw new Error(
      `Invalid taskId "${taskId}": must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$, cannot contain '..', end with '.', or use Windows reserved names.`
    );
  }
  return trimmed;
}

function sanitizeSessionFolder(sessionId) {
  const raw = String(sessionId || "default").trim().replace(/[^A-Za-z0-9._-]/g, "_");
  const clean = raw.replace(/\.\.+/g, "_").replace(/^\.+/, "").replace(/\.+$/, "");
  if (!clean || isWindowsReservedName(clean)) return "default";
  return clean.slice(0, 80);
}

function sanitizeOutputName(name) {
  const raw = String(name || "").trim();
  if (!raw) throw new Error("outputName must be a non-empty filename");
  if (raw.includes("\0") || raw.includes("/") || raw.includes("\\") || raw.includes("..") || path.isAbsolute(raw)) {
    throw new Error(`Invalid outputName "${name}": path separators, '..', and absolute paths are forbidden.`);
  }
  const base = path.basename(raw);
  if (base !== raw || base === "." || base === ".." || base.endsWith(".")) {
    throw new Error(`Invalid outputName "${name}": must be a plain basename and cannot end with '.'.`);
  }
  if (isWindowsReservedName(base)) {
    throw new Error(`Invalid outputName "${name}": Windows reserved device names are forbidden.`);
  }
  return base;
}

function assertContainedPath(baseDir, targetPath, options = {}) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (options.allowSelf && rel === "") {
    return { resolvedBase, resolvedTarget, relPath: "" };
  }
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refused path outside allowed directory (${resolvedBase}): ${resolvedTarget}`);
  }
  return { resolvedBase, resolvedTarget, relPath: rel.replace(/\\/g, "/") };
}

function assertNoReparseEscape(baseDir, targetPath) {
  const { resolvedBase, resolvedTarget, relPath } = assertContainedPath(baseDir, targetPath, { allowSelf: true });
  if (!fs.existsSync(resolvedBase)) return;

  const baseLstat = fs.lstatSync(resolvedBase);
  if (baseLstat.isSymbolicLink()) {
    throw new Error(`Refused symlink/junction base directory: ${resolvedBase}`);
  }
  const realBase = fs.realpathSync(resolvedBase);

  const segments = relPath ? relPath.split("/").filter(Boolean) : [];
  let current = resolvedBase;
  for (const seg of segments) {
    current = path.join(current, seg);
    if (!fs.existsSync(current)) break;
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) {
      throw new Error(`Refused symlink/junction inside workspace subtree: ${current}`);
    }
    const realCur = fs.realpathSync(current);
    const realRel = path.relative(realBase, realCur);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error(`Refused reparse escape (${realBase} -> ${realCur})`);
    }
  }
  return { resolvedBase, resolvedTarget, realBase };
}

function assertMatchesWriteScope(relPath) {
  const norm = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("..") || norm.includes("\0")) {
    throw new Error(`Write path violates allowed artifact scope: ${relPath}`);
  }
  const allowed =
    /^output\/.+$/.test(norm) ||
    /^logs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.log$/.test(norm) ||
    /^result_[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(json|sha256)$/.test(norm);
  if (!allowed) {
    throw new Error(`Write path "${norm}" is outside declared artifact write scope.`);
  }
  return norm;
}

/**
 * Resolve workspace directory bound strictly to the invoking DSH agent/session:
 * - Never substitutes a "currently visible" session for the calling session.
 * - Uses ctx.workingDirectory.ensure(exec.agent, exec.signal) / ctx.workingDirectory.get(exec.agent.session).
 */
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

async function resolveWorkspaceContext(dshCtx, overrideRoot, sessionOrContext) {
  const agent = sessionOrContext && typeof sessionOrContext === "object" ? sessionOrContext.agent : null;
  const signal = sessionOrContext && typeof sessionOrContext === "object" ? sessionOrContext.signal : undefined;
  const rawSessionId =
    typeof sessionOrContext === "string"
      ? sessionOrContext
      : sessionOrContext?.sessionId ?? agent?.session?.id ?? agent?.id ?? null;

  if (overrideRoot && typeof overrideRoot === "string") {
    return {
      workspaceRoot: path.resolve(overrideRoot),
      resolution: "explicit_override",
      sessionId: rawSessionId || null,
      activeWorkspaceRoot: null,
    };
  }

  const wdService = safeGetService(dshCtx, "workingDirectory");
  if (agent && agent.session && wdService) {
    let dir = null;
    if (typeof wdService.ensure === "function") {
      dir = await wdService.ensure(agent, signal);
    } else if (typeof wdService.get === "function") {
      dir = wdService.get(agent.session);
    }
    if (dir && typeof dir === "string") {
      const resolved = path.resolve(dir);
      return {
        workspaceRoot: resolved,
        resolution: "dsh_session_working_directory",
        sessionId: String(agent.session.id ?? agent.id ?? rawSessionId ?? ""),
        activeWorkspaceRoot: resolved,
      };
    }
  }

  if (rawSessionId && dshCtx) {
    const agentsSvc = safeGetService(dshCtx, "agents");
    const matchedAgent = agentsSvc?.get?.(rawSessionId);
    if (matchedAgent?.session && wdService && typeof wdService.get === "function") {
      const dir = wdService.get(matchedAgent.session);
      if (dir && typeof dir === "string") {
        const resolved = path.resolve(dir);
        return {
          workspaceRoot: resolved,
          resolution: "dsh_session_working_directory",
          sessionId: rawSessionId,
          activeWorkspaceRoot: resolved,
        };
      }
    }
    // Session ID provided but does not match a live agent in dshCtx.agents: isolate in DSH_HOME session fallback
    const dshHome =
      safeGetService(dshCtx, "homeDir") ||
      safeGetService(dshCtx, "profileContext")?.home ||
      process.env.DSH_HOME ||
      path.join(os.homedir(), ".dsh");
    const safeSession = sanitizeSessionFolder(rawSessionId);
    return {
      workspaceRoot: path.resolve(dshHome, "bg-control", "sessions", safeSession),
      resolution: "dsh_session_isolated_fallback",
      sessionId: rawSessionId,
      activeWorkspaceRoot: null,
    };
  }

  if (wdService?.defaultDirectory && typeof wdService.defaultDirectory === "string") {
    const resolved = path.resolve(wdService.defaultDirectory);
    return {
      workspaceRoot: resolved,
      resolution: "dsh_default_directory",
      sessionId: null,
      activeWorkspaceRoot: resolved,
    };
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const safeSession = sanitizeSessionFolder(rawSessionId || "default");
  return {
    workspaceRoot: path.resolve(dshHome, "bg-control", "sessions", safeSession),
    resolution: "dsh_home_fallback",
    sessionId: rawSessionId || null,
    activeWorkspaceRoot: null,
  };
}

async function resolveWorkspaceRoot(dshCtx, overrideRoot, sessionOrContext) {
  const ctx = await resolveWorkspaceContext(dshCtx, overrideRoot, sessionOrContext);
  return ctx.workspaceRoot;
}

/**
 * Write a text artifact inside verified workspaceRoot & artifact write scope.
 * Never silently falls back to another directory if writing fails.
 */
async function writeTextArtifact(dshCtx, workspaceRoot, relPath, content, resolutionMode, activeWorkspaceRoot) {
  const normalizedRel = assertMatchesWriteScope(relPath);
  const absPath = path.resolve(workspaceRoot, normalizedRel);
  assertContainedPath(workspaceRoot, absPath);
  assertNoReparseEscape(workspaceRoot, absPath);

  const sameAsActive =
    !activeWorkspaceRoot || path.resolve(workspaceRoot) === path.resolve(activeWorkspaceRoot);

  const customWriter = safeGetService(dshCtx, "writeText");
  if (
    (resolutionMode === "dsh_session_working_directory" || resolutionMode === "session_workspace") &&
    sameAsActive &&
    typeof customWriter === "function"
  ) {
    await customWriter.call(dshCtx, normalizedRel, String(content));
    return { absPath, relPath: normalizedRel, wroteViaCustomWriter: true };
  }

  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  assertNoReparseEscape(workspaceRoot, absPath);
  await fsp.writeFile(absPath, String(content), "utf8");
  return { absPath, relPath: normalizedRel, wroteViaCustomWriter: false };
}

async function copyOutputFileToWorkspace(workspaceRoot, sourcePath, taskId, targetName) {
  const safeId = sanitizeTaskId(taskId);
  const srcAbs = path.resolve(sourcePath);
  if (!fs.existsSync(srcAbs)) return null;

  const outputRoot = path.resolve(workspaceRoot, "output");
  const taskOutDir = path.resolve(outputRoot, safeId);
  assertContainedPath(outputRoot, taskOutDir);
  assertNoReparseEscape(workspaceRoot, taskOutDir);

  const baseName =
    targetName !== undefined && targetName !== null
      ? sanitizeOutputName(targetName)
      : sanitizeOutputName(path.basename(srcAbs));
  const destAbs = path.resolve(taskOutDir, baseName);
  assertContainedPath(taskOutDir, destAbs);
  assertNoReparseEscape(workspaceRoot, destAbs);

  const relPath = `output/${safeId}/${baseName}`;
  if (srcAbs !== destAbs) {
    await fsp.mkdir(taskOutDir, { recursive: true });
    assertNoReparseEscape(workspaceRoot, destAbs);
    await fsp.copyFile(srcAbs, destAbs);
  }
  return { absPath: destAbs, relPath };
}

function computeFileSha256Stream(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function buildArtifactDescriptor(workspaceRoot, relPath, kind) {
  const normalizedRel = relPath.replace(/\\/g, "/");
  const absPath = path.resolve(workspaceRoot, normalizedRel);
  assertContainedPath(workspaceRoot, absPath);
  assertNoReparseEscape(workspaceRoot, absPath);
  try {
    const stat = await fsp.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const sha256 = await computeFileSha256Stream(absPath);
    return {
      kind,
      name: path.basename(normalizedRel),
      relativePath: normalizedRel,
      path: absPath,
      mimeType: guessMimeType(normalizedRel),
      bytes: stat.size,
      sha256,
      recordedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function listOutputFilesForTask(workspaceRoot, taskId) {
  const safeId = sanitizeTaskId(taskId);
  const outputRoot = path.resolve(workspaceRoot, "output");
  const taskOutDir = path.resolve(outputRoot, safeId);
  assertContainedPath(outputRoot, taskOutDir);
  if (!fs.existsSync(taskOutDir)) return [];

  assertNoReparseEscape(workspaceRoot, taskOutDir);
  const realTaskOutDir = await fsp.realpath(taskOutDir);
  const results = [];

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const lstat = await fsp.lstat(full);
      if (lstat.isSymbolicLink()) {
        throw new Error(`Refused symlink/junction inside task output directory: ${full}`);
      }
      const realFull = await fsp.realpath(full);
      const relFromTask = path.relative(realTaskOutDir, realFull);
      if (!relFromTask || relFromTask.startsWith("..") || path.isAbsolute(relFromTask)) {
        throw new Error(`Refused reparse point escaping task output directory: ${full}`);
      }
      if (lstat.isDirectory()) {
        await walk(full);
      } else if (lstat.isFile()) {
        const rel = path.relative(workspaceRoot, full).replace(/\\/g, "/");
        results.push(rel);
      }
    }
  }
  await walk(taskOutDir);
  return results;
}

function capLogLines(rawLines) {
  const list = Array.isArray(rawLines) ? rawLines : [];
  let truncated = false;
  let sliced = list;
  if (sliced.length > MAX_LOG_LINES) {
    sliced = sliced.slice(0, MAX_LOG_LINES);
    truncated = true;
  }
  const out = [];
  let bytes = 0;
  for (const line of sliced) {
    const str = String(line ?? "");
    const b = Buffer.byteLength(str, "utf8") + 1;
    if (bytes + b > MAX_LOG_BYTES) {
      truncated = true;
      break;
    }
    out.push(str);
    bytes += b;
  }
  if (truncated) {
    out.push(`[TRUNCATED: log output exceeded limit (${MAX_LOG_LINES} lines / ${MAX_LOG_BYTES} bytes)]`);
  }
  return { lines: out, truncated };
}

async function deliverTaskArtifacts({
  dshCtx,
  workspaceRoot: overrideRoot,
  workspaceResolution: snapshotResolution,
  activeWorkspaceRoot: snapshotActiveRoot,
  sessionId,
  agent,
  signal,
  taskId,
  payload,
  logLines,
  callChain,
  errorStack,
  outputFiles = [],
  inlineOutputs = [],
}) {
  const safeId = sanitizeTaskId(taskId);
  const wsCtx =
    overrideRoot && snapshotResolution
      ? {
          workspaceRoot: path.resolve(overrideRoot),
          resolution: snapshotResolution,
          sessionId: sessionId || null,
          activeWorkspaceRoot: snapshotActiveRoot ? path.resolve(snapshotActiveRoot) : null,
        }
      : await resolveWorkspaceContext(dshCtx, overrideRoot, { sessionId, agent, signal });

  const workspaceRoot = wsCtx.workspaceRoot;
  const recordedArtifacts = [];

  for (const item of inlineOutputs) {
    if (!item || !item.name) continue;
    const safeName = sanitizeOutputName(item.name);
    const rel = `output/${safeId}/${safeName}`;
    await writeTextArtifact(
      dshCtx,
      workspaceRoot,
      rel,
      item.content ?? "",
      wsCtx.resolution,
      wsCtx.activeWorkspaceRoot
    );
  }

  for (const fileItem of outputFiles) {
    if (!fileItem) continue;
    const src = typeof fileItem === "string" ? fileItem : fileItem.path;
    const name = typeof fileItem === "string" ? undefined : fileItem.name;
    if (src) {
      await copyOutputFileToWorkspace(workspaceRoot, src, safeId, name);
    }
  }

  const discoveredOutputRels = await listOutputFilesForTask(workspaceRoot, safeId);
  for (const rel of discoveredOutputRels) {
    const desc = await buildArtifactDescriptor(workspaceRoot, rel, "output");
    if (desc) recordedArtifacts.push(desc);
  }

  const capped = capLogLines(logLines);
  const logRel = `logs/${safeId}.log`;
  const logText = [
    `=== DSH Background Control Execution Log ===`,
    `taskId: ${safeId}`,
    `status: ${payload.status}`,
    `timestamp: ${new Date().toISOString()}`,
    `workspaceResolution: ${wsCtx.resolution}`,
    wsCtx.sessionId ? `sessionId: ${wsCtx.sessionId}` : null,
    `targetPid: ${payload.targetPid ?? "null"}`,
    `ownedPid: ${payload.ownedPid ?? "null"}`,
    `hwnd: ${payload.hwnd ?? "null"}`,
    `conflict: ${Boolean(payload.conflict)}`,
    payload.conflictReason ? `conflictReason: ${payload.conflictReason}` : null,
    ``,
    `--- Call Chain ---`,
    ...(Array.isArray(callChain) && callChain.length
      ? callChain.map((c, idx) => `${idx + 1}. [${c.ts || ""}] ${c.step} -> ${c.outcome || ""}`)
      : ["(none)"]),
    ``,
    `--- Execution Logs ---`,
    ...(capped.lines.length ? capped.lines : ["(no log lines)"]),
    errorStack ? `\n--- Error Stack ---\n${String(errorStack).slice(0, 65536)}` : "",
    ``,
  ]
    .filter((x) => x !== null)
    .join("\n");

  await writeTextArtifact(
    dshCtx,
    workspaceRoot,
    logRel,
    logText,
    wsCtx.resolution,
    wsCtx.activeWorkspaceRoot
  );
  const logArtifact = await buildArtifactDescriptor(workspaceRoot, logRel, "log");
  if (logArtifact) recordedArtifacts.push(logArtifact);

  const resultRel = `result_${safeId}.json`;
  const sidecarRel = `result_${safeId}.sha256`;
  const resultPayload = {
    ...payload,
    taskId: safeId,
    deliveredAt: new Date().toISOString(),
    workspaceRoot,
    workspaceResolution: wsCtx.resolution,
    sessionId: wsCtx.sessionId,
    logsTruncated: capped.truncated,
    resultSidecarPath: sidecarRel,
    artifacts: recordedArtifacts,
  };
  await writeTextArtifact(
    dshCtx,
    workspaceRoot,
    resultRel,
    JSON.stringify(resultPayload, null, 2) + "\n",
    wsCtx.resolution,
    wsCtx.activeWorkspaceRoot
  );

  const resultDescriptor = await buildArtifactDescriptor(workspaceRoot, resultRel, "result");
  if (resultDescriptor) {
    await writeTextArtifact(
      dshCtx,
      workspaceRoot,
      sidecarRel,
      `${resultDescriptor.sha256} *${path.basename(resultRel)}\n`,
      wsCtx.resolution,
      wsCtx.activeWorkspaceRoot
    );
  }

  const indexRel = "output/artifacts.index.json";
  let existingIndex = { updatedAt: new Date().toISOString(), tasks: {} };
  try {
    const idxAbs = path.resolve(workspaceRoot, indexRel);
    assertNoReparseEscape(workspaceRoot, idxAbs);
    const raw = await fsp.readFile(idxAbs, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.tasks) existingIndex = parsed;
  } catch {}
  existingIndex.updatedAt = new Date().toISOString();
  existingIndex.tasks[safeId] = {
    taskId: safeId,
    status: payload.status,
    pid: payload.pid ?? null,
    targetPid: payload.targetPid ?? null,
    ownedPid: payload.ownedPid ?? null,
    hwnd: payload.hwnd ?? null,
    progress: payload.progress ?? 0,
    conflict: Boolean(payload.conflict),
    conflictReason: payload.conflictReason || "",
    nextAction: payload.nextAction || "",
    deliveredAt: resultPayload.deliveredAt,
    resultPath: resultRel,
    resultSha256: resultDescriptor?.sha256 || null,
    resultBytes: resultDescriptor?.bytes ?? null,
    resultSidecarPath: sidecarRel,
    artifacts: recordedArtifacts,
  };
  await writeTextArtifact(
    dshCtx,
    workspaceRoot,
    indexRel,
    JSON.stringify(existingIndex, null, 2) + "\n",
    wsCtx.resolution,
    wsCtx.activeWorkspaceRoot
  );

  return {
    workspaceRoot,
    workspaceResolution: wsCtx.resolution,
    sessionId: wsCtx.sessionId,
    resultPath: resultRel,
    resultSidecarPath: sidecarRel,
    resultDescriptor,
    logPath: logRel,
    artifacts: recordedArtifacts,
    resultPayload,
  };
}

export {
  MAX_LOG_LINES,
  MAX_LOG_BYTES,
  TASK_ID_REGEX,
  WINDOWS_RESERVED_NAME_RE,
  isWindowsReservedName,
  sanitizeTaskId,
  sanitizeSessionFolder,
  sanitizeOutputName,
  assertContainedPath,
  assertNoReparseEscape,
  assertMatchesWriteScope,
  resolveWorkspaceContext,
  resolveWorkspaceRoot,
  writeTextArtifact,
  copyOutputFileToWorkspace,
  computeFileSha256Stream,
  buildArtifactDescriptor,
  listOutputFilesForTask,
  deliverTaskArtifacts,
};

export default {
  MAX_LOG_LINES,
  MAX_LOG_BYTES,
  TASK_ID_REGEX,
  WINDOWS_RESERVED_NAME_RE,
  isWindowsReservedName,
  sanitizeTaskId,
  sanitizeSessionFolder,
  sanitizeOutputName,
  assertContainedPath,
  assertNoReparseEscape,
  assertMatchesWriteScope,
  resolveWorkspaceContext,
  resolveWorkspaceRoot,
  writeTextArtifact,
  copyOutputFileToWorkspace,
  computeFileSha256Stream,
  buildArtifactDescriptor,
  listOutputFilesForTask,
  deliverTaskArtifacts,
};
