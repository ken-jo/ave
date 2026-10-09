import { describe, expect, it } from "vitest";
import { normalizeSourceUrl } from "../../net/source-url.js";
import { authorityDelta, authorityView, rungOutcomeViews, rungViews, sourceStatus, stagedRungViews, widensAuthority } from "../views.js";

describe("filesystem authority review", () => {
  const base = authorityView({ capabilities: [] });
  const declared = authorityView({
    capabilities: [],
    sandbox: {
      read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read a certificate bundle" }],
      write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store project data" }],
    },
  });

  it("shows every reviewed grant and treats an added entry as widening", () => {
    expect(declared.filesystem).toEqual([
      { access: "read", target: "certs", why: "Read a certificate bundle" },
      { access: "write", target: "config.workspace", why: "Store project data" },
    ]);
    const delta = authorityDelta(base, declared);
    expect(delta?.added.filesystem).toEqual(declared.filesystem);
    expect(widensAuthority(delta)).toBe(true);
    expect(authorityDelta(declared, base)?.removed.filesystem).toEqual(declared.filesystem);
  });

  it("does not treat a reason-only edit as new filesystem authority", () => {
    const revised = { ...declared, filesystem: declared.filesystem.map((grant) => ({ ...grant, why: "Updated explanation" })) };
    expect(authorityDelta(declared, revised)).toBeNull();
  });
});

describe("source status", () => {
  const at = "2026-09-23T00:00:00.000Z";

  it("carries why the last sync failed into the Sources view", () => {
    const state = { pinnedCommit: "a".repeat(40), enabled: true, lastSync: { at, result: "SOURCE_UNREACHABLE" as const, detail: { reason: "dns" as const, host: "nowhere.invalid" } } };
    expect(sourceStatus(state, false, true, false)).toEqual({ state: "unreachable", code: "SOURCE_UNREACHABLE", detail: { reason: "dns", host: "nowhere.invalid" }, cached: true });
  });

  it("carries a sign-in failure's detail into auth-required", () => {
    const state = { pinnedCommit: null, enabled: true, lastSync: { at, result: "SOURCE_AUTH_REQUIRED" as const, detail: { reason: "ssh" as const, host: "git.example.com" } } };
    expect(sourceStatus(state, false, false, false)).toEqual({ state: "auth-required", detail: { reason: "ssh", host: "git.example.com" }, cached: false });
  });

  it("hands a stored detail's diagnostic text to the renderer scrubbed, whatever wrote the state file", () => {
    const detail = { reason: "policy-invalid" as const, error: 'policy.json: duplicate key "https://alice:detail-canary@example.com/x"' };
    const state = { pinnedCommit: null, enabled: true, lastSync: { at, result: "SOURCE_POLICY_BLOCKED" as const, detail } };
    expect(sourceStatus(state, false, false, false)).toEqual({
      state: "unreachable",
      code: "SOURCE_POLICY_BLOCKED",
      detail: { reason: "policy-invalid", error: 'policy.json: duplicate key "https://[REDACTED:CREDENTIALS]@example.com/x"' },
      cached: false,
    });
  });

  it("offers Repair for a sync that found the source's own repository damaged", () => {
    const state = { pinnedCommit: "a".repeat(40), enabled: true, lastSync: { at, result: "SOURCE_LOCAL_DATA_DAMAGED" as const, detail: { reason: "repository-damaged" as const, sourceId: "acme" } } };
    expect(sourceStatus(state, false, true, false)).toEqual({
      state: "broken",
      message: "the last sync found the downloaded copy damaged (repository-damaged)",
      detail: { reason: "repository-damaged", sourceId: "acme" },
    });
  });

  it("shows a failure recorded without a detail by its code alone", () => {
    const state = { pinnedCommit: null, enabled: true, lastSync: { at, result: "SOURCE_UNREACHABLE" as const } };
    expect(sourceStatus(state, false, false, false)).toEqual({ state: "unreachable", code: "SOURCE_UNREACHABLE", cached: false });
  });
});

describe("Delivery label after a download (§15.2, §18.2.3)", () => {
  const SOURCE = normalizeSourceUrl("https://1.1.1.1/acme/market");
  const https = { archive: { url: "https://1.1.1.1/alpha.zip", sha256: "a".repeat(64) } };

  it("predicts from the declared URL, and labels the rung whose staged bytes arrived over plain http", () => {
    const predicted = rungViews(https, "plugins/alpha", false, SOURCE);
    expect(predicted.find((item) => item.rung === "archive")?.unencrypted).toBe(false);
    // A redirect to http is known only once the bytes are staged.
    const staged = stagedRungViews(predicted, { rung: "archive", unencrypted: true });
    expect(staged.find((item) => item.rung === "archive")?.unencrypted).toBe(true);
    expect(staged.filter((item) => item.rung !== "archive")).toEqual(predicted.filter((item) => item.rung !== "archive"));
    expect(stagedRungViews(predicted, { rung: "archive", unencrypted: false })).toEqual(predicted);
  });

  it("carries the transport onto the used rung of the outcome only", () => {
    const outcomes = [
      { rung: "release" as const, outcome: "failed" as const, code: "SOURCE_UNREACHABLE", message: "HTTP 404" },
      { rung: "archive" as const, outcome: "used" as const },
    ];
    expect(rungOutcomeViews(outcomes, true)).toEqual([
      { rung: "release", outcome: "failed", code: "SOURCE_UNREACHABLE", message: "HTTP 404" },
      { rung: "archive", outcome: "used", unencrypted: true },
    ]);
    expect(rungOutcomeViews(outcomes, false)[1]).toEqual({ rung: "archive", outcome: "used", unencrypted: false });
  });
});
