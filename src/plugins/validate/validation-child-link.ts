/** The validator owns one child termination sequence; session close and finalizer must not duplicate it. */
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ChildLink } from "../isolation/plugin-child-transport.js";
import { FRAME_BYTES_MAX } from "../isolation/host-api-wire.js";
import { StdioFrameDecoder } from "../../mcp/stdio-framing.js";
import { terminateChildProcess } from "../../tools/terminate-child-process.js";

/** Use the production signal grace so validator termination matches the app. */
export const VALIDATION_KILL_GRACE_MS = 3_000;

interface ValidationTimelineEntry {
  readonly at: number;
  readonly event: string;
}

export interface ValidationChildRecord {
  readonly stdout: Buffer[];
  readonly hostFrames: Array<Record<string, unknown>>;
  readonly signalsSent: NodeJS.Signals[];
  readonly terminationFaults: string[];
  readonly terminations: string[];
  /** Record termination, signal, fault and exit events in monotonic time order. */
  readonly timeline: ValidationTimelineEntry[];
  readonly note: (event: string) => void;
  readonly exitObserved: () => string | undefined;
  /** Only observed exit settles this promise. */
  readonly exited: Promise<string>;
  /** Await stdout end as well as exit when checking every raw byte. */
  readonly stdoutEnded: Promise<void>;
}

export interface ValidationChildLink {
  readonly link: ChildLink;
  readonly record: ValidationChildRecord;
}

function processId(child: ChildProcess): number | undefined {
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
}

/** Wrap in the spawn turn before any output, fault or exit can be missed. */
export function createValidationChildLink(child: ChildProcess): ValidationChildLink {
  const { stdin, stdout } = child;
  if (!stdin || !stdout) {
    throw new Error("[validate] the child was spawned without piped stdin and stdout");
  }
  const record = {
    stdout: [] as Buffer[],
    hostFrames: [] as Array<Record<string, unknown>>,
    signalsSent: [] as NodeJS.Signals[],
    terminationFaults: [] as string[],
    terminations: [] as string[],
    timeline: [] as ValidationTimelineEntry[],
  };
  const note = (event: string): void => {
    record.timeline.push({ at: performance.now(), event });
  };
  let exitReason: string | undefined;
  let resolveExited!: (reason: string) => void;
  const exited = new Promise<string>((resolve) => {
    resolveExited = resolve;
  });
  const goneHandlers: Array<(reason: string) => void> = [];
  const faultHandlers: Array<(reason: string) => void> = [];

  const gone = (reason: string): void => {
    if (exitReason !== undefined) return;
    exitReason = reason;
    note(`exit:${reason}`);
    resolveExited(reason);
    for (const handler of goneHandlers) handler(reason);
  };
  child.once("exit", (code, signal) => gone(`child exited code=${String(code)} signal=${String(signal)}`));
  child.on("error", (error: Error) => {
    if (processId(child) === undefined) {
      gone(`child error: ${error.message}`);
      return;
    }
    const reason = `child fault: ${error.message}`;
    record.terminationFaults.push(reason);
    note(`fault:${reason}`);
    for (const handler of faultHandlers) handler(reason);
  });

  // Record raw child bytes before forwarding every byte to the decoder, even if reading begins late.
  const input = new PassThrough();
  stdout.on("data", (chunk: Buffer) => {
    record.stdout.push(chunk);
    input.write(chunk);
  });
  const stdoutEnded = new Promise<void>((resolve) => {
    stdout.once("end", () => {
      input.end();
      resolve();
    });
  });

  // Record actual outgoing frames; ending this stream closes only child stdin.
  const output = new PassThrough();
  const hostDecoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  output.on("data", (chunk: Buffer) => {
    record.hostFrames.push(...hostDecoder.push(chunk));
  });
  output.pipe(stdin);
  // An EPIPE after child exit adds no new outcome; gone reports the exit.
  stdin.on("error", () => undefined);

  const signalled = {
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal?: NodeJS.Signals | number): boolean => {
      const name = (signal ?? "SIGTERM") as NodeJS.Signals;
      record.signalsSent.push(name);
      note(`signal:${name}`);
      return child.kill(name);
    },
  };

  const link: ChildLink = {
    input,
    output,
    terminate: (reason) => {
      note(`terminate:${reason}`);
      if (exitReason !== undefined || record.terminations.length > 0) return;
      record.terminations.push(reason);
      const forceTimer = terminateChildProcess(signalled, VALIDATION_KILL_GRACE_MS);
      child.once("exit", () => clearTimeout(forceTimer));
    },
    onGone: (handler) => {
      goneHandlers.push(handler);
      if (exitReason !== undefined) queueMicrotask(() => handler(exitReason!));
    },
    onFault: (handler) => {
      faultHandlers.push(handler);
    },
  };

  return {
    link,
    record: { ...record, note, exitObserved: () => exitReason, exited, stdoutEnded },
  };
}
