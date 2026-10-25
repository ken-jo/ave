/** Required policy overrides switches, skips, approval carry and failure limits.
 * Optional updates must pass every precondition before policy/package/source/global switch precedence. */
import type { ConsentDelta, UpdateReason, AutoUpdateSwitchView } from "../../shared/git-marketplace.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { MarketplacePolicy } from "../sources/policy.js";
import type { PackageKind } from "../catalog/types.js";
import { lockedByPolicy } from "../boot-installs/run.js";

export const MAX_AUTOMATIC_ATTEMPTS = 3;

type AutoUpdateSwitch = "on" | "off";

export type AutoUpdatePolicy = "user" | "on" | "off";

export interface AutoUpdateSettings {
  autoUpdate?: boolean;
  autoUpdateSources?: Readonly<Record<string, AutoUpdateSwitch>>;
  autoUpdatePackages?: Readonly<Record<string, AutoUpdateSwitch>>;
}

export interface SourceFacts {
  id: string;
  origin: SourceOrigin;
  http: boolean;
  acknowledgedUnencryptedUpdates: boolean;
  /** Hidden sources still sync, but no package may install from them. */
  shown: boolean;
  pendingRewrite: boolean;
}

export type UpdateChange = "upgrade" | "refresh" | "downgrade" | "switch";

export interface UpdateFacts {
  switchKey: string;
  to: string;
  change: UpdateChange;
  enabled: boolean;
  source: SourceFacts;
  consent: ConsentDelta;
  /** Retained components with legacy null approval digests cannot carry approval. */
  unconfirmedApprovals: readonly string[];
  required: boolean;
  policyBlocked: boolean;
}

export interface UpdateMemory {
  to: string;
  attempts: number;
}

export type UpdateClassification =
  | { state: "automatic"; reasons: [] }
  | { state: "needs-review" | "manual" | "failed"; reasons: UpdateReason[] };

/** Required status uses policy and identity only; unreadable source metadata cannot make it optional. */
export function requiresPackage(policy: Pick<MarketplacePolicy, "requiredInstalls">, key: { sourceId: string | null; kind: PackageKind; name: string }): boolean {
  return lockedByPolicy(policy, key.kind, key.name, key.sourceId) !== undefined;
}

/** Origins default on except custom or direct HTTP sources. */
export function originDefault(source: Pick<SourceFacts, "origin" | "http">): boolean {
  return !(source.http && (source.origin === "custom" || source.origin === "direct"));
}

/** Resolve required, policy, package, source, global, then origin defaults in that order. */
export function resolvePackageSwitch(
  policy: AutoUpdatePolicy,
  settings: AutoUpdateSettings,
  switchKey: string,
  source: Pick<SourceFacts, "id" | "origin" | "http"> | null,
  required: boolean,
): AutoUpdateSwitchView {
  const override = lookup(settings.autoUpdatePackages, switchKey);
  if (required) return { effective: true, override, lockedByPolicy: true, required: true };
  // Only a required package's switch resolves without its source: nothing below it is read.
  if (!source) throw new Error(`the switch of ${switchKey} needs its source's facts unless the package is required`);
  if (policy !== "user") return { effective: policy === "on", override, lockedByPolicy: true, required: false };
  if (override) return { effective: override === "on", override, lockedByPolicy: false, required: false };
  return { effective: sourceEffective(settings, source), override, lockedByPolicy: false, required: false };
}

export function resolveSourceSwitch(policy: AutoUpdatePolicy, settings: AutoUpdateSettings, source: Pick<SourceFacts, "id" | "origin" | "http">): AutoUpdateSwitchView {
  const override = lookup(settings.autoUpdateSources, source.id);
  if (policy !== "user") return { effective: policy === "on", override, lockedByPolicy: true, required: false };
  return { effective: sourceEffective(settings, source), override, lockedByPolicy: false, required: false };
}

function sourceEffective(settings: AutoUpdateSettings, source: Pick<SourceFacts, "id" | "origin" | "http">): boolean {
  const own = lookup(settings.autoUpdateSources, source.id);
  if (own) return own === "on";
  if (settings.autoUpdate === false) return false;
  return originDefault(source);
}

function lookup(map: Readonly<Record<string, AutoUpdateSwitch>> | undefined, key: string): AutoUpdateSwitch | null {
  return map && Object.hasOwn(map, key) ? map[key]! : null;
}

/** Skipped optional versions return null and are neither applied nor shown. */
export function classifyUpdate(
  facts: UpdateFacts,
  input: { policy: AutoUpdatePolicy; settings: AutoUpdateSettings; memory: UpdateMemory | null; skipped: boolean },
): UpdateClassification | null {
  // Policy authorizes required installs; offered-version checks and idle gating still apply.
  if (facts.required) return { state: "automatic", reasons: [] };
  if (input.skipped) return null;
  if (input.memory && input.memory.to === facts.to && input.memory.attempts >= MAX_AUTOMATIC_ATTEMPTS) {
    return { state: "failed", reasons: ["failed-three-times"] };
  }
  const review: UpdateReason[] = [];
  if (facts.consent.some((entry) => entry.field === "*" || entry.before === "unknown")) review.push("baseline-unknown");
  if (facts.consent.some((entry) => entry.field !== "*" && entry.before !== "unknown")) review.push("consent-changed");
  if (facts.unconfirmedApprovals.length > 0) review.push("approval-unconfirmed");
  const manual: UpdateReason[] = [];
  if (facts.policyBlocked) manual.push("policy-blocked");
  if (!facts.enabled) manual.push("disabled");
  if (!facts.source.shown) manual.push("source-hidden");
  if (facts.change === "downgrade" || facts.change === "switch") manual.push("not-an-upgrade");
  if (facts.source.pendingRewrite) manual.push("history-rewritten");
  if (facts.source.http && !facts.source.acknowledgedUnencryptedUpdates) manual.push("unencrypted-updates");
  // Show required review before other manual reasons.
  if (review.length > 0) return { state: "needs-review", reasons: [...review, ...manual] };
  if (manual.length > 0) return { state: "manual", reasons: manual };
  const decided = resolvePackageSwitch(input.policy, input.settings, facts.switchKey, facts.source, facts.required);
  if (!decided.effective) return { state: "manual", reasons: ["switched-off"] };
  return { state: "automatic", reasons: [] };
}
