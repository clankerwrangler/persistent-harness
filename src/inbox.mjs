import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { INBOX_KINDS } from "./protocol.mjs";

export { inboxOriginJobId, parseInboxOriginJobId } from "./protocol.mjs";
export const MAX_INBOX_TEXT_BYTES = 8 * 1024;
export const DEFAULT_INBOX_RATE_PER_HOUR = 60;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const HOUR_MS = 60 * 60 * 1000;
const MESSAGE_RETENTION_MS = 30 * 24 * HOUR_MS;

const hashKey = (key) => createHash("sha256").update(key).digest("hex");

function requireName(value, label) {
  if (typeof value !== "string" || !NAME.test(value)) throw new TypeError(`${label} must be 1-32 lowercase letters, digits, or hyphens, starting with a letter`);
  return value;
}

export class InboxStore {
  #db;
  constructor(databasePath) {
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (databasePath !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS inbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT OR IGNORE INTO inbox_meta VALUES ('schema_version', '1');
      CREATE TABLE IF NOT EXISTS inbox_senders (
        name TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('news', 'maintenance')),
        rate_per_hour INTEGER NOT NULL CHECK (rate_per_hour > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS inbox_routes (
        route TEXT PRIMARY KEY, target_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS inbox_messages (
        sender TEXT NOT NULL, message_id TEXT NOT NULL, route TEXT NOT NULL, received_at INTEGER NOT NULL,
        delivered_to TEXT NOT NULL, PRIMARY KEY (sender, message_id)) STRICT;
      CREATE INDEX IF NOT EXISTS inbox_messages_recent ON inbox_messages(sender, received_at);
      COMMIT;`);
    const version = this.#db.prepare("SELECT value FROM inbox_meta WHERE key = 'schema_version'").get()?.value;
    if (version !== "1") throw new Error(`unsupported inbox schema version: ${String(version)}`);
  }

  // Returns the new key once; only its hash is stored.
  addSender(name, { kind = "news", ratePerHour = DEFAULT_INBOX_RATE_PER_HOUR } = {}, now = Date.now()) {
    requireName(name, "sender");
    if (!INBOX_KINDS.includes(kind)) throw new TypeError(`kind must be ${INBOX_KINDS.join(" or ")}`);
    if (!Number.isInteger(ratePerHour) || ratePerHour < 1 || ratePerHour > 3600) throw new TypeError("ratePerHour must be from 1 through 3600");
    const key = randomBytes(32).toString("base64url");
    this.#db.prepare(`INSERT INTO inbox_senders VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET
      key_hash = excluded.key_hash, kind = excluded.kind, rate_per_hour = excluded.rate_per_hour, updated_at = excluded.updated_at`)
      .run(name, hashKey(key), kind, ratePerHour, now, now);
    return key;
  }

  removeSender(name) {
    if (this.#db.prepare("DELETE FROM inbox_senders WHERE name = ?").run(name).changes !== 1) throw new Error(`no such sender: ${name}`);
  }

  authenticate(key) {
    if (typeof key !== "string" || key.length < 16 || key.length > 256) return null;
    const row = this.#db.prepare("SELECT name, kind, rate_per_hour FROM inbox_senders WHERE key_hash = ?").get(hashKey(key));
    return row ? { name: row.name, kind: row.kind, ratePerHour: Number(row.rate_per_hour) } : null;
  }

  // A target is one session, or every root that is working when the message arrives.
  setRoute(route, target, now = Date.now()) {
    requireName(route, "route");
    const valid = target && typeof target === "object" && (Object.keys(target).length === 1)
      && ((typeof target.sessionId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(target.sessionId)) || target.workingRoots === true);
    if (!valid) throw new TypeError("route target must be { sessionId } or { workingRoots: true }");
    this.#db.prepare(`INSERT INTO inbox_routes VALUES (?, ?, ?) ON CONFLICT(route) DO UPDATE SET
      target_json = excluded.target_json, updated_at = excluded.updated_at`).run(route, JSON.stringify(target), now);
  }

  removeRoute(route) {
    if (this.#db.prepare("DELETE FROM inbox_routes WHERE route = ?").run(route).changes !== 1) throw new Error(`no such route: ${route}`);
  }

  getRoute(route) {
    const row = this.#db.prepare("SELECT target_json FROM inbox_routes WHERE route = ?").get(route);
    return row ? JSON.parse(row.target_json) : null;
  }

  list() {
    return {
      senders: this.#db.prepare("SELECT name, kind, rate_per_hour, created_at, updated_at, (SELECT max(received_at) FROM inbox_messages m WHERE m.sender = s.name) AS last_message_at FROM inbox_senders s ORDER BY name").all()
        .map((r) => ({ name: r.name, kind: r.kind, ratePerHour: Number(r.rate_per_hour), lastMessageAt: r.last_message_at == null ? null : Number(r.last_message_at) })),
      routes: this.#db.prepare("SELECT route, target_json FROM inbox_routes ORDER BY route").all()
        .map((r) => ({ route: r.route, target: JSON.parse(r.target_json) })),
    };
  }

  recentCount(sender, now = Date.now()) {
    return Number(this.#db.prepare("SELECT count(*) AS n FROM inbox_messages WHERE sender = ? AND received_at > ?").get(sender, now - HOUR_MS).n);
  }

  previousDelivery(sender, messageId) {
    const row = this.#db.prepare("SELECT delivered_to FROM inbox_messages WHERE sender = ? AND message_id = ?").get(sender, messageId);
    return row ? JSON.parse(row.delivered_to) : null;
  }

  recordMessage(sender, messageId, route, deliveredTo, now = Date.now()) {
    this.#db.prepare("INSERT OR IGNORE INTO inbox_messages VALUES (?, ?, ?, ?, ?)").run(sender, messageId, route, now, JSON.stringify(deliveredTo));
    this.#db.prepare("DELETE FROM inbox_messages WHERE received_at < ?").run(now - MESSAGE_RETENTION_MS);
  }

  close() { this.#db.close(); }
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    // An oversized body is read to the end and dropped, so the sender still gets its 413.
    req.on("data", (chunk) => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
    req.on("end", () => {
      if (size > limit) return reject(Object.assign(new Error("message too large"), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("body must be JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

// Accepts messages from registered programs and hands them to `deliver`, which returns the session IDs reached.
export function createInboxServer({ store, deliver, now = () => Date.now(), logger = console }) {
  const handle = async (req, res) => {
    const url = new URL(req.url, "http://inbox");
    if (req.method === "GET" && url.pathname === "/v1/health") return reply(res, 200, { ok: true });
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return reply(res, 404, { error: "unknown endpoint" });
    const sender = store.authenticate(/^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]);
    if (!sender) return reply(res, 401, { error: "unknown sender key" });
    const body = await readJson(req, MAX_INBOX_TEXT_BYTES + 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["route", "id", "text"].includes(key))) {
      return reply(res, 400, { error: "body must be { route, id, text }" });
    }
    const { route, id, text } = body;
    if (typeof id !== "string" || !MESSAGE_ID.test(id)) return reply(res, 400, { error: "id must be 1-64 letters, digits, or . _ : -" });
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_INBOX_TEXT_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
      return reply(res, 400, { error: `text must be nonblank plain text of at most ${MAX_INBOX_TEXT_BYTES} bytes` });
    }
    const previous = store.previousDelivery(sender.name, id);
    if (previous) return reply(res, 200, { duplicate: true, deliveredTo: previous });
    const target = typeof route === "string" ? store.getRoute(route) : null;
    if (!target) return reply(res, 404, { error: "unknown route" });
    if (store.recentCount(sender.name, now()) >= sender.ratePerHour) return reply(res, 429, { error: "rate limit reached" });
    const deliveredTo = await deliver({ sender: sender.name, kind: sender.kind, route, target, messageId: id, text });
    store.recordMessage(sender.name, id, route, deliveredTo, now());
    return reply(res, 202, { deliveredTo });
  };
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!error.status) logger.error?.(`inbox request failed: ${error.message}`);
      if (!res.headersSent) reply(res, error.status ?? 500, { error: error.status ? error.message : "delivery failed" });
    });
  });
}
