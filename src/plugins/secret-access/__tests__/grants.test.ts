import { describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "../../../marketplace/sources/snapshot.js";
import { pinnedArtifactSha256s } from "../../../marketplace/sources/snapshot.js";
import type { PluginRegistryEntryOrigin } from "../../types.js";
import { evaluateHostSecretGrant, HOST_SECRET_GRANTS, type HostSecretGrantEvidence, type HostSecretGrantInput } from "../grants.js";

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

function evidence(patch: Partial<HostSecretGrantEvidence> = {}): HostSecretGrantEvidence {
  return {
    officialPins: vi.fn(async (plugin: string, version: string) => ((plugin === "meeting" || plugin === "local-indexer") && version === "2.1.0" ? [PIN] : [])),
    receiptArtifactSha256: vi.fn(async () => null),
    ...patch,
  };
}

const input = (patch: Partial<HostSecretGrantInput> = {}): HostSecretGrantInput => ({
  pluginId: "meeting",
  key: "llm.apiKey.openai",
  entry: { origin: origin(), manifestSha256: MANIFEST },
  runningManifestSha256: MANIFEST,
  evidence: evidence(),
  ...patch,
});

describe("host-secret grants (design §10.3)", () => {
  it("names only the app's granted plugins and keys", async () => {
    expect(HOST_SECRET_GRANTS.map((grant) => grant.plugin)).toEqual(["meeting", "local-indexer"]);
    await expect(evaluateHostSecretGrant(input())).resolves.toEqual({ granted: true });
    await expect(evaluateHostSecretGrant(input({ pluginId: "local-indexer", entry: { origin: origin({ packagePath: "plugins/local-indexer" }), manifestSha256: MANIFEST } }))).resolves.toEqual({ granted: true });
    await expect(evaluateHostSecretGrant(input({ pluginId: "notes" }))).resolves.toEqual({ granted: false, reason: "not-in-grant-table" });
    await expect(evaluateHostSecretGrant(input({ key: "llm.apiKey.copilot" }))).resolves.toEqual({ granted: false, reason: "not-in-grant-table" });
  });

  it.each([
    ["a custom origin", { entry: { origin: origin({ sourceId: "acme", sourceOrigin: "custom" }), manifestSha256: MANIFEST } }, "not-official"],
    ["a managed origin", { entry: { origin: origin({ sourceId: "corp", sourceOrigin: "managed" }), manifestSha256: MANIFEST } }, "not-official"],
    ["an official-looking origin under another id", { entry: { origin: origin({ sourceId: "ave-mirror" }), manifestSha256: MANIFEST } }, "not-official"],
    ["no origin", { entry: { manifestSha256: MANIFEST } }, "not-official"],
    ["no registry entry", { entry: undefined }, "not-official"],
    ["a tree install", { entry: { origin: origin({ rung: "tree" }), manifestSha256: MANIFEST } }, "tree-install"],
    ["a swapped manifest", { runningManifestSha256: "x".repeat(64) }, "manifest-sha-mismatch"],
    ["no manifest pin", { entry: { origin: origin() } }, "manifest-sha-mismatch"],
    ["a different artifact hash", { entry: { origin: origin({ artifactSha256: "b".repeat(64) }), manifestSha256: MANIFEST } }, "artifact-not-pinned"],
    ["a version the snapshot does not pin", { entry: { origin: origin({ version: "2.0.0" }), manifestSha256: MANIFEST } }, "artifact-not-pinned"],
  ] as Array<[string, Partial<HostSecretGrantInput>, string]>)("refuses %s", async (_label, patch, reason) => {
    await expect(evaluateHostSecretGrant(input(patch))).resolves.toEqual({ granted: false, reason });
  });

  it("reads no evidence for a plugin a cheaper condition already refuses", async () => {
    const reads = evidence();
    await evaluateHostSecretGrant(input({ pluginId: "notes", evidence: reads }));
    await evaluateHostSecretGrant(input({ runningManifestSha256: "x".repeat(64), evidence: reads }));
    expect(reads.officialPins).not.toHaveBeenCalled();
    expect(reads.receiptArtifactSha256).not.toHaveBeenCalled();
  });

  it("uses the verified receipt hash for a legacy entry", async () => {
    const legacy = { entry: { origin: origin({ rung: "legacy", artifactSha256: null }), manifestSha256: MANIFEST } };
    await expect(evaluateHostSecretGrant(input({ ...legacy, evidence: evidence({ receiptArtifactSha256: async () => PIN.toUpperCase() }) }))).resolves.toEqual({ granted: true });
    await expect(evaluateHostSecretGrant(input({ ...legacy, evidence: evidence({ receiptArtifactSha256: async () => "b".repeat(64) }) }))).resolves.toEqual({ granted: false, reason: "artifact-not-pinned" });
    await expect(evaluateHostSecretGrant(input({ ...legacy, evidence: evidence({ receiptArtifactSha256: async () => null }) }))).resolves.toEqual({ granted: false, reason: "artifact-not-pinned" });
  });

  it("refuses, and does not throw, when the evidence cannot be read", async () => {
    const broken = evidence({
      officialPins: async () => {
        throw new Error("snapshot abc.json of ave names other@abc");
      },
    });
    await expect(evaluateHostSecretGrant(input({ evidence: broken }))).resolves.toEqual({ granted: false, reason: "evidence-unreadable" });
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
