// Dependency failures may contain local paths: keep raw wording in host logs and map user surfaces to codes. Unknown wording still fails as dependency-check-failed; drift tests pin package messages.
import type { SandboxStartFailureCause } from "../shared/sandbox-capability-info.js";

const LINUX_DEPENDENCY_PATTERNS: ReadonlyArray<readonly [RegExp, SandboxStartFailureCause]> = [
  [/\bbubblewrap \(bwrap\) not (?:installed|executable)\b/, "missing-bwrap"],
  [/^socat not (?:installed|executable)\b/, "missing-socat"],
  [/^ripgrep \(.*\) not found\b/, "missing-ripgrep"],
];

// ASRT's `resolveSrtWin` wording when the bundled srt-win binary is not there (`srt_win_not_found`): a packaging fault that reinstalling Ave repairs.
const WINDOWS_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /^no srt-win path configured\b/,
  /^windows\.srtWin\.path is set to '.*' but the file does not exist\b/,
];

// The causes behind a failed dependency check, in first-seen order without repeats. On Windows a missing srt-win binary is its own cause; every other dependency error is the srt-win user or WFP state, which the one-time administrator setup provisions.
export function classifySandboxDependencyErrors(
  platform: NodeJS.Platform,
  errors: readonly string[],
  dependencyFailure?: unknown,
): SandboxStartFailureCause[] {
  if (errors.length === 0) {
    throw new Error("classifySandboxDependencyErrors: called without a dependency error");
  }
  const causes: SandboxStartFailureCause[] = [];
  if (platform === "win32") {
    const seen = new Set<object>();
    let failure = dependencyFailure;
    while (failure !== null && typeof failure === "object" && !seen.has(failure)) {
      seen.add(failure);
      const { code, cause } = failure as { code?: unknown; cause?: unknown };
      if (code === "srt-win-not-found") return ["windows-sandbox-missing"];
      if (code === "srt-win-integrity-mismatch") return ["windows-sandbox-integrity-failed"];
      failure = cause;
    }
  }
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
