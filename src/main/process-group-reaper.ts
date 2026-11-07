import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("ave");

// The POSIX analog of the Windows job object (`windows-job-launcher.ts`): a tracked group-kill child leads its own process group, so when the host
// dies by SIGKILL, a crash or an OOM kill, nothing in the host survives to run the group kill and the group is reparented to launchd/init. A
// sandboxed `bash -c 'sleep 100000'` or an MCP server that ignores stdin EOF then lived on indefinitely. The reaper holds the host's end of a
// pipe on its stdin. The OS closes that pipe in every host death mode, the reaper reads EOF and SIGKILLs every group still registered.
//
// Protocol on stdin, one line each: `+<pgid>` registers a group, `-<pgid>` forgets it. Anything else is ignored. HUP, INT and TERM are ignored
// so a terminal hangup or Ctrl-C that reaches the host's own process group cannot stop the reaper before it has read EOF. Plain POSIX sh, so it
// needs no Electron runtime and costs one small shell per host.
export const PROCESS_GROUP_REAPER_SCRIPT = [
  "trap '' HUP INT TERM",
  "groups=' '",
  "while IFS= read -r line; do",
  "  id=${line#?}",
  "  case $id in ''|*[!0-9]*|0*) continue ;; esac",
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

function spawnProcessGroupReaperProcess(): ChildProcess {
  return spawn("/bin/sh", ["-c", PROCESS_GROUP_REAPER_SCRIPT], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { PATH: "/usr/bin:/bin" },
  });
}

/** Counts registrations per group, so a child handed from one tracker to another (foreground shell to background) stays covered. */
export function createProcessGroupReaper(spawnReaper: () => ChildProcess = spawnProcessGroupReaperProcess): ProcessGroupReaper {
  const counts = new Map<number, number>();
  let reaper: ChildProcess | undefined;

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
    const next = spawnReaper();
    if (!next.stdin) throw new Error("[process-group-reaper] reaper was spawned without a stdin pipe");
    // The pipe and the reaper must not keep a headless host alive; the host's exit is what the reaper waits for.
    next.unref();
    (next.stdin as { unref?: () => void }).unref?.();
    const forget = (reason: string): void => {
      if (reaper !== next) return;
      reaper = undefined;
      if (counts.size > 0) log.warn({ reason, groups: counts.size }, "process-group-reaper: reaper ended while groups were registered; respawning on next use");
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
      if (!ensureRunning()) send(`+${processGroupId}`);
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
      reaper?.stdin?.end();
      reaper = undefined;
    },
  };
}
