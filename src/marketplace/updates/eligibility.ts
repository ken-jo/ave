/**
 * Which updates apply by themselves (design §18.7.2): the preconditions,
 * then the switches. Pure: the service gathers the facts of each update, the
 * scheduler reads the settings and the policy, and this decides.
 *
 * An update applies automatically only when every **precondition** holds:
 * the package is enabled, its source shown, it is an upgrade (or a folder's
 * refresh, §18.7.6), the source has no rewrite pending, the version is not
 * skipped, it has not failed three times, its consent fingerprint equals the
 * baseline as far as the catalog shows (§18.7.3), every approved MCP server
 * and hook can keep its approval, and a plain-http source holds
 * `unencrypted-updates`. Then the first switch that is set decides: policy
 * `autoUpdate`, the package's, the source's, the global one, the origin's
 * default.
 *
 * A required install (§10.2) overrides the switches, the skips, the
 * approval-carrying precondition and the three-failure stop: the policy
 * stands for the user's consent, and only for it. It is always queued.
 */
import type { ConsentDelta, UpdateReason, AutoUpdateSwitchView } from "../../shared/git-marketplace.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { MarketplacePolicy } from "../sources/policy.js";
import type { PackageKind } from "../catalog/types.js";
import { lockedByPolicy } from "../boot-installs/run.js";

/** The number of failed attempts at one version after which automatic attempts stop (§18.7.5). */
export const MAX_AUTOMATIC_ATTEMPTS = 3;

type AutoUpdateSwitch = "on" | "off";

/** The organization's `autoUpdate` (§18.6). */
export type AutoUpdatePolicy = "user" | "on" | "off";

/** The user's switches (settings `marketplace.autoUpdate*`, §18.9). */
export interface AutoUpdateSettings {
  autoUpdate?: boolean;
  autoUpdateSources?: Readonly<Record<string, AutoUpdateSwitch>>;
  autoUpdatePackages?: Readonly<Record<string, AutoUpdateSwitch>>;
}

/** What decides a source's default and its http precondition. */
export interface SourceFacts {
  id: string;
  origin: SourceOrigin;
  /** The source is read over plain http. */
  http: boolean;
  /** It holds `unencrypted-updates`. */
  acknowledgedUnencryptedUpdates: boolean;
  /** Shown (not hidden by the user): a hidden source still syncs, but nothing installs from it. */
  shown: boolean;
  /** A history rewrite waits for the user's review (§7.3). */
  pendingRewrite: boolean;
}

/** How the offered version relates to the installed one. */
export type UpdateChange = "upgrade" | "refresh" | "downgrade" | "switch";

/** What the service knows about one offered update. */
export interface UpdateFacts {
  /** The package's skip and switch key (`packageUpdateSkipKey`). */
  switchKey: string;
  to: string;
  change: UpdateChange;
  /** Not disabled by the user or by a revocation. */
  enabled: boolean;
  source: SourceFacts;
  /** Checkpoint one (§18.7.3): the consent fields the catalog shows differing from the baseline. */
  consent: ConsentDelta;
  /**
   * The approved MCP servers and hooks of the running generation whose
   * approval cannot carry (§18.7.2): their record holds no approval digest
   * (an approval from an earlier Ave version) and they are still in the
   * update. Named by consent field.
   */
  unconfirmedApprovals: readonly string[];
  /** A `requiredInstalls` entry names it from this source (§10.2). */
  required: boolean;
  /** The managed policy refuses installs from its source now (`allowDirectInstall`, `allowLocalSources`, §18.6). */
  policyBlocked: boolean;
}

/** What the last apply checks remember of this package (`updates.json`, §18.7.1). */
export interface UpdateMemory {
  to: string;
  attempts: number;
}

export type UpdateClassification =
  | { state: "automatic"; reasons: [] }
  | { state: "needs-review" | "manual" | "failed"; reasons: UpdateReason[] };

/**
 * Whether the policy in force requires this package from this source
 * (`requiredInstalls`, §10.2): the one test of required-ness for an update,
 * an installed package's switch and every update view. It reads only the
 * policy and the package's identity, never a source's health or an offer,
 * so a source whose metadata cannot be read does not make a required
 * package optional, and a withdrawn entry stops counting at once.
 */
export function requiresPackage(policy: Pick<MarketplacePolicy, "requiredInstalls">, key: { sourceId: string | null; kind: PackageKind; name: string }): boolean {
  return lockedByPolicy(policy, key.kind, key.name, key.sourceId) !== undefined;
}

/** The default of a source's origin (§18.7.2): every origin is on, but custom or direct sources over http are off. */
export function originDefault(source: Pick<SourceFacts, "origin" | "http">): boolean {
  return !(source.http && (source.origin === "custom" || source.origin === "direct"));
}

/**
 * A package's switch resolved (§18.7.2): a `requiredInstalls` entry
 * (`required`) makes it on whatever is set; then policy `autoUpdate`, the
 * package's switch, the source's, the global one, the origin's default.
 * `override` is the package's own switch.
 */
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

/** A source's switch resolved: policy, the source's switch, the global one, the origin's default. */
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

/**
 * Classify one update. `memory` is what the apply checks remember of the
 * package, `skipped` whether the user skipped this version. Returns null for
 * a skipped version that is not required: it is neither applied nor shown.
 */
export function classifyUpdate(
  facts: UpdateFacts,
  input: { policy: AutoUpdatePolicy; settings: AutoUpdateSettings; memory: UpdateMemory | null; skipped: boolean },
): UpdateClassification | null {
  // The policy stands for the consent of a required install: only revocation,
  // compatibility and the idle gate hold it, and those decided whether it is offered.
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
  // What the user must review comes first: a manual action would show the same review.
  if (review.length > 0) return { state: "needs-review", reasons: [...review, ...manual] };
  if (manual.length > 0) return { state: "manual", reasons: manual };
  const decided = resolvePackageSwitch(input.policy, input.settings, facts.switchKey, facts.source, facts.required);
  if (!decided.effective) return { state: "manual", reasons: ["switched-off"] };
  return { state: "automatic", reasons: [] };
}
