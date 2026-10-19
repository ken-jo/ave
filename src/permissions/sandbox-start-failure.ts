/**
 * Classify why the ASRT sandbox could not start, once, at the boot gate.
 *
 * ASRT reports a failed dependency check as English free text — "bubblewrap
 * (bwrap) not installed", "socat not executable at <path>" — which can carry
 * local paths and is not localized. Those strings stay in the main-process log
 * and in `SandboxBootOutcome.dependencyErrors`; every surface that tells the
 * user why the sandbox is unavailable renders the codes this returns instead.
 *
 * The patterns below are ASRT's own wording (sandbox-runtime
 * `linux-sandbox-utils.js` / `sandbox-manager.js`); the companion test reads
 * the installed package to catch an upstream rename. A message that matches
 * none of them is still a failed check, so it is reported as
 * `dependency-check-failed` rather than dropped.
 */
import type { SandboxStartFailureCause } from "../shared/sandbox-capability-info.js";

const LINUX_DEPENDENCY_PATTERNS: ReadonlyArray<readonly [RegExp, SandboxStartFailureCause]> = [
  [/\bbubblewrap \(bwrap\) not (?:installed|executable)\b/, "missing-bwrap"],
  [/^socat not (?:installed|executable)\b/, "missing-socat"],
  [/^ripgrep \(.*\) not found\b/, "missing-ripgrep"],
];

/**
 * The causes behind a failed dependency check, in first-seen order without
 * repeats. On Windows every dependency error is the srt-win user or WFP state,
 * which the one-time administrator setup provisions.
 */
export function classifySandboxDependencyErrors(
  platform: NodeJS.Platform,
  errors: readonly string[],
): SandboxStartFailureCause[] {
  if (errors.length === 0) {
    throw new Error("classifySandboxDependencyErrors: called without a dependency error");
  }
  if (platform === "win32") return ["windows-setup-incomplete"];
  const causes: SandboxStartFailureCause[] = [];
  for (const error of errors) {
    const match = LINUX_DEPENDENCY_PATTERNS.find(([pattern]) => pattern.test(error));
    const cause = match ? match[1] : "dependency-check-failed";
    if (!causes.includes(cause)) causes.push(cause);
  }
  return causes;
}
