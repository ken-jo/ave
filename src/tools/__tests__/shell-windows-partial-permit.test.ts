vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, describe, expect, it, vi } from "vitest";
import { BashTool, PowerShellTool } from "../shell-tools.js";
import type { ToolExecutionContext } from "../types.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  getHostShellExecutionPlan,
} from "../../permissions/sandbox-capability.js";
import { buildHostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import {
  partialWindowsAsrt,
  requestedSandboxUnavailable,
} from "../../__tests__/support/host-shell-sandbox-fixtures.js";

const ORIGINAL_PLATFORM = process.platform;

function context(plan: ToolExecutionContext["hostShellExecutionPlan"]): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    hostShellExecutionPlan: plan,
    metadata: { toolUseId: "direct-call" },
  };
}

const SHELLS = [
  {
    name: "bash",
    create: () => new BashTool(),
    input: { command: "echo permit", timeoutSeconds: 5 },
  },
  {
    name: "powershell",
    create: () => new PowerShellTool(),
    input: { command: "Write-Output permit", timeoutSeconds: 5 },
  },
] as const;

describe("builtin shell — Windows partial Plan-B permit", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(ORIGINAL_PLATFORM);
  });

  it.each(SHELLS)("rejects a direct call even with a getter-issued plan ($name)", async ({ create, input }) => {
    partialWindowsAsrt();

    const result = await create().execute(input, context(getHostShellExecutionPlan()));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("one-shot host approval permit");
  });

  it.each(SHELLS)("rejects a forged structural plan ($name)", async ({ create, input }) => {
    partialWindowsAsrt();
    const forgedPlan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: false,
      activeCapability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        reason: "forged off",
        confines: { filesystem: false, process: false, network: false },
      },
    });

    const result = await create().execute(input, context(forgedPlan));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("was not issued by the host");
  });

  // Unavailable sandboxing follows normal permission rules without a permit.
  // Explicit non-Windows host execution still requires an allow-once receipt or rule-minted permit.
  it.each(["darwin", "linux", "win32"] as const)(
    "rejects permit-less direct Bash/PowerShell calls for an explicit host request on %s",
    async (platform) => {
      requestedSandboxUnavailable(platform);
      const plan = getHostShellExecutionPlan("host");
      expect(plan).toMatchObject({
        platform,
        executionRequest: "host",
        mode: "plain",
        fallbackReason: "none",
        requiresExplicitUserApproval: true,
      });

      for (const shell of SHELLS) {
        const result = await shell.create().execute(
          { ...shell.input, executionMode: "host", justification: "Direct call without a permit" },
          context(plan),
        );
        expect(result.isError).toBe(true);
        expect(result.output).toContain("one-shot host approval permit");
      }
    },
  );});
