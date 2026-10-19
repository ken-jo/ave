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
 * ASRT's `resolveSrtWin` wording when the bundled srt-win binary is not there
 * (`srt_win_not_found`): a packaging fault that reinstalling Ave repairs.
 */
const WINDOWS_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /^no srt-win path configured\b/,
  /^windows\.srtWin\.path is set to '.*' but the file does not exist\b/,
];

/**
 * The causes behind a failed dependency check, in first-seen order without
 * repeats. On Windows a missing srt-win binary is its own cause; every other
 * dependency error is the srt-win user or WFP state, which the one-time
 * administrator setup provisions.
 */
export function classifySandboxDependencyErrors(
  platform: NodeJS.Platform,
  errors: readonly string[],
): SandboxStartFailureCause[] {
  if (errors.length === 0) {
    throw new Error("classifySandboxDependencyErrors: called without a dependency error");
  }
  const causes: SandboxStartFailureCause[] = [];
  for (const error of errors) {
    const cause = platform === "win32" ? windowsCause(error) : linuxCause(error);
    if (!causes.includes(cause)) causes.push(cause);
  }
  return causes;
}

function windowsCause(error: string): SandboxStartFailureCause {
  return WINDOWS_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(error))
    ? "windows-sandbox-missing"
    : "windows-setup-incomplete";
}

function linuxCause(error: string): SandboxStartFailureCause {
  const match = LINUX_DEPENDENCY_PATTERNS.find(([pattern]) => pattern.test(error));
  return match ? match[1] : "dependency-check-failed";
}
