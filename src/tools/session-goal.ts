// Upsert and complete one session goal through one writer; every result returns full progress and status.
import { createDynamicTool, toolErrorResult, type Tool } from "./base.js";
import {
  SessionGoalMissingError,
  SessionGoalTextError,
  type SessionGoalStore,
} from "../main/session-goal-store.js";
import { isSessionGoalAtCeiling, type SessionGoal } from "../shared/session-goal.js";
import { t } from "../i18n/index.js";

const STATUSES = ["complete", "pause", "resume"] as const;
type SessionGoalToolStatus = (typeof STATUSES)[number];

function isStatus(value: unknown): value is SessionGoalToolStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function view(goal: SessionGoal) {
  return {
    goal: goal.text,
    status: goal.status,
    round: goal.round,
    ceiling: goal.ceiling,
    atCeiling: isSessionGoalAtCeiling(goal),
  };
}

// Fail no-op updates so failed-input retry policy stops repeated full-context rounds.
function noChange(detail: string) {
  return toolErrorResult(`${detail}: nothing changed. Do not retry session_goal with the same input; continue with work tools and call session_goal again only when the goal itself changes.`);
}

export function createSessionGoalTool(store: SessionGoalStore): Tool {
  return createDynamicTool({
    name: "session_goal",
    description: t("be_sessionGoal.toolDescription"),
    source: "builtin",
    // Read-category session bookkeeping has no external or cross-session effect; goal completion must not wait behind an approval modal.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: t("be_sessionGoal.goalDesc") },
        status: {
          type: "string",
          enum: STATUSES,
          description: t("be_sessionGoal.statusDesc"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      if (typeof ctx.metadata?.sessionId !== "string" || ctx.metadata.sessionId.length === 0) {
        return toolErrorResult("missing sessionId metadata");
      }
      const sessionId = ctx.metadata.sessionId;
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const text = typeof a.goal === "string" && a.goal.trim() ? a.goal.trim() : undefined;
      if (a.status !== undefined && !isStatus(a.status)) {
        return toolErrorResult(`status must be one of ${STATUSES.join(", ")}`);
      }
      const status = isStatus(a.status) ? a.status : undefined;
      const before = store.get(sessionId);
      if (before !== null && status === undefined && text === before.text) {
        return noChange(`the goal is already "${before.text}"`);
      }
      if (before !== null && text === undefined) {
        const already =
          (status === "complete" && before.status === "complete")
          || (status === "pause" && before.status === "paused")
          || (status === "resume" && before.status === "running" && !isSessionGoalAtCeiling(before));
        if (already) return noChange(`the goal is already ${before.status}`);
      }
      const answer = (goal: SessionGoal) =>
        ({ output: JSON.stringify(view(goal)), isError: false });
      try {
        // Apply goal upsert before status so one call can create and complete; let the store own missing-goal errors.
        const upserted = text !== undefined ? await store.set(sessionId, text) : null;
        if (status === "complete") return answer(await store.complete(sessionId));
        if (status === "pause") return answer(await store.pause(sessionId));
        if (status === "resume") return answer(await store.resume(sessionId));
        if (upserted !== null) return answer(upserted);
        return toolErrorResult("session_goal needs goal (the objective) and/or status");
      } catch (err) {
        if (err instanceof SessionGoalTextError || err instanceof SessionGoalMissingError) {
          return toolErrorResult(err.message);
        }
        throw err;
      }
    },
  });
}
