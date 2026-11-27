import { resolve } from "node:path";
import { fileIdentityKey } from "../lib/file-identity.js";
import { admitLocalPath, admitLocalRoute, localFs, withLocalityDecision } from "../shared/local-path-io.js";

/**
 * What a judgment observed about its original operands, carried to each effect the judgment authorizes. `verify` observes
 * the same operands again and refuses any difference; it never adopts the new answer. An effect checks its seals
 * synchronously with the effect itself, after its last wait.
 */
export interface TargetSeal {
  verify(): void;
  /** Runtime spelling of a file operand captured with its authorization. */
  pathFor?(path: string): string | undefined;
  /** Physical parent with the original name retained for a by-name mutation. */
  entryFor?(path: string): string | undefined;
  /** Keep checking the route after an authorized operation has changed this entry. */
  afterMutation?(path: string): TargetSeal;
}

export class TargetIdentityChangedError extends Error {
  constructor() {
    super("Target identity changed");
  }
}

export interface WindowsTargetObservation {
  path: string;
  ancestor: string;
  identity: string;
}

function identityAt(path: string): string {
  const stats = localFs.lstatBigint(admitLocalPath(path));
  if (stats === undefined || stats.isSymbolicLink()) throw new TargetIdentityChangedError();
  return fileIdentityKey(stats);
}

export function observeWindowsTarget(path: string, rejectDanglingLink = false): WindowsTargetObservation {
  return withLocalityDecision(() => {
    const route = admitLocalRoute(resolve(path), { projectMissing: true, rejectDanglingLink });
    if (route.physical === undefined || route.existingAncestor === undefined) throw new TargetIdentityChangedError();
    return { path: route.physical, ancestor: route.existingAncestor, identity: identityAt(route.existingAncestor) };
  });
}

export function assertWindowsTarget(expected: WindowsTargetObservation, actual: WindowsTargetObservation, allowCreatedDirectory = false): void {
  if (actual.path !== expected.path) throw new TargetIdentityChangedError();
  if (actual.ancestor === expected.ancestor) {
    if (actual.identity !== expected.identity) throw new TargetIdentityChangedError();
    return;
  }
  // Some effects create missing parent directories. Keep the originally admitted ancestor pinned.
  if (expected.ancestor === expected.path || (!allowCreatedDirectory && actual.ancestor === actual.path) ||
      identityAt(expected.ancestor) !== expected.identity) {
    throw new TargetIdentityChangedError();
  }
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
        if (identity(withLocalityDecision(observe)) !== expected) throw new TargetIdentityChangedError();
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
