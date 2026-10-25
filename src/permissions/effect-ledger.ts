// Only host-mediated effects classify read/write; plugin risk hints are untrusted. Async-local, per-invocation ledgers prevent concurrent/nested leaks; these records only feed a non-HMAC shadow sink and never decide permission.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  CHOKEPOINT_EFFECT,
  type ChokepointKind,
  type Effect,
  type StaticChokepointKind,
} from "./effect-kind.js";

// One host-mediated effect observed during an invocation. `kind` is a ChokepointKind naming the host chokepoint (e.g. `"config.set"`, `"hostFetch"`); `target` is a coarse, NON-SECRET descriptor (origin, config key, worker id) kept for forensic pivoting — callers must never pass secret VALUES here.
export interface EffectEntry {
  kind: ChokepointKind;
  effect: Effect;
  target?: string;
}

// Aggregate read/write classification for one invocation.
export interface EffectSummary {
  // The owning ledger's EffectLedger.correlationId. Threaded into BOTH the category shadow and the effect shadow for one invocation so the two rows join in the reconciliation dataset.
  correlationId: string;
  // True iff any recorded effect was a `"write"`. The host-owned read/write bit.
  hasMutatingEffect: boolean;
  // The recorded effects in observation order (defensive copy).
  effects: EffectEntry[];
}

// A request-scoped, in-memory ledger. Not thread-shared; one per invocation.
export interface EffectLedger {
  // Stable id for this invocation's ledger — included in the audit record.
  readonly correlationId: string;
  // Append one observed effect.
  record(entry: EffectEntry): void;
  // Compute the aggregate read/write classification.
  summary(): EffectSummary;
}

// Create a fresh, request-scoped effect ledger. Pure in-memory; no global state. Pass an explicit `correlationId` only in tests that pin the id.
export function createEffectLedger(correlationId?: string): EffectLedger {
  const id = correlationId ?? randomUUID();
  const effects: EffectEntry[] = [];
  return {
    correlationId: id,
    record(entry: EffectEntry): void {
      effects.push(entry);
    },
    summary(): EffectSummary {
      return {
        correlationId: id,
        hasMutatingEffect: effects.some((e) => e.effect === "write"),
        effects: effects.slice(),
      };
    },
  };
}

const storage = new AsyncLocalStorage<EffectLedger>();

// Run `fn` with `ledger` bound as the ambient invocation ledger. The executor wraps each tool `execute` in this so the in-process plugin hostApi closures (reached through the loopback transport, which preserves the async chain — the same propagation `currentInvocationOrigin` relies on) record onto the right ledger. Nesting is correct: a re-entrant `callTool` opens its own scope with its own ledger, so inner mutations never double-count on the outer.
export function runWithEffectLedger<T>(
  ledger: EffectLedger,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ledger, fn);
}

// Read the ambient ledger, or `undefined` outside an invocation scope.
export function currentEffectLedger(): EffectLedger | undefined {
  return storage.getStore();
}

// Record an effect onto the ambient ledger if one is bound; a no-op otherwise (boot-time / out-of-invocation hostApi calls observe nothing). Lets a hostApi closure record without branching on currentEffectLedger itself.
export function recordEffect(entry: EffectEntry): void {
  storage.getStore()?.record(entry);
}

// Record a STATIC-effect chokepoint onto the ambient ledger, sourcing the read/write class from the CHOKEPOINT_EFFECT SOT rather than repeating a string literal at the call-site. `hostFetch` is excluded — its effect is verb-derived and recorded explicitly via recordEffect.
export function recordChokepoint(kind: StaticChokepointKind, target?: string): void {
  recordEffect({ kind, effect: CHOKEPOINT_EFFECT[kind], target });
}
