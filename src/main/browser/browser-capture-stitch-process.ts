import { statSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { mainDir } from "../main-paths.js";
import { forceKillManagedChildProcess, spawnManaged } from "../managed-child-processes.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { BrowserActionError } from "./browser-action-guard.js";
import {
  CAPTURE_STITCH_CHILD_FILE, captureStitchFrame, captureStitchFrames,
  type CaptureStitchReply, type CaptureStitchRequest, type CaptureTilePlacement,
} from "./browser-capture-stitch-protocol.js";

export interface CaptureStitcher {
  decode(png: Buffer, tile: CaptureTilePlacement): Promise<void>;
  encode(): Promise<Buffer>;
  /** Terminates the child. A job it still owes settles when its exit is confirmed, never earlier. */
  stop(): void;
}

interface StitchJob { resolve(payload: Buffer): void; reject(error: Error): void }

/**
 * Composes one capture in a child process, so a decode that never returns is reclaimed
 * with its memory by ending that process. A job settles on its reply or on the confirmed exit.
 */
export function startCaptureStitcher(width: number, height: number): CaptureStitcher {
  const jobs = new Map<number, StitchJob>();
  let nextId = 0;
  let exited = false;
  let stopped = false;
  let termination: void | Promise<void>;
  let child: ChildProcess | undefined;
  let input: Writable | undefined;
  const failure = (): Error => new BrowserActionError("screenshot-failed", "the capture decoder stopped");
  const stop = (): void => {
    if (stopped || exited || !child) return;
    stopped = true;
    termination = forceKillManagedChildProcess(child, "browser-capture-stitch");
  };
  const settleExit = (): void => {
    exited = true;
    for (const job of jobs.values()) job.reject(failure());
    jobs.clear();
  };
  try {
    // Resolve from the runtime asset root: this module may live in a split chunk.
    const entryPath = join(mainDir, CAPTURE_STITCH_CHILD_FILE);
    if (!statSync(entryPath).isFile()) throw new Error("the capture decoder entry is missing");
    const spawned = spawnManaged(process.execPath, [
      "--disallow-code-generation-from-strings", entryPath, String(width), String(height),
    ], {
      env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }, { label: "browser-capture-stitch" });
    child = spawned;
    const { stdin, stdout } = spawned;
    if (!stdin || !stdout) throw new Error("the capture decoder has no pipes");
    input = stdin;
    const readFrames = captureStitchFrames((message, payload) => {
      const { id, error } = message as CaptureStitchReply;
      const job = jobs.get(id);
      if (!job) throw new Error("unexpected capture decoder reply");
      jobs.delete(id);
      if (!error) job.resolve(payload);
      else job.reject(error.code === "screenshot-limit" || error.code === "screenshot-unavailable"
        ? new BrowserActionError(error.code, error.message) : new Error(error.message));
    });
    stdout.on("data", (chunk: Buffer) => {
      try { readFrames(chunk); } catch { stop(); }
    });
    stdin.on("error", stop);
    spawned.once("error", () => {
      if (spawned.pid) stop();
      else settleExit();
    });
    spawned.once("close", async () => {
      // Settle only once a pending tree kill has finished with the child.
      if (termination) await termination;
      settleExit();
    });
  } catch {
    stop();
    if (!child) exited = true;
  }
  const request = (png?: Buffer, tile?: CaptureTilePlacement): Promise<Buffer> => new Promise((resolve, reject) => {
    if (exited || stopped || !input) {
      reject(failure());
      return;
    }
    const message: CaptureStitchRequest = { id: nextId++, ...(tile ? { tile } : {}) };
    jobs.set(message.id, { resolve, reject });
    input.write(captureStitchFrame(message, png));
  });
  return {
    decode: (png, tile) => request(png, tile).then(() => undefined),
    encode: () => request(),
    stop,
  };
}
