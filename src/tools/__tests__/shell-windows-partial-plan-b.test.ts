vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("../../shared/powershell-executable.js", () => ({
  resolveTrustedPowerShellExecutable: (platform: NodeJS.Platform = process.platform) => ({
    executable: platform === "win32" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : "/opt/microsoft/powershell/7/pwsh", kind: "pwsh",
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: childProcessMock.spawn,
    execFileSync: childProcessMock.execFileSync,
  };
});

import { BashTool, PowerShellTool } from "../shell-tools.js";
import type { ToolExecutionContext } from "../types.js";
import { mintOneShotHostShellPermit as mintOneShotPermit } from "../../__tests__/support/host-shell-approval.js";
import {
  getHostShellExecutionPlanAuditProjection,
  type HostShellExecutionPlan,
} from "../../permissions/host-shell-execution-plan.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  getHostShellExecutionPlan,
  isIssuedHostShellExecutionPlan,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const ORIGINAL_PLATFORM = process.platform;
const CHILD_OUTPUT = "native Windows Plan-B child output";

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(parser: boolean): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });

  queueMicrotask(() => {
    const output = parser
      ? JSON.stringify({
          errors: [], redirections: [], unsupported: [],
          commands: [
            {
              name: "Write-Output",
              arguments: [{ kind: "literal", text: "Write-Output", value: "Write-Output" }, { kind: "literal", text: "native-plan-b", value: "native-plan-b" }],
              text: "Write-Output native-plan-b",
            },
          ],
        })
      : `${CHILD_OUTPUT}\n`;
    child.stdout.end(output);
    child.stderr.end();
    child.exitCode = 0;
    child.emit("close", 0);
  });
  return child;
}

function issueWindowsPlanB(): HostShellExecutionPlan {
  setProcessPlatform("win32");
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason: "srt-win partial",
    confines: { filesystem: true, process: false, network: true },
  });
  setShellSandboxRequestedAtBoot(true);
  return getHostShellExecutionPlan();
}

function issueRequestedUnavailable(platform: "darwin" | "linux" | "win32"): HostShellExecutionPlan {
  setProcessPlatform(platform);
  __resetActiveSandboxCapabilityForTest();
  setShellSandboxRequestedAtBoot(true);
  return getHostShellExecutionPlan();
}

const SHELLS = [
  {
    label: "BashTool",
    toolName: "bash" as const,
    create: () => new BashTool(),
    input: { command: "echo native-plan-b", timeoutSeconds: 7 },
    expectedSpawnCount: 1,
  },
  {
    label: "PowerShellTool",
    toolName: "powershell" as const,
    create: () => new PowerShellTool(),
    input: { command: "Write-Output native-plan-b", timeoutSeconds: 7 },
    // A direct native AST parse precedes the one approved plain child.
    expectedSpawnCount: 2,
  },
] as const;

describe("builtin shell - Windows partial Plan-B native execution", () => {
  beforeEach(() => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    __resetShellResolverCache();
    childProcessMock.spawn.mockReset();
    childProcessMock.execFileSync.mockReset();
    // Mock the Windows shell capability probe too so no real host child starts.
    childProcessMock.execFileSync.mockImplementation((_file, args) => args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB가😀\0" : "__ave_shell_ok__");
    childProcessMock.spawn.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        options?: { stdio?: unknown },
      ) => {
        const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
        return fakeChild(parser);
      },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetShellResolverCache();
    setProcessPlatform(ORIGINAL_PLATFORM);
    childProcessMock.spawn.mockReset();
    childProcessMock.execFileSync.mockReset();
  });

  it.each(SHELLS)(
    "runs an HMAC-approved one-shot plain child for $label",
    async ({ toolName, create, input, expectedSpawnCount }) => {
      const plan = issueWindowsPlanB();
      expect(plan.platform).toBe("win32");
      expect(isIssuedHostShellExecutionPlan(plan)).toBe(true);

      const toolUseId = `${toolName}-native-plan-b`;
      const baseContext = {
        cwd: process.cwd(),
        extraAllowedDirectories: [] as const,
      };
      const permit = await mintOneShotPermit({
        plan,
        toolName,
        toolUseId,
        rawInput: input,
        context: baseContext,
      });
      const context: ToolExecutionContext = {
        ...baseContext,
        hostShellExecutionPlan: plan,
        hostShellExecutionPermit: permit,
        metadata: { toolUseId },
      };

      const first = await create().execute(input, context);

      expect(first).toMatchObject({
        output: CHILD_OUTPUT,
        isError: false,
        metadata: {
          returncode: 0,
          sandboxed: false,
          isolation: "none",
        },
      });
      expect(first.metadata?.sandboxExecutionPlan).toBe(
        getHostShellExecutionPlanAuditProjection(plan),
      );
      expect(childProcessMock.spawn).toHaveBeenCalledTimes(expectedSpawnCount);

      const nativeCall = childProcessMock.spawn.mock.calls.find((call) => {
        const options = call[2] as { stdio?: unknown } | undefined;
        return Array.isArray(options?.stdio) && options.stdio[0] === "ignore";
      });
      if (nativeCall === undefined) throw new Error("native child spawn was not observed");
      const nativeArgs = nativeCall[1] as readonly string[];
      const nativeOptions = nativeCall[2] as {
        cwd?: string;
        shell?: boolean;
        stdio?: unknown;
      };
      if (toolName === "powershell") {
        expect(nativeArgs.at(-1)).toEqual(expect.stringContaining("$PSModuleAutoLoadingPreference = 'None'"));
        expect(nativeArgs.at(-1)?.endsWith(input.command)).toBe(true);
        expect(nativeArgs.slice(0, -2)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned"]);
        expect((nativeCall[2] as { env: Record<string, string> }).env.PSModulePath).toBe("");
      } else expect(nativeArgs).toContain(input.command);
      expect(nativeOptions).toMatchObject({
        cwd: baseContext.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // The same opaque permit is irreversibly consumed before the first spawn.
      const spawnCountAfterFirst = childProcessMock.spawn.mock.calls.length;
      const replay = await create().execute(input, context);
      expect(replay).toMatchObject({
        isError: true,
        metadata: { sandboxed: false, isolation: "none" },
      });
      expect(replay.output).toContain("one-shot host approval permit");
      expect(childProcessMock.spawn).toHaveBeenCalledTimes(spawnCountAfterFirst);
    },
  );
});


describe.each(["darwin", "linux", "win32"] as const)(
  "builtin shell - requested-unavailable %s native execution",
  (platform) => {
    beforeEach(() => {
      // The win32 group resolves Windows shells on POSIX runners too, which needs SystemRoot.
      vi.stubEnv("SystemRoot", "C:\\Windows");
      __resetShellResolverCache();
      childProcessMock.spawn.mockReset();
      childProcessMock.execFileSync.mockReset();
      childProcessMock.execFileSync.mockImplementation((_file, args) => args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB가😀\0" : "__ave_shell_ok__");
      childProcessMock.spawn.mockImplementation(
        (
          _command: string,
          _args: readonly string[],
          options?: { stdio?: unknown },
        ) => {
          const parser = Array.isArray(options?.stdio) && options.stdio[0] === "pipe";
          return fakeChild(parser);
        },
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      __resetActiveSandboxCapabilityForTest();
      __resetSandboxRequestedAtBootForTest();
      __resetShellResolverCache();
      setProcessPlatform(ORIGINAL_PLATFORM);
      childProcessMock.spawn.mockReset();
      childProcessMock.execFileSync.mockReset();
    });

    // Unavailable sandboxing retains its fallback plan; unpinned startup still needs one-shot authority.
    it.each(SHELLS)(
      "runs $label with the route's required authority and records the fallback plan",
      async ({ toolName, create, input, expectedSpawnCount }) => {
        const plan = issueRequestedUnavailable(platform);
        expect(plan).toMatchObject({
          platform,
          requestedSandbox: true,
          mode: "plain",
          fallbackReason: "requested-sandbox-unavailable",
          requiresExplicitUserApproval: false,
        });
        const toolUseId = `${toolName}-requested-unavailable-${platform}`;
        const context: ToolExecutionContext = {
          cwd: process.cwd(),
          extraAllowedDirectories: [],
          hostShellExecutionPlan: plan,
          metadata: { toolUseId },
        };

        if (platform === "win32" && toolName === "powershell") {
          const refused = await create().execute(input, context);
          expect(refused).toMatchObject({ isError: true, metadata: { sandboxed: false, isolation: "none" } });
          expect(refused.output).toContain("one-shot host approval permit");
          expect(childProcessMock.spawn).not.toHaveBeenCalled();
          context.hostShellExecutionPermit = await mintOneShotPermit({ plan, toolName, toolUseId, rawInput: input, context });
        }

        const first = await create().execute(input, context);
        expect(first).toMatchObject({
          output: CHILD_OUTPUT,
          isError: false,
          metadata: { sandboxed: false, isolation: "none" },
        });
        expect(first.metadata?.sandboxExecutionPlan).toBe(
          getHostShellExecutionPlanAuditProjection(plan),
        );
        expect(childProcessMock.spawn).toHaveBeenCalledTimes(expectedSpawnCount);
      },
    );
  },
);
