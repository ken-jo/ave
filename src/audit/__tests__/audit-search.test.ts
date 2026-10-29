import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

import { AuditLogger, type AuditEntry } from "../audit-logger.js";

let testHome: string;
let auditDir: string;

function searchAudit(options: Parameters<AuditLogger["search"]>[0]) {
  return new AuditLogger().search(options);
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
    type: "turn",
    input: "hello",
    output: "world",
    ...overrides
  };
}

function writeJsonl(filename: string, entries: AuditEntry[]) {
  const path = join(auditDir, filename);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  testHome = mkdtempSync(join(process.cwd(), ".ave-audit-test-"));
  auditDir = join(testHome, ".ave", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.stubEnv("AVE_HOME", join(testHome, ".ave"));
});

afterEach(async () => {
  // The ENOTEMPTY cause remains unverified; search queues no writes, so flush cannot help. Keep bounded cleanup retries and restore home mocks only after removal.
  if (existsSync(testHome)) {
    await cleanupTmpDir(testHome);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AuditLogger.search()", () => {
  it("returns all entries when no filter", async () => {
    writeJsonl("2026-04-17.jsonl", [makeEntry({ type: "turn" }), makeEntry({ type: "tool_call" })]);
    writeJsonl("2026-04-18.jsonl", [makeEntry({ type: "error" })]);
    const { entries, total } = await searchAudit({});
    expect(total).toBe(3);
    expect(entries).toHaveLength(3);
  });

  it("filters by type", async () => {
    writeJsonl("2026-04-17.jsonl", [
      makeEntry({ type: "turn" }),
      makeEntry({ type: "tool_call" }),
      makeEntry({ type: "turn" }),
    ]);
    const { entries, total } = await searchAudit({ type: "tool_call" });
    expect(total).toBe(1);
    expect(entries[0].type).toBe("tool_call");
  });

  it("filters by dateFrom/dateTo", async () => {
    // Filter by row timestamps, not partition names; noon UTC keeps fixture dates stable across zones.
    writeJsonl("2026-04-14.jsonl", [makeEntry({ type: "warn", timestamp: "2026-04-14T12:00:00.000Z" })]);
    writeJsonl("2026-04-17.jsonl", [makeEntry({ type: "turn", timestamp: "2026-04-17T12:00:00.000Z" })]);
    writeJsonl("2026-04-20.jsonl", [makeEntry({ type: "error", timestamp: "2026-04-20T12:00:00.000Z" })]);
    const { entries, total } = await searchAudit({ dateFrom: "2026-04-16", dateTo: "2026-04-18" });
    expect(total).toBe(1);
    expect(entries[0].type).toBe("turn");
  });

  it("filters by textSearch (case-insensitive)", async () => {
    writeJsonl("2026-04-17.jsonl", [
      makeEntry({ input: "secret token abc" }),
      makeEntry({ input: "normal message" }),
    ]);
    const { total } = await searchAudit({ textSearch: "SECRET" });
    expect(total).toBe(1);
  });

  it("applies pagination via limit and offset", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ type: "turn", input: `msg ${i}` }),
    );
    writeJsonl("2026-04-17.jsonl", entries);
    const logger = new AuditLogger();
    const page1 = await logger.search({ limit: 4, offset: 0 });
    expect(page1.total).toBe(10);
    expect(page1.entries).toHaveLength(4);
    const page2 = await logger.search({ limit: 4, offset: 4 });
    expect(page2.entries).toHaveLength(4);
    const page3 = await logger.search({ limit: 4, offset: 8 });
    expect(page3.entries).toHaveLength(2);
  });

  it("returns empty when no files exist", async () => {
    const { entries, total } = await searchAudit({});
    expect(total).toBe(0);
    expect(entries).toHaveLength(0);
  });

  it("skips malformed JSON lines gracefully", async () => {
    const path = join(auditDir, "2026-04-17.jsonl");
    writeFileSync(path, `${JSON.stringify(makeEntry())}\nNOT_JSON\n${JSON.stringify(makeEntry())}\n`, "utf-8");
    const { total } = await searchAudit({});
    expect(total).toBe(2);
  });

  it("streams a large log while retaining only the requested page", async () => {
    const filePath = join(auditDir, "2026-04-17.jsonl");
    const output = createWriteStream(filePath, { encoding: "utf-8" });
    const totalRows = 50_000;
    // Separate rows by one millisecond so newest-first pagination has no accidental ties.
    const firstInstant = Date.parse("2026-04-17T00:00:00.000Z");
    for (let index = 0; index < totalRows; index += 1) {
      const entry = makeEntry({
        input: `${index}:${"x".repeat(1_000)}`,
        timestamp: new Date(firstInstant + index).toISOString(),
      });
      const line = `${JSON.stringify(entry)}\n`;
      if (!output.write(line)) await once(output, "drain");
    }
    output.end();
    await finished(output);

    let eventLoopTicks = 0;
    let scanning = true;
    const tick = () => {
      eventLoopTicks += 1;
      if (scanning) setImmediate(tick);
    };
    setImmediate(tick);

    const result = await searchAudit({ offset: 49_990, limit: 5 });
    scanning = false;

    expect(result.total).toBe(totalRows);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((entry) => entry.input?.split(":", 1)[0])).toEqual([
      "9",
      "8",
      "7",
      "6",
      "5",
    ]);
    expect(eventLoopTicks).toBeGreaterThan(0);
  }, 30_000);
});

describe("AuditLogger.getStats()", () => {
  // Use today's partition so timestamp-window tests do not age out.
  const todayJsonl = () => `${new Date().toISOString().slice(0, 10)}.jsonl`;

  it("counts entries by type", async () => {
    writeJsonl(todayJsonl(), [
      makeEntry({ type: "turn" }),
      makeEntry({ type: "turn" }),
      makeEntry({ type: "tool_call" }),
    ]);
    const logger = new AuditLogger();
    const stats = await logger.getStats(30);
    expect(stats.totalByType["turn"]).toBe(2);
    expect(stats.totalByType["tool_call"]).toBe(1);
  });

  it("counts sensitive ops (approval + kill_switch)", async () => {
    writeJsonl(todayJsonl(), [
      makeEntry({ type: "approval" }),
      makeEntry({ type: "kill_switch" }),
      makeEntry({ type: "turn" }),
    ]);
    const logger = new AuditLogger();
    const stats = await logger.getStats(30);
    expect(stats.sensitiveOps).toBe(2);
  });

  it("counts permission-channel rows by their `decision`, never as an `undefined` type", async () => {
    // Permission rows use decision rather than type; do not invent an undefined telemetry bucket.
    const day = new Date().toISOString().slice(0, 10);
    const ts = new Date().toISOString();
    const permissionRow = (decision: string) => ({
      ts, auditId: `a-${decision}`, decision, tool: "bash", source: "builtin",
      category: "shell", layer: "policy", trustOrigin: "user", toolUseId: "t1",
      prevHash: "0", entryHash: "1",
    });
    writeJsonl(todayJsonl(), [makeEntry({ type: "turn" })]);
    writeFileSync(
      join(auditDir, `${day}.permission-audit.jsonl`),
      [permissionRow("allow"), permissionRow("allow"), permissionRow("deny")]
        .map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf-8",
    );
    const logger = new AuditLogger();
    const stats = await logger.getStats(30);
    expect(stats.totalByType).toEqual({ turn: 1, allow: 2, deny: 1 });
    expect(Object.values(stats.totalByDay).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("does not count a row that states neither a `type` nor a permission `decision`", async () => {
    // Rows matching no audit-channel contract are corrupt and must not count.
    writeFileSync(
      join(auditDir, todayJsonl()),
      [JSON.stringify(makeEntry({ type: "turn" })), JSON.stringify({ timestamp: new Date().toISOString(), sessionId: "s" })]
        .join("\n") + "\n",
      "utf-8",
    );
    const logger = new AuditLogger();
    const stats = await logger.getStats(30);
    expect(stats.totalByType).toEqual({ turn: 1 });
    expect(Object.values(stats.totalByDay).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("returns zero stats when no files", async () => {
    const logger = new AuditLogger();
    const stats = await logger.getStats(7);
    expect(stats.sensitiveOps).toBe(0);
    expect(Object.keys(stats.totalByType)).toHaveLength(0);
  });
});

/** Pin TZ because local picker days can span two UTC partitions, including DST offsets. */
describe("AuditLogger.search() — host-local day range over UTC partitions", () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("a Seoul host at 01:00 local sees today's entries, which live in yesterday's UTC file", async () => {
    process.env.TZ = "Asia/Seoul";
    writeJsonl("2026-06-15.jsonl", [
      makeEntry({ timestamp: "2026-06-15T16:00:00.000Z", input: "after-local-midnight" }),
      makeEntry({ timestamp: "2026-06-15T14:30:00.000Z", input: "before-local-midnight" }),
    ]);
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T10:00:00.000Z", input: "local-evening" }),
    ]);
    const { entries, total } = await searchAudit({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["after-local-midnight", "local-evening"]);
  });

  it("a New York host at 21:00 local sees entries written after 00:00Z that belong to its local today", async () => {
    process.env.TZ = "America/New_York";
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T01:00:00.000Z", input: "local-evening" }),
      makeEntry({ timestamp: "2026-06-16T04:00:00.000Z", input: "next-local-day" }),
    ]);
    writeJsonl("2026-06-15.jsonl", [
      makeEntry({ timestamp: "2026-06-15T03:59:59.000Z", input: "previous-local-day" }),
      makeEntry({ timestamp: "2026-06-15T12:00:00.000Z", input: "local-morning" }),
    ]);
    const { entries, total } = await searchAudit({ dateFrom: "2026-06-15", dateTo: "2026-06-15" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["local-evening", "local-morning"]);
  });

  it("includes both boundary local days: the first instant of dateFrom and the last of dateTo", async () => {
    process.env.TZ = "Asia/Seoul";
    writeJsonl("2026-06-14.jsonl", [
      makeEntry({ timestamp: "2026-06-14T14:59:59.999Z", input: "before-from" }),
      makeEntry({ timestamp: "2026-06-14T15:00:00.000Z", input: "from-first-instant" }),
    ]);
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T14:59:59.999Z", input: "to-last-instant" }),
      makeEntry({ timestamp: "2026-06-16T15:00:00.000Z", input: "after-to" }),
    ]);
    const { entries, total } = await searchAudit({ dateFrom: "2026-06-15", dateTo: "2026-06-16" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["from-first-instant", "to-last-instant"]);
  });

  it("control: under UTC the same files answer by UTC day, so the boundary set differs", async () => {
    process.env.TZ = "UTC";
    writeJsonl("2026-06-14.jsonl", [
      makeEntry({ timestamp: "2026-06-14T14:59:59.999Z", input: "before-from" }),
      makeEntry({ timestamp: "2026-06-14T15:00:00.000Z", input: "from-first-instant" }),
    ]);
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T14:59:59.999Z", input: "to-last-instant" }),
      makeEntry({ timestamp: "2026-06-16T15:00:00.000Z", input: "after-to" }),
    ]);
    const { entries, total } = await searchAudit({ dateFrom: "2026-06-15", dateTo: "2026-06-16" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["after-to", "to-last-instant"]);
  });

  it("keeps HMAC-chained permission rows, which stamp `ts` rather than `timestamp`", async () => {
    process.env.TZ = "Asia/Seoul";
    const permissionRow = {
      ts: "2026-06-15T16:00:00.000Z",
      sessionId: "test-session",
      decision: "allow",
      tool: "read_file",
    } as unknown as AuditEntry;
    writeJsonl("2026-06-15.permission-audit.jsonl", [permissionRow]);
    const { total } = await searchAudit({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(total).toBe(1);
  });

  it("rejects a malformed day key instead of silently widening the range", async () => {
    const logger = new AuditLogger();
    await expect(logger.search({ dateFrom: "2026-6-1" })).rejects.toThrow(TypeError);
  });
});

/** Order by row timestamps across channels rather than concatenating partition streams. */
describe("AuditLogger.search() — newest-first across a day's channel files", () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  function writeDayChannels(): void {
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T01:00:00.000Z", input: "turn-first" }),
      makeEntry({ timestamp: "2026-06-16T09:00:00.000Z", input: "turn-last" }),
    ]);
    writeJsonl("2026-06-16.permission-audit.jsonl", [
      makeEntry({ timestamp: "2026-06-16T02:00:00.000Z", input: "permission" }),
    ]);
    writeJsonl("2026-06-16.sandbox-gate.jsonl", [
      makeEntry({ timestamp: "2026-06-16T05:00:00.000Z", input: "gate" }),
    ]);
    writeJsonl("2026-06-16.sandbox.jsonl", [
      makeEntry({ timestamp: "2026-06-16T03:00:00.000Z", input: "sandbox" }),
    ]);
  }

  it("returns one monotonically descending run, not one per channel file", async () => {
    writeDayChannels();
    const { entries, total } = await searchAudit({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(total).toBe(5);
    expect(entries.map((e) => e.input)).toEqual([
      "turn-last",
      "gate",
      "sandbox",
      "permission",
      "turn-first",
    ]);
    const instants = entries.map((e) => Date.parse(e.timestamp));
    expect(instants).toEqual([...instants].sort((a, b) => b - a));
  });

  it("offset indexes that order, so paging walks backwards through time", async () => {
    writeDayChannels();
    const logger = new AuditLogger();
    const page = await logger.search({
      dateFrom: "2026-06-16",
      dateTo: "2026-06-16",
      limit: 2,
      offset: 1,
    });
    expect(page.total).toBe(5);
    expect(page.entries.map((e) => e.input)).toEqual(["gate", "sandbox"]);
  });

  it("breaks a same-millisecond tie on read order, so a page is deterministic", async () => {
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T04:00:00.000Z", input: "first-read" }),
      makeEntry({ timestamp: "2026-06-16T04:00:00.000Z", input: "second-read" }),
    ]);
    writeJsonl("2026-06-16.sandbox.jsonl", [
      makeEntry({ timestamp: "2026-06-16T04:00:00.000Z", input: "third-read" }),
    ]);
    const { entries } = await searchAudit({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(entries.map((e) => e.input)).toEqual(["first-read", "second-read", "third-read"]);
  });

  it("pages exactly as a full sort of the same rows would, at every window", async () => {
    // Compare capped heap selection against stable sorting with dense deterministic ties.
    const base = Date.parse("2026-06-16T00:00:00.000Z");
    let seed = 20_260_616;
    const nextInstant = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return base + (seed % 40) * 1_000;
    };
    const expected: Array<{ at: number; seq: number; input: string }> = [];
    let seq = 0;
    for (const channel of ["2026-06-16.jsonl", "2026-06-16.permission-audit.jsonl", "2026-06-16.sandbox.jsonl"]) {
      const rows: AuditEntry[] = [];
      for (let index = 0; index < 200; index += 1) {
        const at = nextInstant();
        const input = `row-${seq}`;
        rows.push(makeEntry({ timestamp: new Date(at).toISOString(), input }));
        expected.push({ at, seq, input });
        seq += 1;
      }
      writeJsonl(channel, rows);
    }
    const fullSort = [...expected]
      .sort((a, b) => (a.at === b.at ? a.seq - b.seq : b.at - a.at))
      .map((row) => row.input);

    const logger = new AuditLogger();
    for (const [offset, limit] of [
      [0, 10],
      [0, 600],
      [5, 25],
      [590, 50],
      [377, 1],
    ] as const) {
      const { entries, total } = await logger.search({
        dateFrom: "2026-06-16",
        dateTo: "2026-06-16",
        offset,
        limit,
      });
      expect(total).toBe(600);
      expect(entries.map((e) => e.input)).toEqual(fullSort.slice(offset, offset + limit));
    }
  });

  it("sorts a row with an unreadable instant last, and only when no bound is set", async () => {
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T04:00:00.000Z", input: "timed" }),
      { ...makeEntry({ input: "untimed" }), timestamp: undefined } as unknown as AuditEntry,
    ]);
    const logger = new AuditLogger();
    const unbounded = await logger.search({});
    expect(unbounded.entries.map((e) => e.input)).toEqual(["timed", "untimed"]);
    const bounded = await logger.search({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(bounded.entries.map((e) => e.input)).toEqual(["timed"]);
  });
});

/** Exclude unverified archives from search and stats; those surfaces cannot represent lost seals. */
describe("AuditLogger — quarantined unverified rows", () => {
  const QUARANTINE_FILES = [
    "2026-06-16.permission-audit.torn-unverified-4096-1781568000000.jsonl",
    "2026-06-16.permission-audit.legacy-unverified-a1b2c3d4e5f6.jsonl",
  ];

  function writeVerifiedAndQuarantined(): void {
    writeJsonl("2026-06-16.permission-audit.jsonl", [
      makeEntry({ timestamp: "2026-06-16T04:00:00.000Z", type: "approval", input: "sealed" }),
    ]);
    for (const name of QUARANTINE_FILES) {
      writeJsonl(name, [
        makeEntry({ timestamp: "2026-06-16T05:00:00.000Z", type: "approval", input: "unsealed" }),
      ]);
    }
  }

  it("search never returns them", async () => {
    writeVerifiedAndQuarantined();
    const { entries, total } = await searchAudit({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(total).toBe(1);
    expect(entries.map((e) => e.input)).toEqual(["sealed"]);
  });

  it("getStats never counts them", async () => {
    writeVerifiedAndQuarantined();
    const logger = new AuditLogger(undefined, { now: () => new Date("2026-06-16T12:00:00.000Z") });
    const stats = await logger.getStats(1);
    expect(stats.sensitiveOps).toBe(1);
    expect(stats.totalByType).toEqual({ approval: 1 });
  });
});

describe("AuditLogger.getStats() — host-local window and day buckets", () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  const NOW = new Date("2026-06-15T16:30:00.000Z");

  it("buckets totalByDay by the host's civil day, not the partition's UTC day", async () => {
    process.env.TZ = "Asia/Seoul";
    writeJsonl("2026-06-15.jsonl", [
      makeEntry({ timestamp: "2026-06-15T16:00:00.000Z" }), // 01:00 local, the 16th
      makeEntry({ timestamp: "2026-06-15T14:00:00.000Z" }), // 23:00 local, the 15th
    ]);
    const logger = new AuditLogger(undefined, { now: () => NOW });
    const stats = await logger.getStats(1);
    expect(stats.totalByDay).toEqual({ "2026-06-16": 1, "2026-06-15": 1 });
  });

  it("control: under UTC both entries fall on the partition's day", async () => {
    process.env.TZ = "UTC";
    writeJsonl("2026-06-15.jsonl", [
      makeEntry({ timestamp: "2026-06-15T16:00:00.000Z" }),
      makeEntry({ timestamp: "2026-06-15T14:00:00.000Z" }),
    ]);
    const logger = new AuditLogger(undefined, { now: () => NOW });
    const stats = await logger.getStats(1);
    expect(stats.totalByDay).toEqual({ "2026-06-15": 2 });
  });

  it("starts the window at local midnight N days back, reaching into the earlier UTC partition", async () => {
    process.env.TZ = "Asia/Seoul";
    writeJsonl("2026-06-14.jsonl", [
      makeEntry({ timestamp: "2026-06-14T15:00:00.000Z", type: "approval" }), // 00:00 local, the 15th
      makeEntry({ timestamp: "2026-06-14T14:59:59.000Z", type: "kill_switch" }), // 23:59:59 local, the 14th
    ]);
    const logger = new AuditLogger(undefined, { now: () => NOW });
    const stats = await logger.getStats(1);
    expect(stats.sensitiveOps).toBe(1);
    expect(stats.totalByType).toEqual({ approval: 1 });
  });
});
