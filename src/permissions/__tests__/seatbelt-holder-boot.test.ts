// The holder boot sequence through the real chain and the real helper: the three controls, the boot sweep, the
// watcher, and the gate holder starts wait on.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const lock = vi.hoisted(() => ({ held: true }));
vi.mock("../../shared/ave-home-configuration-access.js", () => ({ isAveHomeConfigurationOwner: () => lock.held }));
vi.mock("../asrt-sandbox.js", () => ({
  seatbeltHolderFloorRows: () => [],
  getDefaultSensitiveWriteDenyEntries: () => [],
  runWithSandboxWritePreflight: (_signal: unknown, run: () => unknown) => run(),
}));

import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";
import { holderInstancePart, newHolderLabels, runHolderSweep, verifyHolderSweepHelper } from "../holder-label-sweep.js";
import {
  __resetHolderBootSweepForTest, proveSeatbeltHolderRoute, runHolderBootSweep, runSeatbeltHolderBootSequence, startHolderWatcher,
} from "../seatbelt-holder-boot.js";
import {
  __resetSeatbeltHolderBootGateForTest, composeSeatbeltHolderLaunch, measureSeatbeltHolderLaunchers, startSeatbeltHolder,
} from "../seatbelt-holder-launch.js";
import { posixPolicyLookups } from "../mxc-posix.js";

const NATIVE = process.platform === "darwin" && process.arch === "arm64";
const RESOURCES = resolve("resources");
const REAL = join(RESOURCES, "macos-holder-sweep", "arm64", "ave-holder-sweep");
let root: string;
let home: string;

function resourcesWith(body: string | { copy: string }): string {
  const dir = mkdtempSync(join(root, "res-"));
  const target = join(dir, "macos-holder-sweep", "arm64", "ave-holder-sweep");
  mkdirSync(join(dir, "macos-holder-sweep", "arm64"), { recursive: true });
  if (typeof body === "string") {
    writeFileSync(target, `#!/bin/sh\n${body}\n`);
    chmodSync(target, 0o755);
  } else {
    copyFileSync(body.copy, target);
  }
  return dir;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.runIf(NATIVE)("macOS holder boot sequence", () => {
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sbb-")));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterEach(() => {
    __resetHolderBootSweepForTest();
    __resetSeatbeltHolderBootGateForTest();
    lock.held = true;
  });
  afterAll(() => {
    __resetManagedChildProcessesForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("passes all three controls on this machine", async () => {
    const proof = await proveSeatbeltHolderRoute({ resourcePath: RESOURCES, home });
    expect(proof.state === "unproven" ? proof.detail : "proven").toBe("proven");
  }, 20_000);

  it("is unproven when the helper never signals (C1), when it ends a non-member (C2), or when the stale identity is not refused (C3)", async () => {
    const never = resourcesWith({ copy: join(RESOURCES, "macos-holder-sweep", "arm64", "ave-holder-sweep-never-signals") });
    await expect(proveSeatbeltHolderRoute({ resourcePath: never, home })).resolves.toMatchObject({ state: "unproven", reason: "sweep-unproven", detail: expect.stringContaining("C1") });
    // Sweeps the whole instance, so the second canary goes with the first.
    const greedy = resourcesWith(`[ "$1" = sweep ] && exec "${REAL}" sweep "$(echo "$2" | /usr/bin/sed 's/\\.b[0-9a-f]*\\.h[0-9a-f]*$/.any/')" "$3"; exec "${REAL}" "$@"`);
    await expect(proveSeatbeltHolderRoute({ resourcePath: greedy, home })).resolves.toMatchObject({ state: "unproven", detail: expect.stringContaining("C2") });
    const unproving = resourcesWith(`[ "$1" = prove ] && { echo "result unproven check=false signal=false member=true"; exit 5; }; exec "${REAL}" "$@"`);
    await expect(proveSeatbeltHolderRoute({ resourcePath: unproving, home })).resolves.toMatchObject({ state: "unproven", detail: expect.stringContaining("C3") });
  }, 30_000);

  it("is binary-missing without the helper and integrity with a writable one", async () => {
    await expect(proveSeatbeltHolderRoute({ resourcePath: mkdtempSync(join(root, "none-")), home })).resolves.toMatchObject({ state: "unproven", reason: "binary-missing" });
    const writable = resourcesWith("exit 0");
    chmodSync(join(writable, "macos-holder-sweep", "arm64", "ave-holder-sweep"), 0o777);
    await expect(proveSeatbeltHolderRoute({ resourcePath: writable, home })).resolves.toMatchObject({ state: "unproven", reason: "integrity" });
  });

  it("runs the boot sweep once, only with the instance lock, and holds every holder start until the sequence ends", async () => {
    const helper = verifyHolderSweepHelper(RESOURCES);
    lock.held = false;
    await expect(runHolderBootSweep(helper, home)).rejects.toThrow("instance lock");
    lock.held = true;
    const order: string[] = [];
    const publish = vi.fn((readiness: { ready: boolean }) => { order.push(`published ${readiness.ready}`); });
    const sequence = runSeatbeltHolderBootSequence({ resourcePath: RESOURCES, home, publish });
    const lookups = { ...posixPolicyLookups(root, true), foldsCase: true };
    const launch = composeSeatbeltHolderLaunch({
      command: "/bin/sh", args: ["-c", "exec /bin/sleep 30"], cwd: root, env: { PATH: "/bin" }, readRoots: [], writeRoots: [root],
      network: "offline", labels: newHolderLabels(home),
    }, { floors: [], allowWrite: [root], lookups });
    const started = startSeatbeltHolder(launch, {
      label: "test:gated", helper, launchers: measureSeatbeltHolderLaunchers(), admittedDigest: launch.digest, assertStillValid: () => {},
    }).then((holder) => { order.push("holder started"); return holder; });
    const result = await sequence;
    const holder = await started;
    expect(order).toEqual(["published true", "holder started"]);
    expect(result.watcher?.available()).toBe(true);
    await expect(runHolderBootSweep(helper, home)).rejects.toThrow("already ran");
    // The watcher's quit sweep ends this run's holders.
    expect(await result.watcher?.stop()).toBe(true);
    await expect(holder.process.completion).resolves.toMatchObject({ signal: "SIGKILL" });
    await expect(holder.dispose()).resolves.toBeDefined();
  }, 30_000);

  it("respawns a watcher that was killed with the same label, and gives up after three failed respawns", async () => {
    const helper = verifyHolderSweepHelper(RESOURCES);
    const watcher = startHolderWatcher(helper, { home, respawnMinMs: 200 });
    const first = watcher.pid() as number;
    process.kill(first, "SIGKILL");
    await vi.waitFor(() => {
      expect(watcher.pid()).toBeDefined();
      expect(watcher.pid()).not.toBe(first);
    }, { timeout: 2_000, interval: 25 });
    expect(alive(watcher.pid() as number)).toBe(true);
    expect(await watcher.stop()).toBe(true);
    const failing = verifyHolderSweepHelper(resourcesWith("exit 0"));
    const onUnavailable = vi.fn();
    const broken = startHolderWatcher(failing, { home, respawnMinMs: 50, onUnavailable });
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce(), { timeout: 2_000, interval: 25 });
    expect(broken.available()).toBe(false);
    await broken.stop();
  }, 15_000);

  it("derives the instance from the canonical Ave home", () => {
    const other = join(root, "other-home");
    const link = join(root, "link-home");
    mkdirSync(other);
    symlinkSync(home, link);
    expect(holderInstancePart(link)).toBe(holderInstancePart(home));
    expect(holderInstancePart(other)).not.toBe(holderInstancePart(home));
    expect(newHolderLabels(home).instance).toMatch(/^dev\.ave\.holder\.i[0-9a-f]{16}\.any$/u);
    void runHolderSweep;
  });
});
