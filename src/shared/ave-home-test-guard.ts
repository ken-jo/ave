/**
 * Where the test runner checks that no test reaches the person's real
 * `~/.ave`.
 *
 * In the app these do nothing, and nothing in the environment changes that:
 * the test configuration swaps this module for
 * `src/__tests__/support/ave-home-isolation-guard.ts`
 * (`vitest.analysis.config.ts`), and every build bundles this one. The swap is
 * by module, not by an environment variable, so an app started from a shell
 * that happens to export `VITEST` resolves its home exactly like any other.
 *
 * The swap reaches only modules the test runner loads. A process a test
 * starts — a plugin child, a worker, the e2e app — runs this no-op module, so
 * it must be given a home of its own explicitly: a plugin child receives the
 * host's resolved `aveHome` in its construction payload and runs with a
 * throwaway sandbox HOME (`plugins/isolation/plugin-child-runtime.ts`); the
 * worker-spawn smoke stubs `AVE_HOME` to a temporary root
 * (`permissions/__tests__/worker-spawn-uds.smoke.test.ts`); the e2e fixture
 * sets HOME, USERPROFILE, AVE_HOME and `--user-data-dir` to temporaries
 * (`test/e2e/ui/fixtures.ts`); and a child spawned with the test's own
 * environment inherits the test file's AVE_HOME.
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
