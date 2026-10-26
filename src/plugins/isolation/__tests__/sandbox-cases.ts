/** Sandbox-required jobs must fail when confinement cannot initialize; optional local runs report a skip. */
import type { TestContext } from "vitest";
import { asrtCanInitialize } from "../../../permissions/__tests__/test-helpers.js";

/** Required measurement flag for confinement jobs. */
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

/** Report unavailable confinement as a skip locally and a failure in required jobs. */
export async function requireSandboxCases(test: TestContext): Promise<void> {
  if (!(await sandboxCasesRun())) test.skip("ASRT cannot initialize (sandbox dependencies missing)");
}
