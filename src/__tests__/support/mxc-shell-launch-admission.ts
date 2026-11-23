import { beforeEach, vi } from "vitest";
import { mxcShellCapability } from "../../boot/steps/windows-sandbox-plan.js";
import * as invocations from "../../permissions/egress-invocations.js";
import * as sandbox from "../../permissions/sandbox-capability.js";

/** Supply boot admission to fixtures that exercise request construction directly. */
export function registerMxcShellLaunchAdmissionFixture(...fixtureTokens: string[]): void {
  beforeEach(() => {
    const capability = vi.spyOn(sandbox, "detectMxcShellCapability").mockReturnValue(mxcShellCapability());
    const lookup = invocations.egressInvocationOwner;
    const shellOwner: invocations.ShellEgressOwner = {
      kind: "shell",
      toolName: "powershell",
      toolUseId: undefined,
      requiresListener: true,
      context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "unavailable" },
    };
    const owner = fixtureTokens.length === 0 ? undefined : vi.spyOn(invocations, "egressInvocationOwner")
      .mockImplementation((token) => fixtureTokens.includes(token) ? shellOwner : lookup(token));
    return () => {
      owner?.mockRestore();
      capability.mockRestore();
    };
  });
}
