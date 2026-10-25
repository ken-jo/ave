// Seed fixture manifests, receipts and registry entries through one shared installer.
// Include every shipped file in the receipt.
import path from "node:path";
import fs from "node:fs";
import {
  hashReceiptFiles,
  writeInstallReceipt,
} from "../../../src/plugins/plugin-install-receipt.js";
import { agentPluginsDocument } from "../../../src/plugins/__tests__/test-helpers.js";

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
  files: Readonly<Record<string, string>>;
}

export interface FixtureRegistryEntry {
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: "local-dev";
  approvedPluginAccess?: unknown;
}

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
