vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

// Per-command deny arrays replace the boot floor, even when empty; the confinement primitive must restate it so children cannot regain secret reads.
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { egressInvocationOwner, liveEgressInvocationCount, onEgressInvocationReleased } from "../egress-invocations.js";
import { TEST_WORKER_EGRESS_OWNER } from "../../__tests__/support/egress-fixture.js";
import * as helperIntegrity from "../srt-win-integrity.js";

const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const spawnMock = vi.fn();
const trackMock = vi.fn();
const admissionMock = vi.fn();
// Whether the host runs under the OS sandbox. The primitive follows this one answer: wrap while it is true, spawn the caller's command as given while it is false. Defaults to true so the composition cases below see the wrap.
const sandboxActiveMock = vi.fn<() => boolean>();

const TEMP_ROOT = "/home/u/.ave/sandbox/tmp";
const HOME_ROOT = "/home/u/.ave/sandbox/home";
const EGRESS_OWNER = { kind: "worker", role: "worker", pluginId: "x", instanceId: "main" } as const;
const PRINCIPAL = { kind: "plugin", id: "x" } as const;
// The principal's own directory, as the real `ensureSandboxTempPrincipalDir` names it; named here so the cases can say which entry is the caller's.
const TEMP_DIR = `${TEMP_ROOT}/plugin-78`;

vi.mock("../asrt-sandbox.js", async (importOriginal) => ({
  assertExtensionStartAllowed: (await importOriginal<typeof import("../asrt-sandbox.js")>()).assertExtensionStartAllowed,
  // The real launcher, so the command line asserted below is the one ASRT gets.
  sandboxTempEnvLaunch: (await importOriginal<typeof import("../asrt-sandbox.js")>()).sandboxTempEnvLaunch,
  ensureSandboxTempPrincipalDir: (principal: { kind: string; id: string }) => ({
    dir: `${TEMP_ROOT}/${principal.kind}-${Buffer.from(principal.id).toString("hex")}`,
    root: TEMP_ROOT,
  }),
  isAsrtSandboxActive: () => sandboxActiveMock(),
  isPluginWorkerConfinementActive: () => sandboxActiveMock(),
  wrapWorkerCommand: (command: string, options?: unknown) =>
    wrapWorkerCommandMock(command, options),
  // The floor carries the sandbox private roots, as the real one does on macOS and Linux; the primitive's own directories are re-allowed under it.
  getDefaultSensitiveReadDenyPaths: () => ["/home/u/.ave/secrets", "/home/u/.ssh", TEMP_ROOT, HOME_ROOT],
  getDefaultSensitiveWriteDenyPaths: () => ["/home/u/.ave/secrets", "/home/u/.bashrc"],
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: (label: string) => admissionMock(label),
  trackManagedChildProcess: (child: unknown, opts: unknown) => trackMock(child, opts),
}));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { resolvePluginChildEntryPath, spawnConfinedChild } = await import("../confined-child.js");
const { startFakeRelayPeer } = await import("../../__tests__/support/fake-relay-peer.js");

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  return child;
}

beforeEach(() => {
  wrapWorkerCommandMock.mockReset();
  wrapWorkerCommandMock.mockResolvedValue({ argv: ["/bin/sandbox", "--", "sh", "-c", "x"], env: {} });
  sandboxActiveMock.mockReset();
  sandboxActiveMock.mockReturnValue(true);
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  trackMock.mockReset();
  admissionMock.mockReset();
});

// The filesystem config the primitive handed ASRT on the last wrap.
function lastFilesystem() {
  const [, options] = wrapWorkerCommandMock.mock.calls.at(-1)!;
  return (options as { filesystem: Record<string, string[]> }).filesystem;
}

// The primitive's macOS and Linux behaviour: the allow-list grant mode and the POSIX command line. The cases name their platform rather than inheriting the runner's — on a Windows runner the line would be rendered for srt-win, and the Windows rendering has cases of its own below.
describe("spawnConfinedChild", () => {
  it("keeps distinct invocation identities until each confined process exits", async () => {
    const releases: unknown[] = [];
    const unsubscribe = onEgressInvocationReleased((token, release) => releases.push({ token, ...release }));
    try {
      const spec = { command: "/usr/bin/python3", args: [], label: "worker:x:main", grantMode: "allow-list" as const, tempPrincipal: PRINCIPAL, baseEnv: {}, egressOwner: EGRESS_OWNER };
      const first = await spawnConfinedChild(spec);
      const second = await spawnConfinedChild({ ...spec, egressOwner: { ...EGRESS_OWNER, instanceId: "other" } });
      const tokens = wrapWorkerCommandMock.mock.calls.map(([, options]) => (options as { commandId: string }).commandId);
      expect(tokens[0]).toMatch(/^[a-f0-9]{32}$/);
      expect(tokens[1]).not.toBe(tokens[0]);
      expect(egressInvocationOwner(tokens[0]!)).toEqual(EGRESS_OWNER);
      expect(egressInvocationOwner(tokens[1]!)).toMatchObject({ instanceId: "other" });
      expect(spawnMock.mock.calls[0]![2]).toMatchObject({ detached: true });
      first.child.emit("error", new Error("signal delivery failed"));
      expect(egressInvocationOwner(tokens[0]!)).toEqual(EGRESS_OWNER);
      first.child.emit("exit", 0, null);
      expect(egressInvocationOwner(tokens[0]!)).toBeUndefined();
      expect(egressInvocationOwner(tokens[1]!)).toBeDefined();
      first.child.emit("exit", 0, null);
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({ token: tokens[0], processGroup: 4242 });
      second.child.emit("exit", 0, null);
    } finally { unsubscribe(); }
  });

  it.each(["wrap", "spawn", "validation", "empty argv", "wrapped callback"])("releases invocation identity after %s failure", async (failure) => {
    const baseline = liveEgressInvocationCount();
    if (failure === "wrap") wrapWorkerCommandMock.mockRejectedValueOnce(new Error("wrap failed"));
    if (failure === "spawn") spawnMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });
    if (failure === "empty argv") wrapWorkerCommandMock.mockResolvedValueOnce({ argv: [], env: {} });
    let validated = false;
    await expect(spawnConfinedChild({ egressOwner: EGRESS_OWNER, command: "/usr/bin/python3", args: [], label: "worker:x:main", grantMode: "allow-list", tempPrincipal: PRINCIPAL, baseEnv: {},
      assertStillValid: () => { if (failure === "validation" && validated) throw new Error("invalidated"); validated = true; },
      onWrapped: () => { if (failure === "wrapped callback") throw new Error("callback failed"); },
    })).rejects.toThrow();
    expect(liveEgressInvocationCount()).toBe(baseline);
  });

  it("releases an invocation when no process starts", async () => {
    const child = fakeChild();
    child.pid = undefined;
    spawnMock.mockReturnValueOnce(child);
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER, command: "/usr/bin/python3", args: [], label: "worker:x:main", grantMode: "allow-list", tempPrincipal: PRINCIPAL, baseEnv: {} });
    const token = (wrapWorkerCommandMock.mock.calls[0]![1] as { commandId: string }).commandId;
    expect(egressInvocationOwner(token)).toBeDefined();
    child.emit("error", new Error("spawn failed"));
    expect(egressInvocationOwner(token)).toBeUndefined();
  });

  const hostPlatform = process.platform;
  beforeEach(() => setProcessPlatform("linux"));
  afterEach(() => setProcessPlatform(hostPlatform));

  it("restates the deny floor even when the caller passes no paths at all", async () => {
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    });

    expect(lastFilesystem().denyRead).toContain("/home/u/.ave/secrets");
    expect(lastFilesystem().denyWrite).toContain("/home/u/.bashrc");
  });

  it("carries the caller's allow paths alongside the floor, not instead of it", async () => {
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      allowRead: ["/data/in"],
      allowWrite: ["/data/out"],
      baseEnv: {},
    });

    const fs = lastFilesystem();
    // The temp directory comes FIRST and is not the caller's — the primitive grants it the way it restates the deny floor, for the same reason: a caller that forgot would produce a child whose `os.tmpdir` names a directory it cannot write, and that failure surfaces inside whatever library happened to want a temp file rather than at the spawn.
    expect(fs.allowRead).toEqual([TEMP_DIR, "/data/in"]);
    expect(fs.allowWrite).toEqual([TEMP_DIR, "/data/out"]);
    expect(fs.denyRead).toContain("/home/u/.ssh");
  });

  it("grants its principal's temp directory alone and read-denies the shared root, with no caller paths", async () => {
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    });
    const fs = lastFilesystem();
    expect(fs.allowWrite).toEqual([TEMP_DIR]);
    expect(fs.allowRead).toEqual([TEMP_DIR]);
    // Every other principal's directory is under the root, and ASRT's reads are deny-only: the floor's deny of it, restated whole, is what keeps the child from reading them all.
    expect(fs.denyRead).toEqual(["/home/u/.ave/secrets", "/home/u/.ssh", TEMP_ROOT, HOME_ROOT]);
    expect(fs.allowWrite).not.toContain(TEMP_ROOT);
  });

  it.each(["darwin", "linux"] as const)("on %s sets TMPDIR, TMP and TEMP to that directory inside the wrap", async (platform) => {
    // ASRT puts its own `TMPDIR=<shared root>` ahead of the sandboxed command, so only an assignment made inside the wrap reaches the child.
    setProcessPlatform(platform);
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: ["-u"],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    });
    const [cmdline] = wrapWorkerCommandMock.mock.calls.at(-1)!;
    expect(cmdline).toBe(
      `'/usr/bin/env' 'TMPDIR=${TEMP_DIR}' 'TMP=${TEMP_DIR}' 'TEMP=${TEMP_DIR}' '/usr/bin/python3' '-u'`,
    );
  });

  it("refuses an allow-list spawn that names no temp principal, before any wrap", async () => {
    await expect(spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      baseEnv: {},
    })).rejects.toThrow(/needs the temp principal/);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("omits allow paths under deny-only, where ACLs grant reachability instead", async () => {
    // Passing them here would imply a confinement the wrap does not perform: on Windows the grant is held against a separate holder process.
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "python.exe",
      args: [],
      label: "worker:x:main:asrt-win",
      grantMode: "deny-only",
      allowRead: ["/data/in"],
      allowWrite: ["/data/out"],
      baseEnv: {},
    });

    const fs = lastFilesystem();
    expect(fs.allowRead).toBeUndefined();
    expect(fs.allowWrite).toBeUndefined();
    expect(fs.denyRead).toContain("/home/u/.ave/secrets");
    // The sandbox HOME's own TEMP is per process there; no env launcher.
    const [cmdline] = wrapWorkerCommandMock.mock.calls.at(-1)!;
    expect(cmdline).not.toContain("TMPDIR=");
  });

  it("carries the plugins-root deny to the wrap under allow-list, beside the floor and never in place of it", async () => {
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/node",
      args: [],
      label: "plugin-child:x",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      allowRead: ["/home/u/.ave/plugins/x"],
      denyPluginsRoot: true,
      baseEnv: {},
    });
    const filesystem = lastFilesystem();
    expect((filesystem as unknown as { denyPluginsRoot?: boolean }).denyPluginsRoot).toBe(true);
    expect(filesystem.denyRead).toEqual(["/home/u/.ave/secrets", "/home/u/.ssh", TEMP_ROOT, HOME_ROOT]);
    // The child's own directory is the re-allow inside it.
    expect(filesystem.allowRead).toContain("/home/u/.ave/plugins/x");
  });

  it("refuses the plugins-root deny under deny-only, where nothing would re-allow the child's own directories", async () => {
    await expect(
      spawnConfinedChild({ egressOwner: EGRESS_OWNER,
        command: "/usr/bin/node",
        args: [],
        label: "worker:x:w:asrt-win",
        grantMode: "deny-only",
        denyPluginsRoot: true,
        baseEnv: {},
      }),
    ).rejects.toThrow(/denyPluginsRoot needs an allow-list confinement/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("quotes every token so a path with spaces cannot mis-split", async () => {
    // ASRT runs this through a shell, so an unquoted path becomes two arguments and the child either fails or opens something else.
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/opt/my tools/python3",
      args: ["--root", "/data/my folder", "--flag"],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    });

    const [cmdline] = wrapWorkerCommandMock.mock.calls.at(-1)!;
    expect(cmdline).toContain("'/opt/my tools/python3'");
    expect(cmdline).toContain("'/data/my folder'");
  });

  it("reports the wrap BEFORE spawning, so the caller can undo ASRT state", async () => {
    // The wrap increments ASRT per-command state. A spawn failure after it must still decrement, and only the caller knows how its cleanup is arranged.
    const order: string[] = [];
    spawnMock.mockImplementation(() => {
      order.push("spawn");
      return fakeChild();
    });

    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
      onWrapped: () => order.push("onWrapped"),
    });

    expect(order).toEqual(["onWrapped", "spawn"]);
  });

  it("spawns the caller's own command, unwrapped, while the host is not sandboxed", async () => {
    // A child is confined exactly as much as the host is. With the sandbox off the host runs its own tools plain, so the child is spawned as given: no wrap, no `onWrapped` (there is no ASRT state to undo), and no ASRT env overlay — the caller's baseEnv plus its own extras is the whole env.
    sandboxActiveMock.mockReturnValue(false);
    const onWrapped = vi.fn();
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: ["-m", "worker", "--socket", "/tmp/w.sock"],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: { PATH: "/usr/bin" },
      extraEnv: { HOME: "/home/u/.ave/sandbox/home" },
      onWrapped,
    });
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(onWrapped).not.toHaveBeenCalled();
    const [executable, args, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe("/usr/bin/python3");
    expect(args).toEqual(["-m", "worker", "--socket", "/tmp/w.sock"]);
    expect(options.env).toEqual({ PATH: "/usr/bin", HOME: "/home/u/.ave/sandbox/home" });
    // Still a managed child: admission and tracking do not depend on the wrap.
    expect(admissionMock).toHaveBeenCalledWith("worker:x:main");
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it("checks validity on both sides of the wrap", async () => {
    // Windows holder liveness: the ACL grant is only real while the holder is alive, so a holder that dies mid-wrap must not yield a child believed to be confined by a grant that no longer exists.
    const assertStillValid = vi.fn();
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
      assertStillValid,
    });
    expect(assertStillValid).toHaveBeenCalledTimes(2);
  });

  it("does not spawn when validity fails after the wrap", async () => {
    const assertStillValid = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("holder died");
      });

    await expect(
      spawnConfinedChild({ egressOwner: EGRESS_OWNER,
        command: "/usr/bin/python3",
        args: [],
        label: "worker:x:main",
        grantMode: "allow-list",
        tempPrincipal: PRINCIPAL,
        baseEnv: {},
        assertStillValid,
      }),
    ).rejects.toThrow("holder died");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses an empty argv rather than spawning something arbitrary", async () => {
    wrapWorkerCommandMock.mockResolvedValueOnce({ argv: [], env: {} });
    await expect(
      spawnConfinedChild({ egressOwner: EGRESS_OWNER,
        command: "/usr/bin/python3",
        args: [],
        label: "worker:x:main",
        grantMode: "allow-list",
        tempPrincipal: PRINCIPAL,
        baseEnv: {},
      }),
    ).rejects.toThrow(/empty argv/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not spawn when helper integrity admission fails", async () => {
    const check = vi.spyOn(helperIntegrity, "assertSrtWinSpawnIntegrity").mockImplementationOnce(() => {
      throw new helperIntegrity.SrtWinIntegrityError("srt-win-integrity-mismatch");
    });
    try {
      await expect(spawnConfinedChild({
        egressOwner: TEST_WORKER_EGRESS_OWNER,
        command: "/usr/bin/python3", args: [], label: "worker:x:main",
        grantMode: "allow-list", tempPrincipal: PRINCIPAL, baseEnv: {},
      })).rejects.toMatchObject({ code: "srt-win-integrity-mismatch" });
      expect(check).toHaveBeenCalledWith("/bin/sandbox");
      expect(spawnMock).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalled();
    } finally { check.mockRestore(); }
  });

  it("spawns the wrapped argv, never the caller's command", async () => {
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/usr/bin/sandbox-exec", "-p", "(profile)", "/bin/sh", "-c", "python3"],
      env: {},
    });
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: ["-u"],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    });

    const [executable, args, options] = spawnMock.mock.calls.at(-1)!;
    expect(executable).toBe("/usr/bin/sandbox-exec");
    expect(args).toEqual(["-p", "(profile)", "/bin/sh", "-c", "python3"]);
    expect((options as { shell: boolean }).shell).toBe(false);
  });

  it("lets the sandbox HOME win over the base environment", async () => {
    // The sandbox process home is the last overlay on purpose: a stale HOME inherited from the host would send the child's writes outside its jail.
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: { HOME: "/home/u", KEEP: "1" },
      extraEnv: { HOME: "/sandbox/home" },
    });

    const [, , options] = spawnMock.mock.calls.at(-1)!;
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    expect(env.HOME).toBe("/sandbox/home");
    expect(env.KEEP).toBe("1");
  });

  it("registers the child under the caller's label", async () => {
    await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:meeting:main:asrt",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    });
    expect(admissionMock).toHaveBeenCalledWith("worker:meeting:main:asrt");
    expect(trackMock).toHaveBeenCalledWith(expect.anything(), { label: "worker:meeting:main:asrt", killProcessGroup: true });
  });
});

describe("spawnConfinedChild reports the wrap it applied", () => {
  const hostPlatform = process.platform;
  afterEach(() => setProcessPlatform(hostPlatform));

  it.each([
    ["darwin", "allow-list", "macos-sandbox"],
    ["linux", "allow-list", "linux-bubblewrap"],
    ["win32", "deny-only", "windows-srt"],
  ] as const)("on %s with the sandbox live it reports %s's wrap as %s", async (platform, grantMode, expected) => {
    setProcessPlatform(platform);
    const hostSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = "C:\\Windows";
    const spawned = await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode,
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
      windowsShell: "cmd",
    }).finally(() => {
      if (hostSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = hostSystemRoot;
    });
    expect(wrapWorkerCommandMock).toHaveBeenCalledTimes(1);
    expect(spawned.confinement).toBe(expected);
    expect(spawned.child).toBe(spawnMock.mock.results[0]!.value);
  });

  it("reports an unwrapped child as unconfined on every platform, whatever the setting would say", async () => {
    // The answer follows the wrap, not `features.osToolSandbox`: the host can have the setting on and still not run a sandbox, and then nothing wraps.
    sandboxActiveMock.mockReturnValue(false);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      setProcessPlatform(platform);
      const spawned = await spawnConfinedChild({ egressOwner: EGRESS_OWNER,
        command: "/usr/bin/python3",
        args: [],
        label: "worker:x:main",
        grantMode: platform === "win32" ? "deny-only" : "allow-list",
        tempPrincipal: PRINCIPAL,
        baseEnv: {},
      });
      expect(spawned.confinement, platform).toBe("unconfined");
    }
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("refuses to name a wrap for a platform no substrate serves, before anything is spawned", async () => {
    setProcessPlatform("freebsd");
    await expect(spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "/usr/bin/python3",
      args: [],
      label: "worker:x:main",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    })).rejects.toThrow(/sandbox is active on 'freebsd', which no wrap substrate serves/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// The `cmd.exe` rendering a sandboxed Windows plugin child launches through (`windowsShell: "cmd"`). srt-win hands the line to `cmd.exe /d /v:off /s /c` verbatim, so this line IS the shell input: every token is quoted, and what quoting cannot neutralise is refused before anything is wrapped.
describe("spawnConfinedChild's cmd.exe rendering on Windows", () => {
  const hostPlatform = process.platform;
  const hostSystemRoot = process.env.SystemRoot;
  beforeEach(() => {
    setProcessPlatform("win32");
    process.env.SystemRoot = "C:\\Windows";
  });
  afterEach(() => {
    setProcessPlatform(hostPlatform);
    if (hostSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = hostSystemRoot;
  });

  function spawnCmd(command: string, args: readonly string[], env?: Record<string, string>) {
    return spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command,
      args,
      label: "plugin-child:x",
      grantMode: "deny-only",
      baseEnv: {},
      windowsShell: "cmd",
      ...(env ? { windowsCommandLineEnv: env } : {}),
    });
  }

  it("quotes every token, puts the environment first, and runs System32 cmd.exe with AutoRun and delayed expansion off", async () => {
    await spawnCmd("C:\\Program Files\\Ave\\Ave.exe", ["--preserve-symlinks", "C:\\Program Files (x86)\\a&b^c!d\\main.js"], {
      ELECTRON_RUN_AS_NODE: "1",
    });
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0]! as [string, { binShell: unknown }];
    expect(cmdline).toBe(
      'set "ELECTRON_RUN_AS_NODE=1"&& "C:\\Program Files\\Ave\\Ave.exe" "--preserve-symlinks" '
        + '"C:\\Program Files (x86)\\a&b^c!d\\main.js"',
    );
    expect(options.binShell).toEqual({ exe: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/v:off", "/s", "/c"] });
  });

  it("refuses wrapping and spawning without an absolute system root", async () => {
    for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) vi.stubEnv(key, undefined);
    try {
      await expect(spawnCmd("C:\\app.exe", [])).rejects.toThrow(/system root/i);
      expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("doubles a trailing backslash run so the target does not read the closing quote as escaped", async () => {
    await spawnCmd("C:\\app.exe", ["C:\\dir\\", "C:\\two\\\\"]);
    expect(wrapWorkerCommandMock.mock.calls[0]![0]).toBe('"C:\\app.exe" "C:\\dir\\\\" "C:\\two\\\\\\\\"');
  });

  it.each([
    ["a double quote", 'C:\\a" & calc & "\\b.js'],
    ["'%'", "C:\\Users\\%USERNAME%\\x.js"],
    ["a control character", "C:\\a.js\r\ncalc"],
    ["a control character", "C:\\a.js\n"],
    ["a control character", "C:\\a\0.js"],
  ])("refuses an argument containing %s before anything is wrapped", async (what, hostile) => {
    await expect(spawnCmd("C:\\app.exe", [hostile])).rejects.toThrow(`contains ${what}, which cmd.exe cannot be given safely`);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses the same characters in the command itself and in an environment value, and a malformed name", async () => {
    await expect(spawnCmd("C:\\100%\\app.exe", [])).rejects.toThrow("contains '%'");
    await expect(spawnCmd("C:\\app.exe", [], { X: 'a"&calc&"' })).rejects.toThrow("contains a double quote");
    await expect(spawnCmd("C:\\app.exe", [], { "X=Y": "1" })).rejects.toThrow("is not an environment variable name");
    await expect(spawnCmd("C:\\app.exe", [], { "A&calc": "1" })).rejects.toThrow("is not an environment variable name");
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("refuses a line longer than cmd.exe can carry", async () => {
    await expect(spawnCmd("C:\\app.exe", ["x".repeat(8_100)])).rejects.toThrow(/over the 8000 it can carry/);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("refuses command-line environment without the cmd rendering", async () => {
    await expect(spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "C:\\app.exe",
      args: [],
      label: "plugin-child:x",
      grantMode: "deny-only",
      baseEnv: {},
      windowsCommandLineEnv: { ELECTRON_RUN_AS_NODE: "1" },
    })).rejects.toThrow('windowsCommandLineEnv needs windowsShell "cmd"');
  });

  it("refuses a Windows sandboxed spawn that names neither the relay nor cmd: srt-win's PowerShell launch would lose its stdin, environment and exit code", async () => {
    await expect(
      spawnConfinedChild({ egressOwner: EGRESS_OWNER, command: "C:\\py.exe", args: ["w.py"], label: "worker:x:main", grantMode: "deny-only", baseEnv: {} }),
    ).rejects.toThrow(/names windowsStdio "relay" or windowsShell "cmd"/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// The Windows stdio relay (`windowsStdio: "relay"`): srt-win runs the host's own runtime in relay mode, and the program — its command, arguments, environment and directory — travels in the request over the authenticated channel, never on the `cmd.exe` line.
describe("spawnConfinedChild's Windows stdio relay", () => {
  const hostPlatform = process.platform;
  const hostSystemRoot = process.env.SystemRoot;
  beforeEach(() => {
    setProcessPlatform("win32");
    process.env.SystemRoot = "C:\\Windows";
  });
  afterEach(() => {
    setProcessPlatform(hostPlatform);
    if (hostSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = hostSystemRoot;
  });

  function relayChild() {
    const child = fakeChild();
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => true);
    return child as ReturnType<typeof fakeChild> & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  }

  function spawnRelayed(overrides: Partial<Parameters<typeof spawnConfinedChild>[0]> = {}) {
    return spawnConfinedChild({ egressOwner: EGRESS_OWNER,
      command: "C:\\Users\\example\\100% tools\\python.exe",
      args: ["w.py", 'say "hi"', "%PATH%"],
      label: "worker:x:main:asrt-win",
      grantMode: "deny-only",
      baseEnv: {
        PATH: "C:\\host\\bin",
        PATHEXT: ".EXE",
        HOME: "C:\\Users\\example",
        USERNAME: "example",
        HTTPS_PROXY: "http://corp:8080",
        node_options: "--max-old-space-size=64",
        GIT_CONFIG_COUNT: "1",
        PLUGIN_PROBE: "kept",
      },
      extraEnv: { HOME: "C:\\sandbox\\home", TEMP: "C:\\sandbox\\home\\tmp" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsStdio: "relay",
      cwd: "C:\\Users\\example\\work dir",
      ...overrides,
    });
  }

  it("runs the host's runtime in relay mode, with nothing of the program's on the cmd.exe line", async () => {
    const child = relayChild();
    spawnMock.mockImplementationOnce(() => child);
    const spawned = await spawnRelayed();
    const [cmdline, options] = wrapWorkerCommandMock.mock.calls[0]! as [string, { binShell: unknown }];
    expect(cmdline).toBe(
      `set "ELECTRON_RUN_AS_NODE=1"&& "${process.execPath}" "--preserve-symlinks" "--preserve-symlinks-main" `
        + `"${resolvePluginChildEntryPath()}" "--ave-child-transport=relay"`,
    );
    expect(options.binShell).toEqual({ exe: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/v:off", "/s", "/c"] });
    // The broker gets no working directory of its own; the program's is in the request.
    const [, , spawnOptions] = spawnMock.mock.calls[0]! as [string, string[], { cwd?: string }];
    expect(spawnOptions.cwd).toBeUndefined();
    expect(spawned.confinement).toBe("windows-srt");
    expect(spawned.stdin).not.toBe(child.stdin);
    expect(spawned.stdout).not.toBe(child.stdout);
  });

  it("sends the program, its arguments, its intended environment and its directory over the channel, and relays both ways", async () => {
    const child = relayChild();
    spawnMock.mockImplementationOnce(() => child);
    const spawned = await spawnRelayed();
    const peer = await startFakeRelayPeer(child.stdout);
    try {
      const request = await peer.request;
      expect(request).toEqual({
        command: "C:\\Users\\example\\100% tools\\python.exe",
        args: ["w.py", 'say "hi"', "%PATH%"],
        cwd: "C:\\Users\\example\\work dir",
        env: {
          // srt-win keeps PATH, PATHEXT, its proxy, its git config and the account's own USERNAME; the sandbox HOME wins over the base one; Node's symlink-preserving flags lead whatever NODE_OPTIONS was.
          HOME: "C:\\sandbox\\home",
          TEMP: "C:\\sandbox\\home\\tmp",
          PLUGIN_PROBE: "kept",
          NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main --max-old-space-size=64",
        },
      });
      spawned.stdin!.write("to the program\n");
      await vi.waitFor(() => expect(peer.input()).toBe("to the program\n"));
      const out: string[] = [];
      spawned.stdout!.on("data", (chunk: Buffer) => out.push(chunk.toString("utf-8")));
      child.stdout.write("from the program\n");
      await vi.waitFor(() => expect(out.join("")).toBe("from the program\n"));
      spawned.stdin!.end();
      await peer.inputEnded;
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it("ends the process, the output and the input's use when the relay does not connect", async () => {
    const child = relayChild();
    spawnMock.mockImplementationOnce(() => child);
    const spawned = await spawnRelayed();
    const ended = new Promise((resolve) => spawned.stdout!.once("end", resolve));
    spawned.stdout!.resume();
    child.stdout.write("Windows PowerShell banner\n");
    await ended;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(() => spawned.stdin!.write("nowhere")).not.toThrow();
  });

  it("refuses a request no environment can hold before anything is wrapped or spawned, and carries any name one can", async () => {
    await expect(spawnRelayed({ baseEnv: { "A=B": "x" } })).rejects.toThrow(/'A=B' is not an environment variable name/);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    const child = relayChild();
    spawnMock.mockImplementationOnce(() => child);
    await spawnRelayed({ baseEnv: { "ProgramFiles(x86)": "C:\\Program Files (x86)" } });
    const peer = await startFakeRelayPeer(child.stdout);
    try {
      expect(((await peer.request).env as Record<string, string>)["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    } finally {
      peer.close();
    }
  });

  it("refuses a relay with its own Windows shell, or without piped stdin and stdout, before anything is wrapped", async () => {
    await expect(spawnRelayed({ windowsShell: "cmd" })).rejects.toThrow(/sets its own Windows shell/);
    await expect(spawnRelayed({ stdio: ["ignore", "pipe", "pipe"] })).rejects.toThrow(/needs piped stdin and stdout/);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    "C:\\Program Files\\nodejs\\npx.cmd",
    "C:\\tools\\setup.BAT",
    "C:\\tools\\setup.cmd. ",
  ])("refuses the batch file %j with the reason, before anything is wrapped or spawned", async (command) => {
    await expect(spawnRelayed({ command })).rejects.toThrow(/is a batch file \(\.cmd\/\.bat\); a sandboxed Windows program cannot be one/);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a bare name that only a batch file on PATH answers, and lets one through that an executable anywhere on PATH answers", async () => {
    const scripts = mkdtempSync(join(tmpdir(), "relay-path-scripts-"));
    const binaries = mkdtempSync(join(tmpdir(), "relay-path-bin-"));
    try {
      writeFileSync(join(scripts, "npx.cmd"), "@echo off\r\n");
      writeFileSync(join(scripts, "tool.cmd"), "@echo off\r\n");
      writeFileSync(join(binaries, "tool.exe"), "");
      const baseEnv = { Path: `${scripts};${binaries}` };
      await expect(spawnRelayed({ command: "npx", baseEnv })).rejects.toThrow(
        `'${join(scripts, "npx.cmd")}' is a batch file`,
      );
      expect(spawnMock).not.toHaveBeenCalled();
      // The relay, without a shell, would find tool.exe further along PATH.
      const child = relayChild();
      spawnMock.mockImplementationOnce(() => child);
      await spawnRelayed({ command: "tool", baseEnv });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      // A name nothing on PATH answers is left to the relay, which reports it.
      spawnMock.mockImplementationOnce(() => relayChild());
      await spawnRelayed({ command: "absent", baseEnv });
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(scripts, { recursive: true, force: true });
      rmSync(binaries, { recursive: true, force: true });
    }
  });

  it("is ignored where it is not needed: unwrapped, the command runs as given in its directory with its own pipes", async () => {
    sandboxActiveMock.mockReturnValue(false);
    const child = relayChild();
    spawnMock.mockImplementationOnce(() => child);
    const spawned = await spawnRelayed();
    const [command, args, options] = spawnMock.mock.calls[0]! as [string, string[], { cwd?: string }];
    expect(command).toBe("C:\\Users\\example\\100% tools\\python.exe");
    expect(args).toEqual(["w.py", 'say "hi"', "%PATH%"]);
    expect(options.cwd).toBe("C:\\Users\\example\\work dir");
    expect(spawned.stdin).toBe(child.stdin);
    expect(spawned.stdout).toBe(child.stdout);
    expect(wrapWorkerCommandMock).not.toHaveBeenCalled();
  });

  it("is ignored on macOS and Linux, where stdin and the environment reach the child", async () => {
    setProcessPlatform("linux");
    const child = relayChild();
    spawnMock.mockImplementationOnce(() => child);
    const spawned = await spawnRelayed({ grantMode: "allow-list", tempPrincipal: PRINCIPAL, command: "/usr/bin/python3", args: ["w.py"] });
    const [cmdline] = wrapWorkerCommandMock.mock.calls[0]! as [string];
    expect(cmdline).toContain("'/usr/bin/python3' 'w.py'");
    expect(spawned.stdin).toBe(child.stdin);
  });
});
