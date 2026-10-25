/** Boot installs absent requirements; upgrades and source switches wait in the idle apply queue.
 * Defaults are recorded once, except transient failures and held-back candidates are retried. */
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
  defaults: readonly PackageKey[];
  rows: readonly CatalogRow[];
  synced: ReadonlyMap<string, SourceOrigin>;
  requiredSources: ReadonlyMap<string, RequirementSourceState>;
  installed(kind: PackageKind, name: string): Promise<InstalledPackage | null>;
  install(row: CatalogRow, options: { switchSource: boolean; required: boolean }): Promise<void>;
  applied: AppliedDefaults;
  now(): Date;
  /** Abort prevents later judgments, installs and records; the install already in flight finishes. */
  signal?: AbortSignal;
}

export interface BootInstallReport {
  installed: PackageKey[];
  skipped: Array<{ key: PackageKey; reason: string }>;
  failed: Array<{ key: PackageKey; message: string }>;
}

const LISTABLE_ORIGINS = new Set<SourceOrigin>(["official", "managed"]);

/** Default installs are user-owned; the boot notice distinguishes policy-required changes. */
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

/** A policy may require a package from only one source; duplicate matches violate the invariant. */
export function requiredByPolicy(policy: Pick<MarketplacePolicy, "requiredInstalls">, kind: PackageKind, name: string): PackageKey | undefined {
  const found = policy.requiredInstalls.filter((key) => key.kind === kind && key.name === name);
  if (found.length > 1) {
    throw new Error(`requiredInstalls names ${kind} ${name} from ${found.map((key) => key.source).join(" and ")}; a parsed policy names one source per package`);
  }
  return found[0];
}

/** Only the named source binding is locked; a same-named install from another source is not required. */
export function lockedByPolicy(policy: Pick<MarketplacePolicy, "requiredInstalls">, kind: PackageKind, name: string, sourceId: string | null): PackageKey | undefined {
  const key = requiredByPolicy(policy, kind, name);
  return key && key.source === sourceId ? key : undefined;
}

export function requiredByPolicyReason(kind: PackageKind, name: string, key: PackageKey, action: "uninstall" | "disable"): string {
  return `${kind} ${name} is required by policy (source ${key.source}); it cannot ${action === "uninstall" ? "be uninstalled" : "be disabled"}`;
}

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

/** Source state is independent of view filtering; hidden sources cannot install from cached rows. */
export type RequirementSourceState = "missing" | "hidden" | "unreachable" | "readable";

export type RequirementGap =
  | { reason: Exclude<UnmetRequirementReason, "incompatible"> }
  | { reason: "incompatible"; minAppVersion: string };

/** Boot and Updates share this judgment over current source state and visible catalog rows. */
export function requirementGap(key: PackageKey, source: RequirementSourceState, rows: readonly CatalogRow[]): RequirementGap | null {
  switch (source) {
    case "missing": return { reason: "source-missing" };
    case "hidden": return { reason: "source-hidden" };
    case "unreachable": return { reason: "source-unreachable" };
    case "readable": break;
  }
  const row = rowFor(rows, key);
  if (!row) return { reason: "not-in-catalog" };
  switch (row.choice.state) {
    case "candidate": return null;
    case "upgrade_required": return { reason: "incompatible", minAppVersion: row.choice.minAppVersion };
    case "unavailable": return { reason: row.choice.reason === "pending" ? "rollout-held" : "not-offered" };
  }
}

function gapText(key: PackageKey, gap: RequirementGap): string {
  switch (gap.reason) {
    case "source-missing": return `source ${key.source} is not one of the app's sources`;
    case "source-hidden": return `source ${key.source} is hidden`;
    case "source-unreachable": return `source ${key.source} has no snapshot yet`;
    case "not-in-catalog": return `${key.source} does not list ${key.kind} ${key.name}`;
    case "incompatible": return `needs Ave ${gap.minAppVersion}`;
    case "rollout-held": return "not offered to this installation yet (rollout or pre-release)";
    case "not-offered": return "no version is offered to this installation";
  }
}

/** The state of a source a requirement names; the caller gives one for each, so a missing one is a broken contract. */
function requiredSourceState(input: BootInstallInput, sourceId: string): RequirementSourceState {
  const state = input.requiredSources.get(sourceId);
  if (state === undefined) throw new Error(`no state was given for required source ${sourceId}`);
  return state;
}

async function required(key: PackageKey, input: BootInstallInput, report: BootInstallReport): Promise<void> {
  const origin = input.synced.get(key.source);
  if (origin && !LISTABLE_ORIGINS.has(origin)) {
    report.skipped.push({ key, reason: `source ${key.source} is neither official nor managed` });
    return;
  }
  const current = await input.installed(key.kind, key.name);
  if (current?.sourceId === key.source) return;
  const gap = requirementGap(key, requiredSourceState(input, key.source), input.rows);
  if (gap) {
    report.skipped.push({ key, reason: gapText(key, gap) });
    return;
  }
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
  if (!origin) return;
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
    // Rollout and prerelease deferrals are retryable, never permanent skips.
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
