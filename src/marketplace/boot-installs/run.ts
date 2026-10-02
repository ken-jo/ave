/**
 * Default and required installs at boot (design §10.2).
 *
 * Required installs (policy `requiredInstalls`, official or managed sources
 * only) are installed here when absent: a first install replaces no running
 * generation, so it cannot interrupt a turn. Updating one, or switching it
 * to the listed source when the user installed the name from another one, is
 * the apply queue's (design §18.7.2): it waits for the conversation to pause
 * like every automatic update. The policy file stands for the consent.
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
import { bootInstallNoticeIsEmpty, type BootInstallNoticeView, type PackageKeyView, type RevokedPackageView, type UnmetRequirementReason } from "../../shared/git-marketplace.js";
import { MarketplaceError } from "../errors.js";
import type { CatalogRow } from "../catalog/aggregate.js";
import type { PackageKind } from "../catalog/types.js";
import type { LegacyPluginReport } from "../migration/legacy-plugins.js";
import type { InstalledPackage } from "../resolve/identity.js";
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
  /** Whether the app has a source of this id at all. */
  known(sourceId: string): boolean;
  installed(kind: PackageKind, name: string): Promise<InstalledPackage | null>;
  install(row: CatalogRow, options: { switchSource: boolean; required: boolean }): Promise<void>;
  applied: AppliedDefaults;
  now(): Date;
  /**
   * Aborted when the app shuts down (the update scheduler's stop): no
   * further package is judged, installed or recorded, and the run rejects
   * with the signal's reason. The install in progress finishes.
   */
  signal?: AbortSignal;
}

export interface BootInstallReport {
  /** Installed for the first time (default or required). */
  installed: PackageKey[];
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
  const requiredKeys = report.installed.filter(required).map(view);
  const unmanaged = [...(legacy?.unmanaged ?? [])];
  const lostGrants = (legacy?.lostGrants ?? []).map((item) => ({ plugin: item.plugin, keys: [...item.keys] }));
  const notice = { forYou, required: requiredKeys, unmanaged, lostGrants, revoked: revoked.map((item) => ({ ...item, key: { ...item.key } })), autoUpdated: [] };
  return bootInstallNoticeIsEmpty(notice) ? null : notice;
}

/**
 * The requiredInstalls entry naming `(kind, name)`, if any, whichever source
 * it names. A policy names each package from one source at most (an entry
 * for another source makes it invalid, §12), so there is no first match to
 * choose: two found is a broken invariant and throws.
 */
export function requiredByPolicy(policy: Pick<MarketplacePolicy, "requiredInstalls">, kind: PackageKind, name: string): PackageKey | undefined {
  const found = policy.requiredInstalls.filter((key) => key.kind === kind && key.name === name);
  if (found.length > 1) {
    throw new Error(`requiredInstalls names ${kind} ${name} from ${found.map((key) => key.source).join(" and ")}; a parsed policy names one source per package`);
  }
  return found[0];
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

/** Why a required install cannot be had from its source now (§10.2); see {@link requirementGap}. */
export type RequirementGap =
  | { reason: Exclude<UnmetRequirementReason, "incompatible"> }
  | { reason: "incompatible"; minAppVersion: string | null };

/**
 * Why `key`, which the policy requires, cannot be installed from its source
 * now, or null when the source's catalog offers a version of it: the one
 * judgement the boot pass and the Updates card share. `source` says whether
 * the app has the source at all, and whether a copy of its catalog reads.
 */
export function requirementGap(key: PackageKey, source: { known: boolean; synced: boolean }, rows: readonly CatalogRow[]): RequirementGap | null {
  if (!source.known) return { reason: "source-missing" };
  if (!source.synced) return { reason: "source-unreachable" };
  const row = rowFor(rows, key);
  if (!row) return { reason: "not-in-catalog" };
  if (row.choice.state === "candidate") return null;
  return { reason: "incompatible", minAppVersion: row.choice.state === "upgrade_required" ? row.choice.minAppVersion : null };
}

function gapText(key: PackageKey, gap: RequirementGap): string {
  switch (gap.reason) {
    case "source-missing": return `source ${key.source} is not one of the app's sources`;
    case "source-unreachable": return `source ${key.source} has no snapshot yet`;
    case "not-in-catalog": return `${key.source} does not list ${key.kind} ${key.name}`;
    case "incompatible": return gap.minAppVersion ? `needs Ave ${gap.minAppVersion}` : "no version is offered to this installation";
  }
}

async function required(key: PackageKey, input: BootInstallInput, report: BootInstallReport): Promise<void> {
  const origin = input.synced.get(key.source);
  if (origin && !LISTABLE_ORIGINS.has(origin)) {
    report.skipped.push({ key, reason: `source ${key.source} is neither official nor managed` });
    return;
  }
  // Installed from this source: its update is the apply queue's (§18.7.2).
  const current = await input.installed(key.kind, key.name);
  if (current?.sourceId === key.source) return;
  const gap = requirementGap(key, { known: input.known(key.source), synced: origin !== undefined }, input.rows);
  if (gap) {
    report.skipped.push({ key, reason: gapText(key, gap) });
    return;
  }
  // Installed from another source: the apply queue switches it to this one (§18.7.2).
  if (current) return;
  const row = rowFor(input.rows, key)!;
  try {
    await input.install(row, { switchSource: false, required: true });
    report.installed.push(key);
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
  const report: BootInstallReport = { installed: [], skipped: [], failed: [] };
  const requiredIds = new Set(input.policy.requiredInstalls.map(packageKeyId));
  for (const key of input.policy.requiredInstalls) {
    input.signal?.throwIfAborted();
    await required(key, input, report);
  }
  const seen = new Set<string>();
  for (const key of [...input.defaults, ...input.policy.defaultInstalls]) {
    input.signal?.throwIfAborted();
    const id = packageKeyId(key);
    if (seen.has(id) || requiredIds.has(id)) continue;
    seen.add(id);
    await byDefault(key, input, report);
  }
  input.signal?.throwIfAborted();
  return report;
}
