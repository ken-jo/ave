import { useCallback, useEffect, useState } from "react";
import { A2ATaskState } from "../../../shared/a2a.js";

/** A sub-agent row rebuilt from disk, as sent by `chat:session-history`. */
export interface RestoredSubAgentRow {
  spawnId: string;
  childSessionId: string;
  title: string;
  modifiedAt: string;
  /** Last durable A2A projection the child recorded, when it recorded one. */
  taskState?: string;
  toolUseId?: string;
}

/** Restored sub-agent rows can never be running; working, submitted or absent durable state means interrupted, not
 * completed. */
function restoredSpawnStatus(row: RestoredSubAgentRow): SubAgentSpawn["status"] {
  switch (row.taskState) {
    case A2ATaskState.COMPLETED:
      return "done";
    case A2ATaskState.FAILED:
    case A2ATaskState.REJECTED:
      return "error";
    case A2ATaskState.INPUT_REQUIRED:
      // Stopped on a question it never got an answer to — still actionable.
      return "waiting";
    case A2ATaskState.CANCELED:
      return "interrupted";
    default:
      return "interrupted";
  }
}

/** Test seam for the mapping above; not used by the hook itself. */
export const restoredSpawnStatusForTest = restoredSpawnStatus;
import type { AveApi } from "../types.js";
import type { AskUserQuestionRequest } from "../components/AskUserQuestionCard.js";
import type { SubAgentSpawn } from "../subagents/types.js";
import type { SkillBadgeProps } from "../components/SkillBadge.js";

/**
 * M4: cap the inline skill badges so a chatty assistant cannot grow the
 * list unbounded across a long session. 10 is large enough that legitimate
 * use is unaffected and small enough that abuse is bounded. Newest-first
 * dedup: re-loading the same skill replaces the prior entry rather than
 * stacking duplicates.
 */
const SKILL_BADGE_CAP = 10;

export interface WorkflowToolsOptions {
  /** Filter window-wide frames to the conversation and its children; keep the ownership predicate stable to avoid losing
   * frames during resubscription. */
  ownsSession?: (sessionId: string) => boolean;
  /**
   * Whether this surface DRAWS a window-wide card addressed to `sessionId`.
   * Wider than `ownsSession`: a turn can run in a session no tile is showing
   * (a routine, a side chat, a background sub-agent whose parent tile moved
   * on), and such a card must still reach a screen — see `tileDrawsSession`.
   * Defaults to `ownsSession` when omitted, and to "keep everything" when
   * neither is given. Same stability requirement as `ownsSession`.
   */
  drawsSession?: (sessionId: string) => boolean;
}

export function useWorkflowTools(api: AveApi, options: WorkflowToolsOptions = {}) {
  const { ownsSession, drawsSession } = options;
  // One predicate for the card channels, resolved once so the subscription below depends on a single identity.
  const drawsOrOwns = drawsSession ?? ownsSession;
  const [askQuestions, setAskQuestions] = useState<AskUserQuestionRequest[]>([]);
  const [subAgentSpawns, setSubAgentSpawns] = useState<SubAgentSpawn[]>([]);
  const [loadedSkills, setLoadedSkills] = useState<SkillBadgeProps[]>([]);

  useEffect(() => {
    // Defensive: in test/preview environments some API surfaces are stubbed and the workflow channels may be undefined. Skip
    // wiring if absent — the components above re-check on each render so a late stub still picks up new requests.
    if (typeof api.onAskUserQuestion !== "function") return undefined;
    const unsubAsk = api.onAskUserQuestion?.((req) => {
      // A question belongs to ONE conversation. Drawn in every tile, it can be answered from a tile that never asked — that
      // answer resolves the gate, and the asking tile is left holding a card the gate now refuses.
      if (drawsOrOwns && !drawsOrOwns(req.sessionId)) return;
      setAskQuestions((prev) =>
        prev.some((p) => p.id === req.id) ? prev : [...prev, req],
      );
    });
    // Questions sent before this renderer subscribed — the window that drew
    // them closed, or this one reloaded. Subscribed first, fetched second, so
    // nothing falls between the two; one that arrived both ways is kept once.
    // Parked questions were asked first, so they go ahead.
    let alive = true;
    void api.listPendingAskUserQuestions?.().then(
      (parked) => {
        if (!alive || !Array.isArray(parked)) return;
        const mine = parked.filter((req) => !drawsOrOwns || drawsOrOwns(req.sessionId));
        if (mine.length === 0) return;
        setAskQuestions((prev) => [
          ...mine.filter((req) => !prev.some((p) => p.id === req.id)),
          ...prev,
        ]);
      },
      () => {
        // No snapshot: live requests still arrive on the subscription above.
      },
    );
    const unsubSpawn = api.onAgentSpawnEvent?.((event) => {
      // Adopt unowned deadline-bearing questions, never spawn progress rows; report malformed spawn frames instead of silently
      // dropping them.
      if (typeof event.parentSessionId !== "string" || event.parentSessionId.length === 0) {
        console.warn("[ave] agent-spawn frame names no conversation; dropped", event.spawnId);
        return;
      }
      if (ownsSession && !ownsSession(event.parentSessionId)) return;
      setSubAgentSpawns((prev) => {
        const existingIdx = prev.findIndex((s) => s.spawnId === event.spawnId);
        if (event.type === "start") {
          if (existingIdx >= 0) return prev;
          const fresh: SubAgentSpawn = {
            spawnId: event.spawnId,
            title: event.title ?? "(sub-agent)",
            status: "running",
            ...(event.instructions ? { instructions: event.instructions } : {}),
            entries: [],
            toolCallCount: 0,
            toolUseId: event.toolUseId,
            childSessionId: event.childSessionId,
            parentSessionId: event.parentSessionId,
          };
          return [...prev, fresh];
        }
        // `activity` / `done` / `error` may arrive before `start` (or after a reload cleared the live list). Synthesize the spawn
        // from what the event carries. `entries` is a full-snapshot replace, never a delta.
        if (existingIdx < 0) {
          const synthetic: SubAgentSpawn = {
            spawnId: event.spawnId,
            title: event.title ?? "(sub-agent)",
            status:
              event.type === "done"
                ? (event.status ?? "done")
                : event.type === "error"
                  ? "error"
                  : "running",
            ...(event.instructions ? { instructions: event.instructions } : {}),
            entries: event.entries ?? [],
            toolCallCount: event.toolCallCount ?? 0,
            summary: event.summary,
            errorMessage: event.message,
            toolUseId: event.toolUseId,
            childSessionId: event.childSessionId,
            parentSessionId: event.parentSessionId,
            suspension: event.suspension,
          };
          return [...prev, synthetic];
        }
        const next = [...prev];
        const existing = next[existingIdx];
        // `childSessionId` (the resume JOIN KEY) may first arrive on a later
        // phase (the original spawn only learns it on `done`). Only overwrite
        // when the event carries a value so a known id is never clobbered with
        // undefined on a phase that omits it.
        const childSessionIdPatch = event.childSessionId
          ? { childSessionId: event.childSessionId }
          : {};
        const instructionsPatch = event.instructions
          ? { instructions: event.instructions }
          : {};
        if (event.type === "activity") {
          next[existingIdx] = {
            ...existing,
            // Full snapshot replace — the accumulator forwards the whole child transcript each time, so overwriting (not appending) is
            // correct and idempotent against re-emitted events.
            ...(event.entries ? { entries: event.entries } : {}),
            toolCallCount: event.toolCallCount ?? existing.toolCallCount,
            ...instructionsPatch,
            ...childSessionIdPatch,
          };
        } else if (event.type === "done") {
          next[existingIdx] = {
            ...existing,
            status: event.status ?? "done",
            summary: event.summary,
            ...(event.entries ? { entries: event.entries } : {}),
            toolCallCount: event.toolCallCount ?? existing.toolCallCount,
            ...instructionsPatch,
            ...childSessionIdPatch,
            ...(event.suspension ? { suspension: event.suspension } : {}),
          };
        } else if (event.type === "error") {
          next[existingIdx] = {
            ...existing,
            status: "error",
            errorMessage: event.message,
            ...(event.entries ? { entries: event.entries } : {}),
            ...instructionsPatch,
            ...childSessionIdPatch,
          };
        }
        return next;
      });
    });
    const unsubSkill = api.onSkillLoaded?.((event) => {
      // Same conversation scoping as the card above, adoption included: a skill loaded in one tile's turn is not a badge on the
      // tile beside it, and one loaded by a routine or a background agent still belongs on screen.
      if (drawsOrOwns && !drawsOrOwns(event.sessionId)) return;
      // M4: dedupe by name (newest wins) and cap to last SKILL_BADGE_CAP. Without this, a chatty assistant could grow the badge
      // list unbounded over a long session.
      setLoadedSkills((prev) => {
        const filtered = prev.filter((s) => s.name !== event.name);
        const next = [
          ...filtered,
          {
            name: event.name,
            description: event.description,
          },
        ];
        if (next.length > SKILL_BADGE_CAP) {
          return next.slice(next.length - SKILL_BADGE_CAP);
        }
        return next;
      });
    });
    // M2: ask-user-question timeout — drop the stale card so the user does not silently click into a no-op. The renderer
    // subscribes to the explicit timeout channel emitted by AskUserQuestionGate.
    const unsubAskTimeout = api.onAskUserQuestionTimeout?.(({ requestId }) => {
      setAskQuestions((prev) => prev.filter((q) => q.id !== requestId));
    });
    return () => {
      alive = false;
      unsubAsk?.();
      unsubSpawn?.();
      unsubSkill?.();
      unsubAskTimeout?.();
    };
  }, [api, ownsSession, drawsOrOwns]);

  const dismissAskQuestion = useCallback((id: string) => {
    setAskQuestions((prev) => prev.filter((q) => q.id !== id));
  }, []);

  /**
   * Seed the panel from sub-agent rows rebuilt on disk after a restart.
   *
   * Merges rather than replaces: a live event may already have produced a row
   * for the same `spawnId` (a restored session whose child is running again via
   * resume), and a restored row must never clobber live state that is strictly
   * fresher than the file it came from.
   */
  const restoreSubAgentSpawns = useCallback((restored: readonly RestoredSubAgentRow[]) => {
    setSubAgentSpawns((prev) => {
      const known = new Set(prev.map((spawn) => spawn.spawnId));
      const rows = restored
        .filter((row) => !known.has(row.spawnId))
        .map((row): SubAgentSpawn => ({
          spawnId: row.spawnId,
          title: row.title || "(sub-agent)",
          status: restoredSpawnStatus(row),
          restored: true,
          entries: [],
          toolCallCount: 0,
          childSessionId: row.childSessionId,
          ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
        }));
      return rows.length > 0 ? [...prev, ...rows] : prev;
    });
  }, []);

  /** Session reset clears old badges and spawn rows but preserves adopted questions until answer, dismissal or host timeout. */
  const resetForNewSession = useCallback(() => {
    setLoadedSkills([]);
    setSubAgentSpawns([]);
  }, []);

  return {
    askQuestions,
    subAgentSpawns,
    restoreSubAgentSpawns,
    loadedSkills,
    dismissAskQuestion,
    resetForNewSession,
  };
}
