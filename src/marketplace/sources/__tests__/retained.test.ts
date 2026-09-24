import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginRegistryOrigins, retainedCommitsFrom } from "../retained.js";

describe("snapshot retention (design §2.3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-retained-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the snapshot commit of every git-installed plugin bound to the source", async () => {
    const registryPath = join(dir, "registry.json");
    const origin = (sourceId: string, commit: string) => ({
      sourceId,
      sourceOrigin: "custom",
      commit,
      packagePath: "plugins/x",
      version: "1.0.0",
      rung: "tree",
      artifactSha256: "d".repeat(64),
      installedAt: "2026-09-23T00:00:00.000Z",
    });
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: "alpha", manifestPath: "alpha/plugin.json", enabled: true, installSource: "user", origin: origin("acme", "a".repeat(40)) },
        { id: "beta", manifestPath: "beta/plugin.json", enabled: true, installSource: "user", origin: origin("ave", "b".repeat(40)) },
        { id: "gamma", manifestPath: "gamma/plugin.json", enabled: true, installSource: "user" },
      ],
    }));
    const other = async () => [{ kind: "mcp" as const, name: "scraper", sourceId: "acme", commit: "c".repeat(40) }];
    const retained = retainedCommitsFrom([pluginRegistryOrigins(registryPath), other]);
    expect([...await retained("acme")].sort()).toEqual(["a".repeat(40), "c".repeat(40)]);
    expect([...await retained("ave")]).toEqual(["b".repeat(40)]);
    expect([...await retained("corp")]).toEqual([]);
    // The revocation feed reads the same origins with the package each names.
    expect(await pluginRegistryOrigins(registryPath)()).toEqual([
      { kind: "plugin", name: "alpha", sourceId: "acme", commit: "a".repeat(40) },
      { kind: "plugin", name: "beta", sourceId: "ave", commit: "b".repeat(40) },
    ]);
  });
});
