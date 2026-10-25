import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { hostTpmDefault } from "../../../shared/model-host-policy.js";
import { getUsableContext } from "../../../shared/context-budget.js";

/** Use engine-projected usage, including cache tokens, and canonical composed-draft estimates; retain the last carrier
 * during streaming. Apply the shared usable-context reservation to the resolved route window so 100% matches compaction. */
export function useContextBudget(params: {
  entries: ChatEntry[];
  /**
   * The active route's context window, already resolved by
   * `resolveContextWindowForRoute` — the same number the engine budgets
   * compaction against. Not derived here: two resolutions of one fact is how
   * the ring and the engine came to disagree.
   */
  contextWindow: number;
  /** The route's prompt cap below the window, from the same resolution; bounds the usable budget. */
  inputLimit?: number;
  /** Omit when the active runtime has no verified pricing/context contract. */
  llmVendor?: string;
  /** Omit when the active runtime has no verified pricing/context contract. */
  llmModel?: string;
  /** Canonical composed-draft estimate supplied by the renderer's shared SOT. */
  draftTokenEstimate?: number;
  /** False disables all API-model-derived budget and TPM projections. */
  enabled?: boolean;
}) {
  const {
    entries,
    contextWindow,
    inputLimit,
    llmVendor,
    llmModel,
    draftTokenEstimate,
    enabled = true,
  } = params;

  const contextBudget = useMemo(() => {
    if (!enabled) return 0;
    return getUsableContext(contextWindow, inputLimit);
  }, [enabled, contextWindow, inputLimit]);

  const baseTokens = useMemo(() => {
    if (!enabled) return 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.kind === "turn_summary" || e?.kind === "context_usage") {
        return Math.max(0, e.tokensIn);
      }
    }
    return 0;
    // Memo key avoids the O(n) scan on every streaming delta — the array identity changes but the *last* entry is the only one
    // that matters for the latest turn_summary. Mirrors the pattern in `use-cost-estimate`.
  }, [enabled, entries.length, entries[entries.length - 1]]);

  // App supplies one canonical composed-draft estimate so this hook stays a lightweight budget aggregator and never
  // recreates renderer/engine policy.
  const draftTokens = useMemo(() => {
    if (!enabled || typeof draftTokenEstimate !== "number" || !Number.isFinite(draftTokenEstimate)) return 0;
    return Math.max(0, Math.ceil(draftTokenEstimate));
  }, [enabled, draftTokenEstimate]);

  const usedTokens = baseTokens + draftTokens;

  const contextOverflowPct = useMemo(
    () => (contextBudget > 0 ? usedTokens / contextBudget : 0),
    [usedTokens, contextBudget],
  );

  // Project per-request TPM against the host model default.
  const tpmLimit = useMemo(
    () => (enabled ? hostTpmDefault(llmVendor ?? "", llmModel ?? "") : undefined),
    [enabled, llmVendor, llmModel],
  );

  const tpmPct = useMemo(
    () => (tpmLimit && tpmLimit > 0 ? usedTokens / tpmLimit : undefined),
    [usedTokens, tpmLimit],
  );

  // The ring uses min(contextBudget, tpmLimit); the tooltip retains the context-window denominator.
  const effectiveBudget = useMemo(
    () => (typeof tpmLimit === "number" && tpmLimit < contextBudget ? tpmLimit : contextBudget),
    [contextBudget, tpmLimit],
  );

  return {
    usedTokens,
    contextBudget,
    contextOverflowPct,
    // #900 #1 — undefined for models without a host TPM default.
    tpmLimit,
    tpmPct,
    isTpmOverflow: typeof tpmPct === "number" && tpmPct >= 1,

    effectiveBudget,
  };
}
