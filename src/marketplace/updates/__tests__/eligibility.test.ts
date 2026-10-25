/** Required policy overrides user switches, skips and approval carry, never revocation or compatibility. */
import { describe, expect, it } from "vitest";
import { UPDATE_PACKAGE_STATES, type UpdateReason } from "../../../shared/git-marketplace.js";
import {
  classifyUpdate,
  MAX_AUTOMATIC_ATTEMPTS,
  originDefault,
  requiresPackage,
  resolvePackageSwitch,
  resolveSourceSwitch,
  type AutoUpdatePolicy,
  type AutoUpdateSettings,
  type UpdateFacts,
} from "../eligibility.js";

function facts(overrides: Partial<UpdateFacts> = {}, source: Partial<UpdateFacts["source"]> = {}): UpdateFacts {
  return {
    switchKey: "notes",
    to: "1.1.0",
    change: "upgrade",
    enabled: true,
    required: false,
    policyBlocked: false,
    consent: [],
    unconfirmedApprovals: [],
    ...overrides,
    source: { id: "acme", origin: "custom", http: false, acknowledgedUnencryptedUpdates: false, shown: true, pendingRewrite: false, ...source },
  };
}

function classify(
  input: UpdateFacts,
  options: { policy?: AutoUpdatePolicy; settings?: AutoUpdateSettings; attempts?: number; skipped?: boolean } = {},
) {
  return classifyUpdate(input, {
    policy: options.policy ?? "user",
    settings: options.settings ?? {},
    memory: options.attempts === undefined ? null : { to: input.to, attempts: options.attempts },
    skipped: options.skipped ?? false,
  });
}

describe("classifyUpdate: the preconditions (§18.7.2)", () => {
  it("applies an upgrade with nothing to review from a default-on source", () => {
    expect(classify(facts())).toEqual({ state: "automatic", reasons: [] });
    expect(classify(facts({ change: "refresh" }))).toEqual({ state: "automatic", reasons: [] });
  });

  it.each<[string, UpdateFacts, UpdateReason]>([
    ["a disabled package", facts({ enabled: false }), "disabled"],
    ["a hidden source", facts({}, { shown: false }), "source-hidden"],
    ["a downgrade", facts({ change: "downgrade" }), "not-an-upgrade"],
    ["a source switch", facts({ change: "switch" }), "not-an-upgrade"],
    ["a history rewrite waiting for review", facts({}, { pendingRewrite: true }), "history-rewritten"],
    ["http without unencrypted-updates", facts({}, { http: true }), "unencrypted-updates"],
    ["a source the policy now blocks", facts({ policyBlocked: true }), "policy-blocked"],
  ])("never applies %s, whatever the switches say", (_what, input, reason) => {
    for (const policy of ["user", "on"] as const) {
      const result = classify(input, { policy, settings: { autoUpdate: true, autoUpdatePackages: { notes: "on" } } });
      expect(result).toEqual({ state: "manual", reasons: [reason] });
    }
  });

  it("never applies, and never shows, a skipped version", () => {
    expect(classify(facts(), { skipped: true })).toBeNull();
  });

  it("stops after three failed attempts at one version, and tries a newer version again", () => {
    expect(classify(facts(), { attempts: MAX_AUTOMATIC_ATTEMPTS - 1 })).toEqual({ state: "automatic", reasons: [] });
    expect(classify(facts(), { attempts: MAX_AUTOMATIC_ATTEMPTS })).toEqual({ state: "failed", reasons: ["failed-three-times"] });
    expect(classifyUpdate(facts({ to: "1.2.0" }), { policy: "user", settings: {}, memory: { to: "1.1.0", attempts: 3 }, skipped: false }))
      .toEqual({ state: "automatic", reasons: [] });
  });

  it("holds back for review a consent change, an unknown baseline field, and an approval that cannot carry", () => {
    const changed = facts({ consent: [{ field: "authority.networkAccess", checkpoint: "catalog", before: [], after: ["api.example.com"] }] });
    expect(classify(changed)).toEqual({ state: "needs-review", reasons: ["consent-changed"] });
    const unknown = facts({ consent: [{ field: "minAppVersion", checkpoint: "catalog", before: "unknown", after: "0.13.0" }] });
    expect(classify(unknown)).toEqual({ state: "needs-review", reasons: ["baseline-unknown"] });
    expect(classify(facts({ consent: [{ field: "*", checkpoint: "catalog", before: "unknown", after: null }] }))).toEqual({ state: "needs-review", reasons: ["baseline-unknown"] });
    expect(classify(facts({ ...changed, enabled: false }))).toEqual({ state: "needs-review", reasons: ["consent-changed", "disabled"] });
  });

  it("the approval invariant: an equal fingerprint whose approved component would not carry is needs-review, never automatic", () => {
    // A legacy null approval digest cannot carry approval to new bytes.
    const input = facts({ consent: [], unconfirmedApprovals: ["mcpServer:search"] });
    for (const policy of ["user", "on"] as const) {
      expect(classify(input, { policy, settings: { autoUpdatePackages: { notes: "on" } } })).toEqual({ state: "needs-review", reasons: ["approval-unconfirmed"] });
    }
  });

  it("writes only states of the view's union", () => {
    const inputs = [facts(), facts({ enabled: false }), facts({ unconfirmedApprovals: ["hook:0"] }), facts({ required: true })];
    for (const input of inputs) {
      for (const attempts of [0, 3]) {
        const result = classify(input, { attempts });
        if (result) expect(UPDATE_PACKAGE_STATES).toContain(result.state);
      }
    }
  });
});

describe("the switches (§18.7.2)", () => {
  it("decides by the first switch that is set: policy, package, source, global, origin", () => {
    const off = { state: "manual", reasons: ["switched-off"] };
    const on = { state: "automatic", reasons: [] };
    expect(classify(facts(), { settings: { autoUpdate: false } })).toEqual(off);
    expect(classify(facts(), { settings: { autoUpdate: false, autoUpdateSources: { acme: "on" } } })).toEqual(on);
    expect(classify(facts(), { settings: { autoUpdateSources: { acme: "off" }, autoUpdatePackages: { notes: "on" } } })).toEqual(on);
    expect(classify(facts(), { settings: { autoUpdatePackages: { notes: "off" } } })).toEqual(off);
  });

  it("policy off beats a package on, and policy on beats a package off", () => {
    expect(classify(facts(), { policy: "off", settings: { autoUpdatePackages: { notes: "on" } } })).toEqual({ state: "manual", reasons: ["switched-off"] });
    expect(classify(facts(), { policy: "on", settings: { autoUpdatePackages: { notes: "off" }, autoUpdate: false } })).toEqual({ state: "automatic", reasons: [] });
    expect(resolvePackageSwitch("on", { autoUpdatePackages: { notes: "off" } }, "notes", { id: "acme", origin: "custom", http: false }, false))
      .toEqual({ effective: true, override: "off", lockedByPolicy: true, required: false });
  });

  it("required-ness is the policy's entries and the package's identity: that kind and name from that source", () => {
    const policy = { requiredInstalls: [{ source: "acme", kind: "plugin" as const, name: "notes" }] };
    expect(requiresPackage(policy, { sourceId: "acme", kind: "plugin", name: "notes" })).toBe(true);
    expect(requiresPackage(policy, { sourceId: "other", kind: "plugin", name: "notes" })).toBe(false);
    expect(requiresPackage(policy, { sourceId: "acme", kind: "skill", name: "notes" })).toBe(false);
    expect(requiresPackage(policy, { sourceId: null, kind: "plugin", name: "notes" })).toBe(false);
    expect(requiresPackage({ requiredInstalls: [] }, { sourceId: "acme", kind: "plugin", name: "notes" })).toBe(false);
  });

  it("resolves a required package's switch without its source, and refuses an optional one's", () => {
    expect(resolvePackageSwitch("user", {}, "notes", null, true)).toEqual({ effective: true, override: null, lockedByPolicy: true, required: true });
    expect(() => resolvePackageSwitch("user", {}, "notes", null, false)).toThrow(/the switch of notes needs its source's facts unless the package is required/u);
  });

  it("a required package's switch is on and locked whatever the policy and every switch say", () => {
    const off = { autoUpdate: false, autoUpdateSources: { acme: "off" as const }, autoUpdatePackages: { notes: "off" as const } };
    for (const policy of ["user", "off", "on"] as const) {
      expect(resolvePackageSwitch(policy, off, "notes", { id: "acme", origin: "custom", http: true }, true))
        .toEqual({ effective: true, override: "off", lockedByPolicy: true, required: true });
      expect(classify(facts({ required: true }), { policy, settings: off })).toEqual({ state: "automatic", reasons: [] });
    }
  });

  it("defaults every origin on, but a custom or direct source over http off until the user turns it on", () => {
    expect(originDefault({ origin: "official", http: false })).toBe(true);
    expect(originDefault({ origin: "managed", http: true })).toBe(true);
    expect(originDefault({ origin: "custom", http: true })).toBe(false);
    expect(originDefault({ origin: "direct", http: true })).toBe(false);
    expect(resolveSourceSwitch("user", {}, { id: "lan", origin: "custom", http: true })).toEqual({ effective: false, override: null, lockedByPolicy: false, required: false });
    // User enablement still requires plaintext automatic-update consent.
    const http = facts({}, { http: true });
    expect(classify(http, { settings: { autoUpdateSources: { acme: "on" } } })).toEqual({ state: "manual", reasons: ["unencrypted-updates"] });
    expect(classify(facts({}, { http: true, acknowledgedUnencryptedUpdates: true }), { settings: { autoUpdateSources: { acme: "on" } } })).toEqual({ state: "automatic", reasons: [] });
    expect(classify(facts({}, { http: true, acknowledgedUnencryptedUpdates: true }))).toEqual({ state: "manual", reasons: ["switched-off"] });
  });
});

describe("required installs (§18.7.2)", () => {
  const required = (overrides: Partial<UpdateFacts> = {}) => facts({ required: true, ...overrides });

  it("apply with the switches off, a skipped version, a changed authority field, a switch, and after three failures", () => {
    const authority = [{ field: "authority.capabilities", checkpoint: "catalog" as const, before: [], after: ["files"] }];
    expect(classify(required({ consent: authority }), { policy: "user", settings: { autoUpdate: false, autoUpdatePackages: { notes: "off" } } })).toEqual({ state: "automatic", reasons: [] });
    expect(classify(required(), { policy: "off" })).toEqual({ state: "automatic", reasons: [] });
    expect(classify(required(), { skipped: true })).toEqual({ state: "automatic", reasons: [] });
    expect(classify(required({ change: "switch" }))).toEqual({ state: "automatic", reasons: [] });
    expect(classify(required(), { attempts: 5 })).toEqual({ state: "automatic", reasons: [] });
    expect(classify(required({ consent: [{ field: "mcpServer:search", checkpoint: "staged", before: "a".repeat(64), after: "b".repeat(64) }], unconfirmedApprovals: ["hook:0"] })))
      .toEqual({ state: "automatic", reasons: [] });
  });
});
