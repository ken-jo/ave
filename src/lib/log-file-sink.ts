/** Use an in-process async sink because packaged worker entry resolution fails. Create private POSIX files at open; Windows confidentiality relies on inherited home ACLs. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
// Keep the CommonJS default runtime import separate from its constructor type.
import sonicBoomDefault, {
  type SonicBoom as SonicBoomInstance,
  type SonicBoomOpts,
} from "sonic-boom";
import { aveHome } from "../shared/ave-home.js";
import { LOG_RETENTION_DAYS } from "../shared/log-retention.js";
import { utcDateKey } from "../shared/local-date.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./atomic-file.js";

const SonicBoomCtor = sonicBoomDefault as unknown as {
  new (opts: SonicBoomOpts): SonicBoomInstance;
};

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
  const byAge = (a: LogFileInfo, b: LogFileInfo): number =>
    a.dateStr === b.dateStr ? a.seq - b.seq : a.dateStr < b.dateStr ? -1 : 1;

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
    list.sort(byAge);
    const overflow = list.slice(0, list.length - maxFilesPerDay);
    for (const f of overflow) remove(f);
  }

  files = listLogFiles(dir).filter((f) => !deleted.includes(f.name));
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total > maxTotalBytes) {
    files.sort(byAge);
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

  /** Seed byte accounting from existing content and count buffered writes in process; disk size lags async flushes. */
  let activeBytes = 0;

  const openBoom = (filePath: string): SonicBoomInstance => {
    // Set mode during async open, never with a racing chmod; Windows relies on inherited ACLs. Flush buffered output at shutdown.
    const boom = new SonicBoomCtor({ dest: filePath, mkdir: false, sync: false, mode: PRIVATE_FILE_MODE });
    // Handle asynchronous error events explicitly; synchronous try/catch cannot catch them and an unhandled event would crash the process.
    boom.on("error", () => {
      /* Destination errors must not crash the process or damage console logging. */
    });
    return boom;
  };

  const seedActiveBytes = (): void => {
    try {
      activeBytes = existsSync(currentFile) ? statSync(currentFile).size : 0;
    } catch {
      activeBytes = 0;
    }
  };

  let boom = openBoom(currentFile);
  seedActiveBytes();

  const roll = (): void => {
    seq += 1;
    const next = join(dir, seqFileName(dateStr, seq));
    const old = boom;
    currentFile = next;
    boom = openBoom(next);
    activeBytes = 0;
    // Make the new destination live before closing the old one to avoid dropped lines.
    try {
      old.end();
    } catch {
    }
    capLogTree(dir, { keepFile: currentFile });
  };

  return {
    get currentFile(): string {
      return currentFile;
    },
    write(chunk: string): void {
      try {
        boom.write(chunk);
      } catch {
        // File-write failures must not propagate to log callers.
        return;
      }
      activeBytes += Buffer.byteLength(chunk, "utf-8");
      if (activeBytes >= maxBytes) {
        roll();
      }
    },
    destroy(): void {
      try {
        boom.end();
      } catch {
      }
    },
  };
}
