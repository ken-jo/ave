import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../../../marketplace/sources/snapshot.js";
import { pinnedArtifactSha256s } from "../../../marketplace/sources/snapshot.js";
import type { PluginRegistryEntryOrigin } from "../../types.js";
import { evaluateHostSecretGrant, HOST_SECRET_GRANTS, type HostSecretGrantInput } from "../grants.js";

const PIN = "a".repeat(64);
const MANIFEST = "m".repeat(64);

const origin = (patch: Partial<PluginRegistryEntryOrigin> = {}): PluginRegistryEntryOrigin => ({
  sourceId: "ave",
  sourceOrigin: "official",
  commit: "c".repeat(40),
  packagePath: "plugins/meeting",
  version: "2.1.0",
  rung: "release",
  artifactSha256: PIN,
  installedAt: "2026-09-23T00:00:00.000Z",
  ...patch,
});

const input = (patch: Partial<HostSecretGrantInput> = {}): HostSecretGrantInput => ({
  pluginId: "meeting",
  key: "llm.apiKey.openai",
  entry: { origin: origin(), manifestSha256: MANIFEST },
  runningManifestSha256: MANIFEST,
  receiptArtifactSha256: null,
  officialPins: [PIN],
  allowlist: ["llm.apiKey.openai", "llm.apiKey.claude"],
  activeProvider: "openai",
  ...patch,
});

describe("host-secret grants (design §10.3)", () => {
  it("names only the app's granted plugins and keys", () => {
    expect(HOST_SECRET_GRANTS.map((grant) => grant.plugin)).toEqual(["meeting", "local-indexer"]);
    expect(evaluateHostSecretGrant(input())).toEqual({ granted: true });
    expect(evaluateHostSecretGrant(input({ pluginId: "local-indexer", entry: { origin: origin({ packagePath: "plugins/local-indexer" }), manifestSha256: MANIFEST } }))).toEqual({ granted: true });
    expect(evaluateHostSecretGrant(input({ pluginId: "notes" }))).toEqual({ granted: false, reason: "not-in-grant-table" });
    expect(evaluateHostSecretGrant(input({ key: "llm.apiKey.copilot", activeProvider: "copilot", allowlist: ["llm.apiKey.copilot"] }))).toEqual({
      granted: false,
      reason: "not-in-grant-table",
    });
  });

  it.each([
    ["a custom origin", { entry: { origin: origin({ sourceId: "acme", sourceOrigin: "custom" }), manifestSha256: MANIFEST } }, "not-official"],
    ["a managed origin", { entry: { origin: origin({ sourceId: "corp", sourceOrigin: "managed" }), manifestSha256: MANIFEST } }, "not-official"],
    ["an official-looking origin under another id", { entry: { origin: origin({ sourceId: "ave-mirror" }), manifestSha256: MANIFEST } }, "not-official"],
    ["no origin", { entry: { manifestSha256: MANIFEST } }, "not-official"],
    ["a tree install", { entry: { origin: origin({ rung: "tree" }), manifestSha256: MANIFEST } }, "tree-install"],
    ["a different artifact hash", { entry: { origin: origin({ artifactSha256: "b".repeat(64) }), manifestSha256: MANIFEST } }, "artifact-not-pinned"],
    ["a version the snapshot does not pin", { officialPins: [] }, "artifact-not-pinned"],
    ["a swapped manifest", { runningManifestSha256: "x".repeat(64) }, "manifest-sha-mismatch"],
    ["no manifest pin", { entry: { origin: origin() } }, "manifest-sha-mismatch"],
    ["a key the manifest does not allow", { allowlist: ["llm.apiKey.claude"] }, "not-allowlisted"],
    ["another active vendor", { activeProvider: "claude" }, "vendor-mismatch"],
  ] as Array<[string, Partial<HostSecretGrantInput>, string]>)("refuses %s", (_label, patch, reason) => {
    expect(evaluateHostSecretGrant(input(patch))).toEqual({ granted: false, reason });
  });

  it("uses the receipt hash for a legacy entry", () => {
    const legacy = { entry: { origin: origin({ rung: "legacy", artifactSha256: null }), manifestSha256: MANIFEST } };
    expect(evaluateHostSecretGrant(input({ ...legacy, receiptArtifactSha256: PIN }))).toEqual({ granted: true });
    expect(evaluateHostSecretGrant(input({ ...legacy, receiptArtifactSha256: "b".repeat(64) }))).toEqual({ granted: false, reason: "artifact-not-pinned" });
    expect(evaluateHostSecretGrant(input({ ...legacy, receiptArtifactSha256: null }))).toEqual({ granted: false, reason: "artifact-not-pinned" });
  });

  it("reads the pins the official snapshot declares for the installed version", () => {
    const snapshot = {
      packages: [
        {
          kind: "plugin",
          name: "meeting",
          path: "plugins/meeting",
          versions: [
            { version: "2.1.0", artifact: { release: { repo: "ave/meeting", sha256: PIN.toUpperCase() }, archive: { url: "https://x.example/m.zip", sha256: "d".repeat(64) } } },
            { version: "2.0.0", artifact: { tree: "plugins/meeting" } },
          ],
        },
      ],
    } as unknown as SourceSnapshot;
    expect(pinnedArtifactSha256s(snapshot, "meeting", "2.1.0")).toEqual([PIN, "d".repeat(64)]);
    expect(pinnedArtifactSha256s(snapshot, "meeting", "2.0.0")).toEqual([]);
    expect(pinnedArtifactSha256s(snapshot, "local-indexer", "2.1.0")).toEqual([]);
  });
});
