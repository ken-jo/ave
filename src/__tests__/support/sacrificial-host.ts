import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Keep the body and teardown within the 45-second test timeout.
const FIXTURE_BODY_MS = 30_000;
const FIXTURE_TEARDOWN_MS = 10_000;

export function spawnSacrificialHost(source: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
  return spawn(node, ["--import", "tsx", "--input-type=module", "-e", source, "--", ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

export async function waitForFixture<T>(phase: string, probe: () => T | undefined, deadline: number): Promise<T> {
  let remaining = deadline - performance.now();
  while (remaining > 0) {
    const result = probe();
    remaining = deadline - performance.now();
    if (remaining <= 0) break;
    if (result !== undefined) return result;
    await delay(Math.min(50, Math.ceil(remaining)));
    remaining = deadline - performance.now();
  }
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

export async function stopSacrificialHost(host: ChildProcess, deadline: number): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null || host.pid === undefined) return;
  host.kill("SIGKILL");
  await waitForFixture("sacrificial host cleanup", () =>
    host.exitCode !== null || host.signalCode !== null ? true : undefined, deadline);
}

export async function stopFixtureProcesses(pids: readonly number[], deadline: number): Promise<void> {
  const results = await Promise.allSettled(pids.map(async (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await waitForFixture(`cleanup of fixture process ${pid}`, () => posixProcessExists(pid) ? undefined : true, deadline);
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Fixture process cleanup failed");
}

export async function withFixtureCleanup(
  run: (deadline: number) => Promise<void>,
  cleanup: readonly { phase: string; run: (deadline: number) => void | Promise<void> }[],
  bodyMs = FIXTURE_BODY_MS,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await run(performance.now() + bodyMs);
  } catch (error) {
    failures.push(error);
  }

  // Give each step a share of teardown time even if the previous step stalls.
  const stepMs = Math.floor(FIXTURE_TEARDOWN_MS / Math.max(1, cleanup.length));
  for (const { phase, run: step } of cleanup) {
    const deadline = performance.now() + stepMs;
    const timeout = new Error(`Fixture cleanup timed out during ${phase}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout), stepMs);
      });
      const result = Promise.resolve().then(() => step(deadline)).finally(() => {
        if (performance.now() >= deadline) throw timeout;
      });
      await Promise.race([watchdog, result]);
    } catch (error) {
      failures.push(error);
    } finally {
      clearTimeout(timer);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Fixture execution or cleanup failed");
}
