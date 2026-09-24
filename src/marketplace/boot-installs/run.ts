/**
 * Default and required installs at boot (design §10.2).
 *
 * Required installs (policy `requiredInstalls`, official or managed sources
 * only) are brought to the source's candidate every boot: installed when
 * absent, updated when the bound source offers a newer version, and switched
 * to the listed source when the user installed the name from another one.
 * The policy file stands for the consent.
 *
 * Default installs (the app's DEFAULT_INSTALLS and policy `defaultInstalls`)
 * are installed once. A key is recorded when it is installed, found already
 * installed, or its package is missing or incompatible (skipped); a recorded
 * key is never tried again. A key whose source has no snapshot yet (the
 * first boot offline), whose versions are only held back by a rollout or as
 * pre-releases, or whose install failed stays unrecorded and is tried at the
 * next boot.
 *
 * Installing is the caller's: `install` runs the normal plan (ladder,
 * verification, receipt). Nothing here decides consent or reads the network.
 */
import { errorMessage } from "../../shared/error-message.js";
import { bootInstallNoticeIsEmpty, type BootInstallNoticeView, type PackageKeyView, type RevokedPackageView } from "../../shared/git-marketplace.js";
import { MarketplaceError } from "../errors.js";
import type { CatalogRow } from "../catalog/aggregate.js";
import type { PackageKind } from "../catalog/types.js";
import type { LegacyPluginReport } from "../migration/legacy-plugins.js";
import { updateFor, type InstalledPackage } from "../resolve/identity.js";
import type { MarketplacePolicy, PackageKey } from "../sources/policy.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { AppliedDefaults } from "./applied.js";
import { packageKeyId } from "./default-installs.js";

export interface BootInstallInput {
  policy: MarketplacePolicy;
  /** The app's list (DEFAULT_INSTALLS). */
  defaults: readonly PackageKey[];
  rows: readonly CatalogRow[];
  /** Sources that have a snapshot now, with their origin. */
  synced: ReadonlyMap<string, SourceOrigin>;
  installed(kind: PackageKind, name: string): Promise<InstalledPackage | null>;
  install(row: CatalogRow, options: { switchSource: boolean; required: boolean }): Promise<void>;
  applied: AppliedDefaults;
  now(): Date;
}

export interface BootInstallReport {
  /** Installed for the first time (default or required). */
  installed: PackageKey[];
  /** Required packages moved to a newer version. */
  updated: PackageKey[];
  /** Required packages moved to the listed source (plugin data kept). */
  switched: PackageKey[];
  skipped: Array<{ key: PackageKey; reason: string }>;
  failed: Array<{ key: PackageKey; message: string }>;
}

const LISTABLE_ORIGINS = new Set<SourceOrigin>(["official", "managed"]);

/**
 * The notice the boot-install step publishes (design §15.1): the default
 * installs, which are the user's now, apart from what the policy requires and
 * moved; null when the boot changed nothing.
 */
export function bootInstallNoticeFrom(
  report: BootInstallReport,
  policy: MarketplacePolicy,
  legacy: Pick<LegacyPluginReport, "unmanaged" | "lostGrants"> | null,
  revoked: readonly RevokedPackageView[],
): BootInstallNoticeView | null {
  const view = (key: PackageKey): PackageKeyView => ({ sourceId: key.source, kind: key.kind, name: key.name });
  const required = (key: PackageKey) => requiredByPolicy(policy, key.kind, key.name) !== undefined;
  const forYou = report.installed.filter((key) => !required(key)).map(view);
  const requiredKeys = [...report.installed.filter(required), ...report.updated, ...report.switched].map(view);
  const unmanaged = [...(legacy?.unmanaged ?? [])];
  const lostGrants = (legacy?.lostGrants ?? []).map((item) => ({ plugin: item.plugin, keys: [...item.keys] }));
  const notice = { forYou, required: requiredKeys, unmanaged, lostGrants, revoked: revoked.map((item) => ({ ...item, key: { ...item.key } })) };
  return bootInstallNoticeIsEmpty(notice) ? null : notice;
}

/** The requiredInstalls entry naming `(kind, name)`, if any, whichever source it names. */
export function requiredByPolicy(policy: Pick<MarketplacePolicy, "requiredInstalls">, kind: PackageKind, name: string): PackageKey | undefined {
  return policy.requiredInstalls.find((key) => key.kind === kind && key.name === name);
}

/**
 * The requiredInstalls entry that locks `(kind, name)` as bound to
 * `sourceId`, if any. An entry locks only the package it names: that kind
 * and name from its source (design §10.2). A same-named package bound to
 * another source is not the required one; the boot pass replaces it.
 */
export function lockedByPolicy(policy: Pick<MarketplacePolicy, "requiredInstalls">, kind: PackageKind, name: string, sourceId: string | null): PackageKey | undefined {
  const key = requiredByPolicy(policy, kind, name);
  return key && key.source === sourceId ? key : undefined;
}

/** Why a locked package cannot be uninstalled or disabled (PACKAGE_REQUIRED_BY_POLICY). */
export function requiredByPolicyReason(kind: PackageKind, name: string, key: PackageKey, action: "uninstall" | "disable"): string {
  return `${kind} ${name} is required by policy (source ${key.source}); it cannot ${action === "uninstall" ? "be uninstalled" : "be disabled"}`;
}

/** Refuse to uninstall or disable a package a `requiredInstalls` entry locks ({@link lockedByPolicy}). */
export function assertNotRequiredByPolicy(
  policy: Pick<MarketplacePolicy, "requiredInstalls">,
  kind: PackageKind,
  name: string,
  sourceId: string | null,
  action: "uninstall" | "disable",
): void {
  const key = lockedByPolicy(policy, kind, name, sourceId);
  if (key) throw new MarketplaceError("PACKAGE_REQUIRED_BY_POLICY", requiredByPolicyReason(kind, name, key, action));
}

function rowFor(rows: readonly CatalogRow[], key: PackageKey): CatalogRow | undefined {
  return rows.find((row) => row.sourceId === key.source && row.kind === key.kind && row.name === key.name);
}

async function required(key: PackageKey, input: BootInstallInput, report: BootInstallReport): Promise<void> {
  const origin = input.synced.get(key.source);
  if (!origin) {
    report.skipped.push({ key, reason: `source ${key.source} has no snapshot yet` });
    return;
  }
  if (!LISTABLE_ORIGINS.has(origin)) {
    report.skipped.push({ key, reason: `source ${key.source} is neither official nor managed` });
    return;
  }
  const row = rowFor(input.rows, key);
  if (!row) {
    report.skipped.push({ key, reason: `${key.source} does not list ${key.kind} ${key.name}` });
    return;
  }
  const current = await input.installed(key.kind, key.name);
  let outcome: "installed" | "updated" | "switched";
  if (!current) {
    outcome = "installed";
  } else if (current.sourceId !== key.source) {
    outcome = "switched";
  } else {
    if (current.version === null) {
      outcome = "updated";
    } else {
      const state = updateFor({ ...current, version: current.version }, input.rows, new Set(input.synced.keys()));
      if (state.state !== "update") {
        if (state.state === "upgrade_required") report.skipped.push({ key, reason: `the update needs Ave ${state.minAppVersion}` });
        return;
      }
      outcome = "updated";
    }
  }
  if (row.choice.state !== "candidate") {
    report.skipped.push({ key, reason: row.choice.state === "upgrade_required" ? `needs Ave ${row.choice.minAppVersion}` : "no version is offered to this installation" });
    return;
  }
  try {
    await input.install(row, { switchSource: outcome === "switched", required: true });
    report[outcome].push(key);
  } catch (error) {
    report.failed.push({ key, message: errorMessage(error) });
  }
}

async function byDefault(key: PackageKey, input: BootInstallInput, report: BootInstallReport): Promise<void> {
  if (input.applied.has(key)) return;
  const origin = input.synced.get(key.source);
  if (!origin) return; // no snapshot yet: try again next boot
  const skip = async (reason: string) => {
    await input.applied.record(key, "skipped", input.now(), reason);
    report.skipped.push({ key, reason });
  };
  if (!LISTABLE_ORIGINS.has(origin)) return skip(`source ${key.source} is neither official nor managed`);
  const current = await input.installed(key.kind, key.name);
  if (current) {
    if (current.sourceId === key.source) {
      await input.applied.record(key, "installed", input.now());
      return;
    }
    return skip(current.sourceId === null ? "already installed without a source" : `already installed from ${current.sourceId}`);
  }
  const row = rowFor(input.rows, key);
  if (!row) return skip(`${key.source} does not list ${key.kind} ${key.name}`);
  if (row.choice.state === "unavailable" && row.choice.reason === "pending") {
    // A rollout or a pre-release holds it back for now: not a permanent skip (§10.2).
    report.skipped.push({ key, reason: "not offered to this installation yet (rollout or pre-release)" });
    return;
  }
  if (row.choice.state !== "candidate") {
    return skip(row.choice.state === "upgrade_required" ? `needs Ave ${row.choice.minAppVersion}` : "no version is offered to this installation");
  }
  try {
    await input.install(row, { switchSource: false, required: false });
  } catch (error) {
    report.failed.push({ key, message: errorMessage(error) });
    return;
  }
  await input.applied.record(key, "installed", input.now());
  report.installed.push(key);
}

export async function runBootInstalls(input: BootInstallInput): Promise<BootInstallReport> {
  const report: BootInstallReport = { installed: [], updated: [], switched: [], skipped: [], failed: [] };
  const requiredIds = new Set(input.policy.requiredInstalls.map(packageKeyId));
  for (const key of input.policy.requiredInstalls) await required(key, input, report);
  const seen = new Set<string>();
  for (const key of [...input.defaults, ...input.policy.defaultInstalls]) {
    const id = packageKeyId(key);
    if (seen.has(id) || requiredIds.has(id)) continue;
    seen.add(id);
    await byDefault(key, input, report);
  }
  return report;
}
