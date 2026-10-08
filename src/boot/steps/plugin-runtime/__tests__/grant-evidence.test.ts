/**
 * What a host-secret grant reads from disk (design §10.3), against real files:
 * the official snapshot's pins at the source's current pin, and a legacy
 * install's verified receipt.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInstallReceipt, writeInstallReceipt } from "../../../../plugins/plugin-install-receipt.js";
import { grantEvidenceReader } from "../grant-evidence.js";

const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const PIN = "a".repeat(64);
const REPINNED = "b".repeat(64);

describe("grantEvidenceReader", () => {
  let root: string;
  let paths: { registryPath: string; cacheRoot: string; pluginsRoot: string };
  let marketplacesRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-grant-evidence-"));
    paths = { registryPath: join(root, "plugins", "registry.json"), cacheRoot: join(root, "plugins", ".cache"), pluginsRoot: join(root, "plugins") };
    marketplacesRoot = join(root, "marketplaces");
    mkdirSync(paths.pluginsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The official source pinned at `commit`, whose snapshot pins `sha` for meeting@1.0.0. */
  function pinOfficial(commit: string, sha: string): void {
    const dir = join(marketplacesRoot, "ave");
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ pinnedCommit: commit, enabled: true }));
    writeFileSync(
      join(dir, "snapshots", `${commit}.json`),
      JSON.stringify({
        sourceId: "ave",
        commit,
        fetchedAt: "2026-09-24T00:00:00.000Z",
        marketplace: { name: "ave", displayName: "Ave" },
        packages: [
          {
            kind: "plugin",
            name: "meeting",
            path: "plugins/meeting",
            versions: [{ version: "1.0.0", artifact: { release: { repo: "ave/meeting", sha256: sha } } }],
          },
        ],
        revocations: [],
        diagnostics: [],
      }),
    );
  }

  it("answers the pins at the official source's current pin, and follows it when it moves", async () => {
    const reader = grantEvidenceReader({ paths, marketplacesRoot });
    await expect(reader.officialPins("meeting", "1.0.0")).resolves.toEqual([]);

    pinOfficial(FIRST, PIN);
    await expect(reader.officialPins("meeting", "1.0.0")).resolves.toEqual([PIN]);
    await expect(reader.officialPins("meeting", "0.9.0")).resolves.toEqual([]);
    await expect(reader.officialPins("local-indexer", "1.0.0")).resolves.toEqual([]);

    pinOfficial(SECOND, REPINNED);
    await expect(reader.officialPins("meeting", "1.0.0")).resolves.toEqual([REPINNED]);
  });

  it("fails when the snapshot at the pin names another commit, rather than answering from it", async () => {
    pinOfficial(FIRST, PIN);
    writeFileSync(join(marketplacesRoot, "ave", "state.json"), JSON.stringify({ pinnedCommit: SECOND, enabled: true }));
    writeFileSync(join(marketplacesRoot, "ave", "snapshots", `${SECOND}.json`), JSON.stringify({ sourceId: "ave", commit: FIRST, packages: [] }));
    await expect(grantEvidenceReader({ paths, marketplacesRoot }).officialPins("meeting", "1.0.0")).rejects.toThrow(/names ave@/);
  });

  it("reads a legacy install's artifact hash from its verified receipt, found through the registry", async () => {
    const dir = join(paths.pluginsRoot, "meeting");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{}\n");
    const { receipt } = await buildInstallReceipt(dir, {
      pluginId: "meeting",
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: PIN,
      signerKeyId: "prod-v1",
      files: ["plugin.json"],
      installedAt: "2026-05-01T00:00:00.000Z",
    });
    await writeInstallReceipt(paths.cacheRoot, receipt);
    writeFileSync(paths.registryPath, JSON.stringify({ version: 1, plugins: [{ id: "meeting", manifestPath: "meeting/plugin.json", installSource: "user" }] }));
    const reader = grantEvidenceReader({ paths, marketplacesRoot });

    await expect(reader.receiptArtifactSha256("meeting")).resolves.toBe(PIN);
    await expect(reader.receiptArtifactSha256("orion")).resolves.toBeNull();

    // A payload that no longer matches its receipt proves nothing.
    writeFileSync(join(dir, "plugin.json"), "{\"tampered\":true}\n");
    await expect(reader.receiptArtifactSha256("meeting")).resolves.toBeNull();
  });

  it("finds no receipt for an entry whose manifest path leaves the plugins directory", async () => {
    writeFileSync(paths.registryPath, JSON.stringify({ version: 1, plugins: [{ id: "meeting", manifestPath: "../elsewhere/plugin.json", installSource: "user" }] }));
    await expect(grantEvidenceReader({ paths, marketplacesRoot }).receiptArtifactSha256("meeting")).resolves.toBeNull();
  });
});
