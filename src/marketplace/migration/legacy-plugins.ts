/** Bind legacy plugins without reinstalling; retain grants only when receipt hashes match official pins.
 * Leave migrated and local entries untouched; retry unresolved recovery entries. */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "../../shared/error-message.js";
import { flattenAgentPluginsManifest } from "../../plugins/public-contract.js";
import { verifyInstallReceipt } from "../../plugins/plugin-install-receipt.js";
import type { PluginPaths } from "../../plugins/plugin-paths.js";
import { readPluginRegistry, updatePluginRegistry } from "../../plugins/registry.js";
import { resolveTrustedRegistryManifestPath } from "../../plugins/registry-manifest-trust.js";
import { HOST_SECRET_GRANTS } from "../../plugins/secret-access/grants.js";
import type { PluginRegistryEntry, PluginRegistryEntryOrigin } from "../../plugins/types.js";
import type { AppliedDefaults } from "../boot-installs/applied.js";

export interface OfficialPlugin {
  snapshotCommit: string;
  packagePath: string;
  pins(version: string): readonly string[];
}

export interface LegacyPluginMigrationInput {
  paths: Pick<PluginPaths, "registryPath" | "cacheRoot" | "pluginsRoot">;
  officialPlugin(name: string): OfficialPlugin | null;
  applied: AppliedDefaults;
  now: () => Date;
  log: { warn(message: string): void };
}

export interface LegacyPluginReport {
  bound: string[];
  unmanaged: string[];
  lostGrants: Array<{ plugin: string; keys: string[] }>;
  failed: Array<{ plugin: string; message: string }>;
}

interface Step {
  id: string;
  manifestPath: string;
  bind: PluginRegistryEntryOrigin | null;
  wasAdmin: boolean;
}

function migratable(entry: PluginRegistryEntry): boolean {
  return entry.origin === undefined && entry.installSource !== "local-dev" && entry.pendingUpdate === undefined;
}

async function manifestVersion(manifestPath: string): Promise<string> {
  const flat = flattenAgentPluginsManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown) as { version?: unknown };
  if (typeof flat.version !== "string" || flat.version.length === 0) throw new Error(`${manifestPath} has no version`);
  return flat.version;
}

export async function migrateLegacyPlugins(input: LegacyPluginMigrationInput): Promise<LegacyPluginReport> {
  const report: LegacyPluginReport = { bound: [], unmanaged: [], lostGrants: [], failed: [] };
  const registry = await readPluginRegistry(input.paths.registryPath);
  const steps: Step[] = [];
  for (const entry of registry.plugins) {
    if (entry.origin === undefined && entry.installSource !== "local-dev" && entry.pendingUpdate !== undefined) {
      report.failed.push({ plugin: entry.id, message: "an interrupted update is still pending recovery" });
      continue;
    }
    if (!migratable(entry)) continue;
    const official = input.officialPlugin(entry.id);
    if (!official) {
      steps.push({ id: entry.id, manifestPath: entry.manifestPath, bind: null, wasAdmin: entry.installSource === "admin" });
      continue;
    }
    try {
      const manifestPath = resolveTrustedRegistryManifestPath(entry.manifestPath, input.paths.pluginsRoot);
      if (manifestPath === null) throw new Error(`its manifest path ${entry.manifestPath} is missing or outside the plugins directory`);
      const receipt = await verifyInstallReceipt(input.paths.cacheRoot, entry.id, dirname(manifestPath));
      const version = receipt.ok ? receipt.receipt.version : await manifestVersion(manifestPath);
      const grant = HOST_SECRET_GRANTS.find((item) => item.plugin === entry.id);
      if (grant) {
        const sha = receipt.ok ? receipt.receipt.artifactSha256 : null;
        if (sha === null || !official.pins(version).includes(sha.toLowerCase())) {
          report.lostGrants.push({ plugin: entry.id, keys: [...grant.keys] });
        }
      }
      steps.push({
        id: entry.id,
        manifestPath: entry.manifestPath,
        wasAdmin: entry.installSource === "admin",
        bind: {
          sourceId: "ave",
          sourceOrigin: "official",
          commit: official.snapshotCommit,
          packagePath: official.packagePath,
          version,
          rung: "legacy",
          artifactSha256: null,
          installedAt: receipt.ok ? receipt.receipt.installedAt : input.now().toISOString(),
        },
      });
    } catch (error) {
      input.log.warn(`legacy plugin ${entry.id} not migrated this time: ${errorMessage(error)}`);
      report.failed.push({ plugin: entry.id, message: errorMessage(error) });
    }
  }
  if (steps.length === 0) return report;

  // Applied only to an entry still as it was read: an install in between wins.
  const applied = await updatePluginRegistry(input.paths.registryPath, (current) => {
    const done: Step[] = [];
    for (const step of steps) {
      const entry = current.plugins.find((item) => item.id === step.id);
      if (!entry || !migratable(entry) || entry.manifestPath !== step.manifestPath) continue;
      if (step.bind) entry.origin = step.bind;
      if (entry.installSource === "admin") entry.installSource = "user";
      done.push(step);
    }
    return done;
  });
  for (const step of applied) {
    if (step.bind) {
      report.bound.push(step.id);
      if (step.wasAdmin) {
        // Registry changes already committed; reporting a failure here would lose the migration notice.
        await input.applied.record({ kind: "plugin", name: step.id, source: "ave" }, "migrated", input.now()).catch((error: unknown) => {
          input.log.warn(`legacy plugin ${step.id}: recording it as an applied default failed: ${errorMessage(error)}`);
        });
      }
    } else {
      report.unmanaged.push(step.id);
    }
  }
  const kept = new Set(applied.filter((step) => step.bind).map((step) => step.id));
  report.lostGrants = report.lostGrants.filter((item) => kept.has(item.plugin));
  return report;
}
