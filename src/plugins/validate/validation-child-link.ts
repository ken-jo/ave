/**
 * The validator's own link to the child it spawned
 * (`docs/design/plugin-hostapi-protocol.md` §9.7 P2).
 *
 * The CLI owns the process, so it owns what is known about it — independently
 * of any session, from the moment of the spawn: every byte the child wrote to
 * stdout (the stdout-discipline check reads these, not decoded frames, because
 * the decoder drops a bad line by design), every frame the host wrote to it
 * (the request-metadata check reads the host side), the exit once observed,
 * every fault on the live child, and every signal sent to it. The finalizer
 * reads these after a run whose session never opened, or already closed.
 *
 * Same split as the production link: `exit`, or an `error` from a spawn that
 * produced no process, is the child gone; an `error` while it has a pid is a
 * fault — Node emits one when a signal could not be delivered — and never a
 * release. `terminate` starts one sequence — SIGTERM, then one SIGKILL after
 * {@link VALIDATION_KILL_GRACE_MS} if no exit was seen — and at most once, so
 * the transport's `close` and the CLI's finalizer cannot start two.
 */
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ChildLink } from "../isolation/plugin-child-transport.js";
import { FRAME_BYTES_MAX } from "../isolation/host-api-wire.js";
import { StdioFrameDecoder } from "../../mcp/stdio-framing.js";
import { terminateChildProcess } from "../../tools/terminate-child-process.js";

/**
 * Production's grace between SIGTERM and SIGKILL (`out-of-process-plugin.ts`,
 * the confined child's link). The helper's own 2 s default is not used: the
 * validator ends a plugin the way the app does.
 */
export const VALIDATION_KILL_GRACE_MS = 3_000;

interface ValidationTimelineEntry {
  readonly at: number;
  readonly event: string;
}

/** What the CLI knows about its child, recorded from the spawn on. */
export interface ValidationChildRecord {
  /** Every chunk the child wrote to stdout, as written. */
  readonly stdout: Buffer[];
  /** Every frame the host wrote to the child, in order. */
  readonly hostFrames: Array<Record<string, unknown>>;
  /** Every signal the link sent, in order. */
  readonly signalsSent: NodeJS.Signals[];
  /** Every fault the live child reported. */
  readonly terminationFaults: string[];
  /** The reason of each termination sequence started — at most one. */
  readonly terminations: string[];
  /**
   * What happened, in order and when (`performance.now()`):
   * `terminate:<reason>`, `signal:<name>`, `fault:<reason>`, `exit:<reason>`,
   * and the entries the run adds.
   */
  readonly timeline: ValidationTimelineEntry[];
  /** Add an entry to {@link timeline}. */
  readonly note: (event: string) => void;
  /** The exit, once observed. */
  readonly exitObserved: () => string | undefined;
  /** Settles with the exit's reason, and on nothing else. */
  readonly exited: Promise<string>;
  /**
   * Settles when the child's stdout has ended. Node reports `exit` before the
   * last bytes are read, so a check on every byte waits for this too.
   */
  readonly stdoutEnded: Promise<void>;
}

export interface ValidationChildLink {
  readonly link: ChildLink;
  readonly record: ValidationChildRecord;
}

/** The child's pid when the spawn produced a process, else `undefined`. */
function processId(child: ChildProcess): number | undefined {
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
}

/**
 * Wrap a freshly spawned child. Call it in the same turn as the spawn, before
 * anything can have been written or emitted.
 */
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

  // Child → host. The raw bytes are kept beside the transport's decoder, and a
  // pass-through hands the transport every byte from the first, however late
  // it starts reading.
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

  // Host → child. Decoded as the child decodes it, so the request-metadata
  // check reads what was actually sent. Ending this ends the child's stdin and
  // nothing else.
  const output = new PassThrough();
  const hostDecoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  output.on("data", (chunk: Buffer) => {
    record.hostFrames.push(...hostDecoder.push(chunk));
  });
  output.pipe(stdin);
  // A write to a child that already left is EPIPE on its stdin. The exit is
  // what reports that, through `gone`, so the pipe error itself is not news.
  stdin.on("error", () => undefined);

  // Every signal goes through here, so `signalsSent` is the whole list.
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
