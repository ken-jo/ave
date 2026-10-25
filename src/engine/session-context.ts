// Carry session identity through turn-scoped async chains, including in-process loopback calls.
// Delegates use this identity for session-only activation rather than global enabled state.
import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionContextStore {
  readonly sessionId: string;
}

export const sessionContext = new AsyncLocalStorage<SessionContextStore>();
