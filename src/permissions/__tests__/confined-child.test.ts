/**
 * The confinement primitive extracted from `worker-spawn.ts`.
 *
 * The worker suite proves the WIRING — that the primitive is called with the
 * right arguments — but it stubs `wrapWorkerCommand`, so a green run there
 * says nothing about what the primitive actually hands ASRT. These assert the
 * command line and filesystem config it composes, which is the part an
 * extraction can silently change.
 *
 * The deny floor is the reason this primitive owns that composition. In ASRT a
 * per-command `denyRead`/`denyWrite` REPLACES the shared boot floor instead of
 * extending it — an empty-but-present array is not nullish — so a caller that
 * omits it hands the child back read of `~/.ave/secrets`, `~/.ssh`, `~/.aws`.
 * Six call sites restate that floor by hand today. Callers here cannot omit it,
 * and these tests are what keeps that true.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const wrapWorkerCommandMock = vi.fn<
  (command: string, options?: unknown) => Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
>();
const spawnMock = vi.fn();
const trackMock = vi.fn();
const admissionMock = vi.fn();
// Whether the host runs under the OS sandbox. The primitive follows this one
// answer: wrap while it is true, spawn the caller's command as given while it
// is false. Defaults to true so the composition cases below see the wrap.
const sandboxActiveMock = vi.fn<() => boolean>();

const TEMP_ROOT = "/home/u/.ave/sandbox/tmp";
const HOME_ROOT = "/home/u/.ave/sandbox/home";
const PRINCIPAL = { kind: "plugin", id: "x" } as const;
// The principal's own directory, as the real `ensureSandboxTempPrincipalDir`
// names it; named here so the cases can say which entry is the caller's.
const TEMP_DIR = `${TEMP_ROOT}/plugin-78`;

vi.mock("../asrt-sandbox.js", async (importOriginal) => ({
  // The real launcher, so the command line asserted below is the one ASRT gets.
  sandboxTempEnvLaunch: (await importOriginal<typeof import("../asrt-sandbox.js")>()).sandboxTempEnvLaunch,
  ensureSandboxTempPrincipalDir: (principal: { kind: string; id: string }) => ({
    dir: `${TEMP_ROOT}/${principal.kind}-${Buffer.from(principal.id).toString("hex")}`,
    root: TEMP_ROOT,
  }),
  isAsrtSandboxActive: () => sandboxActiveMock(),
  wrapWorkerCommand: (command: string, options?: unknown) =>
    wrapWorkerCommandMock(command, options),
  // The floor carries the sandbox private roots, as the real one does on
  // macOS and Linux; the primitive's own directories are re-allowed under it.
  getDefaultSensitiveReadDenyPaths: () => ["/home/u/.ave/secrets", "/home/u/.ssh", TEMP_ROOT, HOME_ROOT],
  getDefaultSensitiveWriteDenyPaths: () => ["/home/u/.ave/secrets", "/home/u/.bashrc"],
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: (label: string) => admissionMock(label),
  trackManagedChildProcess: (child: unknown, opts: unknown) => trackMock(child, opts),
}));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { spawnConfinedChild } = await import("../confined-child.js");

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

/** The filesystem config the primitive handed ASRT on the last wrap. */
function lastFilesystem() {
  const [, options] = wrapWorkerCommandMock.mock.calls.at(-1)!;
  return (options as { filesystem: Record<string, string[]> }).filesystem;
}

describe("spawnConfinedChild", () => {
  it("restates the deny floor even when the caller passes no paths at all", async () => {
    await spawnConfinedChild({
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
    await spawnConfinedChild({
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
    // The temp directory comes FIRST and is not the caller's — the primitive
    // grants it the way it restates the deny floor, for the same reason: a
    // caller that forgot would produce a child whose `os.tmpdir()` names a
    // directory it cannot write, and that failure surfaces inside whatever
    // library happened to want a temp file rather than at the spawn.
    expect(fs.allowRead).toEqual([TEMP_DIR, "/data/in"]);
    expect(fs.allowWrite).toEqual([TEMP_DIR, "/data/out"]);
    expect(fs.denyRead).toContain("/home/u/.ssh");
  });

  it("grants its principal's temp directory alone and read-denies the shared root, with no caller paths", async () => {
    await spawnConfinedChild({
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
    // Every other principal's directory is under the root, and ASRT's reads
    // are deny-only: the floor's deny of it, restated whole, is what keeps the
    // child from reading them all.
    expect(fs.denyRead).toEqual(["/home/u/.ave/secrets", "/home/u/.ssh", TEMP_ROOT, HOME_ROOT]);
    expect(fs.allowWrite).not.toContain(TEMP_ROOT);
  });

  it("sets TMPDIR, TMP and TEMP to that directory inside the wrap", async () => {
    // ASRT puts its own `TMPDIR=<shared root>` ahead of the sandboxed command,
    // so only an assignment made inside the wrap reaches the child.
    await spawnConfinedChild({
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
    await expect(spawnConfinedChild({
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
    // Passing them here would imply a confinement the wrap does not perform:
    // on Windows the grant is held against a separate holder process.
    await spawnConfinedChild({
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

  it("quotes every token so a path with spaces cannot mis-split", async () => {
    // ASRT runs this through a shell, so an unquoted path becomes two arguments
    // and the child either fails or opens something else.
    await spawnConfinedChild({
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
    // The wrap increments ASRT per-command state. A spawn failure after it must
    // still decrement, and only the caller knows how its cleanup is arranged.
    const order: string[] = [];
    spawnMock.mockImplementation(() => {
      order.push("spawn");
      return fakeChild();
    });

    await spawnConfinedChild({
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
    // A child is confined exactly as much as the host is. With the sandbox
    // off the host runs its own tools plain, so the child is spawned as given:
    // no wrap, no `onWrapped` (there is no ASRT state to undo), and no ASRT
    // env overlay — the caller's baseEnv plus its own extras is the whole env.
    sandboxActiveMock.mockReturnValue(false);
    const onWrapped = vi.fn();
    await spawnConfinedChild({
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
    // Windows holder liveness: the ACL grant is only real while the holder is
    // alive, so a holder that dies mid-wrap must not yield a child believed to
    // be confined by a grant that no longer exists.
    const assertStillValid = vi.fn();
    await spawnConfinedChild({
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
      spawnConfinedChild({
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
      spawnConfinedChild({
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

  it("spawns the wrapped argv, never the caller's command", async () => {
    wrapWorkerCommandMock.mockResolvedValueOnce({
      argv: ["/usr/bin/sandbox-exec", "-p", "(profile)", "/bin/sh", "-c", "python3"],
      env: {},
    });
    await spawnConfinedChild({
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
    // The sandbox process home is the last overlay on purpose: a stale HOME
    // inherited from the host would send the child's writes outside its jail.
    await spawnConfinedChild({
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
    await spawnConfinedChild({
      command: "/usr/bin/python3",
      args: [],
      label: "worker:meeting:main:asrt",
      grantMode: "allow-list",
      tempPrincipal: PRINCIPAL,
      baseEnv: {},
    });
    expect(admissionMock).toHaveBeenCalledWith("worker:meeting:main:asrt");
    expect(trackMock).toHaveBeenCalledWith(expect.anything(), { label: "worker:meeting:main:asrt" });
  });
});
