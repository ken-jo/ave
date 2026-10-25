// One driver per chat group reclaims a released turn lease while its goal is running and budget remains; no timer or polling.
import { canReviveSessionGoal, type SessionGoal } from "../shared/session-goal.js";
import type { SessionGoalStore } from "./session-goal-store.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
const log = createLogger("ave");

export interface SessionGoalRevivalDeps {
  goals: SessionGoalStore;
  // The session this group's conversation loop is holding right now.
  currentSessionId: () => string;
  // False once this group can no longer own a turn — it was released, or the window that renders it is gone. A goal must not resurrect a conversation nobody is looking at.
  isAttached: () => boolean;
  // This group's turn/mutation lease state.
  isBusy: () => boolean;
  // The conversation loop's own in-flight turn, independent of the lease.
  hasActiveTurn: () => boolean;
  // Acquire this group's turn lease and run `body` under it, or answer `null` when the lease is already held.
  tryTakeTurn: (body: () => Promise<void>) => Promise<void> | null;
  // Send one revival turn to the provider.
  runTurn: (turn: { input: string; displayText: string }) => Promise<void>;
}

// The text the model receives. The goal is restated every round because the conversation it is restated into may have been compacted since the round
// that set it, and the round/ceiling numbers are included so the model can see how much budget its own pace is spending.
function sessionGoalRevivalInput(goal: SessionGoal): string {
  return t("be_sessionGoalRevival.input", {
    goal: goal.text,
    round: goal.round,
    ceiling: goal.ceiling,
  });
}

// The one-line note the transcript shows in place of the revival input.
function sessionGoalRevivalNote(goal: SessionGoal): string {
  return t("be_sessionGoalRevival.note", { round: goal.round, ceiling: goal.ceiling });
}

export interface SessionGoalRevival {
  // Re-evaluate whether this group owes the goal another turn. Called when a turn lease is released and when the goal itself changes — a resume while the
  // session is idle has no turn to follow, so it has to be its own trigger or the button does nothing.
  reviveIfDue: () => void;
}

export function createSessionGoalRevival(deps: SessionGoalRevivalDeps): SessionGoalRevival {
  const eligible = (sessionId: string): SessionGoal | null => {
    if (sessionId.length === 0 || !deps.isAttached()) return null;
    const goal = deps.goals.get(sessionId);
    if (goal === null || !canReviveSessionGoal(goal)) return null;
    return goal;
  };

  const revive = async (sessionId: string): Promise<void> => {
    // Re-checked INSIDE the lease. Between the settle and the lease being granted, the user may have sent a turn, switched the tile to another conversation,
    // closed it, or told the goal to stop — and each of those has to win over a revival that was decided a moment earlier.
    if (deps.currentSessionId() !== sessionId) return;
    if (deps.hasActiveTurn()) return;
    if (eligible(sessionId) === null) return;
    // Spent BEFORE the turn runs: a revival that fails still consumed its round, because the alternative is a failing goal that revives forever.
    const spent = await deps.goals.recordRevival(sessionId);
    await deps.runTurn({
      input: sessionGoalRevivalInput(spent),
      displayText: sessionGoalRevivalNote(spent),
    });
  };

  return {
    reviveIfDue: () => {
      const sessionId = deps.currentSessionId();
      if (eligible(sessionId) === null) return;
      if (deps.isBusy() || deps.hasActiveTurn()) return;
      const lease = deps.tryTakeTurn(() => revive(sessionId));
      // A rejected revival must not take the process down with it: the goal keeps its spent round and the next settle decides again.
      lease?.catch((err: unknown) => {
        log.warn("session-goal revival turn failed: %s", (err as Error).message);
      });
    },
  };
}
