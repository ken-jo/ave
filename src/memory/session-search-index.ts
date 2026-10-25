// Namespace-local FTS search with fail-closed queries; JSONL rebuild is the only corruption recovery path.
import { promises as fsPromises, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "../lib/logger.js";
import type { SessionKind } from "./memory-manager.js";
import type BetterSqlite3 from "better-sqlite3";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../lib/atomic-file.js";

const log = createLogger("session-search-index");

// Load the native database synchronously on first open so imports alone require no native addon.
let _sqliteCtor: typeof BetterSqlite3 | null = null;
function loadSqlite(): typeof BetterSqlite3 {
  if (_sqliteCtor) return _sqliteCtor;
  const require = createRequire(import.meta.url);
  _sqliteCtor = require("better-sqlite3") as typeof BetterSqlite3;
  return _sqliteCtor;
}

const IS_TEST_ENV = process.env.VITEST !== undefined;

// Rethrow native-addon load failures in tests; production fails closed without a transcript-scan fallback.
function isNativeLoadFailure(err: unknown): boolean {
  if (_sqliteCtor) return false; // constructor already cached ⇒ not a load failure
  const msg = (err as Error)?.message ?? "";
  return (
    /NODE_MODULE_VERSION|was compiled against|different Node\.js|\.node|Cannot find module 'better-sqlite3'|invalid ELF|dlopen|not a valid Win32/i.test(
      msg,
    )
  );
}

export interface IndexedSessionInput {
  sessionId: string;
  content: string;
  // Use transcript mtime for conversation timestamps; rebuild time must not make old sessions appear new.
  timestamp: string;
  sessionKind: SessionKind;
  routineId?: string;
  projectRoot?: string;
  title?: string;
}

export interface SessionSearchIndexQueryOptions {
  kind?: SessionKind | "all";
  routineId?: string;
  projectRoot?: string;
  includeUnscoped?: boolean;
  limit?: number;
}

export interface SessionSearchIndexHit {
  sessionId: string;
  title?: string;
  matchedMessage: string;
  timestamp: string;
  sessionKind: SessionKind;
}

const DEFAULT_LIMIT = 50;
const SNIPPET_TOKENS = 20;
// Trigram MATCH needs three code points; use literal LIKE for two-character queries.
const TRIGRAM_MIN_CODEPOINTS = 3;
const LIKE_ESCAPE = "\\";

export function codePointLength(s: string): number {
  return [...s].length;
}

// Escape user text as one FTS phrase so operators and quotes remain literal.
export function escapeFtsQuery(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

const LIKE_EXCERPT_RADIUS = 100;

// LIKE cannot use snippet(); derive a bounded excerpt centered on the first match.
export function excerptAroundMatch(content: string, needle: string): string {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return content.slice(0, LIKE_EXCERPT_RADIUS * 2);
  const start = Math.max(0, idx - LIKE_EXCERPT_RADIUS);
  const end = Math.min(content.length, idx + needle.length + LIKE_EXCERPT_RADIUS);
  const core = content.slice(start, end);
  return `${start > 0 ? "…" : ""}${core}${end < content.length ? "…" : ""}`;
}

// Escape percent, underscore, and the escape character before adding substring wildcards.
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
}

function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    /* best effort — pre-existing dir may already be 0o755 on some hosts */
  }
}

// Keep each database instance bound to its owning manager's namespace.
export class SessionSearchIndex {
  private readonly dbPath: string;
  private readonly dir: string;
  private db: BetterSqlite3.Database | null = null;

  constructor(aveDir: string) {
    this.dir = join(aveDir, "search");
    this.dbPath = join(this.dir, "index.db");
  }

  getDbPath(): string {
    return this.dbPath;
  }

  // Open synchronously on demand; return false on recoverable failure and keep stored search data private.
  open(): boolean {
    if (this.db) return true;
    // Close handles even if setup fails after opening; leaked handles block Windows corruption recovery.
    let db: BetterSqlite3.Database | null = null;
    try {
      ensureDirSync(this.dir);
      const Database = loadSqlite();
      db = new Database(this.dbPath);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec(
        // Use trigram tokenization to preserve substring matches inside identifiers, URLs, and compound words.
        `CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
          sessionId UNINDEXED,
          content,
          timestamp UNINDEXED,
          sessionKind UNINDEXED,
          routineId UNINDEXED,
          projectRoot UNINDEXED,
          title UNINDEXED,
          tokenize='trigram'
        );`,
      );
      this.db = db;
      try {
        chmodSync(this.dbPath, PRIVATE_FILE_MODE);
      } catch (chmodErr) {
        // Mode-bit failure is non-fatal, but log it because search data may remain readable on POSIX.
        if (process.platform !== "win32") {
          log.debug(
            "chmod 0o600 on index.db failed (file may be world-readable): %s",
            (chmodErr as Error).message,
          );
        }
      }
      return true;
    } catch (err) {
      log.warn("open failed: %s", (err as Error).message);
      if (db) {
        try {
          db.close();
        } catch {
        }
      }
      this.db = null;
      // Tests must surface native-load failures; runtime database errors remain recoverable through deletion and rebuild.
      if (IS_TEST_ENV && isNativeLoadFailure(err)) {
        throw new Error(
          `better-sqlite3 native load failed (corrupt prebuild?) — search index cannot open. ` +
            `In CI this usually means the shipped N-API prebuild is missing or corrupt for this platform+arch. ` +
            `Original: ${(err as Error).message}`,
        );
      }
      return false;
    }
  }

  rowCount(): number {
    if (!this.db) return -1;
    try {
      const row = this.db.prepare("SELECT COUNT(*) as c FROM sessions_fts").all()[0] as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    } catch {
      return -1;
    }
  }

  // Index maintenance must never block source transcript persistence.
  upsertSession(input: IndexedSessionInput): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM sessions_fts WHERE sessionId = ?").run(input.sessionId);
      this.db
        .prepare(
          `INSERT INTO sessions_fts (sessionId, content, timestamp, sessionKind, routineId, projectRoot, title)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.content,
          input.timestamp,
          input.sessionKind,
          input.routineId ?? "",
          input.projectRoot ?? "",
          input.title ?? "",
        );
    } catch (err) {
      log.warn("upsertSession failed for %s: %s", input.sessionId, (err as Error).message);
    }
  }

  deleteSession(sessionId: string): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM sessions_fts WHERE sessionId = ?").run(sessionId);
    } catch (err) {
      log.warn("deleteSession failed for %s: %s", sessionId, (err as Error).message);
    }
  }

  // Match three-plus code points with escaped trigram FTS, two with escaped LIKE, and reject shorter queries.
  query(rawQuery: string, options: SessionSearchIndexQueryOptions = {}): SessionSearchIndexHit[] {
    if (!this.db) return [];
    const trimmed = rawQuery.trim();
    const cpLen = codePointLength(trimmed);
    if (cpLen < 2) return [];
    try {
      const kind = options.kind ?? "main";
      const limit = options.limit ?? DEFAULT_LIMIT;
      const useLike = cpLen < TRIGRAM_MIN_CODEPOINTS; // exactly 2 code points

      const clauses: string[] = [];
      const params: unknown[] = [];
      let matchedMessageExpr: string;
      if (useLike) {
        clauses.push("lower(content) LIKE lower(?) ESCAPE ?");
        params.push(`%${escapeLikePattern(trimmed)}%`, LIKE_ESCAPE);
        // LIKE returns raw content for the bounded match-centered excerpt because snippet() requires MATCH.
        matchedMessageExpr = "content";
      } else {
        clauses.push("sessions_fts MATCH ?");
        params.push(escapeFtsQuery(trimmed));
        matchedMessageExpr = `snippet(sessions_fts, 1, '', '', '…', ${SNIPPET_TOKENS})`;
      }

      if (kind !== "all") {
        clauses.push("sessionKind = ?");
        params.push(kind);
      }
      if (options.routineId !== undefined) {
        clauses.push("routineId = ?");
        params.push(options.routineId);
      }
      if (options.projectRoot !== undefined) {
        if (options.includeUnscoped === true) {
          clauses.push("(projectRoot = ? OR projectRoot = ?)");
          params.push(options.projectRoot, "");
        } else {
          clauses.push("projectRoot = ?");
          params.push(options.projectRoot);
        }
      }
      const sql = `
        SELECT sessionId, title, timestamp, sessionKind,
               ${matchedMessageExpr} as matchedMessage
        FROM sessions_fts
        WHERE ${clauses.join(" AND ")}
        LIMIT ?
      `;
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as Array<{
        sessionId: string;
        title: string;
        timestamp: string;
        sessionKind: SessionKind;
        matchedMessage: string;
      }>;
      return rows.map((row) => ({
        sessionId: row.sessionId,
        ...(row.title ? { title: row.title } : {}),
        matchedMessage: useLike
          ? excerptAroundMatch(row.matchedMessage, trimmed)
          : row.matchedMessage,
        timestamp: row.timestamp,
        sessionKind: row.sessionKind,
      }));
    } catch (err) {
      log.warn("query failed: %s", (err as Error).message);
      return [];
    }
  }

  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
    }
    this.db = null;
  }

  // Delete corrupt storage so the next open creates a clean database.
  static async deleteFile(dbPath: string): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await fsPromises.unlink(`${dbPath}${suffix}`);
      } catch {
      }
    }
  }
}
