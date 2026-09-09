import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonLineDecoder, encodeFrame } from "./framing.mjs";

const KERNEL_FRAME_BYTES = 1024 * 1024;

class OutputCollector {
  constructor({ maxBytes, onUpdate }) {
    this.maxBytes = maxBytes;
    this.onUpdate = onUpdate;
    this.stdout = "";
    this.stderr = "";
    this.totalBytes = 0;
    this.stdoutTruncated = false;
    this.stderrTruncated = false;
    this.outputs = [];
    this.mime = null;
    this.richOutputBytes = 0;
    this.richOutputLimit = KERNEL_FRAME_BYTES;
    this.richTruncated = false;
  }

  addText(text) {
    if (!text) return;
    const last = this.outputs.at(-1);
    if (last && typeof last.text === "string") this.outputs[this.outputs.length - 1] = { text: last.text + text };
    else this.outputs.push({ text });
  }

  add(stream, chunk) {
    const text = chunk.toString("utf8");
    const bytes = Buffer.from(text);
    this.totalBytes += bytes.length;
    const key = stream === "stderr" ? "stderr" : "stdout";
    let captured = "";
    if (!this[`${key}Truncated`]) {
      const remaining = this.maxBytes - Buffer.byteLength(this[key]);
      let end = Math.min(bytes.length, remaining);
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
      captured = bytes.subarray(0, end).toString("utf8");
      this[key] += captured;
      this.addText(captured);
      if (bytes.length > remaining) {
        this[`${key}Truncated`] = true;
        const marker = `\n[... output truncated at ${this.maxBytes} bytes ...]`;
        this.addText(marker); captured += marker;
      }
    }
    if (captured) this.onUpdate?.({ stream: key, text: captured, ...this.streamResult() });
  }

  truncateRich(index = this.outputs.length) {
    if (this.richTruncated) return;
    this.richTruncated = true;
    const text = `\n[... rich output truncated at ${this.richOutputLimit} bytes ...]`;
    if (index === this.outputs.length) this.addText(text);
    else this.outputs.splice(index, 0, { text });
  }

  addMime(mime, truncated = false, terminal = false) {
    if (truncated) { this.truncateRich(); return; }
    if (!mime || typeof mime !== "object" || Array.isArray(mime) || Object.keys(mime).length === 0) return;
    const record = { mime };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    // The decoder already accepted this whole frame. JSON number expansion
    // must not revoke a previously legal single rich result.
    if (terminal) {
      this.richOutputLimit = Math.max(KERNEL_FRAME_BYTES, bytes);
      if (this.richOutputBytes + bytes > this.richOutputLimit) {
        // Explicit displays must not consume a formerly legal final result's
        // capacity. Reclaim the oldest MIME, preserving all surviving order.
        const retained = [];
        let firstRemoved;
        for (const previous of this.outputs) {
          if (previous.mime && this.richOutputBytes + bytes > this.richOutputLimit) {
            this.richOutputBytes -= Buffer.byteLength(JSON.stringify(previous));
            firstRemoved ??= retained.length;
          } else retained.push(previous);
        }
        this.outputs = retained;
        if (firstRemoved !== undefined) this.truncateRich(firstRemoved);
      }
    } else if (this.richOutputBytes === 0) this.richOutputLimit = Math.max(KERNEL_FRAME_BYTES, bytes);
    if (this.richOutputBytes + bytes > this.richOutputLimit) { this.truncateRich(); return; }
    this.richOutputBytes += bytes;
    this.mime = mime;
    this.outputs.push(record);
  }

  streamResult() {
    const marker = `\n[... output truncated at ${this.maxBytes} bytes ...]`;
    return {
      stdout: this.stdoutTruncated ? `${this.stdout}${marker}` : this.stdout,
      stderr: this.stderrTruncated ? `${this.stderr}${marker}` : this.stderr,
      truncated: this.stdoutTruncated || this.stderrTruncated || this.richTruncated,
      totalBytes: this.totalBytes,
    };
  }

  result() {
    return {
      ...this.streamResult(),
      mime: this.mime,
      outputs: [...this.outputs],
      richOutputBytes: this.richOutputBytes,
      richOutputLimit: this.richOutputLimit,
    };
  }

  close() {}
}

export class PythonKernel {
  #process;
  #control;
  #decoder;
  #readyPromise;
  #resolveReady;
  #rejectReady;
  #pending = new Map();
  #tail = Promise.resolve();
  #active;
  #snapshotTimer;
  #interruptTimer;
  #generation = 0;
  #failureEpoch = 0;
  #snapshotGeneration = 0;
  #lastSnapshot;
  #checkpointError;
  #closed = false;

  constructor({
    pythonPath,
    kernelScript,
    runtimeSupportDir,
    cwd,
    stateDir,
    manifest,
    hostHandlers,
    maxOutputBytes = 64 * 1024,
    shutdownTimeoutMs = 1500,
    killTimeoutMs = 1000,
    interruptTimeoutMs = 2000,
  }) {
    this.pythonPath = pythonPath;
    this.kernelScript = kernelScript;
    this.runtimeSupportDir = runtimeSupportDir;
    this.cwd = cwd;
    this.stateDir = stateDir;
    this.manifest = manifest;
    this.hostHandlers = hostHandlers;
    this.maxOutputBytes = maxOutputBytes;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.snapshotPath = stateDir;
    this.configPath = path.join(stateDir, "kernel-config.json");
  }

  get isRunning() {
    return Boolean(this.#process && this.#process.exitCode === null);
  }

  get isBusy() {
    return Boolean(this.#active);
  }

  get snapshotStats() {
    return {
      generation: this.#generation,
      snapshotGeneration: this.#snapshotGeneration,
      dirty: this.#generation > this.#snapshotGeneration,
      last: this.#lastSnapshot?.stats ?? null,
      ...(this.#checkpointError ? { checkpointError: this.#checkpointError } : {}),
    };
  }

  async start() {
    if (this.#readyPromise) return this.#readyPromise;
    if (this.#closed) throw new Error("kernel is closed");
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(this.configPath, `${JSON.stringify({
      version: 1,
      manifest: this.manifest,
      snapshotPath: this.snapshotPath,
      maxOutputFrameBytes: KERNEL_FRAME_BYTES,
    }, null, 2)}\n`, { mode: 0o600 });
    const pythonPaths = [
      this.runtimeSupportDir,
      ...this.manifest.skills.flatMap((skill) => skill.python ? [skill.python.srcPath] : []),
    ];
    this.#readyPromise = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    const child = spawn(this.pythonPath, [this.kernelScript, "--config", this.configPath], {
      cwd: this.cwd,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONPATH: [...pythonPaths, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    this.#process = child;
    this.#control = child.stdio[3];
    this.#decoder = new JsonLineDecoder({ maxFrameBytes: KERNEL_FRAME_BYTES });
    child.stdout.on("data", (chunk) => { if (this.#process === child) this.#active?.collector.add("stdout", chunk); });
    child.stderr.on("data", (chunk) => { if (this.#process === child) this.#active?.collector.add("stderr", chunk); });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    this.#control.on("error", (error) => { if (this.#process === child) this.#failAll(error); });
    this.#control.on("data", (chunk) => { if (this.#process === child) this.#onControl(chunk); });
    child.once("error", (error) => { if (this.#process === child) this.#failAll(error); });
    child.once("exit", (code, signal) => {
      if (this.#process !== child) return;
      const error = new Error(`Python kernel exited code=${code} signal=${signal}`);
      this.#failAll(error);
      this.#process = undefined;
      this.#control = undefined;
      this.#readyPromise = undefined;
    });
    return this.#readyPromise;
  }

  #onControl(chunk) {
    let frames;
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#process?.kill("SIGKILL");
      this.#failAll(error);
      return;
    }
    for (const frame of frames) {
      if (frame.type === "ready") {
        this.#resolveReady?.(frame);
        continue;
      }
      if (frame.type === "host_request") {
        this.#handleHostRequest(frame);
        continue;
      }
      const pending = this.#pending.get(frame.id);
      if (!pending) continue;
      if (frame.type === "result") {
        if (this.#active?.id !== frame.id) continue;
        if (["stdout", "stderr"].includes(frame.stream)) {
          if (typeof frame.mime?.["text/plain"] === "string") this.#active.collector.add(frame.stream, frame.mime["text/plain"]);
        } else this.#active.collector.addMime(frame.mime, frame.truncated === true,
          frame.outputType === undefined);
        continue;
      }
      if (["done", "snapshot_done", "shutdown_done", "protocol_error"].includes(frame.type)) {
        this.#pending.delete(frame.id);
        if ((frame.type === "snapshot_done" && frame.ok === false) || frame.type === "protocol_error") {
          pending.reject(new Error(frame.error ?? "kernel command failed"));
        } else {
          pending.resolve(frame);
        }
      }
    }
  }

  async #handleHostRequest(frame) {
    const active = this.#active;
    const control = this.#control;
    const allowed = this.manifest.skills.some((skill) => skill.python?.hostRequests?.includes(frame.requestType));
    const handler = allowed ? this.hostHandlers[frame.requestType] : undefined;
    if (!active || !handler) {
      this.#writeControl({
        type: "host_response",
        id: frame.id,
        ok: false,
        error: allowed ? `no host handler for ${frame.requestType}` : `host request is not granted: ${frame.requestType}`,
      });
      return;
    }
    // The original cell owns every callback. A cancelled host operation can
    // complete after a later cell starts, or after the process is replaced.
    const reply = (response) => {
      if (this.#active !== active || this.#control !== control || control?.destroyed
        || active.abortController.signal.aborted) return;
      this.#writeControl(response);
    };
    try {
      const result = await handler(frame.payload, {
        signal: active.abortController.signal,
        onProgress: (stream, text) => reply({ type: "host_progress", id: frame.id, stream, text }),
      });
      reply({ type: "host_response", id: frame.id, ok: true, result });
    } catch (error) {
      reply({
        type: "host_response",
        id: frame.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #writeControl(frame) {
    if (!this.#control || this.#control.destroyed) throw new Error("kernel control channel is closed");
    this.#control.write(encodeFrame(frame, { maxFrameBytes: KERNEL_FRAME_BYTES }));
  }

  #command(type, fields = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#writeControl({ type, id, ...fields });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  execute(code, { signal, onUpdate, namespaceCheckpoint, checkpointInBackground = false, onCheckpoint } = {}) {
    const deferred = checkpointInBackground && namespaceCheckpoint ? Promise.withResolvers() : null;
    const failureEpoch = this.#failureEpoch;
    const notAdmitted = () => {
      const cancelled = signal?.aborted;
      if (!cancelled && failureEpoch === this.#failureEpoch) return null;
      return { ok: false, code, durationMs: 0, mime: null, outputs: [],
        errorType: cancelled ? "AbortError" : "KernelReplacedError",
        error: cancelled ? "Python execution cancelled before admission."
          : "Python kernel failed while this cell was queued. The cell did not run; prior execution outcome may be unknown.",
        stdout: "", stderr: "", truncated: false, totalBytes: 0 };
    };
    const operation = this.#tail.then(async () => {
      const queuedFailure = notAdmitted();
      if (queuedFailure) return queuedFailure;
      await this.start();
      // Startup can yield while the caller cancels. Never write a pre-aborted
      // cell to the execution channel, even when its FIFO predecessor succeeded.
      const startupFailure = notAdmitted();
      if (startupFailure) return startupFailure;
      const id = randomUUID();
      const checkpoint = namespaceCheckpoint ? { ...namespaceCheckpoint, executionId: id } : undefined;
      const collector = new OutputCollector({ maxBytes: this.maxOutputBytes, onUpdate });
      const abortController = new AbortController();
      const abort = () => this.interrupt();
      signal?.addEventListener("abort", abort, { once: true });
      this.#active = { id, collector, abortController };
      const startedAt = Date.now();
      try {
        const pending = new Promise((resolve, reject) => {
          this.#pending.set(id, { resolve, reject });
        });
        this.#writeControl({ type: "execute", id, code, ...(checkpoint ? { namespaceCheckpoint: checkpoint } : {}) });
        // A command can mutate the namespace before failing or being interrupted.
        // Advance the generation once it has been admitted by the kernel channel.
        this.#generation += 1;
        const frame = await pending;
        await new Promise((resolve) => setImmediate(resolve));
        const output = collector.result();
        const executionDurationMs = Date.now() - startedAt;
        const result = {
          ok: frame.ok !== false,
          executionId: id,
          ...(checkpoint ? { namespaceCheckpointAttempt: checkpoint } : {}),
          code,
          durationMs: executionDurationMs,
          executionDurationMs,
          checkpointDurationMs: 0,
          errorType: frame.errorType ?? null,
          error: frame.error ?? null,
          ...output,
        };
        if (checkpoint) {
          // Keep namespace publication inside this cell's FIFO slot. Pi owns
          // canonical result persistence after this real promise resolves.
          if (deferred) {
            // The tool result ends the caller's cancellation scope. The existing
            // FIFO still owns durability, including after the Agent settles.
            signal?.removeEventListener("abort", abort);
            if (this.#interruptTimer) clearTimeout(this.#interruptTimer);
            this.#interruptTimer = undefined;
            abortController.abort();
            collector.close();
            deferred.resolve(structuredClone({ ...result,
              namespaceCheckpointState: "pending", checkpointDurationMs: null,
            }));
          }
          const checkpointStartedAt = Date.now();
          try {
            const snapshot = await this.#takeSnapshot();
            if (Object.entries(checkpoint).some(([key, value]) => snapshot.namespaceCheckpoint?.[key] !== value)) {
              throw new Error("snapshot identity does not match the originating execution");
            }
            result.namespaceCheckpoint = snapshot.namespaceCheckpoint;
            result.namespaceSnapshotSkipped = snapshot.skipped;
          } catch (error) {
            result.executionOk = result.ok;
            if (!result.ok) result.executionError = { errorType: result.errorType, error: result.error };
            result.ok = false;
            result.errorType = "NamespaceCheckpointError";
            result.error = `Python execution ended, but its namespace checkpoint failed: ${error.message}. `
              + "Side effects may have occurred. Do not replay this cell automatically.";
          } finally {
            result.checkpointDurationMs = Date.now() - checkpointStartedAt;
          }
          if (deferred) {
            const outcome = Object.freeze({
              ok: Boolean(result.namespaceCheckpoint),
              namespaceCheckpointAttempt: Object.freeze({ ...checkpoint }),
              ...(result.namespaceCheckpoint ? {
                namespaceCheckpoint: Object.freeze({ ...result.namespaceCheckpoint }),
                namespaceSnapshotSkipped: Object.freeze((result.namespaceSnapshotSkipped ?? [])
                  .map((item) => Object.freeze({ ...item }))),
              } : { error: result.error }),
              executionDurationMs,
              checkpointDurationMs: result.checkpointDurationMs,
            });
            this.#checkpointError = outcome.ok ? undefined : outcome;
            try { await onCheckpoint?.(outcome); }
            catch (error) {
              this.#checkpointError = Object.freeze({ ...outcome, ok: false,
                error: "Checkpoint completion notification failed: "
                  + (error instanceof Error ? error.message : String(error)),
              });
            }
          }
        } else if (result.ok) this.#scheduleSnapshot();
        result.durationMs = Date.now() - startedAt;
        return result;
      } catch (error) {
        return {
          ok: false,
          executionId: id,
          ...(checkpoint ? { namespaceCheckpointAttempt: checkpoint } : {}),
          code,
          durationMs: Date.now() - startedAt,
          errorType: error?.name ?? "Error",
          error: error instanceof Error ? error.message : String(error),
          ...collector.result(),
        };
      } finally {
        if (this.#interruptTimer) clearTimeout(this.#interruptTimer);
        this.#interruptTimer = undefined;
        signal?.removeEventListener("abort", abort);
        abortController.abort();
        collector.close();
        this.#active = undefined;
      }
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    if (!deferred) return operation;
    operation.then(deferred.resolve, deferred.reject);
    return deferred.promise;
  }

  interrupt() {
    if (!this.#active || !this.#process) return false;
    this.#active.abortController.abort();
    const signaled = this.#process.kill("SIGINT");
    if (signaled && !this.#interruptTimer) {
      this.#interruptTimer = setTimeout(() => {
        this.#interruptTimer = undefined;
        if (this.#active && this.#process?.exitCode === null) this.#process.kill("SIGKILL");
      }, this.interruptTimeoutMs);
      this.#interruptTimer.unref();
    }
    return signaled;
  }

  terminateForRecovery() {
    if (!this.#process || this.#process.exitCode !== null) return false;
    return this.#process.kill("SIGKILL");
  }

  #scheduleSnapshot() {
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = setTimeout(() => {
      this.#snapshotTimer = undefined;
      this.#enqueueSnapshot({ onlyIfDirty: true }).catch(() => {});
    }, 500);
    this.#snapshotTimer.unref();
  }

  async #takeSnapshot() {
    const generation = this.#generation;
    const frame = await this.#command("snapshot");
    this.#snapshotGeneration = Math.max(this.#snapshotGeneration, generation);
    this.#lastSnapshot = frame.snapshot;
    return frame.snapshot;
  }

  #enqueueSnapshot({ onlyIfDirty = false } = {}) {
    const operation = this.#tail.then(async () => {
      if (!this.isRunning) return { found: false, saved: [], skipped: [] };
      if (onlyIfDirty && this.#generation <= this.#snapshotGeneration) return this.#lastSnapshot;
      return this.#takeSnapshot();
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  snapshot() {
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = undefined;
    return this.#enqueueSnapshot();
  }

  async close({ snapshot = true } = {}) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    if (this.#interruptTimer) clearTimeout(this.#interruptTimer);
    this.#snapshotTimer = undefined;
    this.#interruptTimer = undefined;
    await this.#tail;
    if (!this.isRunning) return;
    if (snapshot && this.#generation > this.#snapshotGeneration) {
      try { await this.#takeSnapshot(); } catch {}
    }
    try {
      await Promise.race([
        this.#command("shutdown"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("kernel shutdown timed out")), this.shutdownTimeoutMs)),
      ]);
    } catch {
      this.#process?.kill("SIGTERM");
    }
    if (this.#process?.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => this.#process?.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, this.killTimeoutMs)),
      ]);
    }
    if (this.#process?.exitCode === null) this.#process.kill("SIGKILL");
    this.#process = undefined;
  }

  #failAll(error) {
    // Queued cells may depend on mutations lost with this process. Require a
    // new explicit execution instead of silently running them on a restore.
    this.#failureEpoch += 1;
    this.#active?.abortController.abort();
    this.#rejectReady?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
