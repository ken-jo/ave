/**
 * The first-boot migration of plugins installed before the git marketplace
 * (design §16.3). It reinstalls nothing and reads only what is on disk: the
 * registry, each install receipt, and the official snapshot.
 *
 *   - An entry whose id the official snapshot lists is bound to `ave` with
 *     `rung: "legacy"` and no digest; its next update installs through the
 *     ladder and fills the origin.
 *   - A granted plugin (§10.3) keeps its grant only when its receipt's
 *     `artifactSha256` is a pin the official index lists for the installed
 *     version; otherwise the report names the keys it lost.
 *   - `installSource: "admin"` becomes `user`. A bound one is recorded as an
 *     applied default install, so nothing reinstalls or removes it.
 *   - An entry the official snapshot does not list is named as no longer
 *     managed (and, if an administrator installed it, unlocked).
 *
 * Entries that already carry an origin and local-dev entries are left alone,
 * so a second run changes nothing. An entry whose interrupted update boot
 * recovery could not resolve is reported as failed, so the migration runs
 * again once it is.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "../../shared/error-message.js";
import { flattenAgentPluginsManifest } from "../../plugins/public-contract.js";
import { verifyInstallReceipt } from "../../plugins/plugin-install-receipt.js";
import type { PluginPaths } from "../../plugins/plugin-paths.js";
import { readPluginRegistry, updatePluginRegistry } from "../../plugins/registry.js";
import { HOST_SECRET_GRANTS } from "../../plugins/secret-access/grants.js";
import type { PluginRegistryEntry, PluginRegistryEntryOrigin } from "../../plugins/types.js";
import type { AppliedDefaults } from "../boot-installs/applied.js";

/** What the official snapshot says about one plugin, for binding and grants. */
export interface OfficialPlugin {
  /** The snapshot commit the row was read from; the origin keeps it. */
  snapshotCommit: string;
  packagePath: string;
  /** Every sha256 the index pins for `version` (release, archive); empty when it lists none. */
  pins(version: string): readonly string[];
}

export interface LegacyPluginMigrationInput {
  paths: Pick<PluginPaths, "registryPath" | "cacheRoot">;
  /** The official snapshot's plugin of this name, or null when it lists none. */
  officialPlugin(name: string): OfficialPlugin | null;
  applied: AppliedDefaults;
  now: () => Date;
  log: { warn(message: string): void };
}

export interface LegacyPluginReport {
  bound: string[];
  /** Entries the official snapshot does not list: no updates (a former admin install is unlocked too). */
  unmanaged: string[];
  /** Granted plugins whose receipt matches no official pin: the keys they no longer read. */
  lostGrants: Array<{ plugin: string; keys: string[] }>;
  /** Entries that could not be read this time; the migration runs again for them. */
  failed: Array<{ plugin: string; message: string }>;
}

interface Step {
  id: string;
  manifestPath: string;
  /** Null: the official snapshot does not list it. */
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
      const receipt = await verifyInstallReceipt(input.paths.cacheRoot, entry.id, dirname(entry.manifestPath));
      const version = receipt.ok ? receipt.receipt.version : await manifestVersion(entry.manifestPath);
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
        // The registry already changed, so a throw here would lose this run's
        // notice. A default install left unrecorded is recorded by the boot
        // installs, which find it installed from ave.
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
