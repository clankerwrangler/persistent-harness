import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VisibleTranscriptReader } from "./visible-transcript-reader.mjs";

// Version 2 rebuilds derived rows that predate receipt-to-entry proof.
export const SESSION_HISTORY_SCHEMA_VERSION = 2;

const MAX_QUERY_BYTES = 512;
const MAX_QUERY_CLAUSES = 32;
const MAX_SESSIONS = 2048;
const MAX_LIMIT = 20;
const MAX_SNIPPET_CHARS = 800;
const MAX_OPEN_CHARS = 16_000;
const MAX_CACHED_PROJECTIONS = 8;
const MAX_CACHED_PROJECTION_BYTES = 4 * 1024 * 1024;
const UNBOUNDED_MESSAGES = Number.MAX_SAFE_INTEGER;
const UNBOUNDED_BYTES = Number.MAX_SAFE_INTEGER;
const ROLES = new Set(["user", "assistant"]);
const SORTS = new Set(["relevance", "newest", "oldest"]);

function requireRecord(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${context} must be an object`);
  return value;
}

function exactKeys(value, allowed, context) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${context}.${key} is not supported`);
}

function boundedInteger(value, context, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${context} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function codePoints(value) { return Array.from(String(value ?? "")); }
function charLength(value) { return codePoints(value).length; }

function truncatePrefix(value, maximum) {
  const chars = codePoints(value);
  if (chars.length <= maximum) return { text: chars.join(""), truncated: false };
  if (maximum <= 0) return { text: "", truncated: true };
  if (maximum === 1) return { text: "…", truncated: true };
  return { text: `${chars.slice(0, maximum - 1).join("")}…`, truncated: true };
}

/** Remove terminal escape sequences and non-printing controls while preserving plain layout. */
export function sanitizeSessionHistoryText(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    // Operating-system command strings, terminated by BEL or string terminator.
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/gu, "")
    // Control Sequence Introducer (7-bit ESC [ and 8-bit C1 forms).
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
    // Remaining two-byte ANSI escape functions.
    .replace(/\u001B[@-_]/gu, "")
    // C0/C1 controls other than tab, LF, and CR.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    // Bidirectional layout controls can visually reorder otherwise plain text.
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "");
}

function searchableMessage(message, sanitizePresentation) {
  let text = sanitizeSessionHistoryText(message.text);
  if (sanitizePresentation && message.role === "assistant") {
    text = text.replace(/^<!--\s*taihou\.presentation\.[^\n]*(?:\n|$)/u, "");
  }
  return { ...message, text };
}

function normalizedSession(value, context = "session") {
  const session = requireRecord(value, context);
  const sessionId = session.sessionId;
  const sessionFile = session.sessionFile;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
    throw new TypeError(`${context}.sessionId must be a non-empty string of at most 128 characters`);
  }
  if (typeof sessionFile !== "string" || !sessionFile || Buffer.byteLength(sessionFile, "utf8") > 4096) {
    throw new TypeError(`${context}.sessionFile must be a non-empty bounded path`);
  }
  if (session.sanitizePresentation !== undefined && typeof session.sanitizePresentation !== "boolean") {
    throw new TypeError(`${context}.sanitizePresentation must be boolean`);
  }
  return {
    sessionId,
    sessionFile: path.resolve(sessionFile),
    sanitizePresentation: session.sanitizePresentation === true,
  };
}

function normalizedSessions(values) {
  if (!Array.isArray(values) || values.length > MAX_SESSIONS) {
    throw new TypeError(`sessions must be an array of at most ${MAX_SESSIONS} items`);
  }
  const result = values.map((value, index) => normalizedSession(value, `sessions[${index}]`));
  const ids = new Set();
  for (const session of result) {
    if (ids.has(session.sessionId)) throw new TypeError(`duplicate sessionId: ${session.sessionId}`);
    ids.add(session.sessionId);
  }
  return result;
}

function fingerprint(fileStat) {
  if (!fileStat.isFile()) throw new Error("canonical Pi transcript is not a regular file");
  return {
    dev: String(fileStat.dev),
    ino: String(fileStat.ino),
    size: String(fileStat.size),
    mtimeNs: String(fileStat.mtimeNs),
    ctimeNs: String(fileStat.ctimeNs),
  };
}

function sameFingerprint(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs);
}

function sourceFingerprint(row) {
  if (!row) return undefined;
  return { dev: row.dev, ino: row.ino, size: row.size, mtimeNs: row.mtime_ns, ctimeNs: row.ctime_ns };
}

function quoteFts(value) { return `"${value.replaceAll('"', '""')}"`; }

/** Parse the deliberately small public query language, never raw FTS MATCH syntax. */
export function parseSessionHistoryQuery(input) {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input, "utf8") > MAX_QUERY_BYTES) {
    throw new TypeError(`query must be a non-empty string of at most ${MAX_QUERY_BYTES} UTF-8 bytes`);
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(input)) throw new TypeError("query must not contain control characters");
  const clauses = [];
  let index = 0;
  while (index < input.length) {
    while (/\s/u.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    if (input[index] === '"') {
      index += 1;
      let value = "";
      let closed = false;
      while (index < input.length) {
        const character = input[index++];
        if (character === '"') { closed = true; break; }
        if (character === "\\" && index < input.length && ['"', "\\"].includes(input[index])) {
          value += input[index++];
        } else value += character;
      }
      if (!closed) throw new TypeError("query contains an unterminated quoted phrase");
      if (!value.trim()) throw new TypeError("query phrases must not be empty");
      if (index < input.length && !/\s/u.test(input[index])) {
        throw new TypeError("a quoted phrase must be followed by whitespace");
      }
      clauses.push({ value, phrase: true, prefix: false });
    } else {
      const start = index;
      while (index < input.length && !/\s/u.test(input[index])) index += 1;
      let value = input.slice(start, index);
      const stars = [...value].filter((character) => character === "*").length;
      const prefix = stars === 1 && value.endsWith("*");
      if (stars && !prefix) throw new TypeError("query '*' is supported only once at the end of a term");
      if (prefix) value = value.slice(0, -1);
      if (!value) throw new TypeError("query prefix must contain text before '*'");
      clauses.push({ value, phrase: false, prefix });
    }
    if (clauses.length > MAX_QUERY_CLAUSES) throw new TypeError(`query must contain at most ${MAX_QUERY_CLAUSES} terms or phrases`);
  }
  if (!clauses.length) throw new TypeError("query must contain a term or phrase");
  return {
    clauses,
    match: clauses.map((clause) => `${quoteFts(clause.value)}${clause.prefix ? "*" : ""}`).join(" AND "),
  };
}

function firstMatch(text, clauses) {
  const folded = text.toLocaleLowerCase();
  let selected = -1;
  for (const clause of clauses) {
    let found = -1;
    if (clause.prefix) {
      const escaped = clause.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try { found = text.search(new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${escaped})`, "iu")); } catch {}
    } else found = folded.indexOf(clause.value.toLocaleLowerCase());
    if (found >= 0 && (selected < 0 || found < selected)) selected = found;
  }
  return selected;
}

function plainSnippet(text, clauses, maximum) {
  const chars = codePoints(text);
  if (chars.length <= maximum) return chars.join("");
  const codeUnitOffset = firstMatch(text, clauses);
  const matchOffset = codeUnitOffset < 0 ? 0 : codePoints(text.slice(0, codeUnitOffset)).length;
  const leading = matchOffset > 0;
  const markerBudget = (leading ? 1 : 0) + 1;
  const bodyLength = Math.max(0, maximum - markerBudget);
  let start = Math.max(0, matchOffset - Math.floor(bodyLength / 3));
  if (start + bodyLength > chars.length) start = Math.max(0, chars.length - bodyLength);
  const trailing = start + bodyLength < chars.length;
  const adjustedLength = Math.max(0, maximum - (start > 0 ? 1 : 0) - (trailing ? 1 : 0));
  return `${start > 0 ? "…" : ""}${chars.slice(start, start + adjustedLength).join("")}${trailing ? "…" : ""}`;
}

function publicMessage(message, text = message.text) {
  return {
    entryId: message.id,
    role: message.role,
    text,
    createdAt: message.createdAt,
    citation: { sessionId: null, entryId: message.id },
  };
}

export class SessionHistoryIndex {
  #db;
  #projectionCache = new Map();
  #projectionCacheBytes = 0;
  #closed = false;

  constructor({ databasePath, reader = new VisibleTranscriptReader() }) {
    if (typeof databasePath !== "string" || !databasePath) throw new TypeError("databasePath is required");
    if (!reader || typeof reader.read !== "function") throw new TypeError("reader.read is required");
    this.databasePath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
    this.reader = reader;
    if (this.databasePath !== ":memory:") {
      const parent = path.dirname(this.databasePath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if ((statSync(parent).mode & 0o077) !== 0) {
        throw new Error("session history database directory must not be accessible by group or other users");
      }
    }
    try { this.#db = this.#openDatabase(); }
    catch (error) {
      if (this.databasePath === ":memory:") throw error;
      this.#discardDatabase();
      this.#db = this.#openDatabase();
    }
  }

  #secureDatabaseFiles() {
    if (this.databasePath === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { chmodSync(`${this.databasePath}${suffix}`, 0o600); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }

  #discardDatabase() {
    try { this.#db?.close(); } catch {}
    this.#db = undefined;
    if (this.databasePath !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.databasePath}${suffix}`, { force: true });
    }
    this.#projectionCache.clear();
    this.#projectionCacheBytes = 0;
  }

  #validateSchema(db, { integrity = true } = {}) {
    const columns = (name) => db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
    const exact = (actual, expected, context) => {
      if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
        throw new Error(`derived session history ${context} schema is invalid`);
      }
    };
    exact(columns("sources"), ["session_id", "session_file", "sanitize_presentation", "dev", "ino", "size", "mtime_ns", "ctime_ns", "indexed_at"], "sources");
    exact(columns("documents"), ["document_id", "session_id", "entry_id", "role", "created_at", "ordinal"], "documents");
    exact(columns("message_fts"), ["text"], "FTS");
    const objects = new Map(db.prepare(`SELECT name, type, sql FROM sqlite_schema
      WHERE name IN ('sources', 'documents', 'documents_session_ordinal', 'message_fts')`).all()
      .map((row) => [row.name, row]));
    if (objects.get("sources")?.type !== "table" || !/\bSTRICT\s*$/iu.test(objects.get("sources")?.sql ?? "")) {
      throw new Error("derived session history sources invariant is invalid");
    }
    if (objects.get("documents")?.type !== "table" || !/\bSTRICT\s*$/iu.test(objects.get("documents")?.sql ?? "")) {
      throw new Error("derived session history documents invariant is invalid");
    }
    if (objects.get("documents_session_ordinal")?.type !== "index") {
      throw new Error("derived session history ordinal index is missing");
    }
    const ftsSql = objects.get("message_fts")?.sql ?? "";
    if (objects.get("message_fts")?.type !== "table" || !/content\s*=\s*''/iu.test(ftsSql)
      || !/contentless_delete\s*=\s*1/iu.test(ftsSql)) {
      throw new Error("derived session history FTS invariant is invalid");
    }
    if (integrity) {
      const check = db.prepare("PRAGMA quick_check").all();
      if (!check.length || check.some((row) => Object.values(row)[0] !== "ok")) {
        throw new Error("derived session history database integrity check failed");
      }
    }
    db.prepare("SELECT session_id, session_file, sanitize_presentation, dev, ino, size, mtime_ns, ctime_ns, indexed_at FROM sources LIMIT 0").all();
    db.prepare("SELECT document_id, session_id, entry_id, role, created_at, ordinal FROM documents LIMIT 0").all();
    db.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH ? LIMIT 0").all("schema_probe");
  }

  #openDatabase() {
    const db = new DatabaseSync(this.databasePath);
    try {
      this.#secureDatabaseFiles();
      const version = Number(db.prepare("PRAGMA user_version").get().user_version);
      if (version !== 0 && version !== SESSION_HISTORY_SCHEMA_VERSION) {
        throw new Error("derived session history schema version is unsupported");
      }
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      if (this.databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          session_id TEXT PRIMARY KEY,
          session_file TEXT NOT NULL,
          sanitize_presentation INTEGER NOT NULL CHECK (sanitize_presentation IN (0, 1)),
          dev TEXT NOT NULL,
          ino TEXT NOT NULL,
          size TEXT NOT NULL,
          mtime_ns TEXT NOT NULL,
          ctime_ns TEXT NOT NULL,
          indexed_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS documents (
          document_id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sources(session_id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          created_at TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          UNIQUE(session_id, entry_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS documents_session_ordinal ON documents(session_id, ordinal);
        CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
          text,
          content='',
          contentless_delete=1,
          tokenize='unicode61 remove_diacritics 2'
        );
        PRAGMA user_version = ${SESSION_HISTORY_SCHEMA_VERSION};
      `);
      this.#validateSchema(db);
      this.#secureDatabaseFiles();
      return db;
    } catch (error) {
      try { db.close(); } catch {}
      throw error;
    }
  }

  #isDatabaseFailure(error) {
    return (typeof error?.code === "string" && (error.code.startsWith("ERR_SQLITE") || error.code.startsWith("SQLITE")))
      || (error instanceof Error && error.message.startsWith("derived session history"));
  }

  #recoverDatabase() {
    if (this.databasePath === ":memory:") throw new Error("in-memory session history index cannot be recovered");
    this.#discardDatabase();
    this.#db = this.#openDatabase();
  }

  #assertOpen() { if (this.#closed) throw new Error("session history index is closed"); }

  #getCachedProjection(session) {
    const cached = this.#projectionCache.get(session.sessionId);
    if (!cached || cached.sessionFile !== session.sessionFile
      || cached.sanitizePresentation !== session.sanitizePresentation) return undefined;
    this.#projectionCache.delete(session.sessionId);
    this.#projectionCache.set(session.sessionId, cached);
    return cached.messages;
  }

  #cacheProjection(session, messages) {
    const byteSize = messages.reduce((total, message) => total + Buffer.byteLength(String(message.text ?? ""), "utf8") + 256, 0);
    const prior = this.#projectionCache.get(session.sessionId);
    if (prior) { this.#projectionCache.delete(session.sessionId); this.#projectionCacheBytes -= prior.byteSize; }
    if (byteSize > MAX_CACHED_PROJECTION_BYTES) return;
    this.#projectionCache.set(session.sessionId, {
      sessionFile: session.sessionFile,
      sanitizePresentation: session.sanitizePresentation,
      messages,
      byteSize,
    });
    this.#projectionCacheBytes += byteSize;
    while (this.#projectionCache.size > MAX_CACHED_PROJECTIONS
      || this.#projectionCacheBytes > MAX_CACHED_PROJECTION_BYTES) {
      const oldestId = this.#projectionCache.keys().next().value;
      const oldest = this.#projectionCache.get(oldestId);
      this.#projectionCache.delete(oldestId);
      this.#projectionCacheBytes -= oldest.byteSize;
    }
  }

  #evictProjection(sessionId) {
    const cached = this.#projectionCache.get(sessionId);
    if (!cached) return;
    this.#projectionCache.delete(sessionId);
    this.#projectionCacheBytes -= cached.byteSize;
  }

  #deleteSession(sessionId) {
    this.#db.prepare("DELETE FROM message_fts WHERE rowid IN (SELECT document_id FROM documents WHERE session_id = ?)").run(sessionId);
    this.#db.prepare("DELETE FROM documents WHERE session_id = ?").run(sessionId);
    this.#db.prepare("DELETE FROM sources WHERE session_id = ?").run(sessionId);
    this.#evictProjection(sessionId);
  }

  async #readStable(session) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const before = fingerprint(await stat(session.sessionFile, { bigint: true }));
        this.reader.clear?.(session.sessionFile);
        const projection = await this.reader.read({
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          maxMessages: UNBOUNDED_MESSAGES,
          maxBytes: UNBOUNDED_BYTES,
          sanitizePresentation: session.sanitizePresentation,
        });
        const after = fingerprint(await stat(session.sessionFile, { bigint: true }));
        if (!sameFingerprint(before, after)) {
          lastError = new Error("canonical Pi transcript changed during history indexing");
          continue;
        }
        const messages = projection.messages.filter((message) => ROLES.has(message.role))
          .map((message) => searchableMessage(message, session.sanitizePresentation));
        return { fingerprint: after, messages };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error("canonical Pi transcript could not be read stably");
  }

  /** Refresh only the supplied caller-authorized sources. Changed sources are fully rebuilt. */
  async refresh(sessions) {
    this.#assertOpen();
    const allowed = normalizedSessions(sessions);
    try { return await this.#refreshAllowed(allowed); }
    catch (error) {
      if (!this.#isDatabaseFailure(error)) throw error;
      this.#recoverDatabase();
      return this.#refreshAllowed(allowed);
    }
  }

  async #refreshAllowed(allowed) {
    this.#validateSchema(this.#db, { integrity: false });
    const removed = [];
    const indexed = [];
    const unchanged = [];
    const errors = [];

    // The array is caller-scoped, not a global inventory. Never erase another
    // caller's indexed source merely because it is absent here.
    for (const session of allowed) {
      let currentFingerprint;
      try { currentFingerprint = fingerprint(await stat(session.sessionFile, { bigint: true })); }
      catch (error) {
        const existed = Boolean(this.#db.prepare("SELECT 1 FROM sources WHERE session_id = ?").get(session.sessionId));
        this.#db.exec("BEGIN IMMEDIATE");
        try { this.#deleteSession(session.sessionId); this.#db.exec("COMMIT"); }
        catch (deleteError) { this.#db.exec("ROLLBACK"); throw deleteError; }
        if (existed) removed.push(session.sessionId);
        errors.push({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const source = this.#db.prepare("SELECT * FROM sources WHERE session_id = ?").get(session.sessionId);
      if (source && source.session_file === session.sessionFile
        && Number(source.sanitize_presentation) === Number(session.sanitizePresentation)
        && sameFingerprint(sourceFingerprint(source), currentFingerprint)) {
        unchanged.push(session.sessionId);
        continue;
      }

      let rebuilt;
      try { rebuilt = await this.#readStable(session); }
      catch (error) {
        const existed = Boolean(this.#db.prepare("SELECT 1 FROM sources WHERE session_id = ?").get(session.sessionId));
        this.#db.exec("BEGIN IMMEDIATE");
        try { this.#deleteSession(session.sessionId); this.#db.exec("COMMIT"); }
        catch (deleteError) { this.#db.exec("ROLLBACK"); throw deleteError; }
        if (existed) removed.push(session.sessionId);
        errors.push({ sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }

      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#deleteSession(session.sessionId);
        const fp = rebuilt.fingerprint;
        this.#db.prepare(`INSERT INTO sources(session_id, session_file, sanitize_presentation,
          dev, ino, size, mtime_ns, ctime_ns, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(session.sessionId, session.sessionFile, session.sanitizePresentation ? 1 : 0,
            fp.dev, fp.ino, fp.size, fp.mtimeNs, fp.ctimeNs, Date.now());
        const insertDocument = this.#db.prepare(`INSERT INTO documents(session_id, entry_id, role, created_at, ordinal)
          VALUES (?, ?, ?, ?, ?)`);
        const insertFts = this.#db.prepare("INSERT INTO message_fts(rowid, text) VALUES (?, ?)");
        rebuilt.messages.forEach((message, ordinal) => {
          const result = insertDocument.run(session.sessionId, message.id, message.role, message.createdAt, ordinal);
          insertFts.run(Number(result.lastInsertRowid), String(message.text ?? ""));
        });
        this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
      this.#cacheProjection(session, rebuilt.messages);
      indexed.push(session.sessionId);
    }
    this.#secureDatabaseFiles();
    return { indexed, unchanged, removed, errors };
  }

  async #projection(session) {
    const cached = this.#getCachedProjection(session);
    if (cached) return cached;
    const projection = await this.reader.read({
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      maxMessages: UNBOUNDED_MESSAGES,
      maxBytes: UNBOUNDED_BYTES,
      sanitizePresentation: session.sanitizePresentation,
    });
    const messages = projection.messages.filter((message) => ROLES.has(message.role))
      .map((message) => searchableMessage(message, session.sanitizePresentation));
    this.#cacheProjection(session, messages);
    return messages;
  }

  #indexedSession(session) {
    const source = this.#db.prepare("SELECT * FROM sources WHERE session_id = ?").get(session.sessionId);
    return source && source.session_file === session.sessionFile
      && Number(source.sanitize_presentation) === Number(session.sanitizePresentation);
  }

  /** Search indexed metadata, then hydrate bounded plain snippets from canonical projections. */
  async search(options = {}) {
    this.#assertOpen();
    try { return await this.#searchOnce(options); }
    catch (error) {
      if (!this.#isDatabaseFailure(error)) throw error;
      this.#recoverDatabase();
      await this.refresh(options.sessions);
      return this.#searchOnce(options);
    }
  }

  async #searchOnce({ sessions, query, roles = ["user", "assistant"], limit = 10,
    sort = "relevance", snippetChars = 320 } = {}) {
    const allowed = normalizedSessions(sessions);
    if (!Array.isArray(roles) || roles.length < 1 || roles.length > 2
      || roles.some((role) => !ROLES.has(role)) || new Set(roles).size !== roles.length) {
      throw new TypeError("roles must contain unique user and/or assistant values");
    }
    limit = boundedInteger(limit, "limit", 1, MAX_LIMIT, 10);
    snippetChars = boundedInteger(snippetChars, "snippetChars", 16, MAX_SNIPPET_CHARS, 320);
    if (!SORTS.has(sort)) throw new TypeError("sort must be relevance, newest, or oldest");
    const parsed = parseSessionHistoryQuery(query);
    const permitted = allowed.filter((session) => this.#indexedSession(session));
    if (!permitted.length) return { query, matches: [], truncated: false };
    const sessionById = new Map(permitted.map((session) => [session.sessionId, session]));
    const sessionPlaceholders = permitted.map(() => "?").join(", ");
    const rolePlaceholders = roles.map(() => "?").join(", ");
    const ordering = sort === "newest"
      ? "d.created_at DESC, d.session_id, d.entry_id"
      : sort === "oldest"
        ? "d.created_at, d.session_id, d.entry_id"
        : "bm25(message_fts), d.created_at DESC, d.session_id, d.entry_id";
    const candidateLimit = Math.min(1000, (limit + 1) * 8);
    const sql = `SELECT d.session_id, d.entry_id, d.role, d.created_at, d.ordinal,
      bm25(message_fts) AS score FROM message_fts JOIN documents d ON d.document_id = message_fts.rowid
      WHERE message_fts MATCH ? AND d.session_id IN (${sessionPlaceholders})
        AND d.role IN (${rolePlaceholders}) ORDER BY ${ordering} LIMIT ?`;
    const rows = this.#db.prepare(sql).all(parsed.match,
      ...permitted.map((session) => session.sessionId), ...roles, candidateLimit);
    const projections = new Map();
    const matches = [];
    for (const row of rows) {
      const session = sessionById.get(row.session_id);
      if (!session) continue;
      let messages = projections.get(session.sessionId);
      if (!messages) { messages = await this.#projection(session); projections.set(session.sessionId, messages); }
      const message = messages.find((item) => item.id === row.entry_id && item.role === row.role);
      if (!message) continue;
      matches.push({
        sessionId: session.sessionId,
        entryId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        snippet: plainSnippet(String(message.text ?? ""), parsed.clauses, snippetChars),
        citation: { sessionId: session.sessionId, entryId: message.id },
        score: sort === "relevance" ? Number(row.score) : undefined,
      });
      if (matches.length > limit) break;
    }
    const truncated = matches.length > limit || rows.length === candidateLimit;
    return { query, matches: matches.slice(0, limit), truncated };
  }

  /** Open one active visible message with bounded nearest chronological context. */
  async open({ session, entryId, before = 2, after = 2, maxChars = 8_000 } = {}) {
    this.#assertOpen();
    const selected = normalizedSession(session);
    if (!this.#indexedSession(selected)) throw new Error("session is not present in the allowed history index");
    if (typeof entryId !== "string" || !entryId || entryId.length > 128) {
      throw new TypeError("entryId must be a non-empty string of at most 128 characters");
    }
    before = boundedInteger(before, "before", 0, 8, 2);
    after = boundedInteger(after, "after", 0, 8, 2);
    maxChars = boundedInteger(maxChars, "maxChars", 1, MAX_OPEN_CHARS, 8_000);
    const messages = await this.#projection(selected);
    const targetIndex = messages.findIndex((message) => message.id === entryId);
    if (targetIndex < 0) throw new Error("entry does not exist on the active visible transcript branch");
    const desiredStart = Math.max(0, targetIndex - before);
    const desiredEnd = Math.min(messages.length, targetIndex + after + 1);
    const chosen = new Map();
    let remaining = maxChars;
    let targetText = truncatePrefix(String(messages[targetIndex].text ?? ""), remaining);
    chosen.set(targetIndex, targetText);
    remaining -= charLength(targetText.text);
    let beforeContiguous = true;
    let afterContiguous = true;
    for (let distance = 1; remaining > 0 && (targetIndex - distance >= desiredStart || targetIndex + distance < desiredEnd); distance += 1) {
      for (const [index, side] of [[targetIndex - distance, "before"], [targetIndex + distance, "after"]]) {
        if (index < desiredStart || index >= desiredEnd || remaining <= 0) continue;
        if ((side === "before" && !beforeContiguous) || (side === "after" && !afterContiguous)) continue;
        const text = String(messages[index].text ?? "");
        const length = charLength(text);
        if (length <= remaining) { chosen.set(index, { text, truncated: false }); remaining -= length; }
        else if (side === "before") beforeContiguous = false;
        else afterContiguous = false;
      }
    }
    const opened = [...chosen.entries()].sort(([left], [right]) => left - right).map(([index, bounded]) => ({
      ...publicMessage(messages[index], bounded.text),
      citation: { sessionId: selected.sessionId, entryId: messages[index].id },
    }));
    const returnedIndexes = new Set(chosen.keys());
    const expectedBefore = Array.from({ length: targetIndex - desiredStart }, (_, offset) => desiredStart + offset);
    const expectedAfter = Array.from({ length: desiredEnd - targetIndex - 1 }, (_, offset) => targetIndex + offset + 1);
    const truncatedBefore = expectedBefore.some((index) => !returnedIndexes.has(index));
    const truncatedAfter = expectedAfter.some((index) => !returnedIndexes.has(index));
    const truncated = targetText.truncated || truncatedBefore || truncatedAfter;
    return {
      sessionId: selected.sessionId,
      entryId,
      messages: opened,
      truncated,
      truncatedBefore,
      truncatedAfter,
      citation: { sessionId: selected.sessionId, entryId },
    };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#projectionCache.clear();
    this.#projectionCacheBytes = 0;
    this.#db?.close();
  }
}
