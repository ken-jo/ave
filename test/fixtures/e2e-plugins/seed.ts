/**
 * Install an in-repository fixture plugin into an isolated Ave home, the way
 * a local-dev install lands: the Agent Plugins manifest, every file the plugin
 * ships, an install receipt over all of them, and the registry row.
 *
 * One writer for every harness that seeds a plugin (the Playwright suite and
 * the screenshot harness), so the receipt rules — the host rejects a payload
 * with any file the receipt does not list — are applied in one place.
 */
import path from "node:path";
import fs from "node:fs";
import {
  hashReceiptFiles,
  writeInstallReceipt,
} from "../../../src/plugins/plugin-install-receipt.js";
import { agentPluginsDocument } from "../../../src/plugins/__tests__/test-helpers.js";

/** The flat manifest fields the seeder reads; the rest pass through. */
export interface FixtureManifest {
  readonly [field: string]: unknown;
  id: string;
  version: string;
  entry: string;
  tools: unknown[];
  pluginAccess?: unknown;
}

export interface FixturePlugin {
  manifest: FixtureManifest;
  /** Every file the plugin ships besides plugin.json, by path relative to it. */
  files: Readonly<Record<string, string>>;
}

export interface FixtureRegistryEntry {
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: "local-dev";
  approvedPluginAccess?: unknown;
}

/** Write one fixture plugin and its receipt under `<aveHome>/plugins`. */
export async function writeFixturePlugin(
  aveHome: string,
  plugin: FixturePlugin,
): Promise<FixtureRegistryEntry> {
  const { manifest, files } = plugin;
  if (!(manifest.entry in files)) {
    throw new Error(`[fixture-plugins] ${manifest.id} does not ship its entry ${manifest.entry}`);
  }
  const pluginsRoot = path.join(aveHome, "plugins");
  const pluginDir = path.join(pluginsRoot, manifest.id);
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    `${JSON.stringify(agentPluginsDocument(manifest), null, 2)}\n`,
    "utf-8",
  );
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(pluginDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, source, "utf-8");
  }
  await writeInstallReceipt(path.join(pluginsRoot, ".cache"), {
    schemaVersion: 3,
    pluginId: manifest.id,
    version: manifest.version,
    installSource: "local-dev",
    artifactSha256: null,
    signerKeyId: null,
    admission: null,
    installedAt: new Date().toISOString(),
    files: await hashReceiptFiles(pluginDir, ["plugin.json", ...Object.keys(files)]),
  });
  return {
    id: manifest.id,
    manifestPath: `${manifest.id}/plugin.json`,
    enabled: true,
    installSource: "local-dev",
    ...(manifest.pluginAccess === undefined ? {} : { approvedPluginAccess: manifest.pluginAccess }),
  };
}

/** Write the plugin registry for exactly these entries (an empty list is valid). */
export function writeFixtureRegistry(
  aveHome: string,
  entries: readonly FixtureRegistryEntry[],
): void {
  const pluginsRoot = path.join(aveHome, "plugins");
  fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(pluginsRoot, "registry.json"),
    `${JSON.stringify({ version: 1, plugins: entries }, null, 2)}\n`,
    "utf-8",
  );
}
