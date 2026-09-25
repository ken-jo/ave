/**
 * Boot feeds the revocation registry from the snapshots on disk before any
 * plugin loads (design §10.4): each installed package gets its own bound
 * source's revocations, read at that source's pin.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedRevocationsFromSnapshots } from "../steps/revocation-bootstrap.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";

const PIN = "a".repeat(40);

describe("feedRevocationsFromSnapshots", () => {
  let home: string;
  const audit = { log: vi.fn() };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ave-revocation-boot-"));
    audit.log.mockClear();
  });

  afterEach(() => {
    revocationRegistry.resetForTesting();
    rmSync(home, { recursive: true, force: true });
  });

  const origin = (sourceId: string) => ({
    sourceId,
    sourceOrigin: "custom",
    commit: PIN,
    packagePath: "plugins/x",
    version: "1.0.0",
    rung: "tree",
    artifactSha256: "d".repeat(64),
    installedAt: "2026-09-23T00:00:00.000Z",
  });

  function writeSource(id: string, revocations: unknown[]) {
    const dir = join(home, "marketplaces", id);
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ pinnedCommit: PIN, enabled: true }));
    writeFileSync(
      join(dir, "snapshots", `${PIN}.json`),
      JSON.stringify({ sourceId: id, commit: PIN, fetchedAt: "2026-09-24T00:00:00.000Z", marketplace: { name: id, displayName: id }, packages: [], revocations, diagnostics: [] }),
    );
  }

  function writePlugins(): string {
    const registryPath = join(home, "plugins", "registry.json");
    mkdirSync(join(home, "plugins"), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: "meeting", manifestPath: "meeting/plugin.json", enabled: true, installSource: "user", origin: origin("acme") },
        { id: "orion", manifestPath: "orion/plugin.json", enabled: true, installSource: "user", origin: origin("ave") },
        { id: "sideloaded", manifestPath: "sideloaded/plugin.json", enabled: true, installSource: "user" },
      ],
    }));
    return registryPath;
  }

  const bad = (name: string, source: string) => ({ kind: "plugin", name, versions: "<2.0.0", reason: `${name} revoked by ${source}`, at: "2026-09-24T00:00:00Z", action: "disable" });

  it("blocks an installed plugin only by the source it is bound to", async () => {
    const pluginRegistryPath = writePlugins();
    writeSource("acme", [bad("meeting", "acme"), bad("orion", "acme"), bad("sideloaded", "acme")]);
    writeSource("ave", []);

    await feedRevocationsFromSnapshots({ home, pluginRegistryPath, bootAuditLogger: audit as never });

    expect(revocationRegistry.evaluate("plugin", "meeting", "1.0.0")).toEqual({ kind: "block", sourceId: "acme", action: "disable", reason: "meeting revoked by acme" });
    expect(revocationRegistry.evaluate("plugin", "meeting", "2.0.0")).toEqual({ kind: "allow" });
    // `orion` is bound to ave, and a sideloaded plugin to no source: acme cannot revoke either.
    expect(revocationRegistry.evaluate("plugin", "orion", "1.0.0")).toEqual({ kind: "allow" });
    expect(revocationRegistry.evaluate("plugin", "sideloaded", "1.0.0")).toEqual({ kind: "allow" });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ input: "revocations_loaded rules=1 unreadable=0" }));
  });

  it("feeds what it can read when a snapshot is unreadable, and never throws", async () => {
    const pluginRegistryPath = writePlugins();
    writeSource("ave", [bad("orion", "ave")]);
    mkdirSync(join(home, "marketplaces", "acme"), { recursive: true });
    writeFileSync(join(home, "marketplaces", "acme", "state.json"), "{ not json");

    await expect(feedRevocationsFromSnapshots({ home, pluginRegistryPath, bootAuditLogger: audit as never })).resolves.toBeUndefined();

    expect(revocationRegistry.evaluate("plugin", "orion", "1.0.0")).toMatchObject({ kind: "block", sourceId: "ave" });
    expect(revocationRegistry.evaluate("plugin", "meeting", "1.0.0")).toEqual({ kind: "allow" });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ input: "revocations_loaded rules=1 unreadable=1" }));
  });

  it("reports a pinned source whose snapshot file is gone as unreadable, not as revoking nothing", async () => {
    const pluginRegistryPath = writePlugins();
    writeSource("ave", []);
    mkdirSync(join(home, "marketplaces", "acme"), { recursive: true });
    writeFileSync(join(home, "marketplaces", "acme", "state.json"), JSON.stringify({ pinnedCommit: PIN, enabled: true }));

    await feedRevocationsFromSnapshots({ home, pluginRegistryPath, bootAuditLogger: audit as never });

    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ input: "revocations_loaded rules=0 unreadable=1" }));
  });

  it("feeds an empty set on a fresh home, so the gates know they were fed", async () => {
    await feedRevocationsFromSnapshots({ home, pluginRegistryPath: join(home, "plugins", "registry.json"), bootAuditLogger: audit as never });
    expect(revocationRegistry.replace([])).toBe(false);
  });
});
