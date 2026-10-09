/**
 * Whether the cases that need a live sandbox may run here — and whether being
 * unable to run them is allowed to be silent.
 *
 * Shared by every suite that spawns a confined child and asserts what the
 * kernel refused (`confined-plugin-child.test.ts`, `adversarial-escapes.test.ts`),
 * so "the sandbox is not here" is decided by one rule rather than by a copy per
 * file that could drift into a quieter one.
 *
 * Returning false lets a file be developed on a machine without the backend.
 * It is ALSO how such cases pass without measuring anything, which is not a
 * theoretical concern: the Linux runner that runs the whole suite on every pull
 * request has no bubblewrap, so `asrtCanInitialize()` is false there and the
 * cases that call this return immediately — no skip mark, no warning, green.
 * The confinement jobs in `ci.yml` are where these cases measure.
 *
 * `AVE_REQUIRE_SANDBOX_CASES` is how an environment that is supposed to run
 * them says so. With it set, a machine that cannot initialize the sandbox fails
 * HERE, loudly, instead of reporting a measurement it never took. It only ever
 * turns a silent pass into a failure; nothing about the cases themselves reads
 * it.
 */
import { asrtCanInitialize } from "../../../permissions/__tests__/test-helpers.js";

/** Set by the CI jobs whose green must mean "measured". */
export function sandboxCasesRequired(): boolean {
  return process.env.AVE_REQUIRE_SANDBOX_CASES === "1";
}

export async function sandboxCasesRun(): Promise<boolean> {
  if (await asrtCanInitialize()) return true;
  if (sandboxCasesRequired()) {
    throw new Error(
      "AVE_REQUIRE_SANDBOX_CASES=1 but the ASRT sandbox cannot initialize on this "
        + "machine, so the confinement cases would pass without measuring anything. "
        + "Install the platform backend (macOS needs none; Linux needs bubblewrap) or "
        + "unset the variable and accept that these cases do not run here.",
    );
  }
  return false;
}
