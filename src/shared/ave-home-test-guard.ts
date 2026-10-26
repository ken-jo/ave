/** Tests replace this module by alias, never environment flags; spawned processes still need explicitly isolated homes. */

export const AVE_HOME_ISOLATION_GUARD_ACTIVE: boolean = false;

export function checkResolvedAveHome(_home: string): void {}

export function checkSandboxSweepRoot(_root: string): void {}

export function checkAdminPolicyPath(_path: string): void {}

export function checkSandboxStampTargets(_paths: readonly string[]): void {}

/** Tests may redirect sandbox roots independently; production uses the resolved app home. */
export function testSandboxPrivateBase(): string | undefined {
  return undefined;
}
