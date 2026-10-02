import { describe, expect, it } from "vitest";
import { parseGitMarketplaceResult, parseUpdateStatus } from "../git-marketplace.js";

describe("the failure envelope across the bridge (design §18.8)", () => {
  it("keeps a detail whose reason belongs to the code", () => {
    const sent = { ok: false, code: "SOURCE_UNREACHABLE", message: "git fetch failed: Could not resolve host", detail: { reason: "dns", host: "nowhere.invalid" } };
    expect(parseGitMarketplaceResult(sent)).toEqual(sent);
  });

  it.each([
    ["a reason of another code", { reason: "token", host: "nowhere.invalid" }],
    ["an unknown reason", { reason: "cosmic-rays", host: "nowhere.invalid" }],
    ["a field of the wrong type", { reason: "http-status", host: "nowhere.invalid", status: "502" }],
    ["a missing field", { reason: "dns" }],
    ["an extra field", { reason: "dns", host: "nowhere.invalid", path: "/etc/passwd" }],
    ["not an object", "dns"],
  ])("drops %s and keeps the code and message", (_case, detail) => {
    expect(parseGitMarketplaceResult({ ok: false, code: "SOURCE_UNREACHABLE", message: "git fetch failed", detail })).toEqual({
      ok: false,
      code: "SOURCE_UNREACHABLE",
      message: "git fetch failed",
    });
  });

  it("drops a detail on a code that has no reasons", () => {
    expect(parseGitMarketplaceResult({ ok: false, code: "PLAN_EXPIRED", message: "expired", detail: { reason: "expired" } })).toEqual({
      ok: false,
      code: "PLAN_EXPIRED",
      message: "expired",
    });
  });

  it("still reads an unknown code as unavailable", () => {
    expect(parseGitMarketplaceResult({ ok: false, code: "SOURCE_FROM_THE_FUTURE", message: "x", detail: { reason: "dns", host: "h" } })).toEqual({
      ok: false,
      code: "unavailable",
      message: "the marketplace did not answer",
    });
  });
});

describe("the update status across the bridge (design §13.1)", () => {
  const update = { key: { sourceId: "ave", kind: "plugin", name: "meeting" }, displayName: "Meeting", from: "1.0.0", to: "1.1.0", state: "manual" };
  const status = (packages: unknown[]) => ({
    discovery: { lastAttemptAt: "2026-10-01T00:00:00.000Z", lastSuccessAt: null, result: "partial", nextAt: "2026-10-01T01:00:00.000Z" },
    applyCheckAt: null,
    running: false,
    historyReset: false,
    waitingSince: null,
    escalated: false,
    autoUpdate: {
      enabled: true,
      lockedByPolicy: null,
      sources: [{ id: "ave", label: "ave", origin: "official", switch: { effective: true, override: null, lockedByPolicy: false, required: false }, needsUnencryptedUpdates: false }],
      packages: [{ key: update.key, switch: { effective: true, override: null, lockedByPolicy: false, required: false } }],
    },
    packages,
    unmetRequired: [],
  });

  it("keeps a package with its state, and one an earlier discovery showed, marked stale", () => {
    const sent = status([update, { ...update, key: { ...update.key, name: "notes" }, stale: true }]);
    expect(parseUpdateStatus(sent)).toEqual(sent);
  });

  it("keeps an escalated wait, and drops a status whose switches are malformed", () => {
    const sent = status([{ ...update, state: "waiting", escalated: true }]);
    expect(parseUpdateStatus(sent)).toEqual(sent);
    expect(parseUpdateStatus(status([{ ...update, state: "waiting", escalated: false }]))).toBeNull();
    const base = status([]);
    expect(parseUpdateStatus({ ...base, autoUpdate: { ...base.autoUpdate, sources: [{ ...base.autoUpdate.sources[0], origin: "elsewhere" }] } })).toBeNull();
    expect(parseUpdateStatus({ ...base, autoUpdate: { ...base.autoUpdate, packages: [{ key: update.key }] } })).toBeNull();
  });

  it("keeps each unmet required install, and drops a status whose rows are malformed or which has none (§10.2)", () => {
    const base = status([]);
    const unmet = { key: { sourceId: "corp", kind: "skill", name: "audit" }, sourceLabel: "Corp", reason: "incompatible", minAppVersion: "9.0.0", installedFrom: { sourceId: "team", label: "Team" } };
    const sent = { ...base, unmetRequired: [unmet, { ...unmet, reason: "source-missing", minAppVersion: null, installedFrom: null }] };
    expect(parseUpdateStatus(sent)).toEqual(sent);
    const { unmetRequired: _rows, ...without } = base;
    expect(parseUpdateStatus(without)).toBeNull();
    for (const bad of [
      { ...unmet, reason: "unknown" },
      { ...unmet, reason: "not-in-catalog" },
      { ...unmet, minAppVersion: 9 },
      { ...unmet, installedFrom: { sourceId: "team" } },
      { ...unmet, key: { ...unmet.key, kind: "widget" } },
    ]) expect(parseUpdateStatus({ ...base, unmetRequired: [bad] })).toBeNull();
  });

  it("keeps a required update and its required switch, and drops a required switch that is not on and locked", () => {
    const required = { effective: true, override: "off", lockedByPolicy: true, required: true };
    const sent = status([{ ...update, state: "waiting", required: true, autoUpdate: required }]);
    expect(parseUpdateStatus(sent)).toEqual(sent);
    expect(parseUpdateStatus(status([{ ...update, required: false }]))).toBeNull();
    expect(parseUpdateStatus(status([{ ...update, autoUpdate: { ...required, effective: false } }]))).toBeNull();
    expect(parseUpdateStatus(status([{ ...update, autoUpdate: { ...required, lockedByPolicy: false } }]))).toBeNull();
    const { required: _missing, ...unmarked } = required;
    expect(parseUpdateStatus(status([{ ...update, autoUpdate: unmarked }]))).toBeNull();
  });

  it.each([
    ["an unknown state", { ...update, state: "maybe" }],
    ["a stale flag that is not true", { ...update, stale: false }],
    ["a missing state", { ...update, state: undefined }],
  ])("drops a status with %s", (_case, item) => {
    expect(parseUpdateStatus(status([item]))).toBeNull();
  });
});
