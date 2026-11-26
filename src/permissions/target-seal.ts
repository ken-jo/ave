import { withLocalityDecision } from "../shared/local-path-io.js";
import type { ApprovalPersistenceGuard } from "./approval-persistence-guard.js";

/**
 * What a judgment observed about its original operands, carried to each effect the judgment authorizes. `verify` observes
 * the same operands again and refuses any difference; it never adopts the new answer. An effect checks its seals
 * synchronously with the effect itself, after its last wait.
 */
export interface TargetSeal {
  verify(): void;
}

/** Seal what `observe` reports now. Inside a running decision the seal shares that decision's observations. */
export function sealTargets(observe: () => string): TargetSeal {
  return sealTargetObservation(observe, (identity) => identity).seal;
}

export function sealTargetObservation<T>(observe: () => T, identity: (observation: T) => string): { observation: T; seal: TargetSeal } {
  const observation = withLocalityDecision(observe);
  const expected = identity(observation);
  return {
    observation,
    seal: {
      verify: () => {
        if (identity(withLocalityDecision(observe)) !== expected) throw new Error("Target identity changed");
      },
    },
  };
}

/** Whether every seal still holds, observed in one decision. A failed observation does not hold. */
export function sealsHold(...seals: ReadonlyArray<TargetSeal | undefined>): boolean {
  try {
    withLocalityDecision(() => { for (const seal of seals) seal?.verify(); });
    return true;
  } catch {
    return false;
  }
}

/** A persistence guard whose synchronous commit check also requires `seals` to hold. */
export function sealedPersistenceGuard(guard: ApprovalPersistenceGuard | undefined, ...seals: ReadonlyArray<TargetSeal | undefined>): ApprovalPersistenceGuard {
  const isCurrent = (): boolean => (guard === undefined || guard.isCurrent()) && sealsHold(...seals);
  return { isCurrent, refresh: async () => (guard === undefined || await guard.refresh()) && isCurrent() };
}
