import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLogFileSink,
  parseLogFileDate,
  pruneOldLogs,
  capLogTree,
  reprunePersistedRetention,
  LOG_RETENTION_DAYS,
  LOG_MAX_BYTES,
  LOG_MAX_FILES_PER_DAY,
  LOG_MAX_TOTAL_BYTES,
} from "../log-file-sink.js";
import { LOG_RETENTION_DAYS as SHARED_LOG_RETENTION_DAYS } from "../../shared/log-retention.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { utcDateKey as todayDateStr } from "../../shared/local-date.js";

let logDir: string;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "ave-logsink-"));
});

afterEach(async () => {
  if (!existsSync(logDir)) return;
  // Allow trailing close callbacks to settle after destroy before removing the directory.
  await new Promise((r) => setTimeout(r, 0));
  await cleanupTmpDir(logDir);
});

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function listFiles(): string[] {
  return readdirSync(logDir).sort();
}

/** Wait for asynchronous open before asserting filesystem presence or permissions. */
async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("parseLogFileDate", () => {
  it("parses base and sequenced log filenames", () => {
    expect(parseLogFileDate("ave-2026-07-05.log")).toBe("2026-07-05");
    expect(parseLogFileDate("ave-2026-07-05.3.log")).toBe("2026-07-05");
  });

  it("rejects non-log / foreign filenames", () => {
    expect(parseLogFileDate("audit-2026-07-05.jsonl")).toBeNull();
    expect(parseLogFileDate("ave.log")).toBeNull();
    expect(parseLogFileDate("ave-2026-7-5.log")).toBeNull();
    expect(parseLogFileDate("readme.txt")).toBeNull();
  });
});

describe("pruneOldLogs — retention", () => {
  it("deletes files older than the retention window, keeps recent ones", () => {
    writeFileSync(join(logDir, `ave-${daysAgo(10)}.log`), "old\n");
    writeFileSync(join(logDir, `ave-${daysAgo(10)}.1.log`), "old-seq\n");
    writeFileSync(join(logDir, `ave-${daysAgo(2)}.log`), "recent\n");
    writeFileSync(join(logDir, `ave-${todayDateStr()}.log`), "today\n");

    const deleted = pruneOldLogs(logDir, 7);

    expect(deleted.sort()).toEqual(
      [`ave-${daysAgo(10)}.1.log`, `ave-${daysAgo(10)}.log`].sort(),
    );
    const remaining = listFiles();
    expect(remaining).toContain(`ave-${daysAgo(2)}.log`);
    expect(remaining).toContain(`ave-${todayDateStr()}.log`);
    expect(remaining).not.toContain(`ave-${daysAgo(10)}.log`);
  });

  it("never touches foreign files in the directory", () => {
    writeFileSync(join(logDir, "audit-2000-01-01.jsonl"), "x\n");
    writeFileSync(join(logDir, "keep.txt"), "x\n");
    const deleted = pruneOldLogs(logDir, 1);
    expect(deleted).toEqual([]);
    expect(listFiles()).toContain("audit-2000-01-01.jsonl");
    expect(listFiles()).toContain("keep.txt");
  });

  it("returns [] for a missing directory (non-fatal)", () => {
    expect(pruneOldLogs(join(logDir, "does-not-exist"), 7)).toEqual([]);
  });

  it("respects the retention boundary exactly", () => {
    writeFileSync(join(logDir, `ave-${daysAgo(7)}.log`), "boundary\n");
    const deleted = pruneOldLogs(logDir, 7);
    expect(deleted).toContain(`ave-${daysAgo(7)}.log`);
  });
});

describe("createLogFileSink — file creation + mode", () => {
  it("creates today's base log file and prunes old files on attach", async () => {
    writeFileSync(join(logDir, `ave-${daysAgo(30)}.log`), "ancient\n");
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7 });
    try {
      sink.write("hello\n");
      // Inspect currentFile immediately, then wait for the async open before disk assertions.
      expect(sink.currentFile).toBe(join(logDir, `ave-${todayDateStr()}.log`));
      await waitForFile(sink.currentFile);
      expect(existsSync(sink.currentFile)).toBe(true);
      expect(existsSync(join(logDir, `ave-${daysAgo(30)}.log`))).toBe(false);
    } finally {
      sink.destroy();
    }
  });

  it("runs capLogTree at init: an over-per-day-count tree is pruned on attach", async () => {
    // Seed more than the per-day cap to verify initialization invokes pruning.
    const day = daysAgo(1);
    writeFileSync(join(logDir, `ave-${day}.log`), "a");
    for (let i = 1; i <= 21; i++) writeFileSync(join(logDir, `ave-${day}.${i}.log`), "a");
    const before = readdirSync(logDir).filter((f) => f.startsWith(`ave-${day}`)).length;
    expect(before).toBe(22);
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7 });
    try {
      await waitForFile(sink.currentFile);
      const after = readdirSync(logDir).filter((f) => f.startsWith(`ave-${day}`)).length;
      expect(after).toBe(20); // capped to LOG_MAX_FILES_PER_DAY at init
    } finally {
      sink.destroy();
    }
  });

  it.runIf(process.platform !== "win32")(
    "enforces 0o600 on the log file (at open) and 0o700 on the directory",
    async () => {
      const sink = createLogFileSink({ dir: logDir, retentionDays: 7 });
      try {
        sink.write("x\n");
        // Wait for creation; mode is set during open, avoiding a post-open chmod window.
        await waitForFile(sink.currentFile);
        const fileMode = statSync(sink.currentFile).mode & 0o777;
        const dirMode = statSync(logDir).mode & 0o777;
        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
      } finally {
        sink.destroy();
      }
    },
  );
});

describe("createLogFileSink — size-based sequence rolling", () => {
  it("rolls to a .seq file once the active file crosses maxBytes", async () => {
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 64 });
    try {
      const base = join(logDir, `ave-${todayDateStr()}.log`);
      // Stay below the per-day file cap so byte-roll assertions retain their base file.
      const line = "x".repeat(20) + "\n";
      for (let i = 0; i < 8; i++) sink.write(line);
      const finalFile = sink.currentFile;
      expect(finalFile).not.toBe(base);
      // Wait for every asynchronous destination open before destroy or cleanup to avoid delayed ENOENT errors.
      await waitForFile(base);
      await waitForFile(finalFile);
      sink.destroy();
      const files = listFiles().filter((f) => parseLogFileDate(f) === todayDateStr());
      expect(files).toContain(`ave-${todayDateStr()}.log`);
      expect(files.some((f) => /\.\d+\.log$/.test(f))).toBe(true);
      expect(existsSync(base)).toBe(true);
    } finally {
      // Repeated destroy must be safe.
    }
  });

  it("resumes into a fresh sequence when today's base file is already oversized", async () => {
    const base = join(logDir, `ave-${todayDateStr()}.log`);
    writeFileSync(base, "y".repeat(200));
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 64 });
    try {
      sink.write("z\n");
      expect(sink.currentFile).not.toBe(base);
      expect(/\.\d+\.log$/.test(sink.currentFile)).toBe(true);
      // Wait for asynchronous open before teardown removes the directory.
      await waitForFile(sink.currentFile);
    } finally {
      sink.destroy();
    }
  });

  it("resumes an UNDER-cap same-day file and seeds the byte counter from its size", async () => {
    // Resume under-cap files in append mode and seed byte accounting from existing content.
    const base = join(logDir, `ave-${todayDateStr()}.log`);
    writeFileSync(base, "a".repeat(60));
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 100 });
    try {
      expect(sink.currentFile).toBe(base);
      // Assert the synchronous currentFile transition; the rolled inode appears asynchronously.
      for (let i = 0; i < 6; i++) sink.write("b".repeat(9) + "\n"); // 10 bytes each
      expect(sink.currentFile).not.toBe(base);
      expect(/\.\d+\.log$/.test(sink.currentFile)).toBe(true);
      // Wait for the rolled file before destroy so no open outlives the fixture.
      const rolledPath = sink.currentFile;
      await waitForFile(rolledPath);
      expect(existsSync(rolledPath)).toBe(true);
      expect(statSync(base).size).toBeGreaterThanOrEqual(60);
    } finally {
      sink.destroy();
    }
  });
});

describe("SOT constants", () => {
  it("exports the documented defaults", () => {
    // Assert retention exports against the shared policy rather than duplicating its literal.
    expect(LOG_RETENTION_DAYS).toBe(SHARED_LOG_RETENTION_DAYS);
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(LOG_MAX_FILES_PER_DAY).toBe(20);
    expect(LOG_MAX_TOTAL_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe("capLogTree — per-day count + total-byte caps (#1499 E2)", () => {
  it("deletes oldest sequences beyond the per-day file limit", () => {
    writeFileSync(join(logDir, "ave-2025-06-01.log"), "a");
    for (let i = 1; i <= 4; i++) writeFileSync(join(logDir, `ave-2025-06-01.${i}.log`), "a");
    const deleted = capLogTree(logDir, { maxFilesPerDay: 2, maxTotalBytes: Infinity });
    expect(deleted.length).toBe(3);
    const remaining = readdirSync(logDir).sort();
    expect(remaining).toEqual(["ave-2025-06-01.3.log", "ave-2025-06-01.4.log"]);
  });

  it("deletes oldest files first to satisfy the total-byte cap", () => {
    writeFileSync(join(logDir, "ave-2025-06-01.log"), "x".repeat(100));
    writeFileSync(join(logDir, "ave-2025-06-02.log"), "x".repeat(100));
    writeFileSync(join(logDir, "ave-2025-06-03.log"), "x".repeat(100));
    const deleted = capLogTree(logDir, { maxFilesPerDay: 999, maxTotalBytes: 150 });
    expect(deleted).toContain("ave-2025-06-01.log");
    expect(existsSync(join(logDir, "ave-2025-06-03.log"))).toBe(true);
  });

  it("never deletes keepFile", () => {
    const keep = join(logDir, "ave-2025-06-01.5.log");
    writeFileSync(join(logDir, "ave-2025-06-01.log"), "a");
    for (let i = 1; i <= 5; i++) writeFileSync(join(logDir, `ave-2025-06-01.${i}.log`), "a");
    capLogTree(logDir, { maxFilesPerDay: 1, maxTotalBytes: Infinity, keepFile: keep });
    expect(existsSync(keep)).toBe(true);
  });

  it("missing dir is graceful", () => {
    expect(capLogTree(join(logDir, "nope"))).toEqual([]);
  });
});

describe("reprunePersistedRetention — boot re-prune (#1499 E2)", () => {
  it("no-op when retention equals the default", () => {
    writeFileSync(join(logDir, `ave-${daysAgo(3)}.log`), "keep");
    const deleted = reprunePersistedRetention(logDir, LOG_RETENTION_DAYS);
    expect(deleted).toEqual([]);
    expect(existsSync(join(logDir, `ave-${daysAgo(3)}.log`))).toBe(true);
  });

  it("a tightened window (< default) prunes files older than the new window", () => {
    writeFileSync(join(logDir, `ave-${daysAgo(3)}.log`), "old");
    writeFileSync(join(logDir, `ave-${daysAgo(1)}.log`), "recent");
    const deleted = reprunePersistedRetention(logDir, 2);
    expect(deleted).toContain(`ave-${daysAgo(3)}.log`);
    expect(existsSync(join(logDir, `ave-${daysAgo(3)}.log`))).toBe(false);
    expect(existsSync(join(logDir, `ave-${daysAgo(1)}.log`))).toBe(true);
  });

  it("also re-runs capLogTree (per-day count cap) after the date prune", () => {
    // Tightened retention must also enforce the per-day file cap.
    const day = daysAgo(1);
    writeFileSync(join(logDir, `ave-${day}.log`), "a");
    for (let i = 1; i <= 21; i++) writeFileSync(join(logDir, `ave-${day}.${i}.log`), "a");
    reprunePersistedRetention(logDir, 5);
    const remaining = readdirSync(logDir).filter((f) => f.startsWith(`ave-${day}`)).length;
    expect(remaining).toBe(LOG_MAX_FILES_PER_DAY);
  });
});
