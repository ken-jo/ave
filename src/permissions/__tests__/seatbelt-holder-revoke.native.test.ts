// A macOS holder whose admission is revoked after the launch gate released it but before its ready byte is stopped at
// once and refused (merge-review P3-1). Each source the start subscribes to is driven here, natively, with a control
// start that runs: the holder's own signal, a sandbox status change, its parent's admission, the lifetime seal, and the
// offline holder's capability. The revocation is scheduled from the launch's last identity measure, which runs inside
// the gate's recheck, so it lands while the start waits for the ready byte (the listener branch, rv13 P2-2).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const measured = vi.hoisted(() => ({ calls: 0, at: undefined as number | undefined, after: undefined as (() => void) | undefined }));

vi.mock("../../shared/container-platform.js", async (actual) => {
  const real = await actual<typeof import("../../shared/container-platform.js")>();
  return { ...real, isContainerHolderRouteEnabled: (platform: NodeJS.Platform) => platform === "darwin" || real.isContainerHolderRouteEnabled(platform) };
});
vi.mock("../holder-admission-darwin.js", async (actual) => {
  const real = await actual<typeof import("../holder-admission-darwin.js")>();
  return { ...real, measurePosixExecutableIdentity: (command: string) => {
    const identity = real.measurePosixExecutableIdentity(command);
    measured.calls += 1;
    // After this measure returns, the gate goes on to release the holder; the revocation lands on the next turn.
    if (measured.calls === measured.at && measured.after) setImmediate(measured.after);
    return identity;
  } };
});

import { __resetManagedChildProcessesForTest } from "../../main/managed-child-processes.js";
import { __resetOfflineHolderQuarantineForTest, prepareMxcHolderStart, spawnSeatbeltOfflineHolder } from "../../sandbox/wrap-bundled-command.js";
import { spawnMxcConfinedChild, type MxcConfinedChildSpawn } from "../confined-child.js";
import { startEgressRelayService, stopEgressRelayService } from "../egress-relay/relay.js";
import { verifyHolderSweepHelper } from "../holder-label-sweep.js";
import { MxcProcessCleanupError, MxcProcessContractError } from "../mxc-extension-errors.js";
import { sealMxcHolderLifetimeAdmission } from "../mxc-holder-lifetime.js";
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, _forgetMxcRuntimeRootForTest } from "../mxc-runtime-root.js";
import { __resetMacExtensionPlanForTest, setMacExtensionPlan, setMacHolderCapability } from "../sandbox-capability.js";
import { __setProvenSeatbeltHolderRouteForTest } from "../seatbelt-holder-boot.js";
import { closeHeldHolderLeases, measureSeatbeltHolderLaunchers } from "../seatbelt-holder-launch.js";

const NATIVE = process.platform === "darwin" && process.arch === "arm64";
const RESOURCES = resolve("resources");
const READY = { platform: "darwin", requestedBackend: "mxc", selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "shared" } as const;
const PATH = "/usr/bin:/bin";
// Each start sleeps for its own count of seconds, so the process table names exactly that holder.
let sleepSeconds = 3370;

let root: string;
let cache: string;
const started: MxcConfinedChildSpawn[] = [];

const sleeping = (seconds: number): boolean => execFileSync("/bin/ps", ["-Ao", "command="]).toString().split("\n").some(row => row.trim() === `/bin/sleep ${seconds}`);

describe.runIf(NATIVE)("macOS holder revoked during its start (native)", () => {
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "sbhr-")));
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", root);
    cache = currentMxcRuntimeHost().cacheHome;
    establishMxcRuntimeRoot();
    startEgressRelayService({ ask: async () => false });
    __setProvenSeatbeltHolderRouteForTest({ helper: verifyHolderSweepHelper(RESOURCES), launchers: measureSeatbeltHolderLaunchers() });
    setMacHolderCapability({ state: "ready" });
    setMacExtensionPlan(READY);
    Object.assign(measured, { calls: 0, at: undefined, after: undefined });
  });

  afterEach(async () => {
    await Promise.allSettled(started.splice(0).map(holder => holder.release()));
    await closeHeldHolderLeases();
    __resetOfflineHolderQuarantineForTest();
    await stopEgressRelayService();
    __setProvenSeatbeltHolderRouteForTest(undefined);
    __resetMacExtensionPlanForTest();
    _forgetMxcRuntimeRootForTest(cache);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    __resetManagedChildProcessesForTest();
  });

  /** One row-2 start; `revoke` runs once the launch's last measure (the gate's recheck) returned. */
  async function start(name: string, revoke?: () => void, over: Partial<Parameters<typeof spawnMxcConfinedChild>[0]> = {}): Promise<{ holder: Promise<MxcConfinedChildSpawn>; seconds: number }> {
    const seconds = ++sleepSeconds;
    return { seconds, holder: startWith(name, seconds, revoke, over) };
  }

  async function startWith(name: string, seconds: number, revoke: (() => void) | undefined, over: Partial<Parameters<typeof spawnMxcConfinedChild>[0]>): Promise<MxcConfinedChildSpawn> {
    const data = join(root, name);
    mkdirSync(data);
    const staging = prepareMxcHolderStart({ label: `test:${name}`, executable: "/bin/sh", baseEnv: { PATH }, allowWrite: [data] });
    const spec = {
      command: "/bin/sh", args: ["-c", `exec /bin/sleep ${seconds}`], cwd: staging.home, home: staging.home, temp: staging.temp,
      stagingRoot: staging.root, holder: {}, label: `test:${name}`,
      filesystemOwnership: { readRoots: [], writeRoots: [data, staging.root], hostStorageRoots: [] },
      egressOwner: { kind: "worker" as const, role: "plugin-child" as const, pluginId: name }, allowRead: [], allowWrite: [data, staging.root], baseEnv: { PATH },
      ...over,
    };
    try {
      if (revoke === undefined) {
        const holder = await spawnMxcConfinedChild(spec);
        started.push(holder);
        return holder;
      }
      // The control's count of measures tells which one is the gate's recheck: the last before the start returns.
      Object.assign(measured, { calls: 0, at: undefined, after: undefined });
      const control = await spawnMxcConfinedChild({ ...spec, label: `test:${name}-control`, holder: {} });
      const last = measured.calls;
      await control.release();
      Object.assign(measured, { calls: 0, at: last, after: revoke });
      const holder = await spawnMxcConfinedChild(spec);
      started.push(holder);
      return holder;
    } finally {
      await staging.release().catch(() => undefined);
    }
  }

  async function expectRevoked(attempt: { holder: Promise<unknown>; seconds: number }): Promise<void> {
    const error = await attempt.holder.then(() => undefined, (caught: unknown) => caught);
    expect(error, "the start should have been refused").toBeInstanceOf(MxcProcessContractError);
    // Refused by the revocation while the start waited for the ready byte, not by a later recheck.
    expect((error as Error).message).toBe("Container holder admission was revoked during its start");
    // A verified stop: not an unverified cleanup, and the holder's process is gone.
    expect(error).not.toBeInstanceOf(MxcProcessCleanupError);
    await vi.waitFor(() => expect(sleeping(attempt.seconds)).toBe(false), { timeout: 5_000, interval: 50 });
  }

  it("its own signal aborted", async () => {
    const own = new AbortController();
    await expectRevoked(await start("own-signal", () => own.abort(), { signal: own.signal }));
  });

  it("a sandbox status change that ends the extension plan", async () => {
    await expectRevoked(await start("status", () => setMacExtensionPlan({ ...READY, readiness: "checking", selectedBackend: "none", reason: "checking" })));
  });

  it("its parent's admission ending", async () => {
    const parent = await (await start("parent")).holder;
    await expectRevoked(await start("child", () => { void parent.release(); }, {
      parent, egressOwner: { kind: "worker", role: "worker", pluginId: "parent", instanceId: "w" }, workerTransport: "output-only-v1",
    }));
  });

  it("an offline holder whose capability is lost", async () => {
    // Control: an offline holder starts while the capability holds.
    const control = await spawnSeatbeltOfflineHolder({ label: "test:offline-control", command: "/bin/sleep", args: [String(++sleepSeconds)], baseEnv: { PATH } });
    const controlMeasures = measured.calls;
    await control.release();
    Object.assign(measured, { calls: 0, at: controlMeasures, after: () => setMacHolderCapability({ state: "checking" }) });
    const seconds = ++sleepSeconds;
    await expectRevoked({ seconds, holder: spawnSeatbeltOfflineHolder({ label: "test:offline", command: "/bin/sleep", args: [String(seconds)], baseEnv: { PATH } }) });
  });

  // Last: the seal cannot be undone in this process.
  it("the lifetime seal at quit", async () => {
    await expectRevoked(await start("seal", () => sealMxcHolderLifetimeAdmission("test quit")));
  });
});
