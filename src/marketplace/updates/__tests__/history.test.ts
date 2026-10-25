import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCheckDueAt,
  discoveryDueAt,
  emptyUpdateHistory,
  parseUpdateHistory,
  updateHistoryStore,
  type UpdateHistory,
} from "../history.js";

const HOUR = 60 * 60 * 1000;
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T01:00:00.000Z";

function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    discovery: { lastAttemptAt: T1, lastSuccessAt: T0, result: "offline" },
    applyCheckAt: T0,
    packages: {
      "ave:plugin:meeting": { to: "2.0.0", state: "failed", attempts: 2, lastError: { code: "SOURCE_UNREACHABLE", detail: { reason: "dns", host: "github.com" }, at: T1 } },
      "acme:agent-plugin:notes": { to: "1.1.0", state: "applied", attempts: 0, appliedAt: T1, from: "1.0.0", displayName: "Notes", commits: { from: null, to: "c".repeat(40) } },
      "acme:plugin:stats": { to: "3.0.0", state: "failed", attempts: 1, lastError: { code: "unavailable", message: "EACCES: permission denied", at: T1 } },
    },
    ...overrides,
  });
}

describe("parseUpdateHistory", () => {
  it("reads the version-1 shape", () => {
    const history = parseUpdateHistory(file());
    expect(history.discovery).toEqual({ lastAttemptAt: T1, lastSuccessAt: T0, result: "offline" });
    expect(history.applyCheckAt).toBe(T0);
    expect(history.packages["ave:plugin:meeting"]).toEqual({
      to: "2.0.0",
      state: "failed",
      attempts: 2,
      lastError: { code: "SOURCE_UNREACHABLE", detail: { reason: "dns", host: "github.com" }, at: T1 },
    });
    expect(history.packages["acme:plugin:stats"]?.lastError).toEqual({ code: "unavailable", message: "EACCES: permission denied", at: T1 });
    expect(history.packages["acme:agent-plugin:notes"]).toMatchObject({ from: "1.0.0", displayName: "Notes" });
    expect(parseUpdateHistory(JSON.stringify(history))).toEqual(history);
    expect(Object.getPrototypeOf(history.packages)).toBeNull();
  });

  it("keeps a failure's code and drops a detail that does not belong to it, as the source state does", () => {
    const history = parseUpdateHistory(file({
      packages: { "ave:plugin:meeting": { to: "2.0.0", state: "failed", attempts: 1, lastError: { code: "SOURCE_UNREACHABLE", detail: { reason: "token" }, at: T1 } } },
    }));
    expect(history.packages["ave:plugin:meeting"]?.lastError).toEqual({ code: "SOURCE_UNREACHABLE", at: T1 });
  });

  it.each([
    ["an unknown top-level field", file({ extra: true })],
    ["another version", file({ version: 2 })],
    ["a missing field", JSON.stringify({ version: 1, discovery: null, applyCheckAt: null })],
    ["an unknown result", file({ discovery: { lastAttemptAt: T0, lastSuccessAt: T0, result: "maybe" } })],
    ["a success without its time", file({ discovery: { lastAttemptAt: T0, lastSuccessAt: null, result: "ok" } })],
    ["a time that is not one", file({ applyCheckAt: "yesterday" })],
    ["a state outside the view's eight", file({ packages: { "ave:plugin:meeting": { to: "2.0.0", state: "skipped", attempts: 0 } } })],
    ["a negative attempt count", file({ packages: { "ave:plugin:meeting": { to: "2.0.0", state: "manual", attempts: -1 } } })],
    ["a key that is not source:kind:name", file({ packages: { "meeting": { to: "2.0.0", state: "manual", attempts: 0 } } })],
    ["a key with an unknown kind", file({ packages: { "ave:widget:meeting": { to: "2.0.0", state: "manual", attempts: 0 } } })],
    ["an applied entry without what the view shows of it", file({ packages: { "ave:plugin:meeting": { to: "2.0.0", state: "applied", attempts: 0, appliedAt: T1 } } })],
    ["an applied entry without its commits", file({ packages: { "ave:plugin:meeting": { to: "2.0.0", state: "applied", attempts: 0, appliedAt: T1, from: "1.0.0", displayName: "meeting" } } })],
    ["commits that are not commits", file({ packages: { "ave:plugin:meeting": { to: "2.0.0", state: "applied", attempts: 0, appliedAt: T1, from: "1.0.0", displayName: "meeting", commits: { from: "", to: "c" } } } })],
    ["a message that is not text", file({ packages: { "ave:plugin:meeting": { to: "2.0.0", state: "failed", attempts: 1, lastError: { code: "unavailable", message: 7, at: T1 } } } })],
    ["an unknown error code", file({ packages: { "ave:plugin:meeting": { to: "2.0.0", state: "failed", attempts: 1, lastError: { code: "NOPE", at: T1 } } } })],
    ["duplicate keys", '{"version":1,"version":1,"discovery":null,"applyCheckAt":null,"packages":{}}'],
    ["text that is not JSON", "{ not json"],
  ])("refuses %s", (_what, text) => {
    expect(() => parseUpdateHistory(text)).toThrow();
  });
});

describe("updateHistoryStore", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-updates-json-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a missing file as an empty history, not as a reset", async () => {
    const store = updateHistoryStore(join(dir, "updates.json"));
    await expect(store.load()).resolves.toEqual({ history: emptyUpdateHistory(), reset: false });
  });

  it("reads an unreadable file as an empty history with the reason, writing and logging nothing: the scheduler does both", async () => {
    const path = join(dir, "updates.json");
    const unreadable = file({ version: 7 });
    writeFileSync(path, unreadable);
    const loaded = await updateHistoryStore(path).load();
    expect(loaded).toEqual({ history: emptyUpdateHistory(), reset: true, reason: expect.stringContaining("version must be 1") });
    expect(readFileSync(path, "utf8")).toBe(unreadable);
  });

  it("writes what it reads back", async () => {
    const path = join(dir, "updates.json");
    const store = updateHistoryStore(path);
    const history: UpdateHistory = parseUpdateHistory(file());
    await store.save(history);
    await expect(store.load()).resolves.toEqual({ history, reset: false });
  });
});

describe("the due rules", () => {
  const ms = (iso: string) => Date.parse(iso);

  it("retries a failed discovery an hour after its attempt, and waits the interval after a success", () => {
    expect(discoveryDueAt(null, 6 * HOUR)).toBe(Number.NEGATIVE_INFINITY);
    expect(discoveryDueAt({ lastAttemptAt: T1, lastSuccessAt: T0, result: "partial" }, 6 * HOUR)).toBe(ms(T1) + HOUR);
    expect(discoveryDueAt({ lastAttemptAt: T1, lastSuccessAt: T0, result: "error" }, 0)).toBe(ms(T1) + HOUR);
    expect(discoveryDueAt({ lastAttemptAt: T1, lastSuccessAt: T1, result: "ok" }, 6 * HOUR)).toBe(ms(T1) + 6 * HOUR);
    expect(discoveryDueAt({ lastAttemptAt: T1, lastSuccessAt: T1, result: "ok" }, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("makes the apply check due 24 hours after the last one, held to the hourly retry while discovery fails", () => {
    expect(applyCheckDueAt({ discovery: null, applyCheckAt: null })).toBe(Number.NEGATIVE_INFINITY);
    expect(applyCheckDueAt({ discovery: { lastAttemptAt: T1, lastSuccessAt: T1, result: "ok" }, applyCheckAt: T0 })).toBe(ms(T0) + 24 * HOUR);
    expect(applyCheckDueAt({ discovery: { lastAttemptAt: T1, lastSuccessAt: T0, result: "offline" }, applyCheckAt: null })).toBe(ms(T1) + HOUR);
    expect(applyCheckDueAt({ discovery: { lastAttemptAt: T1, lastSuccessAt: T0, result: "offline" }, applyCheckAt: T0 })).toBe(ms(T0) + 24 * HOUR);
  });
});
