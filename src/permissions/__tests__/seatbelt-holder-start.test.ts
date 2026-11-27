// A macOS holder through the real chain: launch gate, /usr/bin/sandbox-exec, ready shim. The stop is the group stop,
// then the label sweep, here with the real helper (built by test:prepare) or a scripted stand-in for its exit codes.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";
import { HOLDER_CONTROL_LABEL, newHolderLabels, runHolderSweep, verifyHolderSweepHelper, type HolderSweepHelper } from "../holder-label-sweep.js";
import { MxcHolderStartRefusedError, MxcProcessCleanupError, MxcProcessContractError } from "../mxc-extension-errors.js";
import { buildPolicyModel } from "../policy-model.js";
import {
  composeSeatbeltHolderLaunch, heldUnverifiedHolderLeaseCount, closeHeldHolderLeases, measureSeatbeltHolderLaunchers, seatbeltHolderLaunchDigest,
  startSeatbeltHolder, type SeatbeltHolderLaunch, type SeatbeltHolderLaunchers,
} from "../seatbelt-holder-launch.js";
import { posixPolicyLookups } from "../mxc-posix.js";

vi.mock("../asrt-sandbox.js", () => ({
  seatbeltHolderFloorRows: () => [],
  getDefaultSensitiveWriteDenyEntries: () => [],
  runWithSandboxWritePreflight: (_signal: unknown, run: () => unknown) => run(),
}));
void buildPolicyModel;

const NATIVE = process.platform === "darwin" && process.arch === "arm64";
const RESOURCES = resolve("resources");

let root: string;
let home: string;
let helper: HolderSweepHelper;
let launchers: SeatbeltHolderLaunchers;

function launchOf(script: string, over: { network?: "offline" } = {}): SeatbeltHolderLaunch {
  const lookups = { ...posixPolicyLookups(root, true), foldsCase: true };
  return composeSeatbeltHolderLaunch({
    command: "/bin/sh", args: ["-c", script], cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root },
    readRoots: [], writeRoots: [root], network: over.network ?? "offline", labels: newHolderLabels(home),
  }, { floors: [], allowWrite: [root], lookups });
}

function scriptedHelper(body: string): HolderSweepHelper {
  const dir = join(root, `helper-${Math.random().toString(16).slice(2)}`, "macos-holder-sweep", "arm64");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ave-holder-sweep");
  writeFileSync(path, `#!/bin/sh\necho "$1 $2" >> "${join(root, "sweeps.log")}"\n${body}\n`);
  chmodSync(path, 0o755);
  return verifyHolderSweepHelper(join(dir, "..", ".."));
}

const sweeps = (): string[] => existsSync(join(root, "sweeps.log")) ? readFileSync(join(root, "sweeps.log"), "utf8").trim().split("\n") : [];
const start = (launch: SeatbeltHolderLaunch, over: Partial<Parameters<typeof startSeatbeltHolder>[1]> = {}) => startSeatbeltHolder(launch, {
  label: "test:seatbelt-holder", helper, launchers, admittedDigest: launch.digest, assertStillValid: () => {}, ...over,
});

async function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolveLine => {
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) resolveLine(text.split("\n")[0] as string);
    });
  });
}

describe.runIf(NATIVE)("macOS holder start and stop", () => {
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sbh-")));
    home = join(root, "ave-home");
    mkdirSync(home);
    if (!existsSync(join(RESOURCES, "macos-holder-sweep", "arm64", "ave-holder-sweep"))) throw new Error("Run test:prepare: the holder helper is not built");
    helper = verifyHolderSweepHelper(RESOURCES);
    launchers = measureSeatbeltHolderLaunchers();
  });
  afterEach(async () => {
    rmSync(join(root, "sweeps.log"), { force: true });
    await closeHeldHolderLeases();
  });
  afterAll(() => {
    __resetManagedChildProcessesForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts only on the ready byte, gives the holder fds 0/1/2, and releases it after a clean sweep", async () => {
    const holder = await start(launchOf("echo up; for fd in 3 4 5 6 7 8 9; do [ -e /dev/fd/$fd ] && printf '%s ' $fd >&2; done; echo end >&2; exec /bin/cat"));
    expect(holder.confinement).toBe("macos-seatbelt");
    expect(await readLine(holder.process.stdout)).toBe("up");
    const fds = await new Promise<string>(done => holder.process.stderr.once("data", (chunk: Buffer) => done(chunk.toString().trim())));
    expect(fds).toBe("end");
    const echoed = readLine(holder.process.stdout);
    holder.process.stdin.write("echo-back\n");
    expect(await echoed).toBe("echo-back");
    await expect(holder.dispose()).resolves.toBeDefined();
  });

  it("refuses at the recheck a launch record changed after admission, releasing nothing through the gate", async () => {
    const launch = launchOf("echo ran > ran.txt");
    await expect(start(launch, { admittedDigest: "0".repeat(64) })).rejects.toBeInstanceOf(MxcProcessContractError);
    await expect(start(launch, { assertStillValid: () => { throw new MxcProcessContractError("parent released"); } })).rejects.toThrow("parent released");
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
  });

  it("refuses a start when a launcher of the chain changed since boot", async () => {
    const changed = { files: launchers.files.map((file, index) => index === 0 ? { ...file, sha256: "0".repeat(64) } : file) };
    await expect(start(launchOf("true"), { launchers: changed })).rejects.toMatchObject({ reason: "integrity" });
  });

  it("names a kernel-refused profile as request-rejected, sweeps it, and reports no cleanup error", async () => {
    helper = scriptedHelper('echo "result clean signalled=0"; exit 0');
    try {
      const good = launchOf("true");
      const profile = "(version 1)\n(deny default)\n(not-a-rule)\n";
      const argv = ["-p", profile, ...good.argv.slice(2)];
      const bad = { ...good, profile, argv };
      const refused = start({ ...bad, digest: seatbeltHolderLaunchDigest(bad as SeatbeltHolderLaunch) } as SeatbeltHolderLaunch);
      await expect(refused).rejects.toMatchObject({ name: "MxcHolderStartRefusedError", reason: "request-rejected" });
      expect(sweeps()).toEqual([`sweep ${good.labels.holder}`]);
    } finally {
      helper = verifyHolderSweepHelper(RESOURCES);
    }
  });

  it("treats a ready holder's exit 65 or 127 as an ordinary exit, and a stalled start as a refusal after a full stop", async () => {
    for (const code of [65, 127]) {
      const holder = await start(launchOf(`exit ${code}`));
      await expect(holder.process.completion).resolves.toMatchObject({ code });
      await holder.dispose();
    }
    await expect(start(launchOf("true"), { startMs: 1 })).rejects.toBeInstanceOf(MxcHolderStartRefusedError);
  });

  it("resolves completion only after the whole output of a holder that exits at once", async () => {
    const holder = await start(launchOf("/usr/bin/head -c 524288 /dev/zero | /usr/bin/tr '\\0' x; exit 0"));
    let bytes = 0;
    holder.process.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    await expect(holder.process.completion).resolves.toMatchObject({ code: 0 });
    expect(bytes).toBe(524_288);
    await holder.dispose();
  });

  it("keeps the exit result when the caller writes stdin after the holder exited", async () => {
    const holder = await start(launchOf("exit 3"));
    await holder.process.completion;
    holder.process.stdin.write("late\n");
    holder.process.stdin.write("later\n");
    await new Promise(done => setTimeout(done, 50));
    await expect(holder.process.completion).resolves.toMatchObject({ code: 3 });
    await holder.dispose();
  });

  it("gives a holder its SIGTERM grace and sweeps only afterwards", async () => {
    helper = scriptedHelper('echo "result clean signalled=0"; exit 0');
    try {
      const holder = await start(launchOf("trap '/bin/sleep 1.5; echo done > done.txt; exit 0' TERM; echo ready; while :; do /bin/sleep 0.05; done"));
      await readLine(holder.process.stdout);
      const began = Date.now();
      await expect(holder.dispose()).resolves.toBeDefined();
      expect(readFileSync(join(root, "done.txt"), "utf8").trim()).toBe("done");
      expect(Date.now() - began).toBeGreaterThanOrEqual(1_400);
      expect(sweeps()).toHaveLength(1);
    } finally {
      helper = verifyHolderSweepHelper(RESOURCES);
    }
    const source = readFileSync(new URL("../seatbelt-holder-launch.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\/mxc-shell-supervisor|@microsoft\/mxc-sdk/u);
  });

  it.each([
    ["unclean", 'echo "result unclean signalled=3"; exit 3'],
    ["refused", 'echo "result refused signalled=0"; exit 4'],
    ["usage", "exit 64"],
    ["failed", 'echo "result failed signalled=0"; exit 70'],
    ["disagreeing", 'echo "result clean signalled=0"; exit 3'],
    ["timed out", "/bin/sleep 5"],
  ])("reports cleanup unverified and holds the lease when the sweep is %s", async (_name, body) => {
    const lease = { close: vi.fn(async () => {}) };
    const launch = launchOf("exec /bin/sleep 30");
    const holder = await start(launch, { helper: scriptedHelper(body), egress: { release: () => {}, lease } });
    const before = heldUnverifiedHolderLeaseCount();
    await expect(holder.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    expect(lease.close).not.toHaveBeenCalled();
    expect(heldUnverifiedHolderLeaseCount()).toBe(before + 1);
    expect(sweeps()).toEqual([`sweep ${launch.labels.holder}`]);
    // The scripted sweep ended nothing; the real one ends what is left of this holder's label.
    await expect(runHolderSweep(helper, "sweep", launch.labels.holder, 2_000)).resolves.toMatchObject({ verified: true });
  }, 15_000);

  it("reports cleanup unverified when the helper cannot start", async () => {
    const scripted = scriptedHelper('echo "result clean signalled=0"; exit 0');
    const holder = await start(launchOf("exec /bin/sleep 30"), { helper: scripted });
    rmSync(scripted.path);
    await expect(holder.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
  });

  it("closes the lease after a verified stop", async () => {
    const lease = { close: vi.fn(async () => {}) };
    const released = vi.fn();
    const holder = await start(launchOf("exec /bin/sleep 30"), { egress: { release: released, lease } });
    await holder.dispose();
    expect(released).toHaveBeenCalledOnce();
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it("refuses a helper whose image is not the pinned one, and a stop whose helper changed since boot", async () => {
    vi.stubGlobal("__AVE_MACOS_HOLDER_SWEEP_SHA256__", "0".repeat(64));
    try {
      expect(() => verifyHolderSweepHelper(RESOURCES)).toThrow(expect.objectContaining({ reason: "integrity" }));
    } finally {
      vi.unstubAllGlobals();
    }
    const copyRoot = join(root, "copy");
    mkdirSync(join(copyRoot, "macos-holder-sweep", "arm64"), { recursive: true });
    const copy = join(copyRoot, "macos-holder-sweep", "arm64", "ave-holder-sweep");
    copyFileSync(helper.path, copy);
    const copied = verifyHolderSweepHelper(copyRoot);
    writeFileSync(copy, Buffer.concat([readFileSync(copy), Buffer.from([0])]));
    await expect(runHolderSweep(copied, "sweep", "dev.ave.holder.test.nobody", 2_000)).resolves.toMatchObject({ verified: false });
    await expect(start(launchOf("true"), { helper: copied })).rejects.toMatchObject({ reason: "integrity" });
    expect(HOLDER_CONTROL_LABEL).toBe("dev.ave.holder.ctl");
  });

  it("keeps the holder's stderr written right after the ready byte until its consumer reads it", async () => {
    const holder = await start(launchOf("echo early-diagnostic >&2; exec /bin/cat"));
    // The consumer attaches late, as an adapter does after its own setup.
    await new Promise(done => setTimeout(done, 300));
    const text = await new Promise<string>(done => {
      setTimeout(() => done("lost"), 2_000).unref();
      holder.process.stderr.once("data", (chunk: Buffer) => done(chunk.toString().trim()));
    });
    expect(text).toBe("early-diagnostic");
    await expect(holder.dispose()).resolves.toBeDefined();
  });

  it("reports a helper that cannot even be spawned as unverified instead of throwing", async () => {
    // A label with a NUL byte makes spawn() throw synchronously, before any timer exists.
    await expect(runHolderSweep(helper, "sweep", "dev.ave.holder.bad\0label", 2_000))
      .resolves.toMatchObject({ verified: false, reason: expect.stringContaining("the helper did not start") });
  });
});
