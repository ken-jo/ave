// The memory use log records which memory backed an answer, keyed by id only; it must never carry memory text or user text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { appendJsonlCapped } from "../capped-jsonl.js";
import {
  MEMORY_USAGE_LOG_FILENAME,
  MemoryUsageLog,
  memoryUseStoreForSessionId,
} from "../memory-usage-log.js";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CHILD_SESSION = "sub-1a2b3c4d-0f8fad5b-d9cb-469f-a165-70867728950e";

let root: string;
let memoryDir: string;

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-memory-usage-"));
  memoryDir = join(root, "memories");
  mkdirSync(memoryDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(root);
});

describe("MemoryUsageLog", () => {
  it("appends one id-only row per memory with via, session, store, anchor and time", async () => {
    const log = new MemoryUsageLog({ aveDir: root, now: () => new Date("2026-11-04T01:02:03.000Z") });
    log.record({ memoryIds: ["mem-a", "mem-b"], via: "injected", sessionId: SESSION, store: "main", anchorMessageId: "msg-1" });
    await log.whenIdle();

    expect(log.path).toBe(join(memoryDir, MEMORY_USAGE_LOG_FILENAME));
    expect(rows(log.path)).toEqual([
      { v: 1, memoryId: "mem-a", via: "injected", sessionId: SESSION, store: "main", anchorMessageId: "msg-1", at: "2026-11-04T01:02:03.000Z" },
      { v: 1, memoryId: "mem-b", via: "injected", sessionId: SESSION, store: "main", anchorMessageId: "msg-1", at: "2026-11-04T01:02:03.000Z" },
    ]);
    if (process.platform !== "win32") expect(statSync(log.path).mode & 0o777).toBe(0o600);
  });

  it("omits optional store and anchor instead of writing placeholders", async () => {
    const log = new MemoryUsageLog({ aveDir: root, now: () => new Date("2026-11-04T00:00:00.000Z") });
    log.record({ memoryIds: ["mem-a"], via: "searched", sessionId: SESSION });
    await log.whenIdle();
    expect(rows(log.path)).toEqual([
      { v: 1, memoryId: "mem-a", via: "searched", sessionId: SESSION, at: "2026-11-04T00:00:00.000Z" },
    ]);
  });

  it("keeps rows in record order across back-to-back calls", async () => {
    const log = new MemoryUsageLog({ aveDir: root });
    log.record({ memoryIds: ["first"], via: "searched", sessionId: SESSION });
    log.record({ memoryIds: ["second"], via: "read", sessionId: SESSION });
    log.record({ memoryIds: ["third"], via: "injected", sessionId: SESSION, store: "main" });
    await log.whenIdle();
    expect(rows(log.path).map((row) => [row.memoryId, row.via])).toEqual([
      ["first", "searched"],
      ["second", "read"],
      ["third", "injected"],
    ]);
  });

  it("writes nothing for an empty id list", async () => {
    const log = new MemoryUsageLog({ aveDir: root });
    log.record({ memoryIds: [], via: "searched", sessionId: SESSION });
    await log.whenIdle();
    expect(() => readFileSync(log.path)).toThrow();
  });

  it("rejects internal contract violations instead of coercing them", () => {
    const log = new MemoryUsageLog({ aveDir: root });
    expect(() => log.record({ memoryIds: ["mem-a"], via: "remembered" as never, sessionId: SESSION })).toThrow(/via/);
    expect(() => log.record({ memoryIds: [""], via: "read", sessionId: SESSION })).toThrow(/memoryId/);
    expect(() => log.record({ memoryIds: ["mem-a"], via: "read", sessionId: "" })).toThrow(/sessionId/);
    expect(() => log.record({ memoryIds: ["mem-a"], via: "read", sessionId: SESSION, store: "elsewhere" as never })).toThrow(/store/);
    expect(() => log.record({ memoryIds: ["mem-a"], via: "read", sessionId: SESSION, anchorMessageId: "" })).toThrow(/anchorMessageId/);
  });

  it("swallows a disk failure with one warning so the caller's turn continues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A directory where the log file should be makes every append fail.
    const blocked = join(root, "blocked");
    mkdirSync(join(blocked, "memories", MEMORY_USAGE_LOG_FILENAME), { recursive: true });
    const log = new MemoryUsageLog({ aveDir: blocked });
    expect(() => log.record({ memoryIds: ["mem-a"], via: "read", sessionId: SESSION })).not.toThrow();
    await expect(log.whenIdle()).resolves.toBeUndefined();
    const usageWarnings = warn.mock.calls.filter((call) => String(call[0]).includes("memory-usage"));
    expect(usageWarnings).toHaveLength(1);
    expect(JSON.stringify(usageWarnings)).not.toContain("mem-a");

    // The queue keeps working after a failure.
    const healthy = new MemoryUsageLog({ aveDir: root });
    healthy.record({ memoryIds: ["mem-b"], via: "read", sessionId: SESSION });
    await healthy.whenIdle();
    expect(rows(healthy.path)).toHaveLength(1);
  });

  it("drops the oldest rows when the file would pass its cap", async () => {
    const log = new MemoryUsageLog({ aveDir: root, maxBytes: 1_000 });
    for (let index = 0; index < 40; index += 1) {
      log.record({ memoryIds: [`mem-${index}`], via: "searched", sessionId: SESSION });
    }
    await log.whenIdle();
    const kept = rows(log.path);
    expect(statSync(log.path).size).toBeLessThanOrEqual(1_000);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(40);
    expect(kept.at(-1)!.memoryId).toBe("mem-39");
    const ids = kept.map((row) => Number(String(row.memoryId).slice(4)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe("memoryUseStoreForSessionId", () => {
  it("names the sub-agent store only for sub-agent child ids", () => {
    expect(memoryUseStoreForSessionId(CHILD_SESSION)).toBe("subagent");
    // A plain id may be a main or side-chat conversation; the log does not guess.
    expect(memoryUseStoreForSessionId(SESSION)).toBeUndefined();
  });
});

describe("appendJsonlCapped", () => {
  it("keeps only complete newest lines within half the cap when rotating", async () => {
    const path = join(root, "capped.jsonl");
    const old = Array.from({ length: 20 }, (_, index) => JSON.stringify({ n: index })).join("\n");
    // A torn trailing fragment from a crash must not survive rotation.
    writeFileSync(path, `${old}\n{"n":`, "utf-8");
    const result = await appendJsonlCapped(path, [{ n: 99 }], 120);
    expect(result.rotated).toBe(true);
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.at(-1)).toBe(JSON.stringify({ n: 99 }));
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(statSync(path).size).toBeLessThanOrEqual(120);
  });

  it("appends without rotating while under the cap", async () => {
    const path = join(root, "small.jsonl");
    const first = await appendJsonlCapped(path, [{ n: 1 }], 1_000);
    const second = await appendJsonlCapped(path, [{ n: 2 }], 1_000);
    expect(first.rotated).toBe(false);
    expect(second.rotated).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe('{"n":1}\n{"n":2}\n');
  });

  it("rejects a non-positive cap", async () => {
    await expect(appendJsonlCapped(join(root, "bad.jsonl"), [{ n: 1 }], 0)).rejects.toThrow(/maxBytes/);
  });
});
