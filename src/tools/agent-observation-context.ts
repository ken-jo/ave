import { AsyncLocalStorage } from "node:async_hooks";
import type { ObservationIdentity } from "../shared/agent-observation.js";
import { currentInvocationOrigin } from "../plugins/runtime/origin-chain.js";

export type ObservedFileEffect = { path: string } & ({ content: Buffer | string | null } | { copyFrom: string });
export interface AgentObservationSink {
  openJournal(identity: ObservationIdentity, homePath: string): { poll(): void; finish(): Promise<void>; dispose(): void };
  beforeMutation(identity: ObservationIdentity, effects: readonly ObservedFileEffect[]): Promise<(completed: boolean) => Promise<void>>;
  finishInvocation(identity: ObservationIdentity): Promise<void>;
  revokeInvocation(identity: ObservationIdentity): void;
  finishTurn(sessionId: string, turnId: string): void;
}

interface ObservationTurn { sessionId: string; turnId: string; active: boolean; revocations: Set<() => void> }
interface ObservationInvocation { identity: ObservationIdentity; turn: ObservationTurn; active: boolean }
const turnContext = new AsyncLocalStorage<ObservationTurn>();
const invocationContext = new AsyncLocalStorage<ObservationInvocation | undefined>();
let observationSink: AgentObservationSink | undefined;
const homeReaders = new Map<string, { identity: ObservationIdentity; finish(): Promise<void> }>();

/** Desktop installs an observer. Its absence never changes tool authorization. */
export function setAgentObservationSink(sink: AgentObservationSink | undefined): void {
  observationSink = sink;
}

/** Only the model query owner enters this context; tool metadata carries no authority. */
export async function runWithAgentObservationTurn<T>(identity: { sessionId: string; turnId: string }, run: () => Promise<T>): Promise<T> {
  const turn: ObservationTurn = { ...identity, active: true, revocations: new Set() };
  return turnContext.run(turn, async () => {
    try { return await run(); }
    finally {
      turn.active = false;
      for (const revoke of turn.revocations) revoke();
      turn.revocations.clear();
      observationSink?.finishTurn(identity.sessionId, identity.turnId);
    }
  });
}

export function currentAgentObservationIdentity(): ObservationIdentity | undefined {
  const origin = currentInvocationOrigin();
  if (origin === "ui" || origin === "mcp-app") return undefined;
  const turn = turnContext.getStore();
  const invocation = invocationContext.getStore();
  return invocation?.active && turn?.active && invocation.turn === turn ? invocation.identity : undefined;
}

/** Native callbacks retain a revocable admission, never ambient callback metadata. */
export function captureAgentObservationInvocation(): { identity: ObservationIdentity; isCurrent(): boolean } | undefined {
  const identity = currentAgentObservationIdentity();
  const invocation = invocationContext.getStore();
  if (!identity || !invocation) return undefined;
  return { identity, isCurrent: () => invocation.active && invocation.turn.active };
}

/** Entered only after the executor's final permission/approval admission. */
export async function runWithAgentObservationInvocation<T>(
  identity: { sessionId?: string; toolUseId: string }, run: () => Promise<T>, preparedHome?: string, signal?: AbortSignal,
): Promise<T> {
  const turn = turnContext.getStore();
  const origin = currentInvocationOrigin();
  if (!turn?.active || turn.sessionId !== identity.sessionId || origin === "ui" || origin === "mcp-app") return invocationContext.run(undefined, run);
  const admitted = Object.freeze({ sessionId: turn.sessionId, turnId: turn.turnId, toolUseId: identity.toolUseId });
  const invocation = { identity: admitted, turn, active: true };
  const sink = observationSink;
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    invocation.active = false;
    sink?.revokeInvocation(admitted);
  };
  turn.revocations.add(revoke);
  signal?.addEventListener("abort", revoke, { once: true });
  return invocationContext.run(invocation, async () => {
    try {
      if (signal?.aborted) { revoke(); signal.throwIfAborted(); }
      if (preparedHome) registerAgentObservationHome(preparedHome);
      return await run();
    }
    finally {
      invocation.active = false;
      try { await sink?.finishInvocation(admitted); }
      finally {
        turn.revocations.delete(revoke);
        signal?.removeEventListener("abort", revoke);
        for (const [path, reader] of homeReaders) if (reader.identity === admitted) homeReaders.delete(path);
      }
    }
  });
}

/** The caller owns this isolated HOME; a renderer cannot register journal paths. */
export function registerAgentObservationHome(homePath: string): void {
  const identity = currentAgentObservationIdentity();
  if (!identity || !observationSink || homeReaders.has(homePath)) return;
  const sink = observationSink;
  const reader = sink.openJournal(identity, homePath);
  homeReaders.set(homePath, { identity, finish: () => reader.finish() });
}

/** Drain complete bounded records before the shell's existing HOME cleanup. */
export function drainAgentObservationHome(homePath: string): void {
  const reader = homeReaders.get(homePath);
  homeReaders.delete(homePath);
  // finish drains the capped journal and closes its reader synchronously before
  // awaiting reconciliation, so it must run before the caller's rmSync. A sync
  // throw becomes this same handled rejection; the owner's finishInvocation
  // reports either outcome.
  if (reader) void new Promise<void>((resolve) => { resolve(reader.finish()); }).catch(() => {});
}

export async function observeAgentDocumentMutation<T>(effects: readonly ObservedFileEffect[], run: () => Promise<T>): Promise<T> {
  const identity = currentAgentObservationIdentity();
  if (!identity || !observationSink) return run();
  const finish = await observationSink.beforeMutation(identity, effects);
  let completed = false;
  try {
    const result = await run();
    completed = !(result && typeof result === "object" && "isError" in result && result.isError === true);
    return result;
  } finally { await finish(completed && currentAgentObservationIdentity() === identity); }
}
