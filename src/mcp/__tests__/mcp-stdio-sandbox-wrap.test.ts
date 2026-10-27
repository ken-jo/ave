vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Check external stdio-worker confinement wiring, sensitive-path denial, sanitized spawn environment, and capability attribution.
 * Mocks verify wrapping and fail-closed write scope, not native backend enforcement. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { egressInvocationOwner } from "../../permissions/egress-invocations.js";

const spawnMock = vi.fn<
  (cmd: string, args?: readonly string[], opts?: unknown) => unknown
>();
const execFileSyncMock = vi.fn<
  (cmd: string, args?: readonly string[], opts?: unknown) => string
>();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args?: readonly string[], opts?: unknown) =>
    spawnMock(cmd, args, opts),
  execFileSync: (cmd: string, args?: readonly string[], opts?: unknown) =>
    execFileSyncMock(cmd, args, opts),
}));

// Lifecycle fixtures intercept the launch; real image verification has native tests.
vi.mock("../../permissions/srt-win-integrity.js", async (original) => ({
  ...await original<typeof import("../../permissions/srt-win-integrity.js")>(),
  assertSrtWinSpawnIntegrity: vi.fn(),
}));

const SANDBOX_HOME = "/tmp/ave-sandbox-home-test";
const sandboxHomeCleanupMock = vi.fn();
vi.mock("../../permissions/sandbox-process-home.js", () => ({
  createSandboxProcessHome: () => ({
    path: SANDBOX_HOME,
    env: {
      HOME: SANDBOX_HOME,
      XDG_CONFIG_HOME: `${SANDBOX_HOME}/config`,
    },
    cleanup: sandboxHomeCleanupMock,
  }),
}));

const grantReleaseMock = vi.fn();
const holdGrantMock = vi.fn(async (_opts: unknown) => ({
  assertAlive: () => undefined,
  onLost: () => undefined,
  release: grantReleaseMock,
}));
vi.mock("../../permissions/windows-acl-grant-holder.js", async (original) => ({
  ...(await original<typeof import("../../permissions/windows-acl-grant-holder.js")>()),
  holdWindowsFilesystemGrant: (opts: unknown) => holdGrantMock(opts),
}));

let gateActive = false;
const SANDBOX_TEMP_ROOT = "/tmp/ave-test-sandbox-tmp";
const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const cleanupMock = vi.fn(() => Promise.resolve());
vi.mock("../../permissions/asrt-sandbox.js", async () => {
  // Use the REAL default sensitive path helpers so the wrap test asserts the genuine centralized deny-lists (not a re-implementation that could drift).
  const actual = await vi.importActual<
    typeof import("../../permissions/asrt-sandbox.js")
  >("../../permissions/asrt-sandbox.js");
  return {
    assertExtensionStartAllowed: actual.assertExtensionStartAllowed,
    isAsrtSandboxActive: () => gateActive,
    isPluginWorkerConfinementActive: () => gateActive,
    wrapWorkerCommand: (command: string, options?: unknown) =>
      wrapWorkerCommandMock(command, options),
    cleanupAsrtSandboxAfterCommand: () => cleanupMock(),
    // The real naming and launcher; only the directory's creation is skipped, because the real one would make it under this file's AVE_HOME.
    ensureSandboxTempPrincipalDir: (principal: import("../../permissions/asrt-sandbox.js").SandboxTempPrincipal) => ({
      dir: join(SANDBOX_TEMP_ROOT, actual.sandboxTempPrincipalDirName(principal)),
      root: SANDBOX_TEMP_ROOT,
    }),
    sandboxTempEnvLaunch: actual.sandboxTempEnvLaunch,
    sandboxTempPrincipalDirName: actual.sandboxTempPrincipalDirName,
    getDefaultSensitiveReadDenyPaths: actual.getDefaultSensitiveReadDenyPaths,
    getDefaultSensitiveWriteDenyPaths: actual.getDefaultSensitiveWriteDenyPaths,
    appOwnedSandboxPrivateRoots: actual.appOwnedSandboxPrivateRoots,
  };
});

// Module imports must come AFTER the mocks above.
import { McpClient } from "../mcp-client.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
// Resolves to the mock export above (which delegates to the REAL impl via vi.importActual), so the assertion checks the genuine deny-list.
import {
  appOwnedSandboxPrivateRoots,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  sandboxTempPrincipalDirName,
} from "../../permissions/asrt-sandbox.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedMcpServersForTest,
  isMcpServerWrapped,
} from "../../permissions/sandbox-capability.js";
import { aveHome } from "../../shared/ave-home.js";
import {
  governanceWithPolicy,
  stdioApproval,
  buildPolicy,
  FakeChildProcess,
} from "./test-helpers.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { startFakeRelayPeer } from "../../__tests__/support/fake-relay-peer.js";
import type { McpStdioServerConfig } from "../types.js";

const REAL_PLATFORM = process.platform;

function handshakeResponses(serverName: string): FakeChildProcess["responses"] {
  return {
    "server/discover": (id) => ({
      id,
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "public",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: "1.0.0" },
    }),
    initialize: (id) => ({
      id,
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: "1.0.0" },
    }),
    "tools/list": () => ({ tools: [] }),
  };
}

beforeEach(() => {
  setProcessPlatform("darwin");
  spawnMock.mockReset();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((cmd, args) => {
    const script = Array.isArray(args) ? args[args.length - 1] : undefined;
    if (String(cmd).includes("\\Git\\") && script === "printf __ave_shell_ok__") {
      return "__ave_shell_ok__";
    }
    if (cmd === "where") {
      return "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
    }
    throw new Error(`unexpected execFileSync in MCP ASRT wrap test: ${cmd}`);
  });
  wrapWorkerCommandMock.mockReset();
  cleanupMock.mockClear();
  sandboxHomeCleanupMock.mockClear();
  gateActive = false;
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedMcpServersForTest();
});

afterEach(() => {
  setProcessPlatform(REAL_PLATFORM);
  __resetActiveSandboxCapabilityForTest();
  __resetWrappedMcpServersForTest();
});

describe("StdioTransport ASRT wrap — gate OFF (default)", () => {
  it("spawns the worker PLAIN (no wrap) and reports reviewer 'none'", async () => {
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("fs");
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("fs", "ave-mcp-fs")]),
    );
    const config: McpStdioServerConfig = {
      id: "fs",
      transport: "stdio",
      command: "ave-mcp-fs",
      args: ["--root", "/tmp"],
      cwd: "/tmp/package-generation",
      pluginDataDir: "/tmp/plugin-data",
      env: { PLUGIN_ROOT: "/tmp/package-generation", PLUGIN_DATA: "/tmp/plugin-data" },
      // Host would set this at connect time, but the gate is OFF so it is ignored.
      sandboxRoot: join(aveHome(), "mcp", "fs", "sandbox"),
    };
    const client = new McpClient(config, gov, new ToolRegistry(), unusedNetworkFetch);

    await client.connect();

    // No wrap was attempted.
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    // The plain spawn ran with the UNMODIFIED resolved command + args.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("ave-mcp-fs");
    expect(args).toEqual(["--root", "/tmp"]);
    expect((spawnMock.mock.calls[0]![2] as { cwd: string; env: Record<string, string> }).cwd).toBe("/tmp/package-generation");
    expect((spawnMock.mock.calls[0]![2] as { env: Record<string, string> }).env.PLUGIN_DATA).toBe("/tmp/plugin-data");
    // The server is NOT marked wrapped → reviewer stays none even gate-OFF.
    expect(isMcpServerWrapped("fs")).toBe(false);
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs");
    expect(cap.kind).toBe("none");

    await client.disconnect();
  });
});

describe("StdioTransport ASRT wrap — gate ON", () => {
  it("routes the spawn through wrapWorkerCommand with the FS jail + sensitive read deny-list", async () => {
    gateActive = true;
    const sandboxRoot = join(aveHome(), "mcp", "fs", "sandbox");
    const pluginDataDir = join(aveHome(), "agent-plugin-data", "writer");
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("fs");
    // ASRT (mac/linux shape): proxy baked into the command string, env=process.env.
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "sandbox-exec ... ave-mcp-fs --root /tmp"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("fs", "ave-mcp-fs")]),
    );
    const config: McpStdioServerConfig = {
      id: "fs",
      transport: "stdio",
      command: "ave-mcp-fs",
      args: ["--root", "/tmp"],
      sandboxRoot,
      cwd: "/tmp/package-generation",
      pluginDataDir,
      bundledPayloadRoot: "/tmp/package-generation",
      env: { PLUGIN_ROOT: "/tmp/package-generation", PLUGIN_DATA: pluginDataDir },
    };
    const client = new McpClient(config, gov, new ToolRegistry(), unusedNetworkFetch);

    await client.connect();

    const commandId = (wrapWorkerCommandMock.mock.calls[0]![1] as { commandId: string }).commandId;
    expect(egressInvocationOwner(commandId)).toEqual({ kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "fs" });
    // wrapWorkerCommand received the quoted command line + the FS jail.
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead: string[]; denyWrite: string[] } },
    ];
    // The server's own temp directory, keyed by its server id, set as TMPDIR inside the wrap (ASRT's own assignment
    // names the shared root), then the command + args, every token shell-quoted (defensive against spaces/injection).
    const tempDir = join(SANDBOX_TEMP_ROOT, sandboxTempPrincipalDirName({ kind: "mcp", id: "fs" }));
    expect(cmdline).toBe(
      `'/usr/bin/env' 'TMPDIR=${tempDir}' 'TMP=${tempDir}' 'TEMP=${tempDir}' 'ave-mcp-fs' '--root' '/tmp'`,
    );
    // Write-jail = the server's temp directory + the fresh process HOME + per-server sandbox root. The shared temp root is not granted.
    expect(options.filesystem.allowWrite).toEqual([tempDir, SANDBOX_HOME, sandboxRoot, pluginDataDir]);
    expect(options.filesystem.allowRead).toContain(tempDir);
    expect(options.filesystem.allowRead).toContain(SANDBOX_HOME);
    // The root + tmp are re-allowed for read; HOME is never re-allowed wholesale.
    expect(options.filesystem.allowRead).toContain(sandboxRoot);
    // The worker wrap applies the CENTRALIZED sensitive read DENY-LIST (deny-list, not a read-allow jail): secrets + session/routine history + standard credential stores are all read-DENIED, not just `~/.ave/secrets`.
    // The floor also read-denies the sandbox private roots; every other principal's temp directory and every other process's HOME are under them, and the terminal's shell handoff fifos, and ASRT's reads are deny-only.
    const sensitive = getDefaultSensitiveReadDenyPaths();
    expect(options.filesystem.denyRead).toEqual(sensitive);
    const privateRoots = appOwnedSandboxPrivateRoots();
    expect(privateRoots.map((root) => basename(root))).toEqual(["tmp", "home", "handoff"]);
    for (const root of privateRoots) expect(options.filesystem.denyRead).toContain(root);
    expect(options.filesystem.denyRead).toContain(join(aveHome(), "secrets"));
    expect(options.filesystem.denyRead).toContain(join(aveHome(), "sessions"));
    expect(options.filesystem.denyRead).toContain(join(homedir(), ".ssh"));
    expect(options.filesystem.denyRead).toContain(join(homedir(), ".aws"));
    // The worker wrap also applies the CENTRALIZED sensitive write DENY-LIST. Per-command denyWrite replaces
    // the boot array, so #1449 requires this to be restated wherever wrapWorkerCommand carries a filesystem jail.
    const sensitiveWrite = getDefaultSensitiveWriteDenyPaths();
    expect(options.filesystem.denyWrite).toEqual(sensitiveWrite);
    expect(options.filesystem.denyWrite).toContain(join(homedir(), ".ssh"));
    expect(options.filesystem.denyWrite).toContain(join(homedir(), ".config"));
    // An MCP stdio server is plugin-owned or third-party code: its write roots (the process HOME, the
    // server sandbox root, the plugin data root) are pinned, so it cannot remove or replace one with a link.
    expect((options.filesystem as { pinWriteRoots?: boolean }).pinWriteRoots).toBe(true);
    // Nor does it read another plugin's directories: the plugins root is refused, and the one
    // directory under it a bundled server reads; its generation payload; is the re-allow inside that deny.
    expect((options.filesystem as { denyPluginsRoot?: boolean }).denyPluginsRoot).toBe(true);
    expect(options.filesystem.allowRead).toContain("/tmp/package-generation");

    // spawn ran the WRAPPED argv with shell:false + a writable stdin pipe.
    const [spawnedCmd, spawnedArgs, spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { stdio: unknown[]; shell: boolean; cwd: string; env: Record<string, string> },
    ];
    expect(spawnedCmd).toBe("/bin/bash");
    expect(spawnedArgs[0]).toBe("-c");
    expect(spawnOpts.shell).toBe(false);
    expect(spawnOpts.stdio[0]).toBe("pipe"); // stdin must stay writable for framing
    expect(spawnOpts.cwd).toBe("/tmp/package-generation");
    expect(spawnOpts.env.PLUGIN_DATA).toBe(pluginDataDir);

    // The server is now marked wrapped → reviewer can report genuine asrt.
    expect(isMcpServerWrapped("fs")).toBe(true);

    await client.disconnect();
    // Close releases per-command ASRT state and clears the wrapped marker.
    expect(cleanupMock).toHaveBeenCalled();
    expect(isMcpServerWrapped("fs")).toBe(false);
    expect(egressInvocationOwner(commandId)).toBeUndefined();
  });

  it("absent sandboxRoot grants only the fresh process HOME and the server's temp directory (never real HOME/cwd)", async () => {
    gateActive = true;
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("nojail");
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("nojail", "ave-mcp-nojail")]),
    );
    // Directly construct WITHOUT sandboxRoot (simulates the host invariant not holding); only the host-created, empty process HOME may be writable.
    const config: McpStdioServerConfig = {
      id: "nojail",
      transport: "stdio",
      command: "ave-mcp-nojail",
    };
    const client = new McpClient(config, gov, new ToolRegistry(), unusedNetworkFetch);

    await client.connect();

    const [, options] = wrapWorkerCommandMock.mock.calls[0] as [
      string,
      { filesystem: { allowWrite: string[]; allowRead: string[]; denyRead: string[] } },
    ];
    // Only host-created roots: the server's own temp directory and the fresh process HOME. No real HOME / cwd / shared temp root ever granted write.
    expect(options.filesystem.allowWrite).toEqual([
      join(SANDBOX_TEMP_ROOT, sandboxTempPrincipalDirName({ kind: "mcp", id: "nojail" })),
      SANDBOX_HOME,
    ]);
    expect(options.filesystem.allowWrite).not.toContain(SANDBOX_TEMP_ROOT);
    expect(options.filesystem.allowWrite).not.toContain(process.env.HOME);
    expect(options.filesystem.allowWrite).not.toContain(process.cwd());
    // A server of no plugin is refused the plugins root and re-allowed nothing in it.
    expect((options.filesystem as { denyPluginsRoot?: boolean }).denyPluginsRoot).toBe(true);
    expect(options.filesystem.allowRead.some((path) => path.startsWith(join(aveHome(), "plugins")))).toBe(false);

    await client.disconnect();
  });

  it("overlays ONLY the ASRT proxy keys, preserves apiKey + strips host secrets", async () => {
    gateActive = true;
    const sandboxRoot = join(aveHome(), "mcp", "secure", "sandbox");
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("secure");
    // Simulate an ASRT env carrying proxy keys plus a host secret that must NOT propagate (it is not allow-listed).
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["C:/Git/bin/bash.exe", "-c", "wrapped"],
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:60080",
        HTTPS_PROXY: "http://127.0.0.1:60080",
        NODE_EXTRA_CA_CERTS: "C:/tmp/ca.pem",
        SOME_HOST_SECRET: "leaked-value", // not allow-listed → must be dropped
      },
    });
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([
        stdioApproval("secure", "ave-mcp-secure", {
          requiredAuth: "api-key",
          apiKeyEnv: "MCP_API_KEY",
        }),
      ]),
    );
    const config: McpStdioServerConfig = {
      id: "secure",
      transport: "stdio",
      command: "ave-mcp-secure",
      auth: "api-key",
      apiKey: "secret-key",
      apiKeyEnv: "MCP_API_KEY",
      sandboxRoot,
    };
    const client = new McpClient(config, gov, new ToolRegistry(), unusedNetworkFetch);

    await client.connect();

    const [, , spawnOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const env = spawnOpts.env;
    // ASRT proxy/CA overlay propagated (the win32 "spread").
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:60080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("C:/tmp/ca.pem");
    // Approved per-server apiKey preserved.
    expect(env.MCP_API_KEY).toBe("secret-key");
    // A non-allow-listed host secret ASRT carried is NOT propagated.
    expect(env.SOME_HOST_SECRET).toBeUndefined();
    expect(env.HOME).toBe(SANDBOX_HOME);

    await client.disconnect();
  });

  it("UNEXPECTED child exit releases the wrapped marker + cleanup runs exactly once (MAJOR fix)", async () => {
    gateActive = true;
    const sandboxRoot = join(aveHome(), "mcp", "crash", "sandbox");
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("crash");
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "sandbox-exec ... ave-mcp-crash"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("crash", "ave-mcp-crash")]),
    );
    const config: McpStdioServerConfig = {
      id: "crash",
      transport: "stdio",
      command: "ave-mcp-crash",
      sandboxRoot,
    };
    const client = new McpClient(config, gov, new ToolRegistry(), unusedNetworkFetch);
    await client.connect();

    // Server is wrapped while running.
    expect(isMcpServerWrapped("crash")).toBe(true);

    // Simulate unexpected child exit WITHOUT calling client.disconnect() / close(); e.g. the server binary crashes or is killed by the OS.
    fake.emit("exit", 1, null);

    // The no-leak invariant: the wrapped marker must be cleared immediately.
    expect(isMcpServerWrapped("crash")).toBe(false);
    // Per-command ASRT cleanup (bwrap teardown / ref-count decrement) ran.
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
    // Reviewer now reports none; no stale asrt for the dead server id.
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "test",
      confines: { filesystem: true, process: true, network: true },
    });
    expect(resolveReviewerSandboxCapability("mcp", "mcp_crash_x", "crash").kind).toBe("none");

    // NOW also call disconnect() to exercise the explicit-close path. cleanupMock must NOT be called a second time (idempotency).
    await client.disconnect();
    expect(cleanupMock).toHaveBeenCalledTimes(1); // still exactly once
    expect(isMcpServerWrapped("crash")).toBe(false); // still gone
  });

  it("explicit disconnect defers HOME cleanup until the child exits", async () => {
    gateActive = true;
    const sandboxRoot = join(aveHome(), "mcp", "stubborn-cleanup", "sandbox");
    class StubbornChild extends FakeChildProcess {
      override kill(): boolean {
        return true;
      }
    }
    const fake = new StubbornChild();
    fake.responses = handshakeResponses("stubborn-cleanup");
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "sandbox-exec ... ave-mcp-stubborn"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);

    const client = new McpClient(
      {
        id: "stubborn-cleanup",
        transport: "stdio",
        command: "ave-mcp-stubborn",
        sandboxRoot,
      },
      governanceWithPolicy(buildPolicy([
        stdioApproval("stubborn-cleanup", "ave-mcp-stubborn"),
      ])),
      new ToolRegistry(),
      unusedNetworkFetch,
    );
    await client.connect();

    await client.disconnect();
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(sandboxHomeCleanupMock).not.toHaveBeenCalled();

    fake.exitCode = 0;
    fake.emit("exit", 0, "SIGTERM");
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("retains confinement and HOME ownership when a live child emits error", async () => {
    gateActive = true;
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("live-error");
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "sandbox-exec ... ave-mcp-live-error"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);

    const client = new McpClient(
      {
        id: "live-error",
        transport: "stdio",
        command: "ave-mcp-live-error",
        sandboxRoot: join(aveHome(), "mcp", "live-error", "sandbox"),
      },
      governanceWithPolicy(buildPolicy([stdioApproval("live-error", "ave-mcp-live-error")])),
      new ToolRegistry(),
      unusedNetworkFetch,
    );
    await client.connect();

    fake.emit("error", new Error("signal delivery failed"));
    expect(isMcpServerWrapped("live-error")).toBe(true);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(sandboxHomeCleanupMock).not.toHaveBeenCalled();

    fake.emit("close", null, null);
    expect(isMcpServerWrapped("live-error")).toBe(false);
    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(sandboxHomeCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("an old same-id exit cannot clear a replacement transport's wrapped marker", async () => {
    gateActive = true;
    class StubbornChild extends FakeChildProcess {
      override kill(): boolean {
        return true;
      }
    }
    const oldChild = new StubbornChild();
    oldChild.responses = handshakeResponses("overlap");
    const replacementChild = new FakeChildProcess();
    replacementChild.responses = handshakeResponses("overlap");
    wrapWorkerCommandMock
      .mockResolvedValueOnce({ argv: ["/bin/bash", "-c", "old"], env: { ...process.env } })
      .mockResolvedValueOnce({ argv: ["/bin/bash", "-c", "replacement"], env: { ...process.env } });
    spawnMock.mockReturnValueOnce(oldChild).mockReturnValueOnce(replacementChild);

    const config: McpStdioServerConfig = {
      id: "overlap",
      transport: "stdio",
      command: "ave-mcp-overlap",
      sandboxRoot: join(aveHome(), "mcp", "overlap", "sandbox"),
    };
    const governance = governanceWithPolicy(buildPolicy([stdioApproval("overlap", "ave-mcp-overlap")]));
    const oldClient = new McpClient(config, governance, new ToolRegistry(), unusedNetworkFetch);
    await oldClient.connect();
    await oldClient.disconnect();
    expect(isMcpServerWrapped("overlap")).toBe(true);

    const replacement = new McpClient(config, governance, new ToolRegistry(), unusedNetworkFetch);
    await replacement.connect();
    oldChild.exitCode = 0;
    oldChild.emit("exit", 0, "SIGKILL");
    oldChild.emit("close", 0, "SIGKILL");

    expect(isMcpServerWrapped("overlap")).toBe(true);
    await replacement.disconnect();
    expect(isMcpServerWrapped("overlap")).toBe(false);
  });

  it("win32 runs the server through the stdio relay under a held ACL grant", async () => {
    setProcessPlatform("win32");
    const priorSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = "C:\\Windows";
    gateActive = true;
    const sandboxRoot = join(aveHome(), "mcp", "fs", "sandbox");
    wrapWorkerCommandMock.mockResolvedValueOnce({ argv: ["srt-win.exe", "exec", "--", "cmd.exe"], env: { ...process.env } });
    const broker = new FakeChildProcess();
    Object.assign(broker.responses, handshakeResponses("relayed-fs"));
    let peer: Awaited<ReturnType<typeof startFakeRelayPeer>> | undefined;
    spawnMock.mockImplementationOnce(() => {
      // Announce after the relay host side has attached to the broker's stdout, then play the program: requests
      // that arrive over the channel are answered on the broker's stdout, which is where srt-win carries output.
      setImmediate(() => {
        void startFakeRelayPeer(broker.stdout).then((started) => {
          peer = started;
          started.onInput((text) => broker.stdin.write(text));
        });
      });
      return broker;
    });

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("fs", "ave-mcp-fs")]),
    );
    const client = new McpClient(
      {
        id: "fs",
        transport: "stdio",
        command: "ave-mcp-fs",
        args: ["--root", "C:\\data", "100%", 'say "hi"'],
        sandboxRoot,
      },
      gov,
      new ToolRegistry(),
      unusedNetworkFetch,
    );

    try {
      await client.connect();
      expect(holdGrantMock).toHaveBeenCalledTimes(1);
      const grant = holdGrantMock.mock.calls[0]![0] as { label: string; allowRead: string[]; allowWrite: string[] };
      expect(grant.label).toBe("mcp:fs:asrt-win-acl");
      expect(grant.allowWrite).toEqual([SANDBOX_HOME, sandboxRoot]);
      expect(grant.allowRead).toEqual([SANDBOX_HOME, sandboxRoot]);
      // The line srt-win runs carries the host's runtime only; the server's command and its arguments; `%` and `"` included; are in the request.
      const [cmdline] = wrapWorkerCommandMock.mock.calls[0] as [string];
      expect(cmdline).toContain('"--ave-child-transport=relay"');
      expect(cmdline).not.toContain("ave-mcp-fs");
      const request = await peer!.request;
      expect(request.command).toBe("ave-mcp-fs");
      expect(request.args).toEqual(["--root", "C:\\data", "100%", 'say "hi"']);
      expect((request.env as Record<string, string>).HOME).toBe(SANDBOX_HOME);
      expect(isMcpServerWrapped("fs")).toBe(true);

      await client.disconnect();
      await peer!.inputEnded;
      expect(isMcpServerWrapped("fs")).toBe(false);
      expect(grantReleaseMock).toHaveBeenCalled();
    } finally {
      peer?.close();
      if (priorSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = priorSystemRoot;
    }
  });
});

describe("resolveReviewerSandboxCapability — wrapped MCP worker (no-leak)", () => {
  beforeEach(() => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
  });

  it("reports genuine asrt for a wrapped server's tool call", async () => {
    gateActive = true;
    const sandboxRoot = join(aveHome(), "mcp", "fs", "sandbox");
    const fake = new FakeChildProcess();
    fake.responses = handshakeResponses("fs");
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { ...process.env },
    });
    spawnMock.mockReturnValueOnce(fake);
    const gov = governanceWithPolicy(buildPolicy([stdioApproval("fs", "ave-mcp-fs")]));
    const client = new McpClient(
      { id: "fs", transport: "stdio", command: "ave-mcp-fs", sandboxRoot },
      gov,
      new ToolRegistry(),
      unusedNetworkFetch,
    );
    await client.connect();

    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs");
    expect(cap.kind).toBe("asrt");
    expect(cap.confines).toEqual({ filesystem: true, process: true, network: true });

    await client.disconnect();
    // After close the marker is gone → back to none (no stale leak).
    expect(resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs").kind).toBe("none");
  });

  it("reports none for an UNWRAPPED server even when the global capability is asrt", () => {
    gateActive = true;
    // A server that was never wrapped (not in the registry).
    expect(isMcpServerWrapped("other")).toBe(false);
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_other_x", "other");
    expect(cap.kind).toBe("none");
  });

  it("reports none for a wrapped id once the sandbox is torn down (gate off)", () => {
    // Mark wrapped but flip the gate off (simulates teardown without unmark).
    __resetWrappedMcpServersForTest();
    gateActive = false;
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read", "fs");
    expect(cap.kind).toBe("none");
  });

  it("reports none for an mcp call with NO serverId (back-compat default)", () => {
    gateActive = true;
    const cap = resolveReviewerSandboxCapability("mcp", "mcp_fs_read");
    expect(cap.kind).toBe("none");
  });
});
