/** Use an in-process async sink because packaged worker entry resolution fails. Create private POSIX files at open; Windows confidentiality relies on inherited home ACLs. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { LOG_RETENTION_DAYS } from "../shared/log-retention.js";
import { utcDateKey } from "../shared/local-date.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./atomic-file.js";
import { createAsyncLogDestination } from "./async-log-destination.js";

export { LOG_RETENTION_DAYS } from "../shared/log-retention.js";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Prune oldest per-day sequences so size rolling cannot create unbounded daily files. */
export const LOG_MAX_FILES_PER_DAY = 20;

/** Independently cap total bytes across days, pruning oldest date and sequence first. */
export const LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

function baseFileName(dateStr: string): string {
  return `ave-${dateStr}.log`;
}

function seqFileName(dateStr: string, seq: number): string {
  return seq <= 0 ? baseFileName(dateStr) : `ave-${dateStr}.${seq}.log`;
}

export function parseLogFileDate(fileName: string): string | null {
  const m = fileName.match(/^ave-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/);
  return m ? m[1] : null;
}

/** Create private log directories synchronously during early boot; POSIX modes do not protect Windows files. */
function ensureLogDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    /* A pre-existing directory with unchangeable mode must not block boot. */
  }
}

/** Retention cleanup is best-effort; unreadable or locked entries must not fail boot. */
export function pruneOldLogs(dir: string, retentionDays: number, now: number = Date.now()): string[] {
  const deleted: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return deleted;
  }
  const cutoffMs = retentionDays * 86_400_000;
  for (const fname of entries) {
    const dateStr = parseLogFileDate(fname);
    if (!dateStr) continue;
    const fileMs = new Date(dateStr).getTime();
    if (isNaN(fileMs)) continue;
    if (now - fileMs >= cutoffMs) {
      try {
        unlinkSync(join(dir, fname));
        deleted.push(fname);
      } catch {
        /* Locked or removed files must not break retention. */
      }
    }
  }
  return deleted;
}

interface LogFileInfo {
  name: string;
  dateStr: string;
  seq: number;
  size: number;
}

function byLogAge(a: LogFileInfo, b: LogFileInfo): number {
  return a.dateStr === b.dateStr ? a.seq - b.seq : a.dateStr < b.dateStr ? -1 : 1;
}

function parseLogSeq(fileName: string): number {
  const m = fileName.match(/^ave-\d{4}-\d{2}-\d{2}\.(\d+)\.log$/);
  return m ? parseInt(m[1], 10) : 0;
}

function listLogFiles(dir: string): LogFileInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LogFileInfo[] = [];
  for (const name of entries) {
    const dateStr = parseLogFileDate(name);
    if (!dateStr) continue;
    let size = 0;
    try {
      size = statSync(join(dir, name)).size;
    } catch {
      continue;
    }
    out.push({ name, dateStr, seq: parseLogSeq(name), size });
  }
  return out;
}

/** Prune oldest files under both caps, never the active file; cleanup failures must not stop logging. */
export function capLogTree(
  dir: string,
  opts: { maxFilesPerDay?: number; maxTotalBytes?: number; keepFile?: string } = {},
): string[] {
  const maxFilesPerDay = opts.maxFilesPerDay ?? LOG_MAX_FILES_PER_DAY;
  const maxTotalBytes = opts.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES;
  const deleted: string[] = [];

  let files = listLogFiles(dir);

  const remove = (f: LogFileInfo): void => {
    if (opts.keepFile && join(dir, f.name) === opts.keepFile) return;
    try {
      unlinkSync(join(dir, f.name));
      deleted.push(f.name);
    } catch {
      /* Skip locked or removed files without throwing. */
    }
  };

  const byDay = new Map<string, LogFileInfo[]>();
  for (const f of files) {
    const list = byDay.get(f.dateStr) ?? [];
    list.push(f);
    byDay.set(f.dateStr, list);
  }
  for (const list of byDay.values()) {
    if (list.length <= maxFilesPerDay) continue;
    list.sort(byLogAge);
    const overflow = list.slice(0, list.length - maxFilesPerDay);
    for (const f of overflow) remove(f);
  }

  files = listLogFiles(dir).filter((f) => !deleted.includes(f.name));
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total > maxTotalBytes) {
    files.sort(byLogAge);
    for (const f of files) {
      if (total <= maxTotalBytes) break;
      if (opts.keepFile && join(dir, f.name) === opts.keepFile) continue;
      const before = deleted.length;
      remove(f);
      if (deleted.length > before) total -= f.size;
    }
  }
  return deleted;
}

async function capLogTreeAfterRoll(dir: string, currentFile: () => string): Promise<void> {
  const files: LogFileInfo[] = [];
  const byDay = new Map<string, LogFileInfo[]>();
  for (const name of await readdir(dir)) {
    const dateStr = parseLogFileDate(name);
    if (!dateStr) continue;
    try {
      const file = { name, dateStr, seq: parseLogSeq(name), size: (await stat(join(dir, name))).size };
      const day = byDay.get(dateStr) ?? [];
      day.push(file);
      byDay.set(dateStr, day);
      files.push(file);
    } catch {
      // Another process may have removed the file.
    }
  }

  const removed = new Set<LogFileInfo>();
  for (const daily of byDay.values()) {
    if (daily.length <= LOG_MAX_FILES_PER_DAY) continue;
    daily.sort(byLogAge);
    for (const file of daily.slice(0, daily.length - LOG_MAX_FILES_PER_DAY)) {
      if (await removeInactive(file)) removed.add(file);
    }
  }

  const remaining = files.filter((file) => !removed.has(file)).sort(byLogAge);
  let total = remaining.reduce((sum, file) => sum + file.size, 0);
  for (const file of remaining) {
    if (total <= LOG_MAX_TOTAL_BYTES) break;
    if (await removeInactive(file)) total -= file.size;
  }

  async function removeInactive(file: LogFileInfo): Promise<boolean> {
    const path = join(dir, file.name);
    if (path === currentFile()) return false;
    try {
      await unlink(path);
      return true;
    } catch {
      return false;
    }
  }
}

/** Reapply configured retention after settings load, then cap the tree; early boot used the default window. */
export function reprunePersistedRetention(dir: string, retentionDays: number): string[] {
  if (retentionDays === LOG_RETENTION_DAYS) return [];
  const deleted = pruneOldLogs(dir, retentionDays);
  capLogTree(dir);
  return deleted;
}

/** Reuse the highest under-cap sequence or advance when full. */
function resolveActiveSeq(dir: string, dateStr: string, maxBytes: number): number {
  let highest = 0;
  try {
    for (const fname of readdirSync(dir)) {
      const fileDate = parseLogFileDate(fname);
      if (fileDate !== dateStr) continue;
      const m = fname.match(/^ave-\d{4}-\d{2}-\d{2}\.(\d+)\.log$/);
      const seq = m ? parseInt(m[1], 10) : 0;
      if (seq > highest) highest = seq;
    }
  } catch {
    return 0;
  }
  const activePath = join(dir, seqFileName(dateStr, highest));
  try {
    if (existsSync(activePath) && statSync(activePath).size >= maxBytes) {
      return highest + 1;
    }
  } catch {
    /* On stat failure, reuse the highest sequence. */
  }
  return highest;
}

export interface LogFileSinkOptions {
  dir?: string;
  retentionDays?: number;
  maxBytes?: number;
}

export interface LogFileSink {
  write(chunk: string): void;
  flush(): Promise<void>;
  readonly pending: number;
  destroy(): void;
  readonly currentFile: string;
}

/** Set private modes during creation; unrecoverable directory failure is handled by boot. */
export function createLogFileSink(options: LogFileSinkOptions = {}): LogFileSink {
  const dir = options.dir ?? join(aveHome(), "logs");
  const retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;

  ensureLogDir(dir);
  pruneOldLogs(dir, retentionDays);
  capLogTree(dir);

  const dateStr = utcDateKey();
  let seq = resolveActiveSeq(dir, dateStr, maxBytes);
  let currentFile = join(dir, seqFileName(dateStr, seq));

  let activeBytes = 0;
  try { activeBytes = statSync(currentFile).size; } catch { /* New or unavailable file. */ }
  let closed = false;
  let nextFile: string | undefined;
  const destination = createAsyncLogDestination({
    dest: currentFile, sync: false, mode: PRIVATE_FILE_MODE, maxLength: LOG_MAX_BYTES,
  });
  const { stream: boom } = destination;

  let pruning = false;
  let pruneRequested = false;
  const requestCap = (): void => {
    pruneRequested = true;
    if (pruning) return;
    pruning = true;
    void (async () => {
      try {
        while (pruneRequested) {
          pruneRequested = false;
          await capLogTreeAfterRoll(dir, () => currentFile);
        }
      } finally {
        pruning = false;
      }
    })().catch(() => {});
  };

  boom.on("write", (bytes: number) => {
    activeBytes += bytes;
    if (closed || nextFile || activeBytes < maxBytes) return;
    // Reopen waits for the in-flight write before sending buffered lines to the new file.
    nextFile = join(dir, seqFileName(dateStr, seq + 1));
    try { boom.reopen(nextFile); } catch { nextFile = undefined; }
  });
  boom.on("ready", () => {
    if (!nextFile) return;
    currentFile = nextFile;
    nextFile = undefined;
    seq += 1;
    activeBytes = 0;
    requestCap();
  });
  boom.on("error", () => { nextFile = undefined; });

  return {
    flush: destination.flush,
    get pending() { return destination.pending; },
    get currentFile(): string {
      return currentFile;
    },
    write(chunk: string): void {
      if (closed) return;
      destination.write(chunk);
    },
    destroy(): void {
      if (closed) return;
      closed = true;
      try {
        boom.end();
      } catch {
      }
    },
  };
}
