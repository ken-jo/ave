/**
 * The suggestion ledger keeps one acceptance per (plugin, declared source) for
 * 30 days, and the window has to survive a restart: a watcher that re-emits
 * on every boot must not earn a fresh suggestion each time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUGGESTION_ACCEPTANCE_WINDOW_MS, SuggestionLedger } from "../suggestion-ledger.js";

const NOW = Date.parse("2026-09-26T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

let home: string;
let dir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "suggestion-ledger-"));
  dir = join(home, "alerts");
});

/** Every ledger a case made: `record` queues its write, and a case may end before it lands. */
const made: SuggestionLedger[] = [];

afterEach(async () => {
  // Settle the queued writes before removing their directory: a write still
  // landing in alerts/ while `rm` empties it fails the removal with ENOTEMPTY.
  await Promise.all(made.splice(0).map((l) => l.flush()));
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

function ledger(): SuggestionLedger {
  const l = new SuggestionLedger(() => dir);
  made.push(l);
  return l;
}

describe("SuggestionLedger", () => {
  it("uses a 30-day window", () => {
    expect(SUGGESTION_ACCEPTANCE_WINDOW_MS).toBe(30 * DAY);
  });

  it("limits a source once accepted, per plugin and per source", async () => {
    const l = ledger();
    await l.load();
    expect(l.isLimited("fixturemail", "overlay:routine", NOW)).toBe(false);
    l.record("fixturemail", "overlay:routine", NOW);
    expect(l.isLimited("fixturemail", "overlay:routine", NOW + 1)).toBe(true);
    expect(l.isLimited("fixturemail", "overlay:other", NOW + 1)).toBe(false);
    expect(l.isLimited("fixtureep", "overlay:routine", NOW + 1)).toBe(false);
  });

  it("lifts the limit when the window has passed, and keeps it when the clock is set back", async () => {
    const l = ledger();
    await l.load();
    l.record("fixturemail", "overlay:routine", NOW);
    expect(l.isLimited("fixturemail", "overlay:routine", NOW + 30 * DAY - 1)).toBe(true);
    expect(l.isLimited("fixturemail", "overlay:routine", NOW + 30 * DAY)).toBe(false);
    expect(l.isLimited("fixturemail", "overlay:routine", NOW - 5 * DAY)).toBe(true);
  });

  it("persists an acceptance across a restart", async () => {
    const before = ledger();
    await before.load();
    before.record("fixturemail", "overlay:routine", NOW);
    await before.flush();

    const after = ledger();
    await after.load();
    expect(after.isLimited("fixturemail", "overlay:routine", NOW + DAY)).toBe(true);
    const file = JSON.parse(await readFile(join(dir, "suggestions.json"), "utf8")) as unknown;
    expect(file).toEqual({ version: 1, accepted: { fixturemail: { "overlay:routine": NOW } } });
  });

  it("ignores damaged entries when it loads, and keeps the rest", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "suggestions.json"), JSON.stringify({
      version: 1,
      accepted: {
        fixturemail: { "overlay:fresh": NOW - DAY, "overlay:stale": NOW - 31 * DAY, "overlay:bad": "yesterday" },
        fixtureep: "not an object",
      },
    }));
    const l = ledger();
    await l.load();
    expect(l.isLimited("fixturemail", "overlay:fresh", NOW)).toBe(true);
    expect(l.isLimited("fixturemail", "overlay:stale", NOW)).toBe(false);
    expect(l.isLimited("fixturemail", "overlay:bad", NOW)).toBe(false);
  });

  it("prunes expired entries from the file on the next write", async () => {
    const l = ledger();
    await l.load();
    l.record("fixturemail", "overlay:old", NOW);
    l.record("fixturemail", "overlay:new", NOW + 31 * DAY);
    await l.flush();
    const file = JSON.parse(await readFile(join(dir, "suggestions.json"), "utf8")) as { accepted: unknown };
    expect(file.accepted).toEqual({ fixturemail: { "overlay:new": NOW + 31 * DAY } });
  });

  it("refuses to answer before load() resolved", () => {
    expect(() => ledger().isLimited("fixturemail", "overlay:routine", NOW)).toThrow(/before load/);
  });

  it("keeps the limit for the session when the write fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let target = dir;
    const l = new SuggestionLedger(() => target);
    await l.load();
    // A file where the namespace directory should be: the write cannot land.
    const blocker = join(home, "blocker");
    await writeFile(blocker, "not a directory");
    target = join(blocker, "alerts");
    l.record("fixturemail", "overlay:routine", NOW);
    await l.flush();
    expect(l.isLimited("fixturemail", "overlay:routine", NOW)).toBe(true);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toMatch(/could not persist suggestion acceptances/);
  });
});
