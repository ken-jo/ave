import type * as Runtime from "@anthropic-ai/sandbox-runtime";
import { vi } from "vitest";

export function windowsProfileReadStatus(state: Runtime.WindowsProfileGrantStatus["state"] = "none"): Runtime.WindowsProfileGrantStatus {
  return {
    state, capabilities: [], notGranted: [], selfClosed: [], unverifiable: [], unprotected: [],
    staleAllow: [], replacedFiles: [], extraExclusions: [], exclusions: [], ungrantedOnly: [],
    counts: { containers: 0, granted: 0, files: 0, denied: 0 }, env: {},
  };
}

/** Pair with a mocked initialize only; native enforcement must report its own profile state. */
export function mockWindowsProfileIsolation(runtime: typeof Runtime) {
  return [
    vi.spyOn(runtime.SandboxManager, "getWindowsProfileRead").mockReturnValue("absent"),
    vi.spyOn(runtime, "getWindowsProfileReadStatusAsync").mockResolvedValue(windowsProfileReadStatus()),
  ] as const;
}
