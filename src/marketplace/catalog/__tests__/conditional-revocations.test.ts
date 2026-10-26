import { describe, expect, it } from "vitest";
import { normalizeRetiredPluginConfigRecord } from "../../../data/settings-normalization.js";
import { validateConditionalRevocationsText, validateRevocationsText } from "../validate.js";
import { effectiveRevocations } from "../effective-revocations.js";
import type { ConditionalRevocation } from "../types.js";
import { aggregateCatalog, findRevocation } from "../aggregate.js";
import { versionViews } from "../../app/views.js";
import type { SourceSnapshot } from "../../sources/snapshot.js";

const entry: ConditionalRevocation = {
  kind: "plugin", name: "retired-fixture", versions: "*", appVersions: "0.12.0",
  reason: "Replaced", at: "2026-09-26T00:00:00Z", action: "uninstall",
  successors: { plugins: [{ pluginId: "successor-fixture", anySource: true }], hostKinds: [
    { kind: "@host:due-soon", enabled: { key: "disabled", listed: "disabled", values: ["due"] } },
  ] },
};
const policy = (value: unknown) => JSON.stringify({ schemaVersion: 1, revocations: [value] });

describe("conditional revocation policy", () => {
  it("validates the sibling without expanding the legacy policy", () => {
    expect(validateConditionalRevocationsText(policy(entry))).toEqual({ ok: true, value: JSON.parse(policy(entry)) });
    expect(validateRevocationsText(policy(entry)).ok).toBe(false);
  });
  it.each([
    { appVersions: undefined }, { appVersions: ">=0.12.0" }, { appVersions: "0.12.00" },
    { appVersions: "0.12.0-beta.1" }, { successors: undefined }, { versions: "garbage" },
    { successors: { plugins: [{ pluginId: "successor-fixture", anySource: false }], hostKinds: [] } },
    { successors: { plugins: [], hostKinds: [{ kind: "fixture:due-soon", enabled: entry.successors.hostKinds[0]!.enabled }] } },
    { successors: { plugins: [], hostKinds: [{ kind: "@host:due-soon" }] } },
    { successors: { plugins: [], hostKinds: [{ kind: "@host:due-soon", enabled: { key: "disabled", listed: "disabled", values: [] } }] } },
    { unexpected: true },
  ])("rejects a malformed conditional entry %j", (patch) => {
    expect(validateConditionalRevocationsText(policy({ ...entry, ...patch })).ok).toBe(false);
  });
  it.each([
    ["constructor", false], ["prototype", false], ["__proto__", false], ["*", false], ["", false],
    [" successor-fixture", false], ["successor-fixture ", false], ["successor-fixture\n", false],
    ["plugin/child", false], ["1plugin", false], ["a".repeat(129), false],
    ["a", true], ["a".repeat(128), true], ["Legacy.Plugin_1", true], ["Constructor", true], ["successor-fixture", true],
  ])("aligns successor ID %j with persisted retirement records (%s)", (pluginId, accepted) => {
    const successors = { plugins: [{ pluginId }], hostKinds: [] };
    const record = normalizeRetiredPluginConfigRecord({ config: {}, enabled: true, sourceId: "fixture",
      retiredAtAppVersion: "0.12.0", successors, consumedBy: [] });
    expect(record !== undefined).toBe(accepted);
    expect(validateConditionalRevocationsText(policy({ ...entry, successors })).ok).toBe(accepted);
  });
  it("evaluates raw entries at read time across catalog and version views", () => {
    const snapshot: SourceSnapshot = {
      formatVersion: 2, sourceId: "fixture", commit: "a".repeat(40), fetchedAt: entry.at,
      marketplace: { name: "fixture", displayName: "Fixture" }, diagnostics: [], revocations: [], conditionalRevocations: [entry],
      packages: [{ kind: "plugin", name: entry.name, path: "plugins/retired-fixture", versions: [
        { version: "1.0.0", commit: "a".repeat(40), minAppVersion: "0.10.0", hostProtocol: "4", publishedAt: entry.at },
      ] }],
    };
    for (const [appVersion, revoked] of [["0.11.0", false], ["0.12.0", true], ["0.13.0", true]] as const) {
      const context = { appVersion, platform: process.platform, installationId: "fixture", canaryOptIn: false };
      const effective = effectiveRevocations(snapshot, appVersion);
      expect(effective).toEqual(revoked ? [entry] : []);
      const [row] = aggregateCatalog([{ sourceId: "fixture", sourceOrigin: "custom", snapshot }], context);
      expect(row!.choice.state).toBe(revoked ? "unavailable" : "candidate");
      expect(versionViews(row!, effective, context, null)[0]!.excluded).toEqual(revoked ? ["revoked"] : []);
    }
    expect(snapshot.conditionalRevocations).toEqual([entry]);
    const { formatVersion: _format, conditionalRevocations: _conditional, ...legacy } = snapshot;
    expect(effectiveRevocations(legacy, "0.15.0")).toEqual([]);
  });
});


describe("overlapping revocation rules", () => {
  it.each(["disable", "uninstall"] as const)("preserves successors alongside an unconditional %s in either order", (action) => {
    const { successors: _successors, appVersions: _appVersions, ...plain } = entry;
    const unconditional = { ...plain, action, reason: "Security policy" };
    for (const rules of [[unconditional, entry], [entry, unconditional]]) {
      expect(findRevocation("plugin", entry.name, "1.0.0", rules)).toMatchObject({ action: "uninstall", successors: entry.successors });
    }
  });
  it("uses metadata from a conditional disable without weakening an unconditional uninstall", () => {
    const { successors: _successors, appVersions: _appVersions, ...plain } = entry;
    expect(findRevocation("plugin", entry.name, "1.0.0", [plain, { ...entry, action: "disable" }])).toEqual({ ...plain, successors: entry.successors });
  });
  it("accepts schema-parsed successor objects with reordered keys recursively", () => {
    const reordered = { ...entry, appVersions: "0.13.0", successors: {
      hostKinds: [{ enabled: { values: ["due"], listed: "disabled", key: "disabled" }, kind: "@host:due-soon" }],
      plugins: [{ anySource: true, pluginId: "successor-fixture" }],
    } };
    const parsed = validateConditionalRevocationsText(JSON.stringify({ schemaVersion: 1, revocations: [entry, reordered] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    for (const rules of [parsed.value.revocations, [...parsed.value.revocations].reverse()]) {
      expect(findRevocation("plugin", entry.name, "1.0.0", rules)).toMatchObject({ action: "uninstall", successors: entry.successors });
    }
  });
  it.each(["plugin-id", "any-source", "plugin-order"])("rejects different successor declarations: %s", (difference) => {
    const plugins = [{ pluginId: "successor-fixture", anySource: true as const }, { pluginId: "second-fixture" }];
    const changed = difference === "plugin-id" ? [{ pluginId: "other-fixture" }, plugins[1]!]
      : difference === "any-source" ? [{ pluginId: "successor-fixture" }, plugins[1]!]
        : [...plugins].reverse();
    const rules = [
      { ...entry, successors: { plugins, hostKinds: [] } },
      { ...entry, successors: { plugins: changed, hostKinds: [] } },
    ];
    expect(() => findRevocation("plugin", entry.name, "1.0.0", rules)).toThrow("Conflicting plugin retirement entries");
  });
  it("only combines rules matching the installed version and rejects conflicting successors", () => {
    const { successors: _successors, appVersions: _appVersions, ...plain } = entry;
    const disable = { ...plain, action: "disable" as const };
    expect(findRevocation("plugin", entry.name, "1.0.0", [disable, { ...entry, versions: ">=2.0.0" }])).toEqual(disable);
    expect(() => findRevocation("plugin", entry.name, "1.0.0", [entry, { ...entry, successors: { plugins: [], hostKinds: [] } }])).toThrow("Conflicting plugin retirement entries");
  });
});
