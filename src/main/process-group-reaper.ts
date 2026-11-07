import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("ave");

// The POSIX analog of the Windows job object (`windows-job-launcher.ts`): a tracked group-kill child leads its own process group, so when the host
// dies by SIGKILL, a crash or an OOM kill, nothing in the host survives to run the group kill and the group is reparented to launchd/init. A
// sandboxed `bash -c 'sleep 100000'` or an MCP server that ignores stdin EOF then lived on indefinitely. The reaper holds the host's end of a
// pipe on its stdin. The OS closes that pipe in every host death mode, the reaper reads EOF and SIGKILLs every group still registered.
//
// Protocol on stdin, one line each: `+<pgid>` registers a group, `-<pgid>` forgets it. Anything else is ignored, and so are 0 and 1: `kill -- -1`
// would signal every process the user owns. The reaper runs in its own process group, so a signal sent to the host's group (`kill -9 -<pgid>`, a
// terminal's Ctrl-C or Ctrl-\) cannot take it down with the host; HUP, INT and TERM sent to it directly are ignored as well. Plain POSIX sh, so it
// needs no Electron runtime and costs one small shell per host.
export const PROCESS_GROUP_REAPER_SCRIPT = [
  "trap '' HUP INT TERM",
  "groups=' '",
  "while IFS= read -r line; do",
  "  id=${line#?}",
  "  case $id in ''|*[!0-9]*|0*|1) continue ;; esac",
  "  case $line in",
  "    +*) groups=\"$groups$id \" ;;",
  "    -*) kept=' '; for g in $groups; do [ \"$g\" = \"$id\" ] || kept=\"$kept$g \"; done; groups=$kept ;;",
  "  esac",
  "done",
  "for g in $groups; do kill -s KILL -- \"-$g\" 2>/dev/null; done",
  "exit 0",
].join("\n");

export interface ProcessGroupReaper {
  retain(processGroupId: number): void;
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
    stdio: Object.freeze(["pipe", "ignore", "ignore"] as const),
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

  const send = (line: string): void => {
    const stdin = reaper?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("[process-group-reaper] reaper stdin is not writable");
    }
    stdin.write(`${line}\n`);
  };

  // True when it had to spawn a reaper, which has then been sent every registered group.
  const ensureRunning = (): boolean => {
    if (reaper !== undefined && reaper.exitCode === null && reaper.signalCode === null && reaper.stdin?.writable === true) return false;
    reaper = undefined;
    const next = spawnReaper();
    if (!next.stdin) throw new Error("[process-group-reaper] reaper was spawned without a stdin pipe");
    // The pipe and the reaper must not keep a headless host alive; the host's exit is what the reaper waits for.
    next.unref();
    (next.stdin as { unref?: () => void }).unref?.();
    const forget = (reason: string): void => {
      if (reaper !== next) return;
      reaper = undefined;
      if (counts.size === 0) return;
      // Until a reaper runs again nothing kills these groups if the host dies, so replace it now rather than at the next registration.
      const at = now();
      if (at - lastRespawnAt < PROCESS_GROUP_REAPER_RESPAWN_MIN_INTERVAL_MS) {
        log.warn({ reason, groups: counts.size }, "process-group-reaper: reaper ended again within the respawn interval; next registration retries");
        return;
      }
      lastRespawnAt = at;
      log.warn({ reason, groups: counts.size }, "process-group-reaper: reaper ended while groups were registered; respawning");
      try {
        ensureRunning();
      } catch (error) {
        log.error({ err: errorMessage(error), groups: counts.size }, "process-group-reaper: respawn failed; next registration retries");
      }
    };
    next.once("error", (err) => forget(errorMessage(err)));
    next.once("exit", (code, signal) => forget(`exit code=${code ?? "null"} signal=${signal ?? "null"}`));
    next.stdin.on("error", (err) => forget(errorMessage(err)));
    reaper = next;
    for (const id of counts.keys()) send(`+${id}`);
    return true;
  };

  return {
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
    release(processGroupId) {
      const count = counts.get(processGroupId);
      if (count === undefined) return;
      if (count > 1) {
        counts.set(processGroupId, count - 1);
        return;
      }
      counts.delete(processGroupId);
      if (reaper !== undefined && reaper.stdin?.writable === true) send(`-${processGroupId}`);
    },
    shutdown() {
      counts.clear();
      const current = reaper;
      reaper = undefined;
      current?.stdin?.end();
    },
  };
}
