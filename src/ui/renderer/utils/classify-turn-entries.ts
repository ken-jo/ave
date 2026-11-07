import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { CONVERSATION_TITLE_MAX_CHARS, truncateCodePoints } from "../../../shared/conversation-title.js";

/** True for entries that start a turn: user messages and imported overlay prompts. */
export function isTurnStartEntry(entry: ChatEntry | undefined): boolean {
  return entry?.kind === "user" || entry?.kind === "imported_trigger";
}

/** The user message whose turn raised an approval created at `requestCreatedAt`, for the card's conversation line. Walks back to
 * that turn's start (`isTurnStartEntry`); an imported prompt, a sub-agent report or an empty row starting it names no message.
 * A turn start is not bounded by its stamp: a host-submitted or remote row is stamped by the renderer on arrival and can trail
 * the request it caused, and no later turn starts while this one waits on the approval. Rows injected into the running turn
 * (queued guidance, sub-agent reports) and an interrupt send are bounded: one that arrived after the request did not cause it. A resume row
 * ("Continue") is not the user's words, so the walk passes it to the interrupted turn's own message. Undefined means the
 * caller names the conversation instead. */
export function approvalTriggerMessage(entries: readonly ChatEntry[], requestCreatedAt: number): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (!isTurnStartEntry(entry)) continue;
    // A guidance card from an MCP App is inserted when the guide is accepted, which can be after the request.
    if (entry.kind === "imported_trigger" && Date.parse(entry.importedAt) > requestCreatedAt) continue;
    if (entry.kind !== "user") return undefined;
    // An interrupt send starts the next turn, which begins after the pending request; it bears the same ceiling.
    const injected = entry.injectHint === "queue" || entry.injectHint === "sub-agent" || entry.injectHint === "interrupt";
    if (injected && entry.createdAt !== undefined && entry.createdAt > requestCreatedAt) continue;
    if (entry.resumesInterruptedTurn === true) continue;
    if (entry.injectHint === "sub-agent") return undefined;
    const text = entry.text.replace(/\s+/g, " ").trim();
    return text ? truncateCodePoints(text, CONVERSATION_TITLE_MAX_CHARS) : undefined;
  }
  return undefined;
}

export type EntryClass = "intermediate" | "live" | "final";

export interface TurnEntryClassification {
  /** Index of the last turn-start entry (-1 if none). */
  lastTurnStartIdx: number;
  /** classified entry idx → its class. */
  entryClassMap: Map<number, EntryClass>;
  /** final entry idx → its owning turn-start idx. */
  finalTurnStartMap: Map<number, number>;
  /** classified entry idx → its owning turn-start idx. */
  entryTurnStartMap: Map<number, number>;
}

/** Only completed final entries get TurnActionBar; intermediate reasoning/tools/text collapse as one work group after
 * completion. */
export function classifyTurnEntries(
  activeEntries: ChatEntry[],
  streaming: boolean,
): TurnEntryClassification {
  // Last turn-start index: user messages and imported overlay prompts both own the assistant/tool/summary output that
  // follows them.
  let lastTurnStartIdx = -1;
  for (let k = activeEntries.length - 1; k >= 0; k--) {
    if (isTurnStartEntry(activeEntries[k])) { lastTurnStartIdx = k; break; }
  }

  const entryClassMap = new Map<number, EntryClass>();
  const finalTurnStartMap = new Map<number, number>(); // final idx → turn-start idx
  const entryTurnStartMap = new Map<number, number>(); // classified idx → turn-start idx

  let turnStart = -1;
  for (let i = 0; i < activeEntries.length; i++) {
    const e = activeEntries[i];
    if (!e) continue;
    if (isTurnStartEntry(e)) { turnStart = i; continue; }
    if (e.kind !== "assistant" && e.kind !== "reasoning" && e.kind !== "tool_group" && e.kind !== "permission_review") continue;

    let nextTurnStartIdx = activeEntries.length;
    for (let j = i + 1; j < activeEntries.length; j++) {
      if (isTurnStartEntry(activeEntries[j])) { nextTurnStartIdx = j; break; }
    }

    const subsequentTurnEntries = activeEntries.slice(i + 1, nextTurnStartIdx);
    const hasSubsequent = subsequentTurnEntries.some(
      (ne) => ne.kind === "assistant" || ne.kind === "tool_group" || ne.kind === "reasoning" || ne.kind === "permission_review",
    );
    const hasSubsequentWork = subsequentTurnEntries.some(
      (ne) => ne.kind === "tool_group" || ne.kind === "reasoning" || ne.kind === "permission_review",
    );
    // A turn summary proves that the work settled and has durable usage data.
    // It does not prove a natural end_turn: input waits and output caps also
    // carry summaries. Completion labeling is decided separately by the
    // summary's endedByEndTurn marker.
    const hasTurnSummary = subsequentTurnEntries.some(
      (ne) => ne.kind === "turn_summary",
    );

    const myTurnStart = turnStart >= 0 ? turnStart : 0;
    entryTurnStartMap.set(i, myTurnStart);
    const isActiveTurnEntry = myTurnStart === lastTurnStartIdx && streaming;
    const hasPriorWork = activeEntries.slice(myTurnStart + 1, i).some(
      (pe) => pe.kind === "tool_group" || pe.kind === "reasoning" || pe.kind === "permission_review",
    );

    if (e.kind === "assistant") {
      if (e.phase === "work") {
        entryClassMap.set(i, "intermediate");
      } else if (e.phase === "final" && !isActiveTurnEntry) {
        entryClassMap.set(i, "final");
        finalTurnStartMap.set(i, myTurnStart);
      } else if (!hasSubsequent && !isActiveTurnEntry) {
        entryClassMap.set(i, "final");
        finalTurnStartMap.set(i, myTurnStart);
      } else if (isActiveTurnEntry || hasSubsequentWork || hasPriorWork) {
        entryClassMap.set(i, "intermediate");
      } else {
        entryClassMap.set(i, "live");
      }
    } else if (hasSubsequent || isActiveTurnEntry || hasTurnSummary) {
      entryClassMap.set(i, "intermediate");
    } else {
      entryClassMap.set(i, "live");
    }
  }

  return { lastTurnStartIdx, entryClassMap, finalTurnStartMap, entryTurnStartMap };
}
