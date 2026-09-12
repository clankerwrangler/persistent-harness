import { randomUUID } from "node:crypto";
import { actorInputDigest } from "./protocol.mjs";
import { DatabaseSync } from "node:sqlite";
import { allocateUniqueRootName, defaultRootName, shortSessionId } from "./root-title.mjs";

export const SCHEMA_VERSION = 2;
export const GLOBAL_ROOT_FAMILY_ID = "local-roots";
export const MAX_PENDING_INPUT_BYTES_PER_SESSION = 16 * 1024 * 1024;
export const MAX_PENDING_INPUT_BYTES_GLOBAL = 64 * 1024 * 1024;
export const MAX_NAVIGATOR_SESSIONS = 512;
const MAX_NAVIGATOR_ANCESTOR_DEPTH = 64;

function parseJson(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicLaunch(value) {
  const launch = typeof value === "string" ? parseJson(value) : value;
  if (!launch) return null;
  return {
    model: launch.model,
    thinking: launch.thinking,
    ...(launch.contextFork ? { contextFork: launch.contextFork } : {}),
    capabilityIds: Array.isArray(launch.capabilities) ? launch.capabilities.map((item) => item.id) : [],
  };
}

function mapSession(row) {
  if (!row) return undefined;
  return {
    sessionId: row.id,
    shortId: row.short_id,
    sessionFile: row.session_file,
    cwd: row.cwd,
    repositoryRoot: row.repository_root,
    name: row.display_name,
    kind: row.kind,
    familyId: row.family_id,
    parentSessionId: row.parent_session_id,
    depth: Number(row.depth),
    activity: row.activity,
    lifecycle: row.lifecycle,
    actorGeneration: Number(row.actor_generation),
    actorPid: row.actor_pid == null ? null : Number(row.actor_pid),
    actorIdentity: parseJson(row.actor_identity_json),
    quietSince: row.quiet_since,
    lastError: row.last_error,
    launch: publicLaunch(row.launch_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? row.created_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    workingDescendantCount: Number(row.working_descendant_count ?? 0),
  };
}

function mapMessage(row) {
  if (!row) return undefined;
  return {
    messageId: row.id,
    senderId: row.sender_id,
    targetId: row.target_id,
    relationship: row.relationship,
    deliveryMode: row.delivery_mode,
    body: row.body,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    acceptedAt: row.accepted_at,
    queuedAt: row.queued_at,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
    lastError: row.last_error ?? null,
    senderEntryId: row.sender_entry_id ?? null,
  };
}

function normalizeInputProvenance(source, origin) {
  if (!["user", "cron", "background"].includes(source)) throw new Error("input source must be user, cron, or background");
  if (source === "user") {
    if (origin !== null) throw new Error("user input must not carry an internal origin");
    return { originJson: null };
  }
  const fields = source === "cron" ? ["jobId", "runId"] : ["jobId"];
  if (!origin || typeof origin !== "object" || Array.isArray(origin)
    || Object.keys(origin).some((key) => !fields.includes(key))
    || fields.some((key) => typeof origin[key] !== "string" || !origin[key].length || origin[key].length > 128)) {
    throw new Error("internal input requires an authenticated job origin");
  }
  return { originJson: JSON.stringify(Object.fromEntries(fields.map((key) => [key, origin[key]]))) };
}

function normalizeRetryIntent(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["targetId", "mode"].includes(key))
    || typeof value.targetId !== "string" || !value.targetId || value.targetId.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.targetId) || !["original", "explicit"].includes(value.mode)) {
    throw new Error("retryIntent must contain a bounded targetId and original or explicit mode");
  }
  return JSON.stringify({ targetId: value.targetId, mode: value.mode });
}

function mapActorInputReceipt(row) {
  const acceptedAt = Number(row.created_at), deliveredAt = row.delivered_at == null ? null : Number(row.delivered_at);
  return { inputId: row.id, sessionId: row.session_id, sequence: Number(row.sequence),
    createdAt: acceptedAt, acceptedAt, deliveredAt, entryId: row.delivered_entry_id ?? null,
    outcome: row.handled_at == null ? "accepted" : "handled", handledAt: row.handled_at ?? null,
    source: row.source ?? null, origin: parseJson(row.origin_json), retryIntent: parseJson(row.retry_intent_json),
    ...(row.client_message_id === null ? {} : { clientMessageId: row.client_message_id }),
    delivery: { state: deliveredAt === null ? "accepted" : "delivered", inputId: row.id,
      acceptedAt: new Date(acceptedAt).toISOString(), deliveredAt: deliveredAt === null ? null : new Date(deliveredAt).toISOString() } };
}

function mapTask(row) {
  if (!row) return undefined;
  return {
    taskId: row.id,
    childId: row.child_id,
    kind: row.kind,
    prompt: row.prompt,
    state: row.state,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    error: row.error,
    historyPeerName: row.history_peer_name ?? null,
    historyEntryId: row.history_entry_id ?? null,
  };
}

function relationshipBetween(sender, target) {
  if (sender.id === target.id) return "self";
  if (sender.parent_session_id === target.id) return "parent";
  if (target.parent_session_id === sender.id) return "child";
  if (sender.kind === "root" && target.kind === "root" && sender.family_id === target.family_id) return "sibling";
  if (sender.parent_session_id && sender.parent_session_id === target.parent_session_id) return "sibling";
  return undefined;
}

function activityRank(activity) {
  return { working: 0, delegating: 1, idle: 2, inactive: 3 }[activity] ?? 4;
}

const CURRENT_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL UNIQUE,
    session_file TEXT,
    cwd TEXT NOT NULL,
    repository_root TEXT,
    display_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('root', 'child')),
    family_id TEXT NOT NULL,
    parent_session_id TEXT REFERENCES sessions(id),
    depth INTEGER NOT NULL CHECK (depth >= 0),
    activity TEXT NOT NULL CHECK (activity IN ('working', 'delegating', 'idle', 'inactive')),
    streaming INTEGER NOT NULL DEFAULT 0 CHECK (streaming IN (0, 1)),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('starting', 'resident', 'passivated', 'stopped', 'error', 'deleted')),
    actor_token TEXT NOT NULL,
    actor_generation INTEGER NOT NULL CHECK (actor_generation >= 1),
    actor_pid INTEGER,
    actor_identity_json TEXT,
    launch_json TEXT,
    quiet_since INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER,
    started_at INTEGER,
    stopped_at INTEGER,
    deleted_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX root_name ON sessions(display_name) WHERE kind = 'root' AND lifecycle <> 'deleted';
  CREATE UNIQUE INDEX child_name_per_parent ON sessions(parent_session_id, display_name) WHERE kind = 'child' AND lifecycle <> 'deleted';
  CREATE INDEX sessions_family ON sessions(family_id, kind, created_at);
  CREATE INDEX sessions_lifecycle ON sessions(lifecycle, quiet_since, created_at, id);
  CREATE TABLE children (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE child_tasks (
    id TEXT PRIMARY KEY,
    child_id TEXT NOT NULL REFERENCES children(session_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('initial')),
    prompt TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'submitted', 'completed', 'failed')),
    created_at INTEGER NOT NULL,
    submitted_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    history_peer_name TEXT NOT NULL,
    history_entry_id TEXT
  ) STRICT;
  CREATE INDEX child_tasks_pending ON child_tasks(child_id, created_at, id) WHERE state IN ('queued', 'submitted');
  CREATE INDEX child_tasks_history_pending ON child_tasks(child_id, created_at, id) WHERE history_entry_id IS NULL;
  CREATE UNIQUE INDEX child_tasks_history_entries ON child_tasks(history_entry_id) WHERE history_entry_id IS NOT NULL;
  CREATE TABLE actor_inputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    images_json TEXT NOT NULL DEFAULT '[]',
    digest TEXT NOT NULL,
    behavior TEXT NOT NULL CHECK (behavior IN ('auto', 'steer', 'follow_up')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'accepted')),
    created_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_generation INTEGER
  ) STRICT;
  CREATE INDEX actor_inputs_pending ON actor_inputs(session_id, created_at, id);
  CREATE TABLE actor_input_receipts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sequence INTEGER NOT NULL UNIQUE,
    source TEXT CHECK (source IN ('user', 'cron', 'background')),
    origin_json TEXT,
    client_message_id TEXT,
    delivered_at INTEGER,
    delivered_entry_id TEXT,
    handled_at INTEGER,
    retry_intent_json TEXT
  ) STRICT;
  CREATE INDEX actor_input_receipts_session ON actor_input_receipts(session_id, created_at, id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES sessions(id),
    target_id TEXT NOT NULL REFERENCES sessions(id),
    relationship TEXT NOT NULL CHECK (relationship IN ('parent', 'child', 'sibling')),
    delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('auto', 'follow_up')),
    body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'delivered', 'acknowledged', 'rejected')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    accepted_at INTEGER NOT NULL,
    queued_at INTEGER,
    delivered_at INTEGER,
    acknowledged_at INTEGER,
    last_error TEXT,
    sender_entry_id TEXT
  ) STRICT;
  CREATE INDEX pending_messages_target ON messages(target_id, accepted_at, id) WHERE state IN ('queued', 'delivered');
  CREATE UNIQUE INDEX message_sender_entries ON messages(sender_id, sender_entry_id) WHERE sender_entry_id IS NOT NULL;
  CREATE TABLE session_skill_grants (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    manifest_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE usage_entries (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
    cost_total REAL NOT NULL CHECK (cost_total >= 0),
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_id)
  ) STRICT;
  CREATE INDEX usage_entries_recorded ON usage_entries(recorded_at, session_id, entry_id);
  CREATE TABLE session_context_usage (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    context_tokens INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
    context_window INTEGER NOT NULL CHECK (context_window > 0),
    percent REAL CHECK (percent IS NULL OR (percent >= 0 AND percent <= 10000)),
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

export class HarnessStore {
  #db;
  #deletingSessions = new Set();

  constructor(databasePath, { readOnly = false } = {}) {
    this.#db = new DatabaseSync(databasePath, { readOnly });
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // Native read-only connections can still create local WAL coordination sidecars.
    if (readOnly) return;
    if (databasePath !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  #terminalizeSessionWork(sessionId, now = Date.now()) {
    this.#db.prepare(`UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = coalesce(delivered_at, ?)
      WHERE target_id = ? AND state IN ('accepted', 'queued', 'delivered')`)
      .run("target session was deleted", now, sessionId);
    this.#db.prepare(`UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = coalesce(delivered_at, ?)
      WHERE sender_id = ? AND state = 'accepted'`)
      .run("sender session was deleted before its transcript entry was recorded", now, sessionId);
    this.#db.prepare(`UPDATE child_tasks SET state = 'failed', completed_at = coalesce(completed_at, ?), error = ?
      WHERE child_id = ? AND state IN ('queued', 'submitted')`)
      .run(now, "child session was deleted before its task completed", sessionId);
  }

  #terminalizeDeletedSessionWork(now = Date.now()) {
    for (const row of this.#db.prepare("SELECT id FROM sessions WHERE lifecycle = 'deleted'").all()) {
      this.#terminalizeSessionWork(row.id, now);
    }
  }

  #migrate() {
    const version = Number(this.#db.prepare("PRAGMA user_version").get().user_version);
    if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
      throw new Error(`unreleased database schema ${version} is unsupported; recreate the harness database`);
    }
    if (version === 0) {
      this.#db.exec(`BEGIN IMMEDIATE; ${CURRENT_SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
      return;
    }
    const sessionColumns = new Set(this.#db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name));
    const inputTable = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actor_inputs'").get();
    if (!sessionColumns.has("actor_token") || !sessionColumns.has("actor_generation") || !inputTable) {
      throw new Error("unreleased split-architecture database is unsupported; preserve session files, then recreate harness.sqlite");
    }
    let inputColumns = new Set(this.#db.prepare("PRAGMA table_info(actor_inputs)").all().map((row) => row.name));
    if (!inputColumns.has("images_json")) this.#db.exec("ALTER TABLE actor_inputs ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'");
    inputColumns = new Set(this.#db.prepare("PRAGMA table_info(actor_inputs)").all().map((row) => row.name));
    if (!inputColumns.has("digest")) this.#db.exec("ALTER TABLE actor_inputs ADD COLUMN digest TEXT");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS actor_input_receipts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      digest TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT; CREATE INDEX IF NOT EXISTS actor_input_receipts_session ON actor_input_receipts(session_id, created_at, id);`);
    const updateDigest = this.#db.prepare("UPDATE actor_inputs SET digest = ? WHERE id = ?");
    const insertReceipt = this.#db.prepare("INSERT OR IGNORE INTO actor_input_receipts(id, session_id, digest, created_at) VALUES (?, ?, ?, ?)");
    for (const row of this.#db.prepare("SELECT * FROM actor_inputs WHERE digest IS NULL").all()) {
      const digest = actorInputDigest(row.body, row.images_json, row.behavior); updateDigest.run(digest, row.id);
    }
    for (const row of this.#db.prepare("SELECT * FROM actor_inputs WHERE id NOT IN (SELECT id FROM actor_input_receipts)").all()) {
      insertReceipt.run(row.id, row.session_id, row.digest, row.created_at);
    }
    // Preserve legacy receipt order without guessing provenance or delivery times.
    const receiptColumns = new Set(this.#db.prepare("PRAGMA table_info(actor_input_receipts)").all().map((row) => row.name));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const [name, type] of [["sequence", "INTEGER"], ["source", "TEXT"], ["origin_json", "TEXT"],
        ["client_message_id", "TEXT"], ["delivered_at", "INTEGER"], ["delivered_entry_id", "TEXT"], ["handled_at", "INTEGER"], ["retry_intent_json", "TEXT"]]) {
        if (!receiptColumns.has(name)) this.#db.exec(`ALTER TABLE actor_input_receipts ADD COLUMN ${name} ${type}`);
      }
      this.#db.exec("UPDATE actor_input_receipts SET sequence = rowid WHERE sequence IS NULL");
      this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS actor_input_receipts_sequence ON actor_input_receipts(sequence)");
      if (!sessionColumns.has("last_activity_at")) this.#db.exec("ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER");
      if (sessionColumns.has("created_at")) this.#db.exec("UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL");
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    const messageColumns = new Set(this.#db.prepare("PRAGMA table_info(messages)").all().map((row) => row.name));
    if (!messageColumns.has("sender_entry_id")) this.#db.exec("ALTER TABLE messages ADD COLUMN sender_entry_id TEXT");
    this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS message_sender_entries ON messages(sender_id, sender_entry_id) WHERE sender_entry_id IS NOT NULL");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS session_context_usage (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      context_tokens INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
      context_window INTEGER NOT NULL CHECK (context_window > 0),
      percent REAL CHECK (percent IS NULL OR (percent >= 0 AND percent <= 10000)),
      updated_at INTEGER NOT NULL
    ) STRICT`);
    if (version === 1) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const childTaskTable = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'child_tasks'").get();
        if (childTaskTable) {
          const childTaskColumns = new Set(this.#db.prepare("PRAGMA table_info(child_tasks)").all().map((row) => row.name));
          if (!childTaskColumns.has("history_peer_name")) this.#db.exec("ALTER TABLE child_tasks ADD COLUMN history_peer_name TEXT");
          if (!childTaskColumns.has("history_entry_id")) this.#db.exec("ALTER TABLE child_tasks ADD COLUMN history_entry_id TEXT");
          // Legacy tasks predate child-creation history. Mark them with unique internal
          // receipts so migration never creates retroactive end-of-transcript rows.
          this.#db.exec(`UPDATE child_tasks SET history_peer_name = coalesce(history_peer_name,
            (SELECT display_name FROM sessions WHERE sessions.id = child_tasks.child_id), 'legacy-child')
            WHERE history_peer_name IS NULL`);
          this.#db.exec("UPDATE child_tasks SET history_entry_id = 'legacy-child-history:' || id WHERE history_entry_id IS NULL");
          this.#db.exec("CREATE INDEX IF NOT EXISTS child_tasks_history_pending ON child_tasks(child_id, created_at, id) WHERE history_entry_id IS NULL");
          this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS child_tasks_history_entries ON child_tasks(history_entry_id) WHERE history_entry_id IS NOT NULL");
        }
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
  }

  get schemaVersion() { return Number(this.#db.prepare("PRAGMA user_version").get().user_version); }

  #sessionRow(sessionId) {
    return this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  }

  #workingDescendantCount(sessionId) {
    return Number(this.#db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM sessions WHERE parent_session_id = ? AND lifecycle <> 'deleted'
        UNION ALL
        SELECT s.id FROM sessions s JOIN descendants d ON s.parent_session_id = d.id WHERE s.lifecycle <> 'deleted'
      )
      SELECT count(*) AS count FROM sessions WHERE id IN descendants AND activity = 'working'
    `).get(sessionId).count);
  }

  #sessionLineage(sessionId) {
    const names = [];
    const seen = new Set();
    let current = this.#db.prepare("SELECT id, display_name, parent_session_id FROM sessions WHERE id = ?").get(sessionId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.display_name);
      current = current.parent_session_id
        ? this.#db.prepare("SELECT id, display_name, parent_session_id FROM sessions WHERE id = ?").get(current.parent_session_id)
        : undefined;
    }
    return names.join("/");
  }

  #mappedSession(sessionId) {
    const row = this.#sessionRow(sessionId);
    if (!row) return undefined;
    row.working_descendant_count = this.#workingDescendantCount(sessionId);
    return { ...mapSession(row), lineage: this.#sessionLineage(sessionId) };
  }

  #insertRoot(params, now) {
    const id = params.sessionId;
    if (!id) throw new Error("root sessionId is required");
    if (!params.cwd) throw new Error("root cwd is required");
    const name = params.name?.trim() || defaultRootName(params.cwd, id);
    if (!params.actorToken) throw new Error("root actorToken is required");
    const actorToken = params.actorToken;
    this.#db.prepare(`
      INSERT INTO sessions (id, short_id, session_file, cwd, repository_root, display_name, kind,
        family_id, parent_session_id, depth, activity, streaming, lifecycle, actor_token,
        actor_generation, launch_json, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, 'root', ?, NULL, 0, 'inactive', 0, 'starting', ?, 1, ?, ?, ?, ?)
    `).run(id, shortSessionId(id), params.sessionFile ?? null, params.cwd, params.repositoryRoot ?? null,
      name, GLOBAL_ROOT_FAMILY_ID, actorToken, JSON.stringify(params.launch ?? {}), now, now, now);
    return id;
  }

  createRoot(params, now = params.now ?? Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#sessionRow(params.sessionId)) throw new Error("session already exists");
      const id = this.#insertRoot(params, now);
      this.#db.exec("COMMIT");
      return { session: this.#mappedSession(id) };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  admitRoot(params, now = params.now ?? Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#sessionRow(params.sessionId);
      if (!existing) {
        const id = this.#insertRoot(params, now);
        this.#db.exec("COMMIT");
        return { session: this.#mappedSession(id), created: true };
      }
      if (existing.kind !== "root") throw new Error("child Pi session cannot be admitted as a root");
      if (existing.lifecycle === "deleted") throw new Error("root was deleted");
      const name = params.name?.trim() || existing.display_name;
      this.#db.prepare(`UPDATE sessions SET session_file = coalesce(?, session_file), cwd = ?,
        repository_root = ?, display_name = ?, launch_json = coalesce(?, launch_json), updated_at = ? WHERE id = ?`)
        .run(params.sessionFile ?? null, params.cwd ?? existing.cwd,
          params.repositoryRoot ?? existing.repository_root, name,
          params.launch == null ? null : JSON.stringify(params.launch), now, existing.id);
      this.#db.exec("COMMIT");
      return { session: this.#mappedSession(existing.id), created: false };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  createChild(parentId, { sessionId, sessionFile, policy, actorToken, now = Date.now() }) {
    this.assertSessionAvailable(parentId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const parent = this.#sessionRow(parentId);
      if (!parent || parent.lifecycle === "deleted") throw new Error("parent session does not exist");
      if (this.#sessionRow(sessionId)) throw new Error("session already exists");
      const depth = parent.depth + 1;
      if (policy.depth != null && policy.depth !== depth) throw new Error("child depth does not match its parent edge");
      const displayName = policy.name?.trim() || `subagent-${shortSessionId(sessionId)}`;
      if (!actorToken) throw new Error("child actorToken is required");
      this.#db.prepare(`
        INSERT INTO sessions (id, short_id, session_file, cwd, repository_root, display_name, kind,
          family_id, parent_session_id, depth, activity, streaming, lifecycle, actor_token,
          actor_generation, launch_json, created_at, updated_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, 'child', ?, ?, ?, 'inactive', 0, 'starting', ?, 1, ?, ?, ?, ?)
      `).run(sessionId, shortSessionId(sessionId), sessionFile ?? null, policy.cwd ?? parent.cwd,
        policy.repositoryRoot ?? parent.repository_root, displayName, parent.family_id, parentId, depth,
        actorToken, JSON.stringify({ ...policy, depth }), now, now, now);
      this.#db.prepare("INSERT INTO children(session_id) VALUES (?)").run(sessionId);
      const taskId = randomUUID();
      this.#db.prepare("INSERT INTO child_tasks(id, child_id, kind, prompt, state, created_at, history_peer_name, history_entry_id) VALUES (?, ?, 'initial', ?, 'queued', ?, ?, NULL)")
        .run(taskId, sessionId, policy.prompt ?? null, now, displayName);
      this.#db.exec("COMMIT");
      return { session: this.#mappedSession(sessionId), task: this.getChildTask(taskId) };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  registerActor(params, now = Date.now()) {
    const sessionId = params.sessionId ?? params.actorId;
    const generation = params.generation ?? params.actorGeneration;
    this.assertSessionAvailable(sessionId);
    const row = this.#sessionRow(sessionId);
    if (!row) throw new Error("actor admission does not exist");
    if (row.lifecycle === "deleted") throw new Error("actor was deleted");
    if (row.actor_token !== params.actorToken || row.actor_generation !== generation) {
      throw new Error("actor generation or token is stale");
    }
    this.#db.prepare(`UPDATE sessions SET session_file = coalesce(?, session_file), cwd = coalesce(?, cwd),
      repository_root = coalesce(?, repository_root), updated_at = ? WHERE id = ?`)
      .run(params.sessionFile ?? null, params.cwd ?? null, params.repositoryRoot ?? null, now, sessionId);
    return { session: this.#mappedSession(sessionId) };
  }

  prepareActorRevival(sessionId, actorToken, now = Date.now(), { force = false, error = null } = {}) {
    this.assertSessionAvailable(sessionId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row) throw new Error("actor does not exist");
      if (row.lifecycle === "deleted") throw new Error("actor was deleted");
      if (!actorToken) throw new Error("actorToken is required for revival");
      if (!force && ["resident", "starting"].includes(row.lifecycle)) {
        this.#db.exec("COMMIT");
        return this.#mappedSession(sessionId);
      }
      this.#db.prepare(`UPDATE sessions SET lifecycle = 'starting', actor_token = ?,
        actor_generation = actor_generation + 1, actor_pid = NULL, actor_identity_json = NULL,
        streaming = 0, activity = 'inactive', quiet_since = NULL, last_error = ?, stopped_at = NULL,
        updated_at = ? WHERE id = ?`).run(actorToken, error, now, sessionId);
      this.#refreshAncestors(sessionId, now);
      this.#db.exec("COMMIT");
      return this.#mappedSession(sessionId);
    } catch (error_) { this.#db.exec("ROLLBACK"); throw error_; }
  }

  reconcileAfterDaemonStart(now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const previousOwners = this.#db.prepare(`SELECT * FROM sessions WHERE lifecycle IN ('starting', 'resident')`)
        .all().map((row) => ({
          sessionId: row.id,
          actorId: row.id,
          kind: row.kind,
          activity: row.activity,
          lifecycle: row.lifecycle,
          actorGeneration: Number(row.actor_generation),
          actorPid: row.actor_pid == null ? null : Number(row.actor_pid),
          actorIdentity: parseJson(row.actor_identity_json),
        }));
      for (const owner of previousOwners) {
        const lastError = owner.lifecycle === "starting"
          ? "daemon restarted during actor startup"
          : ["working", "delegating"].includes(owner.activity)
            ? "daemon restarted during active work; completion is unknown"
            : "daemon restarted; actor is queued for recovery";
        this.#db.prepare(`UPDATE sessions SET lifecycle = 'starting', actor_token = ?,
          actor_generation = actor_generation + 1, actor_pid = NULL, actor_identity_json = NULL,
          streaming = 0, activity = 'inactive', quiet_since = NULL, stopped_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?`).run(randomUUID(), now, lastError, now, owner.sessionId);
      }
      this.#db.prepare(`UPDATE child_tasks SET state = 'failed', completed_at = ?,
        error = 'daemon restarted during submitted work; completion is unknown' WHERE state = 'submitted'`).run(now);
      this.#terminalizeDeletedSessionWork(now);
      this.#db.exec("COMMIT");
      return previousOwners;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  listQueuedActorIds() {
    return this.#db.prepare("SELECT id FROM sessions WHERE lifecycle = 'starting' ORDER BY created_at, id")
      .all().map((row) => row.id);
  }

  getActorLaunch(sessionId) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted") return undefined;
    return {
      ...mapSession(row),
      lineage: this.#sessionLineage(sessionId),
      launch: parseJson(row.launch_json, {}),
      actorToken: row.actor_token,
    };
  }

  recordResolvedSessionInference(sessionId, generation, selection, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
      if (Number(row.actor_generation) !== generation) throw new Error("actor generation does not own the session");
      const launch = parseJson(row.launch_json, {});
      const currentModel = launch.model?.resolved;
      const currentThinking = launch.thinking?.resolved;
      if (currentModel && (currentModel.provider !== selection.provider || currentModel.id !== selection.model)) {
        throw new Error("resolved actor model differs from its launch policy");
      }
      if (currentThinking && currentThinking !== selection.thinkingLevel) {
        throw new Error("resolved actor thinking level differs from its launch policy");
      }
      if (!currentModel) launch.model = { requested: launch.model?.requested ?? null,
        resolved: { provider: selection.provider, id: selection.model }, source: launch.model?.source ?? "settings" };
      if (!currentThinking) launch.thinking = { requested: launch.thinking?.requested ?? null,
        resolved: selection.thinkingLevel, source: launch.thinking?.source ?? "settings" };
      if (!currentModel || !currentThinking) {
        this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(launch), now, sessionId);
      }
      this.#db.exec("COMMIT");
      return this.getActorLaunch(sessionId);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  updateSessionInference(sessionId, selection, expectedLaunch = undefined, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
      const launch = parseJson(row.launch_json, {});
      if (expectedLaunch !== undefined && JSON.stringify(launch) !== JSON.stringify(expectedLaunch)) {
        throw new Error("session inference policy changed concurrently");
      }
      launch.model = { requested: `${selection.provider}/${selection.model}`, resolved: { provider: selection.provider, id: selection.model }, source: "explicit" };
      launch.thinking = { requested: selection.thinkingLevel, resolved: selection.thinkingLevel, source: "explicit" };
      this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(launch), now, sessionId);
      if (Number.isSafeInteger(selection.contextWindow) && selection.contextWindow > 0) {
        this.#db.prepare(`INSERT INTO session_context_usage(session_id, context_tokens, context_window, percent, updated_at)
          VALUES (?, NULL, ?, NULL, ?) ON CONFLICT(session_id) DO UPDATE SET context_tokens = NULL,
          context_window = excluded.context_window, percent = NULL, updated_at = excluded.updated_at`)
          .run(sessionId, selection.contextWindow, now);
      } else this.#db.prepare("DELETE FROM session_context_usage WHERE session_id = ?").run(sessionId);
      this.#db.exec("COMMIT");
      return this.getActorLaunch(sessionId);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  restoreSessionLaunch(sessionId, launch, expectedLaunch, contextWindow, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#sessionRow(sessionId);
      if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
      const current = parseJson(row.launch_json, {});
      if (JSON.stringify(current) !== JSON.stringify(expectedLaunch)) throw new Error("session launch policy changed during rollback");
      this.#db.prepare("UPDATE sessions SET launch_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(launch), now, sessionId);
      if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
        this.#db.prepare(`INSERT INTO session_context_usage(session_id, context_tokens, context_window, percent, updated_at)
          VALUES (?, NULL, ?, NULL, ?) ON CONFLICT(session_id) DO UPDATE SET context_tokens = NULL,
          context_window = excluded.context_window, percent = NULL, updated_at = excluded.updated_at`)
          .run(sessionId, contextWindow, now);
      } else this.#db.prepare("DELETE FROM session_context_usage WHERE session_id = ?").run(sessionId);
      this.#db.exec("COMMIT");
      return this.getActorLaunch(sessionId);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  hasPendingSessionWork(sessionId) {
    const input = this.#db.prepare("SELECT 1 FROM actor_inputs WHERE session_id = ? LIMIT 1").get(sessionId);
    const task = this.#db.prepare("SELECT 1 FROM child_tasks WHERE child_id = ? AND state IN ('queued', 'submitted') LIMIT 1").get(sessionId);
    const message = this.#db.prepare("SELECT 1 FROM messages WHERE target_id = ? AND state IN ('queued', 'delivered') LIMIT 1").get(sessionId);
    return Boolean(input || task || message);
  }

  markActorStarted(sessionId, generation, { pid = null, sessionFile = null, processIdentity = null } = {}, now = Date.now()) {
    this.assertSessionAvailable(sessionId);
    const result = this.#db.prepare(`UPDATE sessions SET lifecycle = 'resident', actor_pid = ?,
      actor_identity_json = ?, session_file = coalesce(?, session_file), started_at = ?, stopped_at = NULL,
      streaming = 0, activity = 'idle', quiet_since = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND actor_generation = ? AND lifecycle = 'starting'`)
      .run(pid, processIdentity ? JSON.stringify(processIdentity) : null, sessionFile, now, now, now, sessionId, generation);
    if (result.changes !== 1) throw new Error("actor generation is stale or not starting");
    this.#refreshAncestors(sessionId, now);
    return this.#mappedSession(sessionId);
  }

  markActorLifecycle(sessionId, generation, lifecycle, error = null, now = Date.now()) {
    if (!["passivated", "stopped", "error"].includes(lifecycle)) throw new Error(`unsupported actor lifecycle: ${lifecycle}`);
    const result = this.#db.prepare(`UPDATE sessions SET lifecycle = ?, actor_pid = NULL,
      actor_identity_json = NULL, streaming = 0, activity = 'inactive', stopped_at = ?, quiet_since = NULL,
      last_error = ?, updated_at = ? WHERE id = ? AND actor_generation = ? AND lifecycle <> 'deleted'`)
      .run(lifecycle, now, error, now, sessionId, generation);
    if (result.changes !== 1) return false;
    this.#refreshAncestors(sessionId, now);
    return true;
  }

  setActorActivity(sessionId, generation, streaming, now = Date.now()) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.actor_generation !== generation || row.lifecycle !== "resident") {
      throw new Error("actor generation is stale or not resident");
    }
    const descendants = this.#workingDescendantCount(sessionId);
    const activity = streaming ? "working" : descendants > 0 ? "delegating" : "idle";
    const changed = row.streaming !== Number(streaming) || row.activity !== activity;
    this.#db.prepare("UPDATE sessions SET streaming = ?, activity = ?, quiet_since = ?, updated_at = ? WHERE id = ?")
      .run(streaming ? 1 : 0, activity, activity === "idle" ? (row.quiet_since ?? now) : null,
        changed ? now : row.updated_at, sessionId);
    this.#refreshAncestors(sessionId, now);
    return this.#mappedSession(sessionId);
  }

  #refreshAncestors(sessionId, now) {
    let current = this.#db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get(sessionId)?.parent_session_id;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = this.#sessionRow(current);
      if (!row) break;
      const descendants = this.#workingDescendantCount(current);
      let activity = "inactive";
      if (row.lifecycle === "resident") {
        activity = row.streaming ? "working" : descendants > 0 ? "delegating" : "idle";
      }
      const quietSince = activity === "idle" ? (row.quiet_since ?? now) : null;
      this.#db.prepare("UPDATE sessions SET activity = ?, quiet_since = ? WHERE id = ?")
        .run(activity, quietSince, current);
      current = row.parent_session_id;
    }
  }

  setSessionName(sessionId, name, now = Date.now()) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted") throw new Error("session does not exist");
    const displayName = name?.trim() || (row.kind === "root" ? defaultRootName(row.cwd, row.id) : row.display_name);
    if (row.kind === "child" && displayName !== row.display_name) throw new Error("child names are immutable after admission");
    this.#db.prepare("UPDATE sessions SET display_name = ?, updated_at = ? WHERE id = ?").run(displayName, now, sessionId);
    return this.#mappedSession(sessionId);
  }

  autoNameDefaultRoot(sessionId, title, now = Date.now()) {
    const row = this.#sessionRow(sessionId);
    if (!row || row.lifecycle === "deleted" || row.kind !== "root") {
      return { renamed: false, session: row ? this.#mappedSession(sessionId) : undefined };
    }
    if (row.display_name !== defaultRootName(row.cwd, row.id)) {
      return { renamed: false, session: this.#mappedSession(sessionId) };
    }
    if (typeof title !== "string" || !title.trim() || title === row.display_name) {
      return { renamed: false, session: this.#mappedSession(sessionId) };
    }
    let name;
    try {
      name = allocateUniqueRootName(title, row.short_id, (candidate) => this.#rootNameTaken(candidate, row.id));
    } catch {
      return { renamed: false, session: this.#mappedSession(sessionId) };
    }
    try {
      this.#db.prepare("UPDATE sessions SET display_name = ?, updated_at = ? WHERE id = ?").run(name, now, sessionId);
    } catch (error) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || error?.code === "SQLITE_CONSTRAINT") {
        return { renamed: false, session: this.#mappedSession(sessionId) };
      }
      throw error;
    }
    return { renamed: true, session: this.#mappedSession(sessionId) };
  }

  #rootNameTaken(name, exceptSessionId) {
    const row = this.#db.prepare(`SELECT id FROM sessions WHERE kind = 'root' AND lifecycle <> 'deleted'
      AND display_name = ? AND id <> ? LIMIT 1`).get(name, exceptSessionId);
    return Boolean(row);
  }

  getSession(sessionId) { return this.#mappedSession(sessionId); }
  resolveSession(selector) {
    const rows = this.#db.prepare(`SELECT id FROM sessions WHERE lifecycle <> 'deleted'
      AND (id = ? OR short_id = ? OR display_name = ?) ORDER BY created_at, id LIMIT 2`).all(selector, selector, selector);
    if (rows.length === 0) throw new Error(`session not found: ${selector}`);
    if (rows.length > 1) throw new Error(`session selector is ambiguous: ${selector}`);
    return this.#mappedSession(rows[0].id);
  }
  listSessions() {
    return this.#db.prepare("SELECT id FROM sessions WHERE lifecycle <> 'deleted' ORDER BY created_at, id")
      .all().map((row) => this.#mappedSession(row.id));
  }
  listNavigatorSessions({ limit = MAX_NAVIGATOR_SESSIONS, preferredSessionIds = [] } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NAVIGATOR_SESSIONS) throw new Error(`navigator limit must be from 1 through ${MAX_NAVIGATOR_SESSIONS}`);
    const preferred = [...new Set(preferredSessionIds.filter((id) => typeof id === "string" && id))].slice(0, limit);
    const preferredJson = JSON.stringify(preferred); let queryCount = 0;
    const total = Number(this.#db.prepare("SELECT count(*) AS count FROM sessions WHERE lifecycle <> 'deleted'").get().count); queryCount += 1;
    if (total === 0) return { sessions: [], total: 0, truncated: false,
      work: { queryCount, priorityRows: 0, newestRows: 0, candidateRows: 0, contextRows: 0, mappedRows: 0, newestReserve: 0 } };

    const priorityRows = this.#db.prepare(`WITH preferred(id) AS (SELECT value FROM json_each(?))
      SELECT s.*, CASE
        WHEN EXISTS (SELECT 1 FROM preferred p WHERE p.id = s.id) THEN 0
        WHEN s.activity = 'working' THEN 1 WHEN s.activity = 'delegating' THEN 2
        WHEN s.lifecycle = 'starting' THEN 3
        WHEN EXISTS (SELECT 1 FROM actor_inputs i WHERE i.session_id = s.id)
          OR EXISTS (SELECT 1 FROM child_tasks t WHERE t.child_id = s.id AND t.state IN ('queued', 'submitted'))
          OR EXISTS (SELECT 1 FROM messages m WHERE m.target_id = s.id AND m.state IN ('queued', 'delivered')) THEN 4
        WHEN s.lifecycle = 'resident' THEN 5 ELSE 6 END AS navigator_rank
      FROM sessions s WHERE s.lifecycle <> 'deleted' AND (EXISTS (SELECT 1 FROM preferred p WHERE p.id = s.id)
        OR s.activity IN ('working', 'delegating') OR s.lifecycle IN ('starting', 'resident')
        OR EXISTS (SELECT 1 FROM actor_inputs i WHERE i.session_id = s.id)
        OR EXISTS (SELECT 1 FROM child_tasks t WHERE t.child_id = s.id AND t.state IN ('queued', 'submitted'))
        OR EXISTS (SELECT 1 FROM messages m WHERE m.target_id = s.id AND m.state IN ('queued', 'delivered')))
      ORDER BY navigator_rank, s.updated_at DESC, s.created_at DESC, s.id DESC LIMIT ?`).all(preferredJson, limit); queryCount += 1;
    const newestRows = this.#db.prepare(`SELECT *, 6 AS navigator_rank FROM sessions WHERE lifecycle <> 'deleted'
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit); queryCount += 1;
    const byId = new Map(); const candidates = [];
    for (const row of [...priorityRows, ...newestRows]) if (!byId.has(row.id)) { byId.set(row.id, row); candidates.push(row); }

    const candidateJson = JSON.stringify(candidates.map((row) => row.id));
    const contextRows = this.#db.prepare(`WITH RECURSIVE parent_chain(id, hops) AS (
        SELECT parent_session_id, 1 FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND parent_session_id IS NOT NULL
        UNION ALL
        SELECT s.parent_session_id, p.hops + 1 FROM sessions s JOIN parent_chain p ON s.id = p.id
          WHERE s.parent_session_id IS NOT NULL AND p.hops < ?
      )
      SELECT DISTINCT s.* FROM sessions s JOIN parent_chain p ON p.id = s.id
      WHERE s.lifecycle <> 'deleted' ORDER BY s.depth, s.created_at, s.id LIMIT ?`)
      .all(candidateJson, MAX_NAVIGATOR_ANCESTOR_DEPTH, limit * MAX_NAVIGATOR_ANCESTOR_DEPTH); queryCount += 1;
    for (const row of contextRows) if (!byId.has(row.id)) byId.set(row.id, row);

    const newestReserve = Math.max(1, Math.floor(limit / 8));
    const orderedCandidates = []; const orderedIds = new Set();
    for (const row of [...newestRows.slice(0, newestReserve), ...priorityRows, ...newestRows]) {
      if (!orderedIds.has(row.id)) { orderedIds.add(row.id); orderedCandidates.push(row); }
    }
    const selectedIds = new Set();
    for (const candidate of orderedCandidates) {
      const chain = []; const seen = new Set(); let row = candidate;
      while (row && !seen.has(row.id) && chain.length <= MAX_NAVIGATOR_ANCESTOR_DEPTH) {
        seen.add(row.id); chain.unshift(row); row = row.parent_session_id ? byId.get(row.parent_session_id) : undefined;
      }
      const missing = chain.filter((item) => !selectedIds.has(item.id));
      if (selectedIds.size + missing.length <= limit) for (const item of missing) selectedIds.add(item.id);
      if (selectedIds.size === limit) break;
    }
    const selectedRows = [...selectedIds].map((id) => byId.get(id)).filter(Boolean)
      .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
    const selectedJson = JSON.stringify(selectedRows.map((row) => row.id));
    const workingCounts = this.#db.prepare(`WITH RECURSIVE working(descendant_id, ancestor_id, hops) AS (
        SELECT id, parent_session_id, 1 FROM (SELECT id, parent_session_id FROM sessions
          WHERE lifecycle <> 'deleted' AND activity = 'working' ORDER BY updated_at DESC, id LIMIT ?)
        WHERE parent_session_id IS NOT NULL
        UNION ALL
        SELECT w.descendant_id, s.parent_session_id, w.hops + 1 FROM working w JOIN sessions s ON s.id = w.ancestor_id
          WHERE s.parent_session_id IS NOT NULL AND w.hops < ?
      )
      SELECT ancestor_id, count(DISTINCT descendant_id) AS count FROM working
      WHERE ancestor_id IN (SELECT value FROM json_each(?)) GROUP BY ancestor_id`)
      .all(limit, MAX_NAVIGATOR_ANCESTOR_DEPTH, selectedJson); queryCount += 1;
    const counts = new Map(workingCounts.map((row) => [row.ancestor_id, Number(row.count)]));
    const sessions = selectedRows.map((row) => {
      const names = []; const seen = new Set(); let current = row;
      while (current && !seen.has(current.id) && names.length <= MAX_NAVIGATOR_ANCESTOR_DEPTH) {
        seen.add(current.id); names.unshift(current.display_name); current = current.parent_session_id ? byId.get(current.parent_session_id) : undefined;
      }
      return { ...mapSession({ ...row, working_descendant_count: counts.get(row.id) ?? 0 }), lineage: names.join("/") };
    });
    return { sessions, total, truncated: total > sessions.length,
      work: { queryCount, priorityRows: priorityRows.length, newestRows: newestRows.length,
        candidateRows: candidates.length, contextRows: contextRows.length, mappedRows: sessions.length, newestReserve } };
  }
  listChildren(parentId) {
    return this.#db.prepare(`SELECT s.id FROM sessions s JOIN children c ON c.session_id = s.id
      WHERE s.parent_session_id = ? AND s.lifecycle <> 'deleted' ORDER BY s.created_at, s.id`)
      .all(parentId).map((row) => this.#mappedSession(row.id));
  }

  resolveDirectChild(parentId, selector) {
    const rows = this.#db.prepare(`SELECT s.* FROM sessions s JOIN children c ON c.session_id = s.id
      WHERE s.parent_session_id = ? AND s.lifecycle <> 'deleted'`).all(parentId);
    const exact = rows.find((row) => row.id === selector || row.short_id === selector);
    if (exact) return this.#mappedSession(exact.id);
    const matches = rows.filter((row) => row.display_name === selector);
    if (matches.length === 0) throw new Error(`no direct child matches: ${selector}`);
    if (matches.length > 1) throw new Error(`child selector is ambiguous: ${selector}`);
    return this.#mappedSession(matches[0].id);
  }

  // Traverse tombstones too: older deletions could leave live grandchildren.
  getSessionSubtree(sessionId) {
    if (!this.#sessionRow(sessionId)) throw new Error("session does not exist");
    return this.#db.prepare(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM sessions WHERE id = ?
      UNION SELECT s.id FROM sessions s JOIN subtree t ON s.parent_session_id = t.id
    ) SELECT s.id FROM sessions s JOIN subtree t ON t.id = s.id ORDER BY s.depth DESC, s.id`)
      .all(sessionId).map((row) => this.#mappedSession(row.id));
  }

  isSessionDeleting(sessionId) { return this.#deletingSessions.has(sessionId); }
  assertSessionAvailable(sessionId) {
    if (this.isSessionDeleting(sessionId)) {
      throw Object.assign(new Error("session subtree is being deleted"), { code: "session_deleting" });
    }
    const session = this.#sessionRow(sessionId);
    if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
  }

  // The supervisor owns this synchronous fence across asynchronous actor shutdown.
  beginSessionDeletion(sessionId) {
    const sessions = this.getSessionSubtree(sessionId);
    if (sessions.some((session) => this.isSessionDeleting(session.sessionId))) {
      throw Object.assign(new Error("session subtree is already being deleted"), { code: "session_deleting" });
    }
    for (const session of sessions) this.#deletingSessions.add(session.sessionId);
    return sessions;
  }
  endSessionDeletion(sessions) {
    for (const session of sessions) this.#deletingSessions.delete(session.sessionId);
  }

  deleteChild(parentId, selector, now = Date.now()) {
    const child = this.resolveDirectChild(parentId, selector);
    return this.deleteSession(child.sessionId, now);
  }

  deleteSession(sessionId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const sessions = this.getSessionSubtree(sessionId);
      const tombstone = this.#db.prepare(`UPDATE sessions SET display_name = display_name || '-deleted-' || short_id,
        lifecycle = 'deleted', actor_token = '', actor_pid = NULL, actor_identity_json = NULL,
        streaming = 0, activity = 'inactive', quiet_since = NULL, last_error = NULL,
        deleted_at = ?, stopped_at = ?, updated_at = ? WHERE id = ? AND lifecycle <> 'deleted'`);
      for (const session of sessions) {
        this.#db.prepare("DELETE FROM actor_inputs WHERE session_id = ?").run(session.sessionId);
        this.#terminalizeSessionWork(session.sessionId, now);
        tombstone.run(now, now, now, session.sessionId);
      }
      this.#refreshAncestors(sessionId, now);
      this.#db.exec("COMMIT");
      return this.#mappedSession(sessionId);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  findIdleResidentActor(excludeId = null, { kind } = {}) {
    const row = this.#db.prepare(`SELECT id FROM sessions WHERE lifecycle = 'resident' AND activity = 'idle'
      AND id <> ? AND (? IS NULL OR kind = ?) ORDER BY coalesce(quiet_since, updated_at), created_at, id LIMIT 1`)
      .get(excludeId ?? "", kind ?? null, kind ?? null);
    return row ? this.#mappedSession(row.id) : undefined;
  }

  findIdleResidentChild(excludeId = null) { return this.findIdleResidentActor(excludeId, { kind: "child" }); }

  getChildTask(taskId) { return mapTask(this.#db.prepare("SELECT * FROM child_tasks WHERE id = ?").get(taskId)); }
  nextQueuedChildTask(childId) { return mapTask(this.#db.prepare("SELECT * FROM child_tasks WHERE child_id = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1").get(childId)); }
  submittedChildTask(childId) { return mapTask(this.#db.prepare("SELECT * FROM child_tasks WHERE child_id = ? AND state = 'submitted' ORDER BY submitted_at, id LIMIT 1").get(childId)); }
  markChildTaskSubmitted(taskId, now = Date.now()) {
    const result = this.#db.prepare("UPDATE child_tasks SET state = 'submitted', submitted_at = ? WHERE id = ? AND state = 'queued'").run(now, taskId);
    if (result.changes !== 1) throw new Error("child task is not queued");
    return this.getChildTask(taskId);
  }
  completeSubmittedChildTask(childId, error = null, now = Date.now()) {
    const task = this.submittedChildTask(childId);
    if (!task) return undefined;
    this.#db.prepare("UPDATE child_tasks SET state = ?, completed_at = ?, error = ? WHERE id = ?")
      .run(error ? "failed" : "completed", now, error, task.taskId);
    return this.getChildTask(task.taskId);
  }

  recordSessionLastError(sessionId, generation, error, now = Date.now()) {
    if (typeof error !== "string" || !error) return false;
    const result = this.#db.prepare(`UPDATE sessions SET last_error = ?, updated_at = ?
      WHERE id = ? AND actor_generation = ? AND lifecycle <> 'deleted'`).run(error, now, sessionId, generation);
    return result.changes === 1;
  }

  listPendingChildCreationHistory(parentId, limit = 100) {
    return this.#db.prepare(`SELECT t.id AS task_id, t.child_id, t.history_peer_name, t.prompt, t.created_at
      FROM child_tasks t JOIN sessions child ON child.id = t.child_id
      WHERE child.parent_session_id = ? AND t.history_entry_id IS NULL
      ORDER BY t.created_at, t.id LIMIT ?`).all(parentId, limit).map((row) => ({
      taskId: row.task_id, childId: row.child_id, childName: row.history_peer_name,
      relationship: "child", body: row.prompt, createdAt: row.created_at,
    }));
  }

  recordChildCreationEntry(parentId, { taskId, childId, childName, relationship, entryId, body }, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare(`SELECT t.*, child.parent_session_id, child.kind AS child_kind
        FROM child_tasks t JOIN sessions child ON child.id = t.child_id
        WHERE t.id = ? AND t.child_id = ?`).get(taskId, childId);
      if (!row || row.parent_session_id !== parentId || row.child_kind !== "child") throw new Error("child creation task does not belong to this parent");
      if (row.kind !== "initial" || row.prompt !== body || row.history_peer_name !== childName || relationship !== "child") {
        throw new Error("child creation history entry does not match its durable task");
      }
      if (row.history_entry_id && row.history_entry_id !== entryId) throw new Error("child creation already has a different transcript entry");
      let newlyRecorded = false;
      if (!row.history_entry_id) {
        this.#db.prepare("UPDATE child_tasks SET history_entry_id = ? WHERE id = ? AND history_entry_id IS NULL")
          .run(entryId, taskId);
        newlyRecorded = true;
      }
      const updated = this.#db.prepare("SELECT * FROM child_tasks WHERE id = ?").get(taskId);
      this.#db.exec("COMMIT");
      return { task: mapTask(updated), newlyRecorded };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  setSessionSkillGrant(sessionId, skills, now = Date.now()) {
    const session = this.#sessionRow(sessionId);
    if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
    if (!Array.isArray(skills) || skills.length > 128) throw new Error("skill grant must contain at most 128 skills");
    if (session.kind === "child") {
      const parentGrant = this.getSessionSkillGrant(session.parent_session_id);
      if (!parentGrant) throw new Error("immediate parent skill grant is unavailable");
      const allowed = new Map(parentGrant.skills.map((skill) => [skill.id, skill]));
      for (const skill of skills) {
        const expected = allowed.get(skill.id);
        if (!expected || expected.version !== skill.version || expected.contentHash !== skill.contentHash
          || expected.skillPath !== skill.skillPath || expected.pythonBacked !== skill.pythonBacked) {
          throw new Error(`child skill grant exceeds or differs from immediate parent: ${skill.id}`);
        }
      }
    }
    this.#db.prepare(`INSERT INTO session_skill_grants(session_id, manifest_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET manifest_json = excluded.manifest_json, updated_at = excluded.updated_at`)
      .run(sessionId, JSON.stringify(skills), now);
    return { version: 1, skills, updatedAt: now };
  }

  getSessionSkillGrant(sessionId) {
    const row = this.#db.prepare("SELECT manifest_json, updated_at FROM session_skill_grants WHERE session_id = ?").get(sessionId);
    if (!row) return undefined;
    return { version: 1, skills: parseJson(row.manifest_json, []), updatedAt: row.updated_at };
  }

  recordUsage(sessionId, usage, now = Date.now()) {
    if (!this.#sessionRow(sessionId)) throw new Error("session does not exist");
    const result = this.#db.prepare(`INSERT OR IGNORE INTO usage_entries (
      session_id, entry_id, provider, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, total_tokens, cost_total, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, usage.entryId, usage.provider, usage.model, usage.input, usage.output,
        usage.cacheRead, usage.cacheWrite, usage.reasoning, usage.totalTokens, usage.costTotal, now);
    return { recorded: result.changes === 1 };
  }

  recordContextUsage(sessionId, usage, now = Date.now()) {
    if (!this.#sessionRow(sessionId)) throw new Error("session does not exist");
    this.#db.prepare(`INSERT INTO session_context_usage(session_id, context_tokens, context_window, percent, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET context_tokens = excluded.context_tokens,
      context_window = excluded.context_window, percent = excluded.percent, updated_at = excluded.updated_at`)
      .run(sessionId, usage.tokens, usage.contextWindow, usage.percent, now);
    return { recorded: true };
  }

  getSessionTelemetry(sessionId) {
    if (!this.#sessionRow(sessionId)) throw new Error("session does not exist");
    const total = this.#db.prepare(`SELECT count(*) AS entries, coalesce(sum(input_tokens), 0) AS input_tokens,
      coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
      coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens, coalesce(sum(reasoning_tokens), 0) AS reasoning_tokens,
      coalesce(sum(total_tokens), 0) AS total_tokens
      FROM usage_entries WHERE session_id = ?`).get(sessionId);
    const latest = this.#db.prepare(`SELECT provider, model, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, total_tokens FROM usage_entries
      WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).get(sessionId);
    const context = this.#db.prepare("SELECT context_tokens, context_window, percent FROM session_context_usage WHERE session_id = ?").get(sessionId);
    const project = (row) => {
      const input = Number(row.input_tokens), cacheRead = Number(row.cache_read_tokens), cacheWrite = Number(row.cache_write_tokens);
      const denominator = input + cacheRead + cacheWrite;
      return { input, output: Number(row.output_tokens), cacheRead, cacheWrite,
        reasoning: Number(row.reasoning_tokens ?? 0), totalTokens: Number(row.total_tokens),
        cacheHitRatio: denominator > 0 ? cacheRead / denominator : null };
    };
    return {
      session: { entries: Number(total.entries), ...project(total) },
      latestTurn: latest ? { provider: latest.provider, model: latest.model, ...project(latest) } : null,
      context: context ? { tokens: context.context_tokens == null ? null : Number(context.context_tokens),
        contextWindow: Number(context.context_window), percent: context.percent == null ? null : Number(context.percent) } : null,
    };
  }

  getUsageSummary() {
    const total = this.#db.prepare(`SELECT count(*) AS entries, coalesce(sum(input_tokens), 0) AS input_tokens,
      coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
      coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens, coalesce(sum(reasoning_tokens), 0) AS reasoning_tokens,
      coalesce(sum(total_tokens), 0) AS total_tokens, coalesce(sum(cost_total), 0.0) AS cost_total FROM usage_entries`).get();
    const byModel = this.#db.prepare(`SELECT provider, model, count(*) AS entries, sum(total_tokens) AS total_tokens,
      sum(cost_total) AS cost_total FROM usage_entries GROUP BY provider, model
      ORDER BY total_tokens DESC, provider, model LIMIT 64`).all().map((row) => ({
      provider: row.provider, model: row.model, entries: Number(row.entries),
      totalTokens: Number(row.total_tokens), costTotal: Number(row.cost_total),
    }));
    return {
      entries: Number(total.entries), inputTokens: Number(total.input_tokens), outputTokens: Number(total.output_tokens),
      cacheReadTokens: Number(total.cache_read_tokens), cacheWriteTokens: Number(total.cache_write_tokens),
      reasoningTokens: Number(total.reasoning_tokens), totalTokens: Number(total.total_tokens),
      costTotal: Number(total.cost_total), byModel,
    };
  }

  getUsageWindow(windowMinutes, observedAt = Date.now()) {
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 10_080) {
      throw new Error("usage window must be an integer from 1 through 10080 minutes");
    }
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("usage observation time must be a non-negative safe integer");
    const since = observedAt - windowMinutes * 60_000;
    // SQLite integer sum() throws once a valid sequence exceeds int64. total() accumulates
    // non-negative values without that failure; project() then applies one finite JSON-safe
    // precision boundary to every numeric total and reports each field that hit it.
    const totals = `count(*) AS entries, count(DISTINCT session_id) AS sessions,
      total(input_tokens) AS input_tokens, total(output_tokens) AS output_tokens,
      total(cache_read_tokens) AS cache_read_tokens, total(cache_write_tokens) AS cache_write_tokens,
      total(reasoning_tokens) AS reasoning_tokens, total(total_tokens) AS total_tokens,
      total(cost_total) AS estimated_cost`;
    const total = this.#db.prepare(`SELECT ${totals} FROM usage_entries WHERE recorded_at >= ? AND recorded_at <= ?`)
      .get(since, observedAt);
    const rows = this.#db.prepare(`SELECT provider, model, ${totals} FROM usage_entries
      WHERE recorded_at >= ? AND recorded_at <= ? GROUP BY provider, model
      ORDER BY total(total_tokens) DESC, provider, model LIMIT 65`).all(since, observedAt);
    const numericFields = [
      ["entries", "entries"], ["sessions", "sessions"], ["inputTokens", "input_tokens"],
      ["outputTokens", "output_tokens"], ["cacheReadTokens", "cache_read_tokens"],
      ["cacheWriteTokens", "cache_write_tokens"], ["reasoningTokens", "reasoning_tokens"],
      ["totalTokens", "total_tokens"], ["estimatedCost", "estimated_cost"],
    ];
    const project = (row) => {
      const result = {};
      const saturated = {};
      for (const [field, column] of numericFields) {
        const value = Number(row[column]);
        saturated[field] = !Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER;
        result[field] = saturated[field] ? Number.MAX_SAFE_INTEGER : value;
      }
      return { ...result, precision: { safeMaximum: Number.MAX_SAFE_INTEGER, saturated } };
    };
    return {
      window: { minutes: windowMinutes, since, observedAt, boundaries: "inclusive" },
      aggregate: project(total),
      byModel: rows.slice(0, 64).map((row) => ({ provider: row.provider, model: row.model, ...project(row) })),
      byModelTruncated: rows.length > 64,
    };
  }

  getOperationalCounts() {
    const sessions = Object.fromEntries(this.#db.prepare("SELECT kind || ':' || activity AS key, count(*) AS count FROM sessions WHERE lifecycle <> 'deleted' GROUP BY kind, activity")
      .all().map((row) => [row.key, Number(row.count)]));
    const actors = Object.fromEntries(this.#db.prepare("SELECT lifecycle AS key, count(*) AS count FROM sessions GROUP BY lifecycle")
      .all().map((row) => [row.key, Number(row.count)]));
    const children = Object.fromEntries(this.#db.prepare(`SELECT s.lifecycle AS key, count(*) AS count FROM children c
      JOIN sessions s ON s.id = c.session_id GROUP BY s.lifecycle`).all().map((row) => [row.key, Number(row.count)]));
    const messages = Object.fromEntries(this.#db.prepare("SELECT state AS key, count(*) AS count FROM messages GROUP BY state")
      .all().map((row) => [row.key, Number(row.count)]));
    const inputs = Object.fromEntries(this.#db.prepare("SELECT state AS key, count(*) AS count FROM actor_inputs GROUP BY state")
      .all().map((row) => [row.key, Number(row.count)]));
    const tasks = Object.fromEntries(this.#db.prepare("SELECT state AS key, count(*) AS count FROM child_tasks GROUP BY state")
      .all().map((row) => [row.key, Number(row.count)]));
    return { sessions, actors, children, messages, inputs, tasks };
  }

  diagnose() {
    const issues = [];
    for (const row of this.#db.prepare("SELECT * FROM sessions WHERE lifecycle <> 'deleted'").all()) {
      if (!row.session_file) issues.push({ code: "missing_session_file", sessionId: row.id });
      if (row.lifecycle === "resident" && row.actor_pid == null) issues.push({ code: "resident_without_pid", sessionId: row.id });
      if (!row.actor_token) issues.push({ code: "missing_actor_token", sessionId: row.id });
    }
    for (const row of this.#db.prepare("PRAGMA foreign_key_check").all()) {
      issues.push({ code: "foreign_key_violation", table: row.table, rowId: row.rowid });
    }
    for (const row of this.#db.prepare(`SELECT m.id, m.target_id FROM messages m JOIN sessions s ON s.id = m.target_id
      WHERE s.lifecycle = 'deleted' AND m.state IN ('accepted', 'queued', 'delivered') LIMIT 256`).all()) {
      issues.push({ code: "message_targets_deleted_session", messageId: row.id, sessionId: row.target_id });
    }
    for (const row of this.#db.prepare(`SELECT m.id, m.sender_id FROM messages m JOIN sessions s ON s.id = m.sender_id
      WHERE s.lifecycle = 'deleted' AND m.state = 'accepted' LIMIT 256`).all()) {
      issues.push({ code: "message_awaits_deleted_sender", messageId: row.id, sessionId: row.sender_id });
    }
    for (const row of this.#db.prepare(`SELECT t.id, t.child_id FROM child_tasks t JOIN sessions s ON s.id = t.child_id
      WHERE s.lifecycle = 'deleted' AND t.state IN ('queued', 'submitted') LIMIT 256`).all()) {
      issues.push({ code: "task_targets_deleted_child", taskId: row.id, sessionId: row.child_id });
    }
    return issues.slice(0, 256);
  }

  createActorInput(sessionId, { inputId = randomUUID(), message, images = [], behavior = "auto", source = "user",
    origin = null, clientMessageId = null, retryIntent = null, pendingLimit = 100, pendingBytesLimit = MAX_PENDING_INPUT_BYTES_PER_SESSION,
    globalPendingBytesLimit = MAX_PENDING_INPUT_BYTES_GLOBAL }, now = Date.now()) {
    this.assertSessionAvailable(sessionId);
    const session = this.#sessionRow(sessionId);
    if (!session || session.lifecycle === "deleted") throw new Error("session does not exist");
    const provenance = normalizeInputProvenance(source, origin);
    const retryIntentJson = normalizeRetryIntent(retryIntent);
    if (retryIntent && behavior !== "auto") throw new Error("retry input behavior must be auto");
    if (clientMessageId !== null && (typeof clientMessageId !== "string" || !clientMessageId.length || clientMessageId.length > 128)) {
      throw new Error("clientMessageId must be a non-empty string of at most 128 characters");
    }
    const imagesJson = JSON.stringify(images); const digest = actorInputDigest(message, imagesJson, behavior);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ?").get(inputId);
      if (receipt) {
        if (receipt.session_id !== sessionId || receipt.digest !== digest || receipt.retry_intent_json !== retryIntentJson
          || (receipt.source !== null && (receipt.source !== source || receipt.origin_json !== provenance.originJson))
          || (receipt.client_message_id !== null && clientMessageId !== null && receipt.client_message_id !== clientMessageId)) {
          throw new Error("actor input id was reused with different input");
        }
        // A supervisor job replay can restore missing legacy metadata from its actual origin.
        if (receipt.source === null && source !== "user") {
          this.#db.prepare("UPDATE actor_input_receipts SET source = ?, origin_json = ? WHERE id = ?")
            .run(source, provenance.originJson, inputId);
        }
        if (receipt.client_message_id === null && clientMessageId !== null) {
          this.#db.prepare("UPDATE actor_input_receipts SET client_message_id = ? WHERE id = ?").run(clientMessageId, inputId);
        }
        const result = this.getActorInput(inputId, sessionId);
        this.#db.exec("COMMIT");
        return result.state === "completed" ? { ...result, message, images, behavior } : result;
      }
      const pending = Number(this.#db.prepare("SELECT count(*) AS count FROM actor_inputs WHERE session_id = ?").get(sessionId).count);
      if (pending >= pendingLimit) throw new Error("target pending user-input limit exceeded");
      const payloadBytes = Buffer.byteLength(message, "utf8") + Buffer.byteLength(imagesJson, "utf8");
      const sessionBytes = Number(this.#db.prepare("SELECT coalesce(sum(length(CAST(body AS BLOB)) + length(CAST(images_json AS BLOB))), 0) AS bytes FROM actor_inputs WHERE session_id = ?").get(sessionId).bytes);
      const globalBytes = Number(this.#db.prepare("SELECT coalesce(sum(length(CAST(body AS BLOB)) + length(CAST(images_json AS BLOB))), 0) AS bytes FROM actor_inputs").get().bytes);
      if (sessionBytes + payloadBytes > pendingBytesLimit) throw new Error("target pending user-input byte limit exceeded");
      if (globalBytes + payloadBytes > globalPendingBytesLimit) throw new Error("global pending user-input byte limit exceeded");
      this.#db.prepare(`INSERT INTO actor_input_receipts(id, session_id, digest, created_at, sequence, source, origin_json, client_message_id, retry_intent_json)
        VALUES (?, ?, ?, ?, (SELECT coalesce(max(sequence), 0) + 1 FROM actor_input_receipts), ?, ?, ?, ?)`)
        .run(inputId, sessionId, digest, now, source, provenance.originJson, clientMessageId, retryIntentJson);
      this.#db.prepare("INSERT INTO actor_inputs(id, session_id, body, images_json, digest, behavior, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)")
        .run(inputId, sessionId, message, imagesJson, digest, behavior, now);
      this.recordSessionActivity(sessionId, now);
      const result = this.getActorInput(inputId, sessionId);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  matchActorInputRequest(sessionId, { inputId, message, images, behavior = "auto", retryIntent = null, clientMessageId = null }) {
    const retryIntentJson = normalizeRetryIntent(retryIntent);
    if (retryIntent && behavior !== "auto") throw new Error("retry input behavior must be auto");
    if (retryIntent?.mode === "original" && (message !== undefined || images !== undefined)) {
      throw new Error("original retry request must omit message and images");
    }
    if (inputId === undefined) return undefined;
    const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ?").get(inputId);
    if (!receipt) return undefined;
    const explicit = retryIntent?.mode !== "original";
    if (receipt.session_id !== sessionId || receipt.retry_intent_json !== retryIntentJson
      || (receipt.client_message_id !== null && clientMessageId !== null && receipt.client_message_id !== clientMessageId)
      || (explicit && (receipt.digest !== actorInputDigest(message, JSON.stringify(images ?? []), behavior)
        || (receipt.source !== null && receipt.source !== "user")))) {
      throw new Error("actor input id was reused with different input");
    }
    return this.getActorInput(inputId, sessionId);
  }

  getActorInput(inputId, sessionId, { includeDigest = false } = {}) {
    const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ? AND session_id = ?").get(inputId, sessionId);
    if (!receipt) return undefined;
    const pending = this.#db.prepare("SELECT * FROM actor_inputs WHERE id = ? AND session_id = ?").get(inputId, sessionId);
    return { ...mapActorInputReceipt(receipt), ...(includeDigest ? { digest: receipt.digest } : {}), state: pending?.state ?? "completed",
      transportAcceptedAt: pending?.accepted_at ?? null,
      acceptedGeneration: pending?.accepted_generation == null ? null : Number(pending.accepted_generation),
      ...(pending ? { message: pending.body, images: parseJson(pending.images_json, []), behavior: pending.behavior } : {}) };
  }

  listActorInputReceipts(sessionId, { inputIds = null, limit = 1000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("receipt limit must be from 1 through 10000");
    if (inputIds !== null && (!Array.isArray(inputIds) || inputIds.length > 10000 || inputIds.some((id) => typeof id !== "string"))) {
      throw new Error("inputIds must be an array of at most 10000 strings");
    }
    return (inputIds === null
      ? this.#db.prepare("SELECT * FROM actor_input_receipts WHERE session_id = ? ORDER BY sequence DESC LIMIT ?").all(sessionId, limit).reverse()
      : this.#db.prepare("SELECT * FROM actor_input_receipts WHERE session_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY sequence LIMIT ?")
        .all(sessionId, JSON.stringify(inputIds), limit)).map(mapActorInputReceipt);
  }

  listPendingActorInputs(sessionId) {
    return this.#db.prepare(`SELECT i.id FROM actor_inputs i JOIN actor_input_receipts r ON r.id = i.id
      WHERE i.session_id = ? ORDER BY r.sequence`).all(sessionId).map((row) => this.getActorInput(row.id, sessionId));
  }

  markActorInputAccepted(inputId, sessionId, generation, now = Date.now()) {
    this.#db.prepare("UPDATE actor_inputs SET state = 'accepted', accepted_at = coalesce(accepted_at, ?), accepted_generation = ? WHERE id = ? AND session_id = ?")
      .run(now, generation, inputId, sessionId);
    // Context admission can finish before the RPC preflight acknowledgement arrives.
    const input = this.getActorInput(inputId, sessionId);
    if (!input) throw new Error("actor input does not exist");
    return input;
  }

  completeActorInput(inputId, sessionId, now = Date.now(), entryId = null) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ? AND session_id = ?").get(inputId, sessionId);
      if (!receipt) { this.#db.exec("COMMIT"); return false; }
      if (receipt.handled_at !== null) throw new Error("input was handled without a model message");
      if (receipt.delivered_entry_id && entryId && receipt.delivered_entry_id !== entryId) throw new Error("input has a different delivered entry");
      const changed = receipt.delivered_at === null;
      this.#db.prepare(`UPDATE actor_input_receipts SET delivered_at = coalesce(delivered_at, ?),
        delivered_entry_id = coalesce(delivered_entry_id, ?) WHERE id = ? AND session_id = ?`)
        .run(Math.max(now, receipt.created_at), entryId, inputId, sessionId);
      this.#db.prepare("DELETE FROM actor_inputs WHERE id = ? AND session_id = ?").run(inputId, sessionId);
      if (changed) this.recordSessionActivity(sessionId, now);
      this.#db.exec("COMMIT");
      return changed;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  markActorInputHandled(inputId, sessionId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#db.prepare("SELECT * FROM actor_input_receipts WHERE id = ? AND session_id = ?").get(inputId, sessionId);
      if (!receipt) throw new Error("actor input does not exist");
      if (receipt.source !== null && receipt.source !== "user") throw new Error("only a user control input can be handled without a model message");
      if (receipt.delivered_at !== null) throw new Error("input was already delivered to model context");
      const changed = receipt.handled_at === null;
      this.#db.prepare("UPDATE actor_input_receipts SET handled_at = coalesce(handled_at, ?) WHERE id = ? AND session_id = ?")
        .run(Math.max(now, receipt.created_at), inputId, sessionId);
      this.#db.prepare("DELETE FROM actor_inputs WHERE id = ? AND session_id = ?").run(inputId, sessionId);
      if (changed) this.recordSessionActivity(sessionId, now);
      const input = this.getActorInput(inputId, sessionId);
      this.#db.exec("COMMIT"); return input;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  recordSessionActivity(sessionId, now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("activity timestamp must be nonnegative integer milliseconds");
    return this.#db.prepare(`UPDATE sessions SET last_activity_at = ?
      WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)`)
      .run(now, sessionId, now).changes === 1;
  }

  listSearchableSessions(callerId, { includeDeleted = false, includeSelf = false } = {}) {
    const caller = this.#sessionRow(callerId);
    if (!caller || caller.lifecycle === "deleted") throw new Error("caller session does not exist");
    const rows = this.#db.prepare("SELECT * FROM sessions WHERE family_id = ? AND session_file IS NOT NULL")
      .all(caller.family_id);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const historicalName = (row) => {
      const suffix = `-deleted-${row.short_id}`;
      return row.lifecycle === "deleted" && row.display_name.endsWith(suffix)
        ? row.display_name.slice(0, -suffix.length) : row.display_name;
    };
    const lineage = (row) => {
      const names = [historicalName(row)]; const seen = new Set([row.id]); let current = row;
      while (current.parent_session_id) {
        current = byId.get(current.parent_session_id);
        if (!current || seen.has(current.id)) break;
        seen.add(current.id); names.unshift(historicalName(current));
      }
      return names.join("/");
    };
    return rows.filter((row) => (includeDeleted || row.lifecycle !== "deleted")
      && (includeSelf || row.id !== caller.id))
      .map((row) => ({ ...mapSession(row), name: historicalName(row), lineage: lineage(row) }))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
  }

  getRoster(callerId) {
    const rows = this.#db.prepare("SELECT * FROM sessions WHERE lifecycle <> 'deleted'").all();
    const caller = rows.find((row) => row.id === callerId);
    if (!caller) throw new Error("caller session does not exist");
    const byId = new Map(rows.map((row) => [row.id, row]));
    const lineage = (row) => {
      const names = [row.display_name];
      const seen = new Set([row.id]);
      let current = row;
      while (current.parent_session_id) {
        current = byId.get(current.parent_session_id);
        if (!current || seen.has(current.id)) break;
        seen.add(current.id);
        names.unshift(current.display_name);
      }
      return names.join("/");
    };
    return rows.filter((row) => row.family_id === caller.family_id && relationshipBetween(caller, row)).map((row) => ({
      sessionId: row.id, shortId: row.short_id, name: row.display_name, kind: row.kind, depth: Number(row.depth),
      lineage: lineage(row), relationship: relationshipBetween(caller, row), activity: row.activity,
      lifecycle: row.lifecycle, cwd: row.cwd, repositoryRoot: row.repository_root,
      workingDescendantCount: this.#workingDescendantCount(row.id),
    })).sort((left, right) => {
      if (left.relationship === "self" && right.relationship !== "self") return -1;
      if (right.relationship === "self" && left.relationship !== "self") return 1;
      return activityRank(left.activity) - activityRank(right.activity)
        || left.name.localeCompare(right.name) || left.sessionId.localeCompare(right.sessionId);
    });
  }

  #resolveReachableTarget(senderId, selector) {
    const sender = this.#sessionRow(senderId);
    if (!sender || sender.lifecycle === "deleted") throw new Error("sender session does not exist");
    const rows = this.#db.prepare("SELECT * FROM sessions WHERE family_id = ? AND lifecycle <> 'deleted'").all(sender.family_id);
    const exact = rows.find((row) => row.id === selector || row.short_id === selector);
    if (exact) {
      const relationship = relationshipBetween(sender, exact);
      if (relationship === "self") throw new Error("cannot send a message to the same session");
      if (!relationship) throw new Error("target is outside permitted family reach");
      return { target: exact, relationship };
    }
    const matches = rows.filter((row) => row.display_name === selector && relationshipBetween(sender, row) !== undefined);
    if (matches.length === 0) throw new Error(`no reachable target matches: ${selector}`);
    if (matches.length > 1) throw new Error(`target name is ambiguous; use a stable ID: ${selector}`);
    const relationship = relationshipBetween(sender, matches[0]);
    if (relationship === "self") throw new Error("cannot send a message to the same session");
    return { target: matches[0], relationship };
  }

  createMessage(senderId, params, { pendingLimit = 100, now = Date.now() } = {}) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const { target, relationship } = this.#resolveReachableTarget(senderId, params.target);
      this.assertSessionAvailable(senderId);
      this.assertSessionAvailable(target.id);
      const id = params.messageId ?? randomUUID();
      const existing = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      if (existing) {
        if (existing.sender_id !== senderId || existing.target_id !== target.id
          || existing.delivery_mode !== params.deliveryMode || existing.body !== params.body) {
          throw new Error(`message ID already exists with different content: ${id}`);
        }
        this.#db.exec("COMMIT");
        return mapMessage(existing);
      }
      const pending = Number(this.#db.prepare(`SELECT count(*) AS count FROM messages
        WHERE target_id = ? AND state IN ('accepted', 'queued', 'delivered')`).get(target.id).count);
      if (pending >= pendingLimit) throw new Error(`target pending-message limit reached: ${pendingLimit}`);
      this.#db.prepare(`INSERT INTO messages (id, sender_id, target_id, relationship, delivery_mode, body,
        state, attempt_count, accepted_at) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 0, ?)`)
        .run(id, senderId, target.id, relationship, params.deliveryMode, params.body, now);
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      this.#db.exec("COMMIT");
      return mapMessage(row);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  recordMessageSenderEntry(senderId, { messageId, entryId, peerId, relationship, body }, now = Date.now()) {
    this.assertSessionAvailable(senderId);
    this.assertSessionAvailable(peerId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ? AND sender_id = ?").get(messageId, senderId);
      if (!row) throw new Error("message does not exist for this sender");
      if (row.target_id !== peerId || row.relationship !== relationship || row.body !== body) {
        throw new Error("agent message transcript entry does not match its durable message");
      }
      if (row.sender_entry_id && row.sender_entry_id !== entryId) throw new Error("message already has a different transcript entry");
      let newlyQueued = false;
      if (!row.sender_entry_id) {
        if (row.state !== "accepted") throw new Error(`message cannot record its sender entry from state ${row.state}`);
        this.#db.prepare("UPDATE messages SET sender_entry_id = ?, state = 'queued', queued_at = ? WHERE id = ?")
          .run(entryId, now, messageId);
        newlyQueued = true;
      }
      const updated = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
      this.#db.exec("COMMIT");
      return { message: mapMessage(updated), newlyQueued };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  listMessagesAwaitingSenderEntry(senderId, limit = 100) {
    return this.#db.prepare("SELECT * FROM messages WHERE sender_id = ? AND state = 'accepted' ORDER BY accepted_at, id LIMIT ?")
      .all(senderId, limit).map(mapMessage);
  }

  listPendingMessages(targetId) {
    return this.#db.prepare("SELECT * FROM messages WHERE target_id = ? AND state IN ('queued', 'delivered') ORDER BY accepted_at, id")
      .all(targetId).map(mapMessage);
  }

  markMessageDelivered(messageId, targetId, now = Date.now(), maxAttempts = 5) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ? AND target_id = ?").get(messageId, targetId);
      if (!row || !["queued", "delivered"].includes(row.state)) { this.#db.exec("COMMIT"); return undefined; }
      if (row.state === "delivered") { this.#db.exec("COMMIT"); return mapMessage(row); }
      if (row.attempt_count >= maxAttempts) {
        this.#db.prepare("UPDATE messages SET state = 'rejected', last_error = ?, delivered_at = ? WHERE id = ?")
          .run(`delivery attempt limit reached: ${maxAttempts}`, now, messageId);
        const rejected = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
        this.#db.exec("COMMIT");
        return { ...mapMessage(rejected), permanentlyFailed: true };
      }
      this.#db.prepare(`UPDATE messages SET state = 'delivered', attempt_count = attempt_count + 1,
        delivered_at = ?, last_error = NULL WHERE id = ?`).run(now, messageId);
      const delivered = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
      this.#db.exec("COMMIT");
      return mapMessage(delivered);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  acknowledgeMessage(messageId, targetId, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM messages WHERE id = ? AND target_id = ?").get(messageId, targetId);
      if (!row) throw new Error("message does not exist for this target");
      if (row.state === "acknowledged") { this.#db.exec("COMMIT"); return mapMessage(row); }
      if (row.state !== "delivered") throw new Error(`message cannot be acknowledged from state ${row.state}`);
      this.#db.prepare("UPDATE messages SET state = 'acknowledged', acknowledged_at = ? WHERE id = ?").run(now, messageId);
      const updated = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
      this.#db.exec("COMMIT");
      return mapMessage(updated);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  getMessage(messageId) { return mapMessage(this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId)); }
  listMessages() { return this.#db.prepare("SELECT * FROM messages ORDER BY accepted_at, id").all().map(mapMessage); }
  close() { this.#db.close(); }
}
