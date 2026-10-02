/**
 * Where the test runner checks that no test reaches the person's real
 * `~/.ave`.
 *
 * In the app these do nothing, and nothing in the environment changes that:
 * the test configuration swaps this module for
 * `src/__tests__/support/ave-home-isolation-guard.ts`
 * (`vitest.analysis.config.ts`), and every build bundles this one. The swap is
 * by module, not by an environment variable, so an app started from a shell
 * that happens to export `VITEST` behaves exactly like any other.
 */

/** False here; true in the module the test runner puts in its place. */
export const AVE_HOME_ISOLATION_GUARD_ACTIVE: boolean = false;

/** Called with every Ave home `aveHome()` resolves. */
export function checkResolvedAveHome(_home: string): void {}

/** Called with every sandbox root the boot sweep is about to empty. */
export function checkSandboxSweepRoot(_root: string): void {}

/**
 * The directory a test with no AVE_HOME keeps the sandbox private roots in,
 * in place of `<AVE_HOME>/sandbox`. Undefined here: the app uses its home.
 */
export function testSandboxPrivateBase(): string | undefined {
  return undefined;
}
