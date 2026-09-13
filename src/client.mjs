
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { JsonLineDecoder, encodeFrame } from "./framing.mjs";
import { PROTOCOL_VERSION, ProtocolError, validateServerFrame } from "./protocol.mjs";

export class HarnessRequestError extends Error {
  constructor(code, message) { super(message); this.name = "HarnessRequestError"; this.code = code; }
}

/** Reconnecting protocol client. Registration establishes either one actor identity or one detachable UI. */
export class HarnessClient extends EventEmitter {
  #socket;
  #decoder;
  #pending = new Map();
  #registration;
  #registrationType;
  #connectedSession;
  #limits;
  #connectPromise;
  #retryTimer;
  #heartbeatTimer;
  #stopped = true;
  #registrationRejected = false;
  #retryAttempt = 0;

  constructor({ socketPath, reconnectBaseMs = 100, reconnectMaxMs = 2000, heartbeatMs = 15000, requestTimeoutMs = 3000 }) {
    super(); Object.assign(this, { socketPath, reconnectBaseMs, reconnectMaxMs, heartbeatMs, requestTimeoutMs });
  }
  get connectedSession() { return this.#connectedSession; }
  get limits() { return this.#limits; }
  get role() { return this.#registrationType === "register_actor" ? "actor" : this.#registrationType === "register_client" ? "client" : undefined; }
  get isConnected() { return Boolean(this.#socket && !this.#socket.destroyed && this.#registrationType); }

  async start(registration) {
    if (!this.#stopped) throw new Error("client is already started");
    const { registrationType, ...params } = registration;
    if (!["register_actor", "register_client"].includes(registrationType)) throw new Error("registrationType must be register_actor or register_client");
    this.#registrationType = registrationType; this.#registration = params; this.#stopped = false; this.#registrationRejected = false;
    this.#setStatus("connecting");
    try { return await this.#connect(); }
    catch (error) { if (!this.#stopped && !this.#registrationRejected) { this.#setStatus("offline", error); this.#scheduleReconnect(); } return undefined; }
  }

  async #connect() {
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#connectOnce().finally(() => { this.#connectPromise = undefined; });
    return this.#connectPromise;
  }
  async #connectOnce() {
    if (this.#stopped) return undefined;
    const socket = net.createConnection(this.socketPath); socket.setNoDelay(true); this.#decoder = new JsonLineDecoder(); this.#socket = socket;
    socket.on("data", (chunk) => this.#onData(socket, chunk)); socket.on("close", () => this.#onClose(socket)); socket.on("error", () => {});
    await new Promise((resolve, reject) => {
      const clean = () => { socket.off("connect", connected); socket.off("error", failed); };
      const connected = () => { clean(); resolve(); }; const failed = (error) => { clean(); reject(error); };
      socket.once("connect", connected); socket.once("error", failed);
    });
    if (this.#socket !== socket || this.#stopped) { socket.destroy(); return undefined; }
    let result;
    try { result = await this.request(this.#registrationType, this.#registration); }
    catch (error) {
      // Only explicit admission failures are terminal; transport failures use normal backoff.
      if (!this.#stopped && (error instanceof HarnessRequestError || error instanceof ProtocolError)) {
        this.#registrationRejected = true; this.#setStatus("rejected", error);
      }
      if (this.#socket === socket) socket.destroy(); throw error;
    }
    if (this.#socket !== socket || this.#stopped) { socket.destroy(); return undefined; }
    this.#connectedSession = result.session; this.#limits = result.limits; this.#retryAttempt = 0; this.#setStatus("connected"); this.emit("registered", result); this.#startHeartbeat(); return result;
  }
  #onData(socket, chunk) {
    if (socket !== this.#socket) return;
    try { for (const raw of this.#decoder.push(chunk)) this.#onFrame(validateServerFrame(raw)); }
    catch (error) { this.emit("protocolError", error); socket.destroy(); }
  }
  #onFrame(frame) {
    if (frame.type === "response") {
      const pending = this.#pending.get(frame.id);
      if (!pending) { this.emit("protocolError", new ProtocolError("unknown_response", `response for unknown request ${frame.id}`)); this.#socket?.destroy(); return; }
      this.#pending.delete(frame.id); clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame.data); else pending.reject(new HarnessRequestError(frame.code ?? "request_failed", frame.error));
    } else if (frame.type === "protocol_error") {
      const error = new ProtocolError(frame.code, frame.message);
      this.emit("protocolError", error);
      // Preserve the supervisor's rejection instead of replacing it with a transport close.
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.#pending.clear(); this.#socket?.destroy();
    }
    else this.emit("event", frame);
  }
  #onClose(socket) {
    if (socket !== this.#socket) return;
    this.#socket = undefined; this.#connectedSession = undefined; this.#limits = undefined; this.#stopHeartbeat();
    for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(new Error(`connection closed before response ${id}`)); }
    this.#pending.clear();
    if (!this.#stopped && !this.#registrationRejected) { this.#setStatus("offline"); this.emit("disconnected"); this.#scheduleReconnect(); }
  }
  #scheduleReconnect() {
    if (this.#stopped || this.#registrationRejected || this.#retryTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.#retryAttempt++);
    this.#retryTimer = setTimeout(() => { this.#retryTimer = undefined; this.#setStatus("connecting"); this.#connect().catch((error) => { if (!this.#stopped && !this.#registrationRejected) { this.#setStatus("offline", error); this.#scheduleReconnect(); } }); }, delay);
    this.#retryTimer.unref();
  }
  #startHeartbeat() { this.#stopHeartbeat(); if (this.heartbeatMs <= 0) return; this.#heartbeatTimer = setInterval(() => this.request("heartbeat", {}).catch(() => this.#socket?.destroy()), this.heartbeatMs); this.#heartbeatTimer.unref(); }
  #stopHeartbeat() { if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer); this.#heartbeatTimer = undefined; }
  #setStatus(state, error) { this.emit("status", { state, error: error instanceof Error ? error.message : error ? String(error) : undefined }); }

  request(type, params = {}) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("harness is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${type} request timed out`)); socket.destroy(); }, this.requestTimeoutMs); timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try { socket.write(encodeFrame({ version: PROTOCOL_VERSION, id, type, params })); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  async stop() {
    if (this.#stopped) return; this.#stopped = true; if (this.#retryTimer) clearTimeout(this.#retryTimer); this.#retryTimer = undefined; this.#stopHeartbeat();
    const socket = this.#socket; this.#connectedSession = undefined; this.#limits = undefined;
    if (socket && !socket.destroyed) await new Promise((resolve) => { const timer = setTimeout(() => { socket.destroy(); resolve(); }, 250); socket.once("close", () => { clearTimeout(timer); resolve(); }); socket.end(); });
    this.#socket = undefined; this.#setStatus("stopped");
  }
}
