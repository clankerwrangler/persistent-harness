import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const NOTIFICATION_IDLE_MS = 3_000;
export const NOTIFICATION_RETRY_MS = [5_000, 30_000, 120_000, 300_000, 900_000];
export function notificationId(key) { return createHash("sha256").update(key).digest("hex"); }
const parse = (value) => value ? JSON.parse(value) : null;
const clean = (text, max) => String(text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
function map(row) {
  if (!row) return null;
  return { id: row.id, seq: row.seq, rootId: row.root_id, sessionId: row.session_id, kind: row.kind,
    title: row.title, body: row.body, createdAt: row.created_at, expiresAt: row.expires_at,
    state: row.state, readAt: row.read_at, updatedAt: row.updated_at, source: parse(row.source_json),
    url: `/?session=${encodeURIComponent(row.session_id)}&notification=${encodeURIComponent(row.id)}` };
}

// Same canonical database, separate additive schema version. No change to core
// user_version: baseline writable readers can preserve and ignore these tables.
export class NotificationStore {
  #db;
  constructor(databasePath, { idleMs = NOTIFICATION_IDLE_MS } = {}) {
    this.idleMs = idleMs;
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const existingMeta = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_meta'").get();
    if (existingMeta && this.#db.prepare("SELECT value FROM notification_meta WHERE key='version'").get()?.value !== "1") {
      this.#db.close(); throw new Error("unsupported notification schema version");
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS notification_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT OR IGNORE INTO notification_meta VALUES ('version', '1');
      CREATE TABLE IF NOT EXISTS notification_families (
        root_id TEXT PRIMARY KEY, episode_id TEXT, owner TEXT NOT NULL DEFAULT 'user',
        opened_at INTEGER, quiet_since INTEGER, closed_at INTEGER, pending_user INTEGER NOT NULL DEFAULT 0, pending_owner TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS notification_ownership (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
        owner TEXT NOT NULL CHECK(owner IN ('user','cron','unknown'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS notification_ownership_time ON notification_ownership(root_id,observed_at,seq);
      CREATE TABLE IF NOT EXISTS notification_origins (
        source_key TEXT PRIMARY KEY, root_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER,
        owner TEXT NOT NULL CHECK(owner IN ('user','cron','unknown')), admitted INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS notifications (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_key TEXT NOT NULL UNIQUE,
        root_id TEXT NOT NULL, session_id TEXT NOT NULL, episode_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('idle','attention','cron')),
        title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','resolved','cancelled','expired','superseded')),
        read_at INTEGER, updated_at INTEGER NOT NULL, source_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(state, expires_at, seq);
      CREATE INDEX IF NOT EXISTS notifications_root ON notifications(root_id, seq);
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        notification_id TEXT NOT NULL REFERENCES notifications(id), endpoint_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','inflight','accepted','failed','suppressed','expired')),
        attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER,
        code TEXT, accepted_at INTEGER, PRIMARY KEY(notification_id, endpoint_id)
      ) STRICT;
    `);
    if (!this.#db.prepare("PRAGMA table_info(notification_families)").all().some(column => column.name === "pending_owner")) {
      this.#db.exec("ALTER TABLE notification_families ADD COLUMN pending_owner TEXT");
    }
    if (this.#db.prepare("SELECT value FROM notification_meta WHERE key='version'").get().value !== "1") {
      this.#db.close(); throw new Error("unsupported notification schema version");
    }
  }
  close() { this.#db.close(); }
  #transaction(action) {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  family(sessionId) {
    let root = this.#db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId);
    const seen = new Set();
    while (root?.parent_session_id && !seen.has(root.id)) {
      seen.add(root.id); root = this.#db.prepare("SELECT * FROM sessions WHERE id=?").get(root.parent_session_id);
    }
    if (!root || root.lifecycle === "deleted" || root.kind !== "root") return null;
    const members = this.#db.prepare(`WITH RECURSIVE family(id) AS (
      SELECT id FROM sessions WHERE id=? AND lifecycle <> 'deleted' UNION ALL
      SELECT s.id FROM sessions s JOIN family f ON s.parent_session_id=f.id WHERE s.lifecycle <> 'deleted'
    ) SELECT s.id, s.activity, s.lifecycle, s.streaming FROM sessions s JOIN family f ON s.id=f.id`).all(root.id);
    return { rootId: root.id, title: root.display_name, members,
      active: members.some(s => s.streaming === 1 || s.activity === "working"),
      starting: members.some(s => s.lifecycle === "starting") };
  }
  #checkpoint(rootId, owner, now) {
    const last = this.#db.prepare("SELECT owner FROM notification_ownership WHERE root_id=? ORDER BY seq DESC LIMIT 1").get(rootId);
    if (last?.owner !== owner) this.#db.prepare("INSERT INTO notification_ownership(root_id,observed_at,owner) VALUES(?,?,?)").run(rootId, now, owner);
  }
  noteUserInput(sessionId, now = Date.now()) {
    const family = this.family(sessionId); if (!family) return;
    this.#transaction(() => {
      this.#db.prepare(`INSERT INTO notification_families(root_id, pending_user) VALUES (?,1)
        ON CONFLICT(root_id) DO UPDATE SET pending_user=CASE WHEN episode_id IS NULL OR closed_at IS NOT NULL THEN 1 ELSE 0 END,
        owner=CASE WHEN episode_id IS NOT NULL AND closed_at IS NULL THEN 'user' ELSE owner END`).run(family.rootId);
      this.#checkpoint(family.rootId, "user", now);
    });
  }
  // Notification attribution only: never used for actor routing or authorization.
  // Millisecond timestamps cannot order a launch against a conflicting checkpoint
  // at the same instant. Missing/prehistory/ambiguous origins remain unknown.
  bindOrigin(sessionId, key, createdAt) {
    const family = this.family(sessionId); if (!family) return null;
    return this.#transaction(() => {
      const saved = this.#db.prepare("SELECT * FROM notification_origins WHERE source_key=?").get(key);
      if (saved) return saved;
      const timestamp = typeof createdAt === "number" ? createdAt : typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
      const valid = Number.isSafeInteger(timestamp) && timestamp >= 0;
      const prior = valid ? this.#db.prepare("SELECT owner FROM notification_ownership WHERE root_id=? AND observed_at<? ORDER BY observed_at DESC,seq DESC LIMIT 1").get(family.rootId, timestamp) : null;
      const ties = valid ? this.#db.prepare("SELECT owner FROM notification_ownership WHERE root_id=? AND observed_at=?").all(family.rootId, timestamp) : [];
      const owner = prior && ties.every(row => row.owner === prior.owner) ? prior.owner : "unknown";
      this.#db.prepare("INSERT INTO notification_origins(source_key,root_id,session_id,created_at,owner) VALUES(?,?,?,?,?)")
        .run(key, family.rootId, sessionId, valid ? timestamp : null, owner);
      return this.#db.prepare("SELECT * FROM notification_origins WHERE source_key=?").get(key);
    });
  }
  noteContinuation(sessionId, key, createdAt, now = Date.now()) {
    const origin = this.bindOrigin(sessionId, key, createdAt); if (!origin) return;
    this.#transaction(() => {
      if (!this.#db.prepare("UPDATE notification_origins SET admitted=1 WHERE source_key=? AND admitted=0").run(key).changes) return;
      this.#db.prepare(`INSERT INTO notification_families(root_id,pending_owner) VALUES(?,?)
        ON CONFLICT(root_id) DO UPDATE SET
        pending_owner=CASE WHEN episode_id IS NULL OR closed_at IS NOT NULL THEN
          CASE WHEN pending_owner='user' OR excluded.pending_owner='user' THEN 'user' ELSE excluded.pending_owner END ELSE pending_owner END,
        owner=CASE WHEN episode_id IS NOT NULL AND closed_at IS NULL AND excluded.pending_owner='user' THEN 'user' ELSE owner END`)
        .run(origin.root_id, origin.owner);
      const active = this.#db.prepare("SELECT owner FROM notification_families WHERE root_id=? AND episode_id IS NOT NULL AND closed_at IS NULL").get(origin.root_id);
      if (active) this.#checkpoint(origin.root_id, active.owner, now);
    });
  }
  settled(sessionId, { liveActors = [], now = Date.now() } = {}) {
    const family = this.family(sessionId);
    if (!family || family.active || family.starting || family.members.some(s => liveActors.includes(s.id))) return false;
    const episode = this.#db.prepare("SELECT quiet_since FROM notification_families WHERE root_id=?").get(family.rootId);
    return episode?.quiet_since != null && now - episode.quiet_since >= this.idleMs;
  }
  observe(sessionId, { owner = null, backgroundCount = 0, liveActors = [], now = Date.now() } = {}) {
    const family = this.family(sessionId);
    if (!family) { this.cancelSession(sessionId, now); return null; }
    return this.#transaction(() => {
      let episode = this.#db.prepare("SELECT * FROM notification_families WHERE root_id=?").get(family.rootId);
      if (family.active || family.members.some(s => liveActors.includes(s.id))) {
        if (!episode?.episode_id || episode.closed_at !== null) {
          const id = randomUUID(), nextOwner = episode?.pending_user ? "user" : episode?.pending_owner ?? (owner === "cron" ? "cron" : episode?.owner ?? "user");
          this.#db.prepare(`UPDATE notifications SET state='superseded', updated_at=?
            WHERE root_id=? AND kind='idle' AND state='pending'`).run(now, family.rootId);
          this.#db.prepare(`INSERT INTO notification_families(root_id,episode_id,owner,opened_at,pending_user)
            VALUES (?,?,?,?,0) ON CONFLICT(root_id) DO UPDATE SET episode_id=excluded.episode_id,
            owner=excluded.owner, opened_at=excluded.opened_at, quiet_since=NULL, closed_at=NULL, pending_user=0, pending_owner=NULL`)
            .run(family.rootId, id, nextOwner, now);
          this.#checkpoint(family.rootId, nextOwner, now);
        } else this.#db.prepare("UPDATE notification_families SET quiet_since=NULL WHERE root_id=?").run(family.rootId);
        return null;
      }
      if (!episode?.episode_id || episode.closed_at !== null) return null;
      if (family.starting) {
        this.#db.prepare("UPDATE notification_families SET quiet_since=NULL WHERE root_id=?").run(family.rootId); return null;
      }
      if (episode.quiet_since === null) {
        this.#db.prepare("UPDATE notification_families SET quiet_since=? WHERE root_id=?").run(now, family.rootId); return null;
      }
      if (now - episode.quiet_since < this.idleMs) return null;
      this.#db.prepare("UPDATE notification_families SET closed_at=? WHERE root_id=?").run(now, family.rootId);
      // An unresolved root request already describes why the family is quiet.
      const needs = this.#db.prepare(`SELECT 1 FROM notifications WHERE root_id=? AND kind='attention'
        AND episode_id=? AND state='pending' AND expires_at>? LIMIT 1`).get(family.rootId, episode.episode_id, now);
      if (episode.owner !== "user" || needs) return null;
      return this.#create({ key: `idle:${episode.episode_id}`, rootId: family.rootId, sessionId: family.rootId,
        episodeId: episode.episode_id, kind: "idle", title: clean(family.title, 120) || "Activity stopped",
        body: `The conversation and its agents are now idle.${backgroundCount ? ` ${backgroundCount} background job${backgroundCount === 1 ? " is" : "s are"} still running.` : ""}`,
        expiresAt: now + 300_000, source: { type: "family_idle", episodeId: episode.episode_id, backgroundCount } }, now);
    });
  }
  openFamilies() { return this.#db.prepare("SELECT root_id FROM notification_families WHERE episode_id IS NOT NULL AND closed_at IS NULL").all().map(r => r.root_id); }
  #create({ key, rootId, sessionId, episodeId = null, kind, title, body, expiresAt, source }, now) {
    const id = notificationId(key);
    episodeId ??= this.#db.prepare("SELECT episode_id FROM notification_families WHERE root_id=? AND closed_at IS NULL").get(rootId)?.episode_id ?? null;
    this.#db.prepare(`INSERT OR IGNORE INTO notifications(id,source_key,root_id,session_id,episode_id,kind,title,body,
      created_at,expires_at,state,updated_at,source_json) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
      .run(id, key, rootId, sessionId, episodeId, kind, clean(title, 120), clean(body, 1000), now, expiresAt, now, JSON.stringify(source));
    return this.get(id, now);
  }
  create(params, now = Date.now()) { return this.#transaction(() => this.#create(params, now)); }
  request(sessionId, params, now = Date.now(), actorGeneration = null) {
    const episode = this.#db.prepare("SELECT episode_id FROM notification_families WHERE root_id=?").get(sessionId);
    return this.create({ key: `attention:${sessionId}:${params.key}`, rootId: sessionId, sessionId,
      episodeId: episode?.episode_id, kind: "attention", title: params.title, body: params.body,
      expiresAt: now + params.expiresIn * 1000, source: { type: "explicit", key: params.key, actorGeneration } }, now);
  }
  resolveKey(sessionId, key, now = Date.now()) {
    return this.transition(notificationId(`attention:${sessionId}:${key}`), "resolved", now);
  }
  get(id, now = Date.now()) {
    this.expire(now); return map(this.#db.prepare("SELECT * FROM notifications WHERE id=?").get(id));
  }
  list({ limit = 100, before = Number.MAX_SAFE_INTEGER } = {}, now = Date.now()) {
    this.expire(now);
    const rows = this.#db.prepare("SELECT * FROM notifications WHERE seq<? ORDER BY seq DESC LIMIT ?").all(before, limit);
    return { notifications: rows.map(map), nextBefore: rows.length === limit ? rows.at(-1).seq : null,
      unread: this.#db.prepare("SELECT count(*) AS n FROM notifications WHERE state='pending' AND read_at IS NULL").get().n };
  }
  expire(now = Date.now()) {
    this.#db.prepare("UPDATE notifications SET state='expired',updated_at=? WHERE state='pending' AND expires_at<=?").run(now, now);
  }
  read(id, now = Date.now()) {
    this.#db.prepare("UPDATE notifications SET read_at=coalesce(read_at,?),updated_at=? WHERE id=?").run(now, now, id);
    return this.get(id, now);
  }
  transition(id, state, now = Date.now()) {
    if (!["resolved", "cancelled", "superseded"].includes(state)) throw new Error("invalid notification transition");
    this.expire(now);
    this.#db.prepare("UPDATE notifications SET state=?,updated_at=? WHERE id=? AND state='pending'").run(state, now, id);
    return this.get(id, now);
  }
  cancelSession(id, now = Date.now()) {
    this.#db.prepare("UPDATE notifications SET state='cancelled',updated_at=? WHERE (session_id=? OR root_id=?) AND state='pending'").run(now, id, id);
    this.#db.prepare("UPDATE notification_families SET closed_at=? WHERE root_id=? AND closed_at IS NULL").run(now, id);
  }
  cancelDialogs(now = Date.now()) {
    // Restart cannot revive a generation-bound interactive approval.
    this.#db.prepare(`UPDATE notifications SET state='cancelled',updated_at=? WHERE state='pending'
      AND json_extract(source_json,'$.type')='extension_ui'`).run(now);
  }
  claim(endpoints, now = Date.now()) {
    return this.#transaction(() => {
      this.expire(now);
      for (const endpoint of endpoints) this.#db.prepare(`INSERT OR IGNORE INTO notification_deliveries(notification_id,endpoint_id,state,due_at)
        SELECT id,?,'pending',? FROM notifications WHERE state='pending' AND read_at IS NULL AND expires_at>?`)
        .run(endpoint, now, now);
      this.#db.prepare(`UPDATE notification_deliveries SET state='expired',lease_id=NULL,lease_until=NULL
        WHERE state IN ('pending','inflight') AND notification_id IN (SELECT id FROM notifications WHERE state<>'pending' OR read_at IS NOT NULL)` ).run();
      this.#db.prepare(`UPDATE notification_deliveries SET state='failed',code='attempts_exhausted',lease_id=NULL,lease_until=NULL
        WHERE state='inflight' AND lease_until<=? AND attempts>=?`).run(now, NOTIFICATION_RETRY_MS.length);
      const claims = [];
      for (const endpoint of endpoints) {
        if (claims.length >= 8) break;
        const rows = this.#db.prepare(`SELECT * FROM notification_deliveries WHERE endpoint_id=? AND attempts<?
          AND ((state='pending' AND due_at<=?) OR (state='inflight' AND lease_until<=?)) ORDER BY due_at,notification_id LIMIT ?`)
          .all(endpoint, NOTIFICATION_RETRY_MS.length, now, now, 8 - claims.length);
        for (const row of rows) {
          const leaseId = randomUUID();
          this.#db.prepare(`UPDATE notification_deliveries SET state='inflight',attempts=attempts+1,lease_id=?,lease_until=?
            WHERE notification_id=? AND endpoint_id=?`).run(leaseId, now + 60_000, row.notification_id, endpoint);
          claims.push({ notification: this.get(row.notification_id, now), endpointId: endpoint, leaseId, attempt: row.attempts + 1 });
        }
      }
      return claims;
    });
  }
  receipt({ id, endpointId, leaseId, status }, now = Date.now()) {
    const allowed = ["accepted", "retry", "gone", "failed", "suppressed"];
    if (!allowed.includes(status)) throw new Error("invalid notification receipt");
    const row = this.#db.prepare("SELECT * FROM notification_deliveries WHERE notification_id=? AND endpoint_id=? AND lease_id=? AND state='inflight'").get(id, endpointId, leaseId);
    if (!row) return { recorded: false };
    const retry = status === "retry" && row.attempts < NOTIFICATION_RETRY_MS.length;
    const state = retry ? "pending" : status === "accepted" ? "accepted" : status === "suppressed" ? "suppressed" : "failed";
    this.#db.prepare(`UPDATE notification_deliveries SET state=?,code=?,due_at=?,lease_id=NULL,lease_until=NULL,accepted_at=?
      WHERE notification_id=? AND endpoint_id=?`).run(state, status, now + (NOTIFICATION_RETRY_MS[row.attempts - 1] ?? 900_000),
        status === "accepted" ? now : null, id, endpointId);
    return { recorded: true, state };
  }
  deliveries(id) {
    return this.#db.prepare(`SELECT endpoint_id AS endpointId,state,attempts,code,accepted_at AS acceptedAt
      FROM notification_deliveries WHERE notification_id=?`).all(id);
  }
}
