import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("ave");

// The POSIX analog of the Windows job object (`windows-job-launcher.ts`): a tracked group-kill child leads its own process group, so when the host
// dies by SIGKILL, a crash or an OOM kill, nothing in the host survives to run the group kill and the group is reparented to launchd/init. A
// sandboxed `bash -c 'sleep 100000'` or an MCP server that ignores stdin EOF then lived on indefinitely. The reaper holds the host's end of a
// pipe on its stdin. The OS closes that pipe in every host death mode, the reaper reads EOF and SIGKILLs every group still registered.
//
// Protocol on stdin, one line each: `+<pgid>` registers a group, `-<pgid>` forgets it, and `@<request>:<pgid>` acknowledges a retained group
// with `@<request>\n` on stdout. Invalid input is ignored, including group 0 and 1: `kill -- -1`
// would signal every process the user owns. The reaper runs in its own process group, so a signal sent to the host's group (`kill -9 -<pgid>`, a
// terminal's Ctrl-C or Ctrl-\) cannot take it down with the host; HUP, INT and TERM sent to it directly are ignored as well. Plain POSIX sh, so it
// needs no Electron runtime and costs one small shell per host.
export const PROCESS_GROUP_REAPER_SCRIPT = [
  // Host death can close stdout during an ack. Keep reading stdin through EOF to reap the retained groups.
  "trap '' HUP INT TERM PIPE",
  "groups=' '",
  "while IFS= read -r line; do",
  "  id=${line#?}",
  "  case $line in",
  `    @*:*) request=\${id%%:*}; id=\${id#*:} ;;`,
  "  esac",
  "  case $id in ''|*[!0-9]*|0*|1) continue ;; esac",
  "  case $line in",
  "    +*) groups=\"$groups$id \" ;;",
  "    -*) kept=' '; for g in $groups; do [ \"$g\" = \"$id\" ] || kept=\"$kept$g \"; done; groups=$kept ;;",
  "    @*:*)",
  "      case $request in ''|*[!0-9]*) continue ;; esac",
  "      case $groups in *\" $id \"*) printf '@%s\\n' \"$request\" ;; esac ;;",
  "  esac",
  "done",
  "for g in $groups; do kill -s KILL -- \"-$g\" 2>/dev/null; done",
  "exit 0",
].join("\n");

export interface ProcessGroupReaper {
  assertAvailable(): void;
  retain(processGroupId: number): void;
  acknowledge(processGroupId: number, signal: AbortSignal, onWritten?: () => void | Promise<void>): Promise<() => void>;
  release(processGroupId: number): void;
  /** Close the reaper's stdin, which makes it kill every group still registered and exit. */
  shutdown(): void;
}

/** How the reaper is started; exported so a test can start one exactly this way from a separate fake host process. */
export const PROCESS_GROUP_REAPER_SPAWN = Object.freeze({
  command: "/bin/sh",
  args: Object.freeze(["-c", PROCESS_GROUP_REAPER_SCRIPT]),
  options: Object.freeze({
    // Its own process group: a signal to the host's group must not reach it.
    detached: true,
    stdio: Object.freeze(["pipe", "pipe", "ignore"] as const),
    env: Object.freeze({ PATH: "/usr/bin:/bin" }),
  }),
});

function spawnProcessGroupReaperProcess(): ChildProcess {
  const { command, args, options } = PROCESS_GROUP_REAPER_SPAWN;
  return spawn(command, [...args], { detached: options.detached, stdio: [...options.stdio], env: { ...options.env } });
}

/** A reaper that ends while groups are registered is replaced at once, but not more often than this, so a reaper that cannot run does not spin. */
export const PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS = 1_000;

interface ProcessGroupReaperOptions {
  now?: () => number;
  onUnavailable?: () => void;
}

/** Counts registrations per group, so a child handed from one tracker to another (foreground shell to background) stays covered. */
export function createProcessGroupReaper(
  spawnReaper: () => ChildProcess = spawnProcessGroupReaperProcess,
  options: ProcessGroupReaperOptions = {},
): ProcessGroupReaper {
  const now = options.now ?? Date.now;
  const counts = new Map<number, number>();
  let reaper: ChildProcess | undefined;
  let lastRespawnAt = Number.NEGATIVE_INFINITY;
  let recovering = false;
  let respawnTimer: NodeJS.Timeout | undefined;
  let requestId = 0;
  const acknowledgments = new Map<string, { accept: () => void; reject: (error: Error) => void }>();

  const isRunning = (child: ChildProcess): boolean =>
    child.pid !== undefined && child.exitCode === null && child.signalCode === null
    && child.stdin?.writable === true && !child.stdin.destroyed && child.stdout?.destroyed === false;

  const send = (line: string): void => {
    const stdin = reaper?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("[process-group-reaper] reaper stdin is not writable");
    }
    stdin.write(`${line}\n`);
  };

  function forget(current: ChildProcess, reason: string): void {
    if (reaper !== current) return;
    reaper = undefined;
    rejectAcknowledgments(new Error("Process group reaper is unavailable"));
    current.stdin?.destroy();
    current.stdout?.destroy();
    if (counts.size !== 0) beginRecovery(reason);
  }

  function rejectAcknowledgments(error: Error): void {
    for (const pending of acknowledgments.values()) pending.reject(error);
  }

  function start(): void {
    const next = spawnReaper();
    next.once("error", (err) => forget(next, errorMessage(err)));
    if (!next.stdin) throw new Error("[process-group-reaper] reaper was spawned without a stdin pipe");
    const stdout = next.stdout;
    next.once("exit", (code, signal) => forget(next, `exit code=${code ?? "null"} signal=${signal ?? "null"}`));
    next.stdin.on("error", (err) => forget(next, errorMessage(err)));
    next.stdin.once("close", () => forget(next, "stdin closed"));
    if (!stdout || !isRunning(next)) {
      next.stdin.destroy();
      stdout?.destroy();
      throw new Error("[process-group-reaper] reaper did not start with usable pipes");
    }
    let frame = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      if (reaper !== next) return;
      frame += chunk;
      let newline = frame.indexOf("\n");
      while (newline >= 0) {
        acknowledgments.get(frame.slice(0, newline))?.accept();
        frame = frame.slice(newline + 1);
        newline = frame.indexOf("\n");
      }
    });
    stdout.on("error", (err) => forget(next, errorMessage(err)));
    stdout.once("close", () => forget(next, "stdout closed"));
    // The pipe and the reaper must not keep a headless host alive; the host's exit is what the reaper waits for.
    next.unref();
    (next.stdin as { unref?: () => void }).unref?.();
    (stdout as { unref?: () => void }).unref?.();
    reaper = next;
    try {
      for (const id of counts.keys()) send(`+${id}`);
    } catch (error) {
      reaper = undefined;
      next.stdin.destroy();
      stdout.destroy();
      throw error;
    }
  }

  function scheduleRespawn(): void {
    const respawn = (): void => {
      respawnTimer = undefined;
      lastRespawnAt = now();
      try {
        start();
        recovering = false;
      } catch {
        scheduleRespawn();
      }
    };
    const delay = PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS - (now() - lastRespawnAt);
    if (delay <= 0) {
      respawn();
      return;
    }
    respawnTimer = setTimeout(respawn, delay);
    respawnTimer.unref();
  }

  function beginRecovery(reason: string): void {
    recovering = true;
    log.warn({ reason, groups: counts.size }, "process-group-reaper: protection lost; process plugin launches paused until recovery");
    try {
      options.onUnavailable?.();
    } finally {
      scheduleRespawn();
    }
  }

  // A replacement receives every retained group before registration resumes.
  const ensureRunning = (): boolean => {
    if (reaper !== undefined) {
      if (isRunning(reaper)) return false;
      forget(reaper, "reaper is no longer writable");
      if (reaper !== undefined) return true;
    }
    if (recovering) throw new Error("Process group reaper is unavailable");
    start();
    return true;
  };

  return {
    assertAvailable() {
      try {
        ensureRunning();
      } catch (error) {
        if (!recovering) {
          lastRespawnAt = now();
          beginRecovery(errorMessage(error));
        }
        throw new Error("Process group reaper is unavailable", { cause: error });
      }
    },
    retain(processGroupId) {
      if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
        throw new Error(`[process-group-reaper] invalid process group id ${processGroupId}`);
      }
      const count = counts.get(processGroupId) ?? 0;
      counts.set(processGroupId, count + 1);
      if (count > 0) return;
      try {
        if (!ensureRunning()) send(`+${processGroupId}`);
      } catch (error) {
        counts.delete(processGroupId);
        throw error;
      }
    },
    acknowledge(processGroupId, signal, onWritten) {
      const current = reaper;
      const assertCurrent = (): void => {
        if (!current || reaper !== current || recovering || !isRunning(current) || !counts.has(processGroupId)) {
          throw new Error("Process group reaper is unavailable");
        }
      };
      const frame = `@${++requestId}`;
      let abort: (() => void) | undefined;
      return new Promise<() => void>((resolve, reject) => {
        assertCurrent();
        signal.throwIfAborted();
        const stdin = current?.stdin;
        if (!stdin) throw new Error("Process group reaper is unavailable");
        let written = false;
        let accepted = false;
        const finish = (): void => {
          if (written && accepted) resolve(assertCurrent);
        };
        acknowledgments.set(frame, {
          accept() { accepted = true; finish(); },
          reject,
        });
        abort = (): void => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        // The callback accounts for queued writes even when write() returns false. The ack proves
        // the reaper read past the preceding +PGID and still holds it.
        stdin.write(`${frame}:${processGroupId}\n`, (error) => {
          if (error) {
            reject(error);
            return;
          }
          if (!acknowledgments.has(frame) || signal.aborted) return;
          void Promise.resolve().then(onWritten).then(() => {
            written = true;
            finish();
          }, reject);
        });
      }).finally(() => {
        acknowledgments.delete(frame);
        if (abort) signal.removeEventListener("abort", abort);
      });
    },
    release(processGroupId) {
      const count = counts.get(processGroupId);
      if (count === undefined) return;
      if (count > 1) {
        counts.set(processGroupId, count - 1);
        return;
      }
      counts.delete(processGroupId);
      if (reaper !== undefined && isRunning(reaper)) send(`-${processGroupId}`);
    },
    shutdown() {
      clearTimeout(respawnTimer);
      respawnTimer = undefined;
      recovering = false;
      counts.clear();
      const current = reaper;
      reaper = undefined;
      rejectAcknowledgments(new Error("Process group reaper is unavailable"));
      current?.stdin?.end();
    },
  };
}
