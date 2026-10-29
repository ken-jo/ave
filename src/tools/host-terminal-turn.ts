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
  /** True once any tool result has returned to the model in this turn (a file, a page, a plugin's, a browser's or a sub-agent's text, a
   * command's output, whatever the tool). It never resets within the turn. A host command after it needs a fresh person's approval. */
  externalContentSeen(): boolean;
  /** True once guidance from another principal (a staged app or plugin message, an agent's message) entered this turn. It never resets
   * within the turn, whatever the trust origin later becomes; host typing is refused while it holds. */
  otherPrincipalGuidance(): boolean;
  /** Run `listener` once when the turn ends (at once if it already has); returns the unsubscribe. */
  onEnd(listener: () => void): () => void;
}

interface TurnState {
  readonly sessionId: string;
  readonly turnId: string;
  active: boolean;
  externalContent: boolean;
  otherPrincipal: boolean;
  readonly endListeners: Set<() => void>;
}

const turnContext = new AsyncLocalStorage<TurnState | undefined>();

/** Run one turn. `identity` is set only for an eligible user-typed turn; `undefined` masks any enclosing turn (a sub-agent run inside it). */
export async function runWithHostTerminalTurn<T>(identity: { sessionId: string; turnId: string } | undefined, run: () => Promise<T>): Promise<T> {
  if (identity === undefined) return turnContext.run(undefined, run);
  const state: TurnState = { ...identity, active: true, externalContent: false, otherPrincipal: false, endListeners: new Set() };
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
    externalContentSeen: () => state.externalContent,
    otherPrincipalGuidance: () => state.otherPrincipal,
    onEnd: (listener: () => void) => {
      if (!state.active) { listener(); return () => {}; }
      state.endListeners.add(listener);
      return () => { state.endListeners.delete(listener); };
    },
  });
}

/** A tool result is entering the model-visible history of the turn the caller runs inside: from now on that turn's host commands each need
 * a fresh person's approval. Called only by the history's single append point, whatever the tool or path; there is no way to clear it. */
export function noteToolResultsReturnedToModel(): void {
  const state = turnContext.getStore();
  if (state?.active) state.externalContent = true;
}

/** Guidance from another principal (a staged app or plugin message, an agent's message) entered the turn the caller runs inside: host
 * typing is refused for the rest of it. Called where the query loop stages that guidance; there is no way to clear it. */
export function noteOtherPrincipalGuidance(): void {
  const state = turnContext.getStore();
  if (state?.active) state.otherPrincipal = true;
}
