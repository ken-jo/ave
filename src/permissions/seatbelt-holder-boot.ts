// Once per app run, before any macOS holder starts: prove the label sweep through the real chain (owner O8's three
// controls), end what an earlier run of this instance left (the boot sweep), and start the one watcher that sweeps
// this run's holders if Ave dies. Holder starts wait on the whole sequence. Any failure leaves the holder route
// unproven, which is the extension-start floor (O1): ask at each start, as on Windows. Never a silent group-only stop.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { isAveHomeConfigurationOwner } from "../shared/ave-home-configuration-access.js";
import { errorMessage } from "../shared/error-message.js";
import type { SandboxMacExtensionReason } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  assertHolderSweepHelperUnchanged, HOLDER_CONTROL_LABEL, HolderSweepUnavailableError, newHolderLabels, runHolderSweep, verifyHolderSweepHelper,
  type HolderSweepHelper,
} from "./holder-label-sweep.js";
import { MxcHolderStartRefusedError } from "./mxc-extension-errors.js";
import {
  buildSeatbeltHolderLaunch, closeHeldHolderLeases, gateSeatbeltHolderStartsOn, measureSeatbeltHolderLaunchers, startSeatbeltHolderNow, type SeatbeltHolder, type SeatbeltHolderLaunchers,
} from "./seatbelt-holder-launch.js";

const log = createLogger("seatbelt-holder-boot");

/** A canary: a background job in its own process group (job control on), the setpgid escape a group stop misses. */
const CANARY_SCRIPT = "set -m; /bin/sleep 600 & echo $!; set +m; exec /bin/sleep 600";

export type SeatbeltHolderRouteProof =
  | { readonly state: "proven"; readonly helper: HolderSweepHelper; readonly launchers: SeatbeltHolderLaunchers }
  | { readonly state: "unproven"; readonly reason: Extract<SandboxMacExtensionReason, "binary-missing" | "integrity" | "sweep-unproven">; readonly detail: string };

export interface SeatbeltHolderBootDependencies {
  readonly resourcePath: string;
  /** The instance's Ave home: the boot sweep's scope. */
  readonly home?: string;
  readonly signal?: AbortSignal;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function firstLine(holder: SeatbeltHolder): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("the canary did not report its background job")), TOOL_TIMEOUT_POLICY.mxcMacHolderStartMs);
    holder.process.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const line = text.split("\n");
      if (line.length > 1) {
        clearTimeout(timer);
        resolve(Number(line[0]));
      }
    });
  });
}

/** The three controls through the real chain: an escape is found and ended, a non-member is untouched, a stale identity is refused. */
export async function proveSeatbeltHolderRoute(deps: SeatbeltHolderBootDependencies): Promise<SeatbeltHolderRouteProof> {
  let helper: HolderSweepHelper;
  let launchers: SeatbeltHolderLaunchers;
  try {
    helper = verifyHolderSweepHelper(deps.resourcePath);
    launchers = measureSeatbeltHolderLaunchers();
  } catch (error) {
    if (error instanceof HolderSweepUnavailableError) return { state: "unproven", reason: error.reason, detail: error.message };
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "unproven", reason: "binary-missing", detail: errorMessage(error) };
    if (error instanceof MxcHolderStartRefusedError) return { state: "unproven", reason: "integrity", detail: error.message };
    throw error;
  }
  const work = mkdtempSync(join(tmpdir(), "ave-holder-canary-"));
  const holders: SeatbeltHolder[] = [];
  let bystander: ChildProcess | undefined;
  const unproven = (detail: string): SeatbeltHolderRouteProof => ({ state: "unproven", reason: "sweep-unproven", detail });
  try {
    const start = async (): Promise<{ holder: SeatbeltHolder; job: number }> => {
      const launch = await buildSeatbeltHolderLaunch({
        command: "/bin/sh", args: ["-c", CANARY_SCRIPT], cwd: work, env: { PATH: "/usr/bin:/bin" },
        readRoots: [], writeRoots: [work], network: "offline", labels: newHolderLabels(deps.home),
      }, deps.signal);
      const holder = await startSeatbeltHolderNow(launch, {
        label: "boot:holder-canary", helper, launchers, admittedDigest: launch.digest, assertStillValid: () => deps.signal?.throwIfAborted(),
      });
      holders.push(holder);
      return { holder, job: await firstLine(holder) };
    };
    const a = await start();
    const b = await start();
    bystander = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
    // C1: the group stop misses the background job; the sweep of A's label must find and end it.
    process.kill(-a.holder.process.pid, "SIGKILL");
    await a.holder.process.completion;
    if (!alive(a.job)) return unproven("the canary's background job left with its group, so the check proves nothing");
    const c1 = await runHolderSweep(helper, "sweep", a.holder.labels.holder, TOOL_TIMEOUT_POLICY.mxcMacHolderSweepMs);
    if (!c1.verified || c1.signalled < 1 || alive(a.job)) return unproven(`C1: the sweep did not end an escaped member (${c1.verified ? `signalled ${c1.signalled}` : c1.reason})`);
    await a.holder.dispose("holder boot check");
    // C2: the other holder and an unsandboxed process are untouched.
    if (!alive(b.holder.process.pid) || !alive(b.job) || bystander.pid === undefined || !alive(bystander.pid)) {
      return unproven("C2: the sweep ended a process outside its label");
    }
    // C3: a token with a stale pid version is refused by the check and by the signal.
    const c3 = await runHolderSweep(helper, "prove", b.holder.labels.holder, TOOL_TIMEOUT_POLICY.mxcMacHolderSweepMs);
    if (!c3.verified) return unproven(`C3: ${c3.reason}`);
    await b.holder.dispose("holder boot check");
    return { state: "proven", helper, launchers };
  } catch (error) {
    if (error instanceof MxcHolderStartRefusedError) return unproven(`a canary did not start: ${error.message}`);
    return unproven(errorMessage(error));
  } finally {
    bystander?.kill("SIGKILL");
    await Promise.allSettled(holders.map(holder => holder.dispose("holder boot check")));
    rmSync(work, { recursive: true, force: true });
  }
}

let bootSweepRan = false;

/** End what an earlier run of this instance left. Once per app run, with the host instance lock held. */
export async function runHolderBootSweep(helper: HolderSweepHelper, home?: string): Promise<boolean> {
  if (!isAveHomeConfigurationOwner()) throw new Error("The holder boot sweep requires the host instance lock");
  if (bootSweepRan) throw new Error("The holder boot sweep already ran this app run");
  bootSweepRan = true;
  const outcome = await runHolderSweep(helper, "sweep", newHolderLabels(home).instance, TOOL_TIMEOUT_POLICY.mxcMacHolderSweepMs);
  // Leftovers are not this run's holders: the route stays proven, and the earlier run's cleanup is recorded as unverified.
  if (!outcome.verified) log.warn({ reason: outcome.reason }, "holder boot sweep: cleanup of an earlier run is unverified");
  else if (outcome.signalled > 0) log.warn({ signalled: outcome.signalled }, "holder boot sweep ended processes an earlier run left");
  return outcome.verified;
}

// ---------------------------------------------------------------------------------------------------------------------
// The watcher: the helper in watch mode, blocked on a pipe whose write end Ave keeps. When Ave exits in any way the
// pipe closes and the watcher sweeps this run's label. No holder depends on it.

const WATCHER_FAILURE_LIMIT = 3;

export interface HolderWatcher {
  /** False after three respawns failed in a row: new holder starts fall to the floor. Live holders are unaffected. */
  available(): boolean;
  pid(): number | undefined;
  /** Quit, after the holder drain: close the pipe and wait for the watcher's sweep. */
  stop(): Promise<boolean>;
}

export function startHolderWatcher(helper: HolderSweepHelper, input: { readonly home?: string; readonly onUnavailable?: () => void; readonly respawnMinMs?: number } = {}): HolderWatcher {
  const label = newHolderLabels(input.home).boot;
  const respawnMinMs = input.respawnMinMs ?? 1_000;
  let current: ChildProcess | undefined;
  let failures = 0;
  let stopping = false;
  let unavailable = false;
  let respawnTimer: NodeJS.Timeout | undefined;
  const spawnWatcher = (): void => {
    respawnTimer = undefined;
    if (stopping || unavailable) return;
    try {
      assertHolderSweepHelperUnchanged(helper);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "holder watcher not started: the helper changed");
      return fail();
    }
    const startedAt = Date.now();
    const child = spawn(helper.path, ["watch", label, HOLDER_CONTROL_LABEL], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: {} });
    current = child;
    child.stdin?.on("error", () => {});
    child.once("error", () => {});
    child.once("exit", () => {
      if (current === child) current = undefined;
      if (stopping) return;
      // A watcher that lived a while had not failed; one that ended at once had.
      if (Date.now() - startedAt < respawnMinMs) fail();
      else failures = 0;
      if (!unavailable) respawnTimer = setTimeout(spawnWatcher, respawnMinMs);
    });
  };
  const fail = (): void => {
    failures += 1;
    if (failures >= WATCHER_FAILURE_LIMIT && !unavailable) {
      unavailable = true;
      log.error("holder watcher could not be kept running; new holder starts are unproven");
      input.onUnavailable?.();
    }
  };
  spawnWatcher();
  return {
    available: () => !unavailable,
    pid: () => current?.pid,
    stop: async () => {
      stopping = true;
      if (respawnTimer) clearTimeout(respawnTimer);
      const child = current;
      if (child === undefined || child.exitCode !== null) return false;
      const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
      child.stdin?.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), TOOL_TIMEOUT_POLICY.mxcMacHolderSweepMs);
      const code = await exited;
      clearTimeout(timer);
      if (code !== 0) log.warn({ code }, "holder watcher's quit sweep was not clean");
      return code === 0;
    },
  };
}

// @internal — test teardown only.
export function __resetHolderBootSweepForTest(): void {
  bootSweepRan = false;
}

export interface SeatbeltHolderBootResult {
  readonly proof: SeatbeltHolderRouteProof;
  readonly watcher?: HolderWatcher;
}

/**
 * The whole boot sequence, gated: holder starts wait for it. Proven means the boot sweep ran once and the watcher
 * started; `publish` receives the plan's readiness either way, and again if the watcher later cannot be kept.
 */
export function runSeatbeltHolderBootSequence(deps: SeatbeltHolderBootDependencies & {
  readonly publish: (readiness: { readonly ready: true } | { readonly ready: false; readonly reason: SandboxMacExtensionReason }) => void;
}): Promise<SeatbeltHolderBootResult> {
  const sequence = (async (): Promise<SeatbeltHolderBootResult> => {
    const proof = await proveSeatbeltHolderRoute(deps);
    if (proof.state === "unproven") {
      log.warn({ reason: proof.reason, detail: proof.detail }, "macOS holder route unproven; extension starts ask each time");
      deps.publish({ ready: false, reason: proof.reason });
      return { proof };
    }
    await runHolderBootSweep(proof.helper, deps.home);
    const watcher = startHolderWatcher(proof.helper, { home: deps.home, onUnavailable: () => deps.publish({ ready: false, reason: "watcher-unavailable" }) });
    deps.publish({ ready: true });
    return { proof, watcher };
  })();
  gateSeatbeltHolderStartsOn(sequence);
  return sequence;
}

let runningWatcher: HolderWatcher | undefined;

/** Boot (`sandbox-init.ts`): run the sequence for this app run and publish the macOS extension plan from it. */
export function startSeatbeltHolderBootServices(deps: SeatbeltHolderBootDependencies & {
  readonly publish: Parameters<typeof runSeatbeltHolderBootSequence>[0]["publish"];
}): Promise<SeatbeltHolderBootResult> {
  return runSeatbeltHolderBootSequence(deps).then((result) => {
    runningWatcher = result.watcher;
    return result;
  });
}

/** Quit, after the holder drain: the watcher sweeps this run's label and exits; held leases close with the app. */
export async function stopSeatbeltHolderBootServices(): Promise<void> {
  const watcher = runningWatcher;
  runningWatcher = undefined;
  await watcher?.stop();
  await closeHeldHolderLeases();
}
