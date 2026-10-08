import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import type { PackageKey } from "../../marketplace/sources/policy.js";
import { assertDisableAllowed, PluginDeploymentDeniedError, PluginDeploymentGuard } from "../deployment-guard.js";
import { agentPluginsDocument, writeTestPluginRegistry, type TestRegistryEntry } from "./test-helpers.js";

/**
 * Only the machine policy's `requiredInstalls` locks a plugin (design §10.1,
 * §10.2): an entry naming the plugin and the source it is bound to. No
 * manifest field and no registry `installSource` protects one.
 */
describe("PluginDeploymentGuard", () => {
  let testDir: string;
  let registryPath: string;
  let pluginsRoot: string;
  let required: PackageKey[];

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-guard-"));
    registryPath = join(testDir, "registry.json");
    pluginsRoot = join(testDir, "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    required = [];
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const guard = () => new PluginDeploymentGuard({ registryPath, pluginsRoot, requiredInstalls: async () => required });

  const origin = (sourceId: string) => ({
    sourceId,
    sourceOrigin: sourceId === "ave" ? "official" : "managed",
    commit: "c".repeat(40),
    packagePath: "plugins/wiki",
    version: "1.0.0",
    rung: "release",
    artifactSha256: "d".repeat(64),
    installedAt: "2026-09-24T00:00:00.000Z",
  });

  async function install(id: string, entry: Partial<TestRegistryEntry> = {}, manifest: Record<string, unknown> = {}): Promise<void> {
    const dir = join(pluginsRoot, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.json"), JSON.stringify(agentPluginsDocument({ id, name: id, version: "1.0.0", entry: "index.js", ...manifest })), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id, manifestPath: join(dir, "plugin.json"), ...entry }]);
  }

  it("locks a plugin a requiredInstalls entry names, from the source it is bound to", async () => {
    await install("wiki", { origin: origin("corp") });
    required = [{ kind: "plugin", name: "wiki", source: "corp" }];

    await expect(guard().canUninstall("wiki")).resolves.toEqual({
      allowed: false,
      reason: "plugin wiki is required by policy (source corp); it cannot be uninstalled",
    });
    await expect(guard().canDisable("wiki")).resolves.toEqual({
      allowed: false,
      reason: "plugin wiki is required by policy (source corp); it cannot be disabled",
    });
  });

  it("does not lock the same name bound to another source, or to none", async () => {
    required = [{ kind: "plugin", name: "wiki", source: "corp" }];
    await install("wiki", { origin: origin("ave") });
    await expect(guard().canUninstall("wiki")).resolves.toEqual({ allowed: true });
    await install("wiki");
    await expect(guard().canDisable("wiki")).resolves.toEqual({ allowed: true });
  });

  it("reads the policy at each check", async () => {
    await install("wiki", { origin: origin("corp") });
    const checking = guard();
    await expect(checking.canUninstall("wiki")).resolves.toEqual({ allowed: true });
    required = [{ kind: "plugin", name: "wiki", source: "corp" }];
    await expect(checking.canUninstall("wiki")).resolves.toMatchObject({ allowed: false });
  });

  it("grants nothing to a legacy admin entry or a manifest that still declares installPolicy", async () => {
    await install("meeting", { installSource: "admin" }, { installPolicy: "admin" });
    await expect(guard().canUninstall("meeting")).resolves.toEqual({ allowed: true });
    await expect(guard().canDisable("meeting")).resolves.toEqual({ allowed: true });
  });

  it("rejects an unknown plugin id with a not-found reason", async () => {
    await writeTestPluginRegistry({ registryPath }, []);
    await expect(guard().canUninstall("ghost")).resolves.toEqual({ allowed: false, reason: "Plugin not found: ghost" });
  });

  it("SECURITY_GATE: refuses an entry whose manifest is outside the plugins directory, including a prefix look-alike", async () => {
    for (const [id, manifestPath] of [
      ["spoof", join(testDir, "plugins-foo", "plugin.json")],
      ["escape", "elsewhere/plugin.json"],
    ] as const) {
      await writeTestPluginRegistry({ registryPath }, [{ id, manifestPath }]);
      const result = await guard().canUninstall(id);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/outside the plugins directory/);
    }
  });

  it("assertDisableAllowed throws the denial for a required plugin and passes an enable", async () => {
    await install("wiki", { origin: origin("corp") });
    required = [{ kind: "plugin", name: "wiki", source: "corp" }];
    await expect(assertDisableAllowed(false, "wiki", "wiki", guard())).rejects.toBeInstanceOf(PluginDeploymentDeniedError);
    await expect(assertDisableAllowed(true, "wiki", "wiki", guard())).resolves.toBeUndefined();
    await expect(assertDisableAllowed(false, null, "wiki", guard())).resolves.toBeUndefined();
  });
});
