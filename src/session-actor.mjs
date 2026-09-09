import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_RPC_LINE_BYTES = 256 * 1024 * 1024;
// Codex compaction may consume its full 300s HTTP idle window before prompt acceptance returns.
export const DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS = 330_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Split newline-delimited JSON without repeatedly copying/rescanning a large partial line. */
export class PiRpcLineDecoder {
  #parts = [];
  #bytes = 0;

  push(chunk) {
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const frames = [];
    let start = 0;
    while (start < source.length) {
      const newline = source.indexOf(0x0a, start);
      if (newline < 0) {
        this.#append(source.subarray(start));
        break;
      }
      this.#append(source.subarray(start, newline));
      let line = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts, this.#bytes);
      this.#parts = [];
      this.#bytes = 0;
      if (line.length > 0 && line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length > 0) frames.push(JSON.parse(utf8.decode(line)));
      start = newline + 1;
    }
    return frames;
  }

  #append(part) {
    if (part.length === 0) return;
    this.#bytes += part.length;
    if (this.#bytes > MAX_RPC_LINE_BYTES) throw new Error(`Pi RPC line exceeds ${MAX_RPC_LINE_BYTES} bytes`);
    this.#parts.push(part);
  }
}

export class PiSessionActor extends EventEmitter {
  #child;
  #pending = new Map();
  #stdoutDecoder = new PiRpcLineDecoder();
  #stderr = "";
  #started = false;
  #closing = false;
  #exitPromise;
  #terminal = false;
  #inputTail = Promise.resolve();

  constructor({ command = "pi", args, cwd, env, requestTimeoutMs = 30_000,
    promptPreflightTimeoutMs = DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS, shutdownTimeoutMs = 3000 }) {
    super();
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.promptPreflightTimeoutMs = promptPreflightTimeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
  }

  get pid() {
    return this.#child?.pid;
  }

  get stderr() {
    return this.#stderr;
  }

  get isRunning() {
    return Boolean(this.#child && !this.#terminal && this.#child.exitCode === null && !this.#child.killed);
  }

  async start() {
    if (this.#started) throw new Error("session actor is already started");
    this.#started = true;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const available = Math.max(0, MAX_STDERR_BYTES - Buffer.byteLength(this.#stderr));
      if (available > 0) this.#stderr += Buffer.from(chunk).subarray(0, available).toString("utf8");
    });
    this.#exitPromise = new Promise((resolve) => {
      const finish = (code, signal, spawnError = null) => {
        if (this.#terminal) return;
        this.#terminal = true;
        const details = (spawnError?.message ?? this.#stderr) || null;
        const error = new Error(`Pi session actor exited code=${code} signal=${signal}${details ? `\n${details}` : ""}`);
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.#pending.clear();
        this.emit("exit", { code, signal, expected: this.#closing, error: details });
        resolve({ code, signal });
      };
      child.once("exit", (code, signal) => finish(code, signal));
      child.once("error", (error) => finish(null, null, error));
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const state = await this.request("get_state", {}, this.requestTimeoutMs);
    await this.request("set_steering_mode", { mode: "all", persist: false });
    return { ...state, steeringMode: "all" };
  }

  #onStdout(chunk) {
    let frames;
    try {
      frames = this.#stdoutDecoder.push(chunk);
    } catch (error) {
      this.emit("protocolError", new Error(`invalid Pi RPC JSON: ${error.message}`));
      this.#terminate("SIGKILL");
      return;
    }
    for (const frame of frames) {
      if (frame.type === "response" && frame.id && this.#pending.has(frame.id)) {
        const pending = this.#pending.get(frame.id);
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.success) pending.resolve(frame.data);
        else pending.reject(new Error(frame.error ?? `${pending.type} failed`));
      } else {
        this.emit("event", frame);
      }
    }
  }

  send(frame) {
    const child = this.#child;
    if (!child || child.exitCode !== null || !child.stdin.writable) throw new Error("Pi session actor is not running");
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(type, fields = {}, timeoutMs = this.requestTimeoutMs) {
    const child = this.#child;
    if (!child || child.exitCode !== null || !child.stdin.writable) return Promise.reject(new Error("Pi session actor is not running"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { type, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  /** Serialize Pi input acceptance. The RPC response acknowledges preflight, not run completion. */
  submit(message, behavior = "auto", images = [], messageId) {
    const operation = this.#inputTail.then(async () => {
      const state = await this.request("get_state");
      const imageFields = { ...(images.length ? { images } : {}), ...(messageId === undefined ? {} : { messageId }) };
      if (behavior === "steer") {
        if (!state?.isStreaming) throw new Error("cannot steer an idle Pi session actor");
        return this.request("steer", { message, ...imageFields });
      }
      if (behavior === "follow_up" && state?.isStreaming) return this.request("follow_up", { message, ...imageFields });
      return this.request("prompt", {
        message, ...imageFields,
        ...(state?.isStreaming ? { streamingBehavior: "steer" } : {}),
      }, this.promptPreflightTimeoutMs);
    });
    this.#inputTail = operation.catch(() => {});
    return operation;
  }

  prompt(message, images = []) { return this.submit(message, "auto", images); }
  steer(message, images = []) { return this.submit(message, "steer", images); }
  followUp(message, images = []) { return this.submit(message, "follow_up", images); }

  #terminate(signal) {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  }

  async close() {
    if (!this.#child || this.#terminal || this.#child.exitCode !== null) return;
    this.#closing = true;
    // Pi drains extension shutdown hooks before exiting. Give its Python child
    // that grace period too; forced shutdown still terminates the owned group.
    try { this.#child.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => this.#terminate("SIGKILL"), this.shutdownTimeoutMs);
    timer.unref();
    await this.#exitPromise;
    clearTimeout(timer);
  }
}
