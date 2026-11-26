import { statSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { crc32 } from "node:zlib";
import { BROWSER_CAPTURE_LIMITS } from "../../shared/browser-capture.js";
import { hasOnlyKeys, isRecord } from "../../shared/is-record.js";
import { mainDir } from "../main-paths.js";
import { forceKillManagedChildProcess, spawnManaged } from "../managed-child-processes.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import { BrowserActionError } from "./browser-action-guard.js";
import {
  CAPTURE_STITCH_CHILD_FILE, captureStitchFrame, captureStitchFrames,
  type CaptureStitchRequest, type CaptureTilePlacement,
} from "./browser-capture-stitch-protocol.js";

export interface CaptureStitcher {
  decode(png: Buffer, tile: CaptureTilePlacement): Promise<void>;
  encode(): Promise<Buffer>;
  /** Terminates the child. A job it still owes settles when its exit is confirmed, never earlier. */
  stop(): void;
}

interface StitchJob { expectsPayload: boolean; resolve(payload: Buffer): void; reject(error: Error): void }

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_CHUNK_OVERHEAD = 12;
const PNG_IHDR_DATA_BYTES = 13;

function isValidEncodedPng(png: Buffer, width: number, height: number): boolean {
  const firstChunk = PNG_SIGNATURE.length;
  if (png.length > BROWSER_CAPTURE_LIMITS.bytes || png.length < firstChunk + PNG_CHUNK_OVERHEAD + PNG_IHDR_DATA_BYTES
    || !png.subarray(0, firstChunk).equals(PNG_SIGNATURE)
    || png.readUInt32BE(firstChunk) !== PNG_IHDR_DATA_BYTES || png.toString("latin1", 12, 16) !== "IHDR"
    || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) return false;

  let hasImageData = false;
  for (let offset = firstChunk; offset + PNG_CHUNK_OVERHEAD <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + PNG_CHUNK_OVERHEAD + length;
    const crcOffset = end - 4;
    if (end > png.length || crc32(png.subarray(offset + 4, crcOffset)) !== png.readUInt32BE(crcOffset)) return false;
    const type = png.toString("latin1", offset + 4, offset + 8);
    if (type === "IHDR" && offset !== firstChunk) return false;
    if (type === "IDAT") hasImageData ||= length > 0;
    if (type === "IEND") return hasImageData && length === 0 && end === png.length;
    offset = end;
  }
  return false;
}

/**
 * Composes one capture in a child process, so a decode that never returns is reclaimed
 * with its memory by ending that process. A job settles on its reply or on the confirmed exit.
 */
export function startCaptureStitcher(
  width: number, height: number, onProtocolFault?: (error: Error, closed: Promise<void>) => void,
): CaptureStitcher {
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
    const closed = new Promise<void>((resolve) => {
      spawned.once("close", async () => {
        // Settle only once a pending tree kill has finished with the child.
        if (termination) await termination;
        settleExit();
        resolve();
      });
    });
    const readFrames = captureStitchFrames((message, payload) => {
      if (!isRecord(message) || !hasOnlyKeys(message, ["id", "error"]) || typeof message.id !== "number") {
        throw new Error("invalid capture decoder reply");
      }
      const { id, error } = message;
      const job = jobs.get(id);
      if (!job) throw new Error("unexpected capture decoder reply");
      const expectsPayload = job.expectsPayload && error === undefined;
      if (expectsPayload ? !isValidEncodedPng(payload, width, height) : payload.length !== 0) {
        throw new Error("invalid capture decoder reply payload");
      }
      let replyError: Error | undefined;
      if (error !== undefined) {
        if (!isRecord(error) || !hasOnlyKeys(error, ["message", "code"]) || typeof error.message !== "string"
          || (error.code !== undefined && typeof error.code !== "string")) {
          throw new Error("invalid capture decoder error");
        }
        replyError = error.code === "screenshot-limit" || error.code === "screenshot-unavailable"
          ? new BrowserActionError(error.code, error.message) : new Error(error.message);
      }
      jobs.delete(id);
      if (replyError) job.reject(replyError);
      else job.resolve(payload);
    });
    stdout.on("data", (chunk: Buffer) => {
      if (stopped || exited) return;
      try { readFrames(chunk); } catch {
        stop();
        onProtocolFault?.(failure(), closed);
      }
    });
    stdin.on("error", stop);
    spawned.once("error", () => {
      if (spawned.pid) stop();
      else settleExit();
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
    jobs.set(message.id, { expectsPayload: tile === undefined, resolve, reject });
    input.write(captureStitchFrame(message, png));
  });
  return {
    decode: (png, tile) => request(png, tile).then(() => undefined),
    encode: () => request(),
    stop,
  };
}
