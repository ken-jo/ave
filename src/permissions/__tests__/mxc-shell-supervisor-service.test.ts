import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MxcIntegrityError } from "../../../scripts/lib/mxc-sdk-integrity.mjs";
import { createPosixSupervisorHarness, stageSeatbeltWire } from "../../__tests__/support/mxc-posix-supervisor-harness.js";
import { SEATBELT_CLEANUP_WARNINGS, seatbeltCleanupUnverified } from "../mxc-native-process.js";
import { _lostShellOutcomeForTest, _shellOutcomeForTest, MxcCwdChangedError, stageMxcShellRequest } from "../mxc-shell-supervisor-client.js";
import { captureShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";
import PINS from "../mxc-launcher-pins.json" with { type: "json" };
import { mxcShellLibraryCheck } from "../mxc-shell-supervisor-bootstrap.js";
import { serveMxcShellSupervisor } from "../mxc-shell-supervisor-service.js";

let harness: ReturnType<typeof createPosixSupervisorHarness> | undefined;

// The service restats the staged cwd with captureShellWorkingDirectoryIdentity before every spawn. On a Windows host
// that capture is the volume serial and file id, while the harness stages the POSIX realpath and stat dev and inode, so
// every start there is refused as cwd-changed before the fake SDK runs. Cases that need a spawn therefore run only on a
// POSIX host; the service itself runs only on macOS. Cases decided before the restat run everywhere.
const POSIX_CWD_IDENTITY = process.platform !== "win32";
const POSIX_ONLY = " (POSIX cwd identity; not run on a Windows host)";
afterEach(() => { harness?.dispose(); harness = undefined; });

async function runToReady(warnings: readonly string[]) {
  harness = createPosixSupervisorHarness();
  const h = harness;
  const served = serveMxcShellSupervisor(h.supervisor, h.liveness, h.stdout, h.stderr, h.bootstrap, h.onFatal);
  await h.host.send({ type: "shell-start", ...stageSeatbeltWire(h.directory) });
  await h.waitFor("shell-ready");
  const native = h.natives[0];
  if (native === undefined) throw new Error("the fake SDK spawned nothing");
  native.native.warnings.push(...warnings);
  native.stdout.end();
  native.stderr.end();
  native.resolve({ exitCode: 0, timedOut: false });
  await served;
  return h.frames.at(-1);
}

describe("macOS shell supervisor cleanup receipts", () => {
  it.runIf(POSIX_CWD_IDENTITY).each(SEATBELT_CLEANUP_WARNINGS.map((warning) => [warning]))(`reports a zero exit with %s as cleanup unverified${POSIX_ONLY}`, async (warning) => {
    expect(await runToReady([warning])).toMatchObject({ type: "error", code: "cleanup-unverified" });
  });

  it.runIf(POSIX_CWD_IDENTITY)(`reports any other post-run Seatbelt warning as cleanup unverified${POSIX_ONLY}`, async () => {
    expect(await runToReady(["Seatbelt: a cleanup phrase this build does not name"])).toMatchObject({ code: "cleanup-unverified" });
  });

  it.runIf(POSIX_CWD_IDENTITY)(`reports a clean zero exit as an exit${POSIX_ONLY}`, async () => {
    expect(await runToReady([])).toEqual({ type: "exit", exitCode: 0, timedOut: false });
  });

  it("treats only Seatbelt warnings as unverified cleanup", () => {
    expect(seatbeltCleanupUnverified([])).toBe(false);
    expect(seatbeltCleanupUnverified(["profile note"])).toBe(false);
    expect(seatbeltCleanupUnverified(["note", "Seatbelt: anything"])).toBe(true);
  });
});

describe("macOS shell outcome wording", () => {
  it("reports a supervisor lost before the run began as a failed start, still unverified", () => {
    expect(_lostShellOutcomeForTest(false)).toMatchObject({ startFailed: true, cleanupUnverified: true, rejected: false });
    expect(_lostShellOutcomeForTest(true)).toMatchObject({ cleanupUnverified: true });
    expect(_lostShellOutcomeForTest(true)).not.toHaveProperty("startFailed");
  });

  it("reports a cwd refusal before the run began as nothing run, and confirmed stopped", () => {
    const refusal = { type: "error", code: "cwd-changed", message: "x" } as const;
    expect(_shellOutcomeForTest(refusal, false)).toMatchObject({ rejected: true, cwdChanged: true, cleanupUnverified: false, code: null });
    // After ready a refusal cannot be true: the run's completion is then unverified.
    expect(_shellOutcomeForTest(refusal, true)).toMatchObject({ cleanupUnverified: true });
    expect(_shellOutcomeForTest(refusal, true)).not.toHaveProperty("cwdChanged");
  });

  it("reports a channel failure after the run began as a confirmed stop, not a container refusal", () => {
    const contract = { type: "error", code: "contract", message: "Invalid native shell supervisor transport" } as const;
    expect(_shellOutcomeForTest(contract, true)).toMatchObject({ transportFailed: true, cleanupUnverified: false, rejected: false });
    expect(_shellOutcomeForTest(contract, false)).toMatchObject({ rejected: true, cleanupUnverified: false });
    expect(_shellOutcomeForTest(contract, false)).not.toHaveProperty("transportFailed");
    expect(_shellOutcomeForTest({ type: "error", code: "integrity", message: "x" }, true)).toMatchObject({ cleanupUnverified: true });
  });
});

describe("macOS shell supervisor working directory check before spawn", () => {
  it.runIf(POSIX_CWD_IDENTITY)(`refuses a working directory replaced at the same path after staging, and never calls the SDK${POSIX_ONLY}`, async () => {
    harness = createPosixSupervisorHarness();
    const h = harness;
    const cwd = join(h.directory, "cwd");
    mkdirSync(cwd);
    const staged = stageSeatbeltWire(h.directory, { cwd });
    renameSync(cwd, join(h.directory, "moved"));
    mkdirSync(cwd);
    const served = serveMxcShellSupervisor(h.supervisor, h.liveness, h.stdout, h.stderr, h.bootstrap, h.onFatal);
    await h.host.send({ type: "shell-start", ...staged });
    await served;
    expect(h.frames.at(-1)).toMatchObject({ type: "error", code: "cwd-changed" });
    expect(h.spawned).toEqual([]);
  });

  it.runIf(POSIX_CWD_IDENTITY)(`stages the cwd's physical identity, and refuses a path that is not physical or not the expected directory${POSIX_ONLY}`, async () => {
    harness = createPosixSupervisorHarness();
    const h = harness;
    const cwd = join(h.directory, "cwd");
    mkdirSync(cwd);
    const expected = captureShellWorkingDirectoryIdentity(cwd);
    if (expected === undefined) throw new Error("no identity");
    const staged = await stageMxcShellRequest(join(h.directory, "a.json"), { process: { cwd } }, expected);
    expect(staged.cwdIdentity).toEqual({ realpath: cwd, dev: String(expected.dev), ino: String(expected.ino) });
    symlinkSync(cwd, join(h.directory, "alias"));
    await expect(stageMxcShellRequest(join(h.directory, "b.json"), { process: { cwd: join(h.directory, "alias") } })).rejects.toThrow(MxcCwdChangedError);
    renameSync(cwd, join(h.directory, "moved"));
    mkdirSync(cwd);
    await expect(stageMxcShellRequest(join(h.directory, "c.json"), { process: { cwd } }, expected)).rejects.toThrow(MxcCwdChangedError);
    expect(existsSync(join(h.directory, "b.json")) || existsSync(join(h.directory, "c.json"))).toBe(false);
  });

  it("refuses a staged environment name that /bin/sh could import as a function, and never calls the SDK", async () => {
    for (const entry of ["BASH_FUNC_read%%=() { aveHostHandoff=G; }", "BASH_FUNC_pwd%%=() { echo /forged; }", "WITH-DASH=1", "=empty"]) {
      harness?.dispose();
      harness = createPosixSupervisorHarness();
      const h = harness;
      const served = serveMxcShellSupervisor(h.supervisor, h.liveness, h.stdout, h.stderr, h.bootstrap, h.onFatal);
      await h.host.send({ type: "shell-start", ...stageSeatbeltWire(h.directory, { env: ["PATH=/usr/bin:/bin", entry] }) });
      await served;
      expect(h.frames.at(-1), entry).toMatchObject({ type: "error", code: "start-refused", sdkCode: "malformed_request" });
      expect(h.spawned).toEqual([]);
    }
  });

  async function startUntilSpawned(h: ReturnType<typeof createPosixSupervisorHarness>) {
    const served = serveMxcShellSupervisor(h.supervisor, h.liveness, h.stdout, h.stderr, h.bootstrap, h.onFatal);
    await h.host.send({ type: "shell-start", ...stageSeatbeltWire(h.directory) });
    for (let attempt = 0; attempt < 400 && h.natives.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const native = h.natives[0];
    if (native === undefined) throw new Error("the fake SDK spawned nothing");
    const stdin: Buffer[] = [];
    native.stdin.on("data", (chunk: Buffer) => stdin.push(chunk));
    return { served, native, stdin: () => Buffer.concat(stdin).toString("latin1") };
  }

  it.runIf(POSIX_CWD_IDENTITY)(`prefixes the staged command with the workload's cwd check for the staged identity${POSIX_ONLY}`, async () => {
    harness = createPosixSupervisorHarness();
    const { served, native } = await startUntilSpawned(harness);
    const command = (harness.spawned[0] as { command: string }).command;
    expect(command.endsWith("/usr/bin/true")).toBe(true);
    expect(command).toContain("$(pwd -P; printf .)");
    expect(command).not.toContain(">&3");
    expect(command).toContain(String(statSync(harness.directory, { bigint: true }).ino));
    await harness.waitFor("shell-ready");
    native.stdout.end();
    native.stderr.end();
    native.resolve({ exitCode: 0, timedOut: false });
    await served;
  });

  it.runIf(POSIX_CWD_IDENTITY)(`writes the grant only after the host's spawn-authorized frame, and reports ready only then${POSIX_ONLY}`, async () => {
    harness = createPosixSupervisorHarness();
    harness.withholdGrant();
    const h = harness;
    const { served, native, stdin } = await startUntilSpawned(h);
    await h.waitFor("shell-cwd-verified");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stdin()).toBe("");
    expect(h.frames.some((frame) => frame.type === "shell-ready")).toBe(false);
    await h.host.send({ type: "spawn-authorized" });
    await h.waitFor("shell-ready");
    expect(stdin()).toBe("G\n");
    expect(native.stdin.writableEnded).toBe(true);
    native.stdout.end("output");
    native.stderr.end();
    // A command's own 197 after the grant is its ordinary exit status.
    native.resolve({ exitCode: 197, timedOut: false });
    await served;
    expect(h.frames.at(-1)).toEqual({ type: "exit", exitCode: 197, timedOut: false });
    expect(h.stdout.read()?.toString()).toBe("output");
  });

  it.runIf(POSIX_CWD_IDENTITY)(`reports the workload's cwd refusal from its verdict byte, grants nothing and forwards no verdict${POSIX_ONLY}`, async () => {
    harness = createPosixSupervisorHarness();
    harness.reportVerdict("C");
    const h = harness;
    const { served, native, stdin } = await startUntilSpawned(h);
    await vi.waitFor(() => expect(native.stdin.writableEnded).toBe(true));
    expect(stdin()).toBe("");
    native.stdout.end();
    native.stderr.end();
    native.resolve({ exitCode: 197, timedOut: false });
    await served;
    expect(h.frames.map((frame) => frame.type)).not.toContain("shell-cwd-verified");
    expect(h.frames.at(-1)).toMatchObject({ type: "error", code: "cwd-changed" });
    expect(h.stdout.read()).toBeNull();
  });

  it.runIf(POSIX_CWD_IDENTITY)(`reports a workload that ended before its check as a refused start, and a forged verdict as a broken contract${POSIX_ONLY}`, async () => {
    for (const [forged, code] of [[undefined, "start-refused"], ["X", "contract"]] as const) {
      harness?.dispose();
      harness = createPosixSupervisorHarness();
      harness.reportVerdict("");
      const h = harness;
      const { served, native, stdin } = await startUntilSpawned(h);
      if (forged === undefined) {
        native.stdout.end();
        native.stderr.end();
        native.resolve({ exitCode: -1, timedOut: false });
      } else native.stdout.write(forged);
      await served;
      expect(stdin()).toBe("");
      expect(h.frames.map((frame) => frame.type)).not.toContain("shell-ready");
      expect(h.frames.at(-1)).toMatchObject({ type: "error", code });
    }
  });

  it("refuses an unsolicited grant as a broken contract", async () => {
    harness = createPosixSupervisorHarness();
    const h = harness;
    const served = serveMxcShellSupervisor(h.supervisor, h.liveness, h.stdout, h.stderr, h.bootstrap, h.onFatal);
    await h.host.send({ type: "spawn-authorized" });
    await served;
    expect(h.frames.at(-1)).toMatchObject({ type: "error", code: "contract" });
    expect(h.spawned).toEqual([]);
  });
});

describe("macOS shell supervisor library check before spawn", () => {
  it.runIf(POSIX_CWD_IDENTITY)(`refuses with integrity and never calls the SDK when the verified library changed since bootstrap${POSIX_ONLY}`, async () => {
    harness = createPosixSupervisorHarness();
    const h = harness;
    const served = serveMxcShellSupervisor(h.supervisor, h.liveness, h.stdout, h.stderr, h.bootstrap, h.onFatal);
    h.replaceLibrary();
    await h.host.send({ type: "shell-start", ...stageSeatbeltWire(h.directory) });
    await served;
    expect(h.frames.at(-1)).toMatchObject({ type: "error", code: "integrity" });
    expect(h.spawned).toEqual([]);
  });

  it("accepts only the pinned library at its path with no source-build fallback beside the installation", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-mxc-lib-"));
    try {
      const nodeModules = join(root, "node_modules");
      const sdkRoot = join(nodeModules, "@microsoft", "mxc-sdk");
      const member = PINS.targets["darwin-arm64"].library.member;
      mkdirSync(dirname(join(sdkRoot, member)), { recursive: true });
      copyFileSync(join("node_modules", PINS.package, member), join(sdkRoot, member));
      const check = mxcShellLibraryCheck(nodeModules, sdkRoot);
      expect(check).not.toThrow();
      mkdirSync(join(nodeModules, "src", "target"), { recursive: true });
      expect(check).toThrow(MxcIntegrityError);
      rmSync(join(nodeModules, "src"), { recursive: true });
      writeFileSync(join(sdkRoot, member), "replaced");
      expect(check).toThrow(MxcIntegrityError);
      rmSync(join(sdkRoot, member));
      expect(check).toThrow(MxcIntegrityError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
