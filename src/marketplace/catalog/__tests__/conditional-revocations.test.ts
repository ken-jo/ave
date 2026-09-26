import { describe, expect, it } from "vitest";
import { validateConditionalRevocationsText, validateRevocationsText } from "../validate.js";
import { effectiveRevocations } from "../effective-revocations.js";
import type { ConditionalRevocation } from "../types.js";
import { aggregateCatalog } from "../aggregate.js";
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
  it("evaluates raw entries at read time across catalog and version views", () => {
    const snapshot: SourceSnapshot = {
      formatVersion: 2, sourceId: "fixture", commit: "a".repeat(40), fetchedAt: entry.at,
      marketplace: { name: "fixture", displayName: "Fixture" }, diagnostics: [], revocations: [], conditionalRevocations: [entry],
      packages: [{ kind: "plugin", name: entry.name, path: "plugins/retired-fixture", versions: [
        { version: "1.0.0", commit: "a".repeat(40), minAppVersion: "0.10.0", publishedAt: entry.at },
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
    expect(effectiveRevocations(legacy, "0.14.0")).toEqual([]);
  });
});
