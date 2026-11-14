import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import defaultWin32 from "./win32-bridge.js";
import { enforceFocusGuard } from "./focus-guard.js";
import {
  deliverTaskArtifacts,
  resolveWorkspaceContext,
  sanitizeOutputName,
  sanitizeTaskId,
  writeTextArtifact,
} from "./artifacts.js";

function createTaskId(prefix = "dsh") {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString("hex");
  return `${prefix}_${ts}_${rand}`;
}
const TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled",
  "closed",
  "failed",
  "unsupported_uwp",
  "unsupported",
  "unsupported_unverified_target",
  "unsupported_existing_instance",
  "unsupported_unverified_com",
]);
class DshJobQueue {
  constructor(options = {}) {
    this.dshCtx = options.dshCtx || options.piApi || null;
    this.piApi = this.dshCtx;
    this.hostJobs = options.hostJobs || null;
    this.probe = options.probe || null;
    this.workspaceRoot = options.workspaceRoot || null;
    this.win32 = options.win32 || defaultWin32;
    this.settings = options.settings || {};
    this.jobs = new Map();
    this.runningService = false;
    this.listeners = new Set();
  }

  updateSettings(settings) {
    this.settings = { ...(this.settings || {}), ...(settings || {}) };
  }

  setHostJobs(hostJobs) {
    this.hostJobs = hostJobs || null;
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event, job) {
    const snapshot = this.toPublicRecord(job);
    for (const fn of this.listeners) {
      try { fn(event, snapshot); } catch {}
    }
  }

  toPublicRecord(job) {
    if (!job) return null;
    return {
      taskId: job.taskId,
      jobHandle: job.taskId,
      kind: job.kind,
      status: job.status,
      pid: job.ownedPid ?? job.targetPid ?? null,
      targetPid: job.targetPid ?? null,
      ownedPid: job.ownedPid ?? null,
      ownedPids: Array.isArray(job.ownedPids) ? [...job.ownedPids] : [],
      verifiedPid: job.verifiedPid ?? null,
      hwnd: job.hwnd ?? null,
      progress: Number(job.progress ?? 0),
      conflict: Boolean(job.conflict),
      conflictReason: job.conflictReason || "",
      nextAction: job.nextAction || "",
      checkpoint: job.checkpoint || null,
      workspaceResolution: job.workspaceResolution || null,
      sessionId: job.sessionId || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      result: job.result ?? null,
      resultSidecarPath: job.resultSidecarPath || null,
      artifacts: Array.isArray(job.artifacts) ? job.artifacts : [],
      hostJobId: job.hostJobId || null,
    };
  }

  async persistState(job) {
    try {
      const wsCtx =
        job?.workspaceRoot && job?.workspaceResolution
          ? {
              workspaceRoot: job.workspaceRoot,
              resolution: job.workspaceResolution,
              activeWorkspaceRoot: job.activeWorkspaceRoot || null,
            }
          : await resolveWorkspaceContext(
              this.piApi,
              job?.workspaceRoot || this.workspaceRoot,
              job?.sessionId
            );
      const stateRel = "output/jobs.state.json";
      const all = {};
      for (const [id, entry] of this.jobs.entries()) {
        all[id] = this.toPublicRecord(entry);
      }
      await writeTextArtifact(
        this.piApi,
        wsCtx.workspaceRoot,
        stateRel,
        JSON.stringify({ updatedAt: new Date().toISOString(), jobs: all }, null, 2) + "\n",
        wsCtx.resolution,
        wsCtx.activeWorkspaceRoot
      );
    } catch {}
  }

  async loadPersistedState(overrideRoot, sessionId) {
    try {
      const wsCtx = await resolveWorkspaceContext(this.piApi, overrideRoot || this.workspaceRoot, sessionId);
      const raw = await fsp.readFile(path.resolve(wsCtx.workspaceRoot, "output/jobs.state.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.jobs && typeof parsed.jobs === "object") {
        for (const [id, rec] of Object.entries(parsed.jobs)) {
          if (!this.jobs.has(id) && rec && typeof rec === "object") {
            this.jobs.set(id, {
              ...rec,
              targetPid: rec.targetPid ?? null,
              ownedPid: rec.ownedPid ?? null,
              ownedPids: Array.isArray(rec.ownedPids) ? rec.ownedPids : (rec.ownedPid ? [rec.ownedPid] : []),
              logLines: [],
              callChain: [],
              abortController: new AbortController(),
              runner: null,
              target: null,
              restoredFromDisk: true,
              suspendedProcess: false,
            });
          }
        }
      }
    } catch {}
  }

  appendLog(job, line) {
    if (job.logLines.length >= 20000) {
      if (!job.logCapNotified) {
        job.logLines.push(`[${new Date().toISOString()}] [TRUNCATED: in-memory log line cap reached]`);
        job.logCapNotified = true;
      }
      return;
    }
    const entry = `[${new Date().toISOString()}] ${line}`;
    job.logLines.push(entry);
    if (typeof job.hostLog === "function") {
      try { job.hostLog(`[${job.taskId}] ${line}`); } catch {}
    }
    if (job.hostHandle && typeof job.hostHandle.append === "function") {
      try { job.hostHandle.append(entry + "\n"); } catch {}
    }
  }

  addChain(job, step, outcome) {
    job.callChain.push({
      ts: new Date().toISOString(),
      step,
      outcome,
    });
  }

  attachToContext(ctx = {}) {
    const hostJobs = (ctx && ctx.jobs && typeof ctx.jobs === "object" ? ctx.jobs : null) || this.hostJobs;
    const queue = this;
    const jobsFacade = {
      isHostProvided: Boolean(hostJobs),
      submit: (spec) => queue.submit(spec, { ...ctx, jobs: hostJobs }),
      pause: (taskId, checkpoint) => queue.pause(taskId, checkpoint, hostJobs),
      resume: (taskId, resumeOpts) => queue.resume(taskId, { ...ctx, jobs: hostJobs }, resumeOpts),
      cancel: (taskId, reason) => queue.cancel(taskId, reason, hostJobs),
      close: (taskId, reason) => queue.close(taskId, reason, hostJobs),
      get: (taskId) => queue.inspect(taskId),
      inspect: (taskId) => queue.inspect(taskId),
      list: (filter) => queue.list(filter),
      checkpoint: (taskId, data) => queue.saveCheckpoint(taskId, data),
    };
    return {
      ...ctx,
      jobs: jobsFacade,
    };
  }

  async submit(spec, ctx = {}) {
    let taskId;
    if (spec.taskId !== undefined && spec.taskId !== null) {
      taskId = sanitizeTaskId(spec.taskId);
    } else {
      taskId = createTaskId(spec.kind || "job");
    }

    if (this.jobs.has(taskId)) {
      if (spec.allowDuplicateSuffix === true) {
        const suffix = crypto.randomBytes(2).toString("hex");
        const prefix = taskId.slice(0, 64 - 1 - suffix.length);
        taskId = sanitizeTaskId(`${prefix}_${suffix}`);
      } else {
        throw new Error(`Duplicate taskId "${taskId}": taskId already exists in queue.`);
      }
    }

    const wsCtx = await resolveWorkspaceContext(
      this.dshCtx,
      spec.workspaceRoot || this.workspaceRoot,
      { sessionId: ctx?.sessionId, agent: ctx?.agent, signal: ctx?.signal }
    );
    const controller = new AbortController();

    if (ctx?.signal) {
      if (ctx.signal.aborted) {
        controller.abort(ctx.signal.reason || new Error("Host tool signal aborted"));
      } else {
        ctx.signal.addEventListener(
          "abort",
          () => {
            if (spec.cancelOnSignalAbort !== false) {
              this.cancel(taskId, "Host invocation signal aborted").catch(() => {});
            }
          },
          { once: true }
        );
      }
    }

    const hoverThreshold = Number.isFinite(Number(this.settings?.hoverActiveThresholdMs))
      ? Number(this.settings.hoverActiveThresholdMs)
      : 1500;

    const initialOwnedPids = [];
    if (Array.isArray(spec.ownedPids)) {
      for (const p of spec.ownedPids) {
        const n = Number(p);
        if (Number.isFinite(n) && n > 0 && !initialOwnedPids.includes(n)) initialOwnedPids.push(n);
      }
    }
    if (spec.ownedPid && Number(spec.ownedPid) > 0 && !initialOwnedPids.includes(Number(spec.ownedPid))) {
      initialOwnedPids.unshift(Number(spec.ownedPid));
    }

    const job = {
      taskId,
      kind: String(spec.kind || "generic"),
      status: "pending",
      targetPid: spec.targetPid ?? spec.target?.pid ?? null,
      ownedPid: spec.ownedPid ?? (initialOwnedPids[0] ?? null),
      ownedPids: initialOwnedPids,
      verifiedPid: spec.verifiedPid ?? null,
      hwnd: spec.hwnd ?? spec.target?.hwnd ?? null,
      progress: 0,
      conflict: false,
      conflictReason: "",
      nextAction: "",
      checkpoint: spec.checkpoint || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      errorStack: "",
      result: null,
      resultSidecarPath: null,
      artifacts: [],
      outputFiles: Array.isArray(spec.outputFiles) ? [...spec.outputFiles] : [],
      inlineOutputs: Array.isArray(spec.inlineOutputs) ? [...spec.inlineOutputs] : [],
      logLines: [],
      logCapNotified: false,
      callChain: [],
      abortController: controller,
      target: spec.target || {},
      guardOptions: {
        hoverActiveThresholdMs: hoverThreshold,
        ...(spec.guardOptions || {}),
      },
      runner: spec.run,
      precheckResult: spec.precheckResult || null,
      workspaceRoot: wsCtx.workspaceRoot,
      workspaceResolution: wsCtx.resolution,
      activeWorkspaceRoot: wsCtx.activeWorkspaceRoot || null,
      sessionId: wsCtx.sessionId || ctx?.sessionId || null,
      agent: ctx?.agent || null,
      hostLog: ctx?.log,
      hostJobId: null,
      hostHandle: null,
      hostSettleResolve: null,
      hostOwnerId: ctx?.agent?.id || undefined,
      suspendedProcess: false,
      pauseGateResolve: null,
    };
    this.jobs.set(taskId, job);
    this.appendLog(job, `Submitted job ${taskId} (kind=${job.kind}, ws=${wsCtx.resolution}) to job queue`);
    this.addChain(job, "queue.submit", "queued");
    this.emit("submitted", job);

    const hostJobs = (ctx?.jobs && !ctx.jobs.isHostProvided ? ctx.jobs : null) || this.hostJobs;
    if (hostJobs && typeof hostJobs.start === "function") {
      try {
        let settleResolve = null;
        const donePromise = new Promise((resolve) => {
          settleResolve = resolve;
        });
        job.hostSettleResolve = settleResolve;
        const dshJobId = hostJobs.start({
          kind: `bg_${job.kind}`,
          label: `${taskId} (${job.kind})`,
          ...(ctx?.callId && ctx?.rootCallId
            ? { toolCall: { callId: ctx.callId, rootCallId: ctx.rootCallId } }
            : {}),
          ...(ctx?.agent?.id ? { owner: ctx.agent.id } : {}),
          run: (handle) => {
            job.hostHandle = handle;
            return {
              done: donePromise,
              cancel: (reason) => {
                this.cancel(taskId, reason || "Cancelled via DSH ctx.jobs").catch(() => {});
              },
            };
          },
        });
        job.hostJobId = dshJobId;
        this.addChain(job, "host.ctx.jobs.start", `registered:${job.hostJobId}`);
      } catch (err) {
        this.appendLog(job, `DSH ctx.jobs.start notice: ${err.message}`);
      }
    } else if (hostJobs && typeof hostJobs.submit === "function") {
      try {
        const hostHandle = await hostJobs.submit({ taskId, kind: job.kind, target: job.target });
        job.hostJobId = hostHandle?.jobId || hostHandle?.id || taskId;
        this.addChain(job, "host.ctx.jobs.submit", `delegated:${job.hostJobId}`);
      } catch (err) {
        this.appendLog(job, `Host ctx.jobs bridge notice: ${err.message}`);
      }
    }

    const runPromise = this._executeJob(job);

    if (spec.async === true) {
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 120))]);
      await this.persistState(job);
      return this.toPublicRecord(job);
    }

    await runPromise;
    return this.toPublicRecord(job);
  }

  async _executeJob(job) {
    try {
      if (job.status === "paused") {
        await this._waitWhilePaused(job);
      }
      if (job.abortController.signal.aborted) {
        throw Object.assign(new Error("Job cancelled before execution"), { name: "AbortError" });
      }

      if (job.precheckResult && typeof job.precheckResult === "object") {
        const pre = job.precheckResult;
        job.status = pre.status || "unsupported";
        job.progress = 1;
        job.conflict = false;
        job.conflictReason = "";
        job.nextAction = pre.nextAction || "";
        job.error = pre.error || `Target is ${job.status} by this background control tool.`;
        if (pre.hwnd !== undefined) job.hwnd = pre.hwnd;
        if (pre.verifiedPid !== undefined) job.verifiedPid = pre.verifiedPid;
        job.result = pre;
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        this.appendLog(job, `Job ${job.taskId} ${job.status}: ${job.error}`);
        this.addChain(job, "job.precheck", job.status);
        await this._deliver(job);
        this.emit("failed", job);
        return;
      }

      // Mandatory Hard Foreground Focus Guard (never skipped)
      const guard = await enforceFocusGuard(job.target || {}, {
        ...job.guardOptions,
        probe: this.probe || job.guardOptions?.probe,
        signal: job.abortController.signal,
      });
      this.addChain(job, "focus_guard.enforce", guard.allowed ? "allowed" : "conflict_refused");
      if (!guard.allowed) {
        job.status = "human_intervened";
        job.conflict = true;
        job.conflictReason = guard.conflictReason;
        job.nextAction = guard.nextAction;
        job.updatedAt = new Date().toISOString();
        this.appendLog(job, `HARD FOCUS GUARD REFUSED: ${guard.conflictReason}`);
        await this._deliver(job);
        this.emit("conflict", job);
        return;
      }

      job.status = "running";
      job.conflict = false;
      job.conflictReason = "";
      job.progress = Math.max(job.progress || 0, 0.1);
      job.updatedAt = new Date().toISOString();
      this.emit("running", job);

      const jobCtx = {
        taskId: job.taskId,
        signal: job.abortController.signal,
        getCheckpoint: () => job.checkpoint,
        setCheckpoint: async (cp) => {
          job.checkpoint = cp;
          job.updatedAt = new Date().toISOString();
          await this.persistState(job);
        },
        setOwnedProcess: (ownedPid, hwnd, actualProcessName, ownedPids) => {
          const pidList = [];
          if (Array.isArray(ownedPids)) {
            for (const p of ownedPids) {
              const n = Number(p);
              if (Number.isFinite(n) && n > 0 && !pidList.includes(n)) pidList.push(n);
            }
          }
          if (ownedPid) {
            const mainOwned = Number(ownedPid);
            if (Number.isFinite(mainOwned) && mainOwned > 0) {
              job.ownedPid = mainOwned;
              if (!pidList.includes(mainOwned)) pidList.unshift(mainOwned);
            }
          }
          if (pidList.length > 0) {
            const merged = new Set([...(job.ownedPids || []), ...pidList]);
            job.ownedPids = Array.from(merged);
            if (!job.ownedPid) job.ownedPid = job.ownedPids[0];
          }
          if (hwnd !== undefined) job.hwnd = hwnd;
          if (actualProcessName) {
            job.target = {
              ...(job.target || {}),
              pid: job.ownedPid || job.target?.pid,
              hwnd: hwnd ?? job.target?.hwnd,
              processName: actualProcessName,
            };
          }
          job.updatedAt = new Date().toISOString();
        },
        setVerifiedTarget: (targetPid, hwnd) => {
          if (targetPid) {
            job.targetPid = Number(targetPid);
            job.verifiedPid = Number(targetPid);
          }
          if (hwnd !== undefined) job.hwnd = hwnd;
          job.updatedAt = new Date().toISOString();
        },
        updateTarget: (patch) => {
          job.target = { ...(job.target || {}), ...(patch || {}) };
        },
        setProgress: (p) => {
          job.progress = Math.max(0, Math.min(1, Number(p) || 0));
          job.updatedAt = new Date().toISOString();
          this.emit("progress", job);
        },
        log: (msg) => this.appendLog(job, msg),
        chain: (step, outcome) => this.addChain(job, step, outcome),
        addOutputFile: (filePath, name) => {
          if (name !== undefined && name !== null) sanitizeOutputName(name);
          job.outputFiles.push(name ? { path: filePath, name } : filePath);
        },
        addInlineOutput: (name, content) => {
          sanitizeOutputName(name);
          job.inlineOutputs.push({ name, content });
        },
        waitIfPaused: () => this._waitWhilePaused(job),
        checkFocusGuard: async (overrideTarget) => {
          return enforceFocusGuard(overrideTarget || job.target || {}, {
            ...job.guardOptions,
            probe: this.probe || job.guardOptions?.probe,
            signal: job.abortController.signal,
          });
        },
      };

      const output = await job.runner(jobCtx);

      if (job.status === "human_intervened") {
        await this._deliver(job);
        this.emit("conflict", job);
        return;
      }

      if (output && typeof output === "object") {
        if (output.conflict === true) {
          job.status = "human_intervened";
          job.conflict = true;
          job.conflictReason = output.conflictReason || "Foreground interaction detected";
          job.nextAction = output.nextAction || "Wait for user confirmation before resuming.";
          if (output.verifiedPid) job.verifiedPid = output.verifiedPid;
          if (output.hwnd !== undefined) job.hwnd = output.hwnd;
          job.result = output;
          job.updatedAt = new Date().toISOString();
          await this._deliver(job);
          this.emit("conflict", job);
          return;
        }
        if (
          output.status === "unsupported" ||
          output.status === "unsupported_unverified_target" ||
          output.status === "unsupported_existing_instance" ||
          output.status === "unsupported_unverified_com"
        ) {
          job.status = output.status;
          job.progress = 1;
          job.conflict = false;
          job.conflictReason = "";
          job.nextAction = output.nextAction || "";
          job.error = output.error || `Target is ${output.status} by this background control tool.`;
          if (output.hwnd !== undefined) job.hwnd = output.hwnd;
          if (output.verifiedPid !== undefined) job.verifiedPid = output.verifiedPid;
          job.result = output;
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
          this.appendLog(job, `Job ${job.taskId} ${output.status}: ${job.error}`);
          this.addChain(job, "job.finish", output.status);
          await this._deliver(job);
          this.emit("failed", job);
          return;
        }
        if (output.status === "unsupported_uwp") {
          job.status = "unsupported_uwp";
          job.progress = 1;
          job.error = output.error || "UWP/Store app exited without controllable background window.";
          job.hwnd = null;
          job.result = output;
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
          this.appendLog(job, `Job ${job.taskId} unsupported_uwp: ${job.error}`);
          this.addChain(job, "job.finish", "unsupported_uwp");
          await this._deliver(job);
          this.emit("failed", job);
          return;
        }
        if (output.status === "partial") {
          job.status = "partial";
          job.progress = 0.5;
          if (output.pid) job.ownedPid = Number(output.pid);
          job.hwnd = output.hwnd ?? null;
          job.nextAction = output.nextAction || "call bg_query_state with processName to find hwnd";
          job.result = output;
          job.updatedAt = new Date().toISOString();
          this.appendLog(job, `Job ${job.taskId} partial: ${job.nextAction}`);
          this.addChain(job, "job.finish", "partial");
          await this._deliver(job);
          this.emit("partial", job);
          return;
        }
        if (output.hwnd !== undefined) job.hwnd = output.hwnd;
        if (output.verifiedPid !== undefined) job.verifiedPid = output.verifiedPid;
      }

      job.status = "completed";
      job.progress = 1;
      job.result = output ?? { ok: true };
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      this.appendLog(job, `Job ${job.taskId} completed successfully`);
      this.addChain(job, "job.finish", "completed");
      await this._deliver(job);
      this.emit("completed", job);
    } catch (err) {
      if (job.status === "paused") {
        await this.persistState(job);
        return;
      }
      if (job.status === "cancelled") {
        await this._deliver(job);
        return;
      }
      const isAbort = err?.name === "AbortError" || job.abortController.signal.aborted;
      job.status = isAbort ? "cancelled" : "failed";
      job.error = isAbort ? (err?.message || "Job cancelled") : (err?.message || String(err));
      job.errorStack = err?.stack || String(err);
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      this.appendLog(job, `Job ${job.taskId} ${job.status}: ${job.error}`);
      this.addChain(job, "job.finish", job.status);
      await this._deliver(job);
      this.emit(job.status, job);
    }
  }

  _waitWhilePaused(job) {
    if (job.status !== "paused") return Promise.resolve();
    return new Promise((resolve) => {
      job.pauseGateResolve = resolve;
    });
  }

  _settleHostJobIfNeeded(job) {
    if (typeof job.hostSettleResolve === "function" && TERMINAL_STATUSES.has(job.status)) {
      const resolve = job.hostSettleResolve;
      job.hostSettleResolve = null;
      const mappedStatus =
        job.status === "completed"
          ? "completed"
          : job.status === "cancelled" || job.status === "closed"
          ? "killed"
          : "failed";
      try {
        resolve({
          status: mappedStatus,
          detail: job.error || job.nextAction || job.status,
        });
      } catch {}
    }
  }

  async _deliver(job) {
    this._settleHostJobIfNeeded(job);
    const delivered = await deliverTaskArtifacts({
      dshCtx: this.dshCtx,
      workspaceRoot: job.workspaceRoot,
      workspaceResolution: job.workspaceResolution,
      activeWorkspaceRoot: job.activeWorkspaceRoot,
      sessionId: job.sessionId,
      taskId: job.taskId,
      payload: {
        taskId: job.taskId,
        status: job.status,
        pid: job.ownedPid ?? job.targetPid ?? null,
        targetPid: job.targetPid ?? null,
        ownedPid: job.ownedPid ?? null,
        ownedPids: Array.isArray(job.ownedPids) ? [...job.ownedPids] : [],
        verifiedPid: job.verifiedPid ?? null,
        hwnd: job.hwnd ?? null,
        progress: job.progress,
        conflict: Boolean(job.conflict),
        conflictReason: job.conflictReason || "",
        nextAction: job.nextAction || "",
        kind: job.kind,
        checkpoint: job.checkpoint,
        error: job.error,
        result: job.result,
      },
      logLines: job.logLines,
      callChain: job.callChain,
      errorStack: job.errorStack,
      outputFiles: job.outputFiles,
      inlineOutputs: job.inlineOutputs,
    });
    job.artifacts = delivered.artifacts;
    job.resultSidecarPath = delivered.resultSidecarPath;
    job.workspaceResolution = delivered.workspaceResolution;
    await this.persistState(job);
  }
  async saveCheckpoint(taskId, data) {
    const job = this.jobs.get(taskId);
    if (!job) throw new Error(`Job not found: ${taskId}`);
    job.checkpoint = { ...(job.checkpoint || {}), ...data, savedAt: new Date().toISOString() };
    job.updatedAt = new Date().toISOString();
    this.appendLog(job, `Saved checkpoint: ${JSON.stringify(job.checkpoint)}`);
    await this.persistState(job);
    return this.toPublicRecord(job);
  }

  _getOwnedPidList(job) {
    const out = [];
    const candidates = [...(Array.isArray(job?.ownedPids) ? job.ownedPids : []), job?.ownedPid];
    for (const raw of candidates) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n !== job?.targetPid && !out.includes(n)) {
        out.push(n);
      }
    }
    return out;
  }

  async pause(taskId, checkpoint, hostJobs) {
    const job = this.jobs.get(taskId);
    if (!job) throw new Error(`Job not found: ${taskId}`);
    if (TERMINAL_STATUSES.has(job.status)) {
      return this.toPublicRecord(job);
    }
    if (checkpoint) {
      job.checkpoint = { ...(job.checkpoint || {}), ...checkpoint, savedAt: new Date().toISOString() };
    }
    // Only ownedPids may be suspended; targetPid is NEVER suspended
    const ownedList = this._getOwnedPidList(job);
    for (const pid of ownedList) {
      if (!job.suspendedProcess || ownedList.length > 1) {
        try {
          const res = await this.win32.suspendOrResumeProcess(pid, "suspend");
          if (res?.ok) {
            job.suspendedProcess = true;
            this.appendLog(job, `Suspended owned OS process PID ${pid}`);
          }
        } catch (err) {
          this.appendLog(job, `Process suspend fallback to gate pause for PID ${pid} (${err.message})`);
        }
      }
    }
    job.status = "paused";
    job.nextAction = "Call bg_job_control(action='resume') after verifying foreground safety.";
    job.updatedAt = new Date().toISOString();
    this.addChain(job, "queue.pause", "paused");

    if (hostJobs && typeof hostJobs.pause === "function" && job.hostJobId) {
      try { await hostJobs.pause(job.hostJobId); } catch {}
    }
    await this.persistState(job);
    this.emit("paused", job);
    return this.toPublicRecord(job);
  }

  async resume(taskId, ctx = {}, options = {}) {
    const job = this.jobs.get(taskId);
    if (!job) throw new Error(`Job not found: ${taskId}`);
    if (TERMINAL_STATUSES.has(job.status)) {
      return this.toPublicRecord(job);
    }

    // Hard Focus Guard check before resuming (cannot be bypassed)
    if (options.forceUnsafeSkip !== true) {
      const guard = await enforceFocusGuard(job.target || {}, {
        ...job.guardOptions,
        probe: this.probe || job.guardOptions?.probe,
        signal: ctx?.signal,
      });
      this.addChain(job, "focus_guard.resume_check", guard.allowed ? "allowed" : "conflict_refused");
      if (!guard.allowed) {
        job.status = "human_intervened";
        job.conflict = true;
        job.conflictReason = guard.conflictReason;
        job.nextAction = guard.nextAction;
        job.updatedAt = new Date().toISOString();
        this.appendLog(job, `RESUME REFUSED BY FOCUS GUARD: ${guard.conflictReason}`);
        await this._deliver(job);
        this.emit("conflict", job);
        return this.toPublicRecord(job);
      }
    }

    const ownedList = this._getOwnedPidList(job);
    if (ownedList.length > 0 && job.suspendedProcess) {
      for (const pid of ownedList) {
        try {
          const res = await this.win32.suspendOrResumeProcess(pid, "resume");
          if (res?.ok) {
            this.appendLog(job, `Resumed owned OS process PID ${pid}`);
          }
        } catch (err) {
          this.appendLog(job, `Process resume notice for PID ${pid}: ${err.message}`);
        }
      }
      job.suspendedProcess = false;
    }

    job.status = "running";
    job.conflict = false;
    job.conflictReason = "";
    job.nextAction = "";
    job.updatedAt = new Date().toISOString();
    this.addChain(job, "queue.resume", "running");

    if (typeof job.pauseGateResolve === "function") {
      const resolve = job.pauseGateResolve;
      job.pauseGateResolve = null;
      resolve();
    } else if (job.restoredFromDisk && typeof job.runner !== "function") {
      this.appendLog(job, "Restored job resumed with preserved checkpoint.");
    }

    const hostJobs = ctx?.jobs && !ctx.jobs.isHostProvided ? ctx.jobs : null;
    if (hostJobs && typeof hostJobs.resume === "function" && job.hostJobId) {
      try { await hostJobs.resume(job.hostJobId); } catch {}
    }
    await this.persistState(job);
    this.emit("resumed", job);
    return this.toPublicRecord(job);
  }

  async cancel(taskId, reason = "Cancelled by bg_job_control", hostJobs) {
    const job = this.jobs.get(taskId);
    if (!job) throw new Error(`Job not found: ${taskId}`);
    if (TERMINAL_STATUSES.has(job.status)) return this.toPublicRecord(job);

    const ownedList = this._getOwnedPidList(job);
    if (ownedList.length > 0 && job.suspendedProcess) {
      for (const pid of ownedList) {
        try { await this.win32.suspendOrResumeProcess(pid, "resume"); } catch {}
      }
      job.suspendedProcess = false;
    }

    job.abortController.abort(new Error(reason));
    // Only ownedPids may be terminated; targetPid is NEVER killed
    for (const pid of ownedList) {
      try {
        await this.win32.terminateProcessTree(pid);
        this.appendLog(job, `Terminated owned process tree PID ${pid}`);
      } catch {}
    }

    if (typeof job.pauseGateResolve === "function") {
      const resolve = job.pauseGateResolve;
      job.pauseGateResolve = null;
      resolve();
    }

    job.status = "cancelled";
    job.error = reason;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    this.appendLog(job, `Job cancelled: ${reason}`);
    this.addChain(job, "queue.cancel", "cancelled");

    if (hostJobs && typeof hostJobs.cancel === "function" && job.hostJobId) {
      try { await hostJobs.cancel(job.hostJobId); } catch {}
    }

    await this._deliver(job);
    this.emit("cancelled", job);
    return this.toPublicRecord(job);
  }

  async close(taskId, reason = "Closed by bg_job_control", hostJobs) {
    const job = this.jobs.get(taskId);
    if (!job) throw new Error(`Job not found: ${taskId}`);
    if (job.status === "closed") return this.toPublicRecord(job);

    const ownedList = this._getOwnedPidList(job);
    if (ownedList.length === 0) {
      throw new Error(
        `Job "${taskId}" has no plugin-owned processes to close (targetPid=${job.targetPid ?? "none"} is never terminated).`
      );
    }

    if (job.suspendedProcess) {
      for (const pid of ownedList) {
        try { await this.win32.suspendOrResumeProcess(pid, "resume"); } catch {}
      }
      job.suspendedProcess = false;
    }

    if (!TERMINAL_STATUSES.has(job.status)) {
      job.abortController.abort(new Error(reason));
    }

    // Only ownedPids may be terminated; targetPid is NEVER killed
    for (const pid of ownedList) {
      try {
        await this.win32.terminateProcessTree(pid);
        this.appendLog(job, `Closed owned process tree PID ${pid}`);
      } catch {}
    }

    if (typeof job.pauseGateResolve === "function") {
      const resolve = job.pauseGateResolve;
      job.pauseGateResolve = null;
      resolve();
    }

    job.status = "closed";
    job.error = reason;
    job.nextAction = "";
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    this.appendLog(job, `Job closed: ${reason}`);
    this.addChain(job, "queue.close", "closed");

    if (hostJobs && typeof hostJobs.cancel === "function" && job.hostJobId) {
      try { await hostJobs.cancel(job.hostJobId); } catch {}
    }

    await this._deliver(job);
    this.emit("closed", job);
    return this.toPublicRecord(job);
  }

  /**
   * Release all suspended processes and cleanly shut down active jobs on service stop / plugin unload.
   * Never leaves any OS process suspended.
   * Completed/partial launched processes are preserved by default (closeCompletedLaunchOnShutdown=false)
   * unless closeCompletedLaunchOnShutdown=true is configured; explicit closing uses action='close'.
   */
  async releaseAllOnShutdown(reason = "Service stopped / plugin unloaded") {
    const closeCompleted = this.settings?.closeCompletedLaunchOnShutdown === true;
    for (const job of this.jobs.values()) {
      const ownedList = this._getOwnedPidList(job);
      if (job.suspendedProcess && ownedList.length > 0) {
        for (const pid of ownedList) {
          try {
            await this.win32.suspendOrResumeProcess(pid, "resume");
            this.appendLog(job, `Shutdown safeguard resumed owned PID ${pid}`);
          } catch (err) {
            this.appendLog(job, `Shutdown resume notice for PID ${pid}: ${err.message}`);
          }
        }
        job.suspendedProcess = false;
      }
      if (job.status === "running" || job.status === "pending" || job.status === "paused") {
        if (ownedList.length > 0) {
          try {
            await this.cancel(job.taskId, reason);
          } catch {}
        } else {
          job.status = "paused";
          job.suspendedProcess = false;
          job.nextAction = "Paused without OS suspension across plugin restart.";
          job.updatedAt = new Date().toISOString();
          await this.persistState(job);
        }
      } else if ((job.status === "completed" || job.status === "partial") && ownedList.length > 0) {
        if (closeCompleted) {
          try {
            await this.close(job.taskId, reason);
          } catch {}
        } else {
          this.appendLog(
            job,
            `Shutdown policy preserved ${job.status} ownedPids=${JSON.stringify(ownedList)} (closeCompletedLaunchOnShutdown=false); call action='close' to terminate explicitly.`
          );
        }
      }
    }
  }
  inspect(taskId) {
    const job = this.jobs.get(taskId);
    return job ? this.toPublicRecord(job) : null;
  }

  list(filter = {}) {
    const items = [];
    for (const job of this.jobs.values()) {
      if (filter.status && job.status !== filter.status) continue;
      if (filter.kind && job.kind !== filter.kind) continue;
      items.push(this.toPublicRecord(job));
    }
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return items;
  }
}

export {
  createTaskId,
  TERMINAL_STATUSES,
  DshJobQueue,
};
export default {
  createTaskId,
  TERMINAL_STATUSES,
  DshJobQueue,
};
