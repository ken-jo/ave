// Accepted and never are terminal; later defers only until the next launch. Select in main so multiple windows cannot independently propose the same unanswered item.
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import type {
  PluginOnboardingAction,
  PluginOnboardingSpec,
} from "../plugins/public-contract.js";

// `~/.ave/onboarding/` namespace — shares the directory with `tour-state.json`.
const ns = openFeatureNamespace("onboarding");
const PROPOSALS_FILE = "proposals.json";

// Keep the firstTask record ID stable so stored answers continue to name the same proposal.
export const FIRST_TASK_PROPOSAL_ID = "first-task";

export type OnboardingProposalDisposition = "accepted" | "never" | "later";

interface OnboardingProposalAnswer {
  disposition: OnboardingProposalDisposition;
  // ISO timestamp of the answer.
  answeredAt: string;
}

export interface OnboardingProposalState {
  // Keyed `<pluginId>:<proposalId>`.
  answers: Record<string, OnboardingProposalAnswer>;
}

const EMPTY_STATE: OnboardingProposalState = { answers: {} };

// The storage key for one proposal. Both kinds share the shape.
export function onboardingProposalKey(pluginId: string, proposalId: string): string {
  return `${pluginId}:${proposalId}`;
}

const DISPOSITIONS: ReadonlySet<string> = new Set([
  "accepted",
  "never",
  "later",
] satisfies OnboardingProposalDisposition[]);

export function isOnboardingProposalDisposition(
  value: unknown,
): value is OnboardingProposalDisposition {
  return typeof value === "string" && DISPOSITIONS.has(value);
}

// Drop malformed answers and ask again rather than silently treating unknown dispositions as user intent.
function normaliseState(raw: unknown): OnboardingProposalState {
  if (!raw || typeof raw !== "object") return { answers: {} };
  const candidate = (raw as { answers?: unknown }).answers;
  if (!candidate || typeof candidate !== "object") return { answers: {} };
  const answers: Record<string, OnboardingProposalAnswer> = {};
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { disposition, answeredAt } = value as {
      disposition?: unknown;
      answeredAt?: unknown;
    };
    if (!isOnboardingProposalDisposition(disposition)) continue;
    if (typeof answeredAt !== "string") continue;
    answers[key] = { disposition, answeredAt };
  }
  return { answers };
}

// Read the stored answers. Like the neighbouring tour state, a missing or corrupt file resolves to the empty state rather than throwing: this is a
// user-preference store, and losing it re-asks questions instead of blocking the host.
export async function readOnboardingProposalState(): Promise<OnboardingProposalState> {
  const parsed = await ns.readJson<unknown>(PROPOSALS_FILE, EMPTY_STATE);
  return normaliseState(parsed);
}

// Record one answer and return the state that was written. Re-answering a key replaces the previous answer — the user's latest word is the one that counts.
export async function recordOnboardingProposalAnswer(
  key: string,
  disposition: OnboardingProposalDisposition,
): Promise<OnboardingProposalState> {
  if (!key) throw new Error("invalid-proposal-key");
  const current = await readOnboardingProposalState();
  const next: OnboardingProposalState = {
    answers: {
      ...current.answers,
      [key]: { disposition, answeredAt: new Date().toISOString() },
    },
  };
  await ns.writeJson(PROPOSALS_FILE, next);
  return next;
}

// One plugin's declared onboarding, as the selection below needs it.
export interface OnboardingProposalSource {
  pluginId: string;
  onboarding: PluginOnboardingSpec;
}

// One proposal the user has not answered, with its copy already resolved.
export interface PendingOnboardingProposal {
  // `<pluginId>:<proposalId>` — what {@link recordOnboardingProposalAnswer} takes.
  key: string;
  pluginId: string;
  proposalId: string;
  headline: string;
  body: string;
  actionLabel: string;
  action: PluginOnboardingAction;
}

function normaliseLocaleTag(locale: string): string {
  return locale.trim().toLowerCase().replaceAll("_", "-");
}

// Resolve per-locale copy: exact tag, then the bare language, then English. English is required by the manifest schema, so the last step always lands.
function resolveCopy<T>(locales: Record<string, T>, locale: string): T | undefined {
  const normalized = normaliseLocaleTag(locale);
  const primary = normalized.split("-")[0];
  return locales[normalized] ?? locales[primary] ?? locales.en;
}

// Ask firstTask proposals before highlights, then priority and stable IDs for deterministic order.
const FIRST_TASK_RANK = 0;
const HIGHLIGHT_RANK = 1;
// Sorts an omitted highlight priority last, above the schema's own ceiling.
const UNSPECIFIED_PRIORITY = 1001;

interface RankedProposal extends PendingOnboardingProposal {
  rank: number;
  priority: number;
}

// Track answeredThisLaunch separately so later cannot be re-asked within the same run.
export function pendingOnboardingProposals(
  sources: readonly OnboardingProposalSource[],
  state: OnboardingProposalState,
  answeredThisLaunch: ReadonlySet<string>,
  locale: string,
): PendingOnboardingProposal[] {
  const ranked: RankedProposal[] = [];
  for (const { pluginId, onboarding } of sources) {
    const consider = (candidate: RankedProposal): void => {
      const stored = state.answers[candidate.key]?.disposition;
      if (stored === "accepted" || stored === "never") return;
      if (answeredThisLaunch.has(candidate.key)) return;
      ranked.push(candidate);
    };

    const firstTask = onboarding.firstTask;
    if (firstTask) {
      const copy = resolveCopy(firstTask.locales, locale);
      if (copy) {
        consider({
          key: onboardingProposalKey(pluginId, FIRST_TASK_PROPOSAL_ID),
          pluginId,
          proposalId: FIRST_TASK_PROPOSAL_ID,
          headline: copy.headline,
          body: copy.body,
          actionLabel: copy.actionLabel,
          action: { kind: "composer", prompt: copy.composerPrompt },
          rank: FIRST_TASK_RANK,
          priority: firstTask.priority,
        });
      }
    }

    for (const highlight of onboarding.highlights ?? []) {
      const copy = resolveCopy(highlight.copy, locale);
      if (!copy) continue;
      consider({
        key: onboardingProposalKey(pluginId, highlight.id),
        pluginId,
        proposalId: highlight.id,
        headline: copy.headline,
        body: copy.body,
        actionLabel: copy.actionLabel,
        action: highlight.action,
        rank: HIGHLIGHT_RANK,
        priority: highlight.priority ?? UNSPECIFIED_PRIORITY,
      });
    }
  }

  ranked.sort(
    (left, right) =>
      left.rank - right.rank
      || left.priority - right.priority
      || (left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0)
      || (left.proposalId < right.proposalId ? -1 : left.proposalId > right.proposalId ? 1 : 0),
  );

  return ranked.map(({ rank: _rank, priority: _priority, ...proposal }) => proposal);
}
