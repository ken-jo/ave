/** The user-typed turn a command for the user's own host terminal belongs to. Only the model query owner enters this context, and only for a
 * turn the user typed at the keyboard with no remote controller, unattended authority, agent message or attachment behind it; every other
 * turn (a routine, a plugin or app message, a sub-agent, an agent-to-agent message) runs with none. The approval, the final PTY write, the
 * disclosed output and its continuation are each bound to this turn, and the capability ends when the turn does. Tool metadata carries no
 * authority here: a tool can only read the turn it is running inside. */
import { AsyncLocalStorage } from "node:async_hooks";

export interface HostTerminalTurn {
  readonly sessionId: string;
  readonly turnId: string;
  /** False once the turn has ended. */
  isCurrent(): boolean;
  /** Run `listener` once when the turn ends (at once if it already has); returns the unsubscribe. */
  onEnd(listener: () => void): () => void;
}

interface TurnState {
  readonly sessionId: string;
  readonly turnId: string;
  active: boolean;
  readonly endListeners: Set<() => void>;
}

const turnContext = new AsyncLocalStorage<TurnState | undefined>();

/** Run one turn. `identity` is set only for an eligible user-typed turn; `undefined` masks any enclosing turn (a sub-agent run inside it). */
export async function runWithHostTerminalTurn<T>(identity: { sessionId: string; turnId: string } | undefined, run: () => Promise<T>): Promise<T> {
  if (identity === undefined) return turnContext.run(undefined, run);
  const state: TurnState = { ...identity, active: true, endListeners: new Set() };
  return turnContext.run(state, async () => {
    try { return await run(); }
    finally {
      state.active = false;
      const listeners = [...state.endListeners];
      state.endListeners.clear();
      for (const listener of listeners) listener();
    }
  });
}

/** The live user turn of `sessionId` the caller runs inside, or undefined. */
export function currentHostTerminalTurn(sessionId: string | undefined): HostTerminalTurn | undefined {
  const state = turnContext.getStore();
  if (!state?.active || sessionId === undefined || state.sessionId !== sessionId) return undefined;
  return Object.freeze({
    sessionId: state.sessionId,
    turnId: state.turnId,
    isCurrent: () => state.active,
    onEnd: (listener: () => void) => {
      if (!state.active) { listener(); return () => {}; }
      state.endListeners.add(listener);
      return () => { state.endListeners.delete(listener); };
    },
  });
}
