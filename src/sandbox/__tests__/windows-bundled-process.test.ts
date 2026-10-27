vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** `spawnWindowsBundledProcess`: a bundled hook or MCP stdio server under srt-win. What it holds (the ACL grant, the throwaway HOME), what it hands
 * the confined spawn, and that every failure gives all of it back. The relay and the grant are each tested where they live; this is the composition. */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_WORKER_EGRESS_OWNER } from "../../__tests__/support/egress-fixture.js";

const SANDBOX_HOME = "C:\\sandbox\\home-1";
const homeCleanup = vi.fn();
vi.mock("../../permissions/sandbox-process-home.js", () => ({
  createSandboxProcessHome: () => ({ path: SANDBOX_HOME, env: { HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME }, cleanup: homeCleanup }),
}));

const grantRelease = vi.fn();
let lostListener: ((reason: Error) => void) | undefined;
const holdGrant = vi.fn(async (_opts: unknown) => ({
  assertAlive: () => undefined,
  onLost: (listener: (reason: Error) => void) => {
    lostListener = listener;
  },
  release: grantRelease,
}));
const terminate = vi.fn();
vi.mock("../../permissions/windows-acl-grant-holder.js", () => ({
  holdWindowsFilesystemGrant: (opts: unknown) => holdGrant(opts),
  terminateChildBestEffort: (child: unknown) => terminate(child),
}));

const asrtCleanup = vi.fn(async () => undefined);
vi.mock("../../permissions/asrt-sandbox.js", async (original) => ({
  ...(await original<typeof import("../../permissions/asrt-sandbox.js")>()),
  cleanupAsrtSandboxAfterCommand: () => asrtCleanup(),
}));

type Spec = Record<string, unknown> & { onWrapped?: () => void; assertStillValid?: () => void };
const confinedSpawn = vi.fn<(spec: Spec) => Promise<unknown>>();
vi.mock("../../permissions/confined-child.js", () => ({
  spawnConfinedChild: (spec: Spec) => confinedSpawn(spec),
}));

const { spawnWindowsBundledProcess } = await import("../wrap-bundled-command.js");
const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");
const { aveHome } = await import("../../shared/ave-home.js");

function brokerChild(): EventEmitter & { pid: number | undefined } {
  return Object.assign(new EventEmitter(), { pid: 4321 as number | undefined });
}

function spawnedAs(child: unknown, confinement = "windows-srt") {
  return async (spec: Spec) => {
    spec.onWrapped?.();
    return { child, confinement, stdin: new PassThrough(), stdout: new PassThrough() };
  };
}

const input = {
  label: "hook:alpha",
  command: "node",
  args: ["hook.js"],
  baseEnv: { PLUGIN_ROOT: "C:\\p\\gen" },
  cwd: "C:\\p\\gen",
  allowRead: ["C:\\p\\gen"],
  allowWrite: ["C:\\p\\data"],
  egressOwner: TEST_WORKER_EGRESS_OWNER,
};

describe("spawnWindowsBundledProcess", () => {
  const hostPlatform = process.platform;
  beforeEach(() => {
    setProcessPlatform("win32");
    lostListener = undefined;
  });
  afterEach(() => {
    setProcessPlatform(hostPlatform);
    vi.clearAllMocks();
  });

  it("holds a grant on its own roots and the HOME, and runs the command through the relay, deny-only", async () => {
    const child = brokerChild();
    confinedSpawn.mockImplementationOnce(spawnedAs(child));
    const spawned = await spawnWindowsBundledProcess(input);
    expect(holdGrant).toHaveBeenCalledWith({
      label: "hook:alpha:asrt-win-acl",
      allowRead: [SANDBOX_HOME, "C:\\p\\data", "C:\\p\\gen"],
      allowWrite: [SANDBOX_HOME, "C:\\p\\data"],
    });
    const spec = confinedSpawn.mock.calls[0]![0];
    expect(spec).toMatchObject({
      command: "node",
      args: ["hook.js"],
      label: "hook:alpha:asrt-win",
      grantMode: "deny-only",
      baseEnv: { PLUGIN_ROOT: "C:\\p\\gen" },
      extraEnv: { HOME: SANDBOX_HOME, USERPROFILE: SANDBOX_HOME },
      stdio: ["pipe", "pipe", "pipe"],
      windowsStdio: "relay",
      cwd: "C:\\p\\gen",
    });
    expect(spawned.child).toBe(child);
    spawned.releaseHold();
    expect(grantRelease).toHaveBeenCalledTimes(1);
    expect(homeCleanup).toHaveBeenCalledTimes(1);
    // ASRT's per-command cleanup stays the caller's, as with the POSIX wrap.
    expect(asrtCleanup).not.toHaveBeenCalled();
  });

  it("grants READ on the host's runtime directory only for a program the host keeps there", async () => {
    confinedSpawn.mockImplementation(spawnedAs(brokerChild()));
    const runtime = join(aveHome(), "runtime");
    await spawnWindowsBundledProcess({ ...input, command: join(runtime, "uv", "x86_64-pc-windows-msvc", "abc", "uv.exe") });
    expect((holdGrant.mock.calls[0]![0] as { allowRead: string[] }).allowRead).toContain(runtime);
    await spawnWindowsBundledProcess({ ...input, command: `${runtime}-elsewhere\\uv.exe` });
    expect((holdGrant.mock.calls[1]![0] as { allowRead: string[] }).allowRead).not.toContain(runtime);
  });

  it("ends the process when the grant is lost while it runs", async () => {
    const child = brokerChild();
    confinedSpawn.mockImplementationOnce(spawnedAs(child));
    await spawnWindowsBundledProcess(input);
    lostListener!(new Error("holder exited"));
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it("releases what it holds when a start produced no process", async () => {
    const child = brokerChild();
    child.pid = undefined;
    confinedSpawn.mockImplementationOnce(spawnedAs(child));
    await spawnWindowsBundledProcess(input);
    child.emit("error", new Error("spawn EPERM"));
    expect(grantRelease).toHaveBeenCalledTimes(1);
    expect(homeCleanup).toHaveBeenCalledTimes(1);
  });

  it("gives everything back, the wrap's state included, when the spawn fails after the wrap", async () => {
    confinedSpawn.mockImplementationOnce(async (spec) => {
      spec.onWrapped?.();
      throw new Error("admission closed");
    });
    await expect(spawnWindowsBundledProcess(input)).rejects.toThrow("admission closed");
    expect(asrtCleanup).toHaveBeenCalledTimes(1);
    expect(grantRelease).toHaveBeenCalledTimes(1);
    expect(homeCleanup).toHaveBeenCalledTimes(1);
  });

  it("removes the HOME, and spawns nothing, when the grant cannot be held", async () => {
    holdGrant.mockRejectedValueOnce(new Error("grant refused"));
    await expect(spawnWindowsBundledProcess(input)).rejects.toThrow("grant refused");
    expect(confinedSpawn).not.toHaveBeenCalled();
    expect(homeCleanup).toHaveBeenCalledTimes(1);
  });

  it("rechecks caller admission after preparation and releases the grant if permission changed", async () => {
    let allowed = true;
    const actualSpawn = vi.fn();
    confinedSpawn.mockImplementationOnce(async (spec) => {
      allowed = false;
      spec.assertStillValid?.();
      actualSpawn();
      return { child: brokerChild(), confinement: "windows-srt" };
    });
    await expect(spawnWindowsBundledProcess({ ...input, assertStillValid: () => {
      if (!allowed) throw new Error("permission revoked");
    } })).rejects.toThrow("permission revoked");
    expect(actualSpawn).not.toHaveBeenCalled();
    expect(grantRelease).toHaveBeenCalledTimes(1);
    expect(homeCleanup).toHaveBeenCalledTimes(1);
  });

  it("refuses a process that came back unconfined, and ends it", async () => {
    const child = brokerChild();
    confinedSpawn.mockImplementationOnce(async () => ({ child, confinement: "unconfined", stdin: new PassThrough(), stdout: new PassThrough() }));
    await expect(spawnWindowsBundledProcess(input)).rejects.toThrow(/came back unconfined/);
    expect(terminate).toHaveBeenCalledWith(child);
    expect(grantRelease).toHaveBeenCalledTimes(1);
  });

  it("is the Windows path only", async () => {
    setProcessPlatform("darwin");
    await expect(spawnWindowsBundledProcess(input)).rejects.toThrow(/is the Windows path/);
    expect(holdGrant).not.toHaveBeenCalled();
  });
});
