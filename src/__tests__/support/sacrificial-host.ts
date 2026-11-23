import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const WATCHDOG_MS = 15_000;

export function spawnSacrificialHost(source: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
  return spawn(node, ["--import", "tsx", "--input-type=module", "-e", source, "--", ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

export async function waitForFixture<T>(phase: string, probe: () => T | undefined): Promise<T> {
  const deadline = performance.now() + WATCHDOG_MS;
  do {
    const result = probe();
    if (result !== undefined) return result;
    await delay(50);
  } while (performance.now() < deadline);
  throw new Error(`Fixture watchdog expired during ${phase}`);
}

export function posixProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

export async function stopSacrificialHost(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null || host.pid === undefined) return;
  const exited = once(host, "exit", { signal: AbortSignal.timeout(WATCHDOG_MS) });
  host.kill("SIGKILL");
  try {
    await exited;
  } catch (error) {
    throw new Error("Sacrificial host cleanup watchdog failed", { cause: error });
  }
}

export async function stopFixtureProcesses(pids: readonly number[]): Promise<void> {
  const results = await Promise.allSettled(pids.map(async (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await waitForFixture(`cleanup of fixture process ${pid}`, () => posixProcessExists(pid) ? undefined : true);
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Fixture process cleanup failed");
}

export async function withFixtureCleanup(run: () => Promise<void>, cleanup: readonly (() => void | Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of [run, ...cleanup]) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Fixture execution or cleanup failed");
}
