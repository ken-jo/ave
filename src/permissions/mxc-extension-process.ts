import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { MxcProcess } from "@microsoft/mxc-sdk/v1";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export class MxcProcessContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcProcessContractError";
  }
}

export class MxcProcessCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcProcessCleanupError";
  }
}

export class MxcSupervisorLostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MxcSupervisorLostError";
  }
}

type NativeProcess = Pick<MxcProcess, "id" | "standardInput" | "standardOutput" | "standardError" | "wait" | "kill" | "dispose">;
type ProcessResult = Awaited<ReturnType<MxcProcess["wait"]>>;

/** Lives only inside the dedicated native supervisor, never in the host process. */
export class MxcExtensionProcess {
  readonly id: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<ProcessResult>;
  private phase: "running" | "stopping" | "terminated" | "cleanup-failed" = "running";
  private cleanup: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly native: NativeProcess) {
    this.id = native.id;
    // Taking all three endpoints must precede wait, including on startup failure.
    const stdin = native.standardInput;
    const stdout = native.standardOutput;
    const stderr = native.standardError;
    if (!stdin || !stdout || !stderr) {
      const failure = new MxcProcessContractError("Native process requires all standard streams");
      try { void native.wait().catch(() => {}); } catch (error) { failure.cause = error; }
      try { native.kill(); } catch (error) { failure.cause = error; }
      try { native.dispose(); } catch (error) { failure.cause = error; }
      throw failure;
    }
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    // Stream errors remain visible to consumers and cannot become unhandled events.
    for (const stream of [stdin, stdout, stderr]) stream.on("error", this.handleStreamError);
    let waiting: Promise<ProcessResult>;
    try {
      waiting = native.wait();
    } catch (cause) {
      const failures: unknown[] = [cause];
      try { native.kill(); } catch (error) { failures.push(error); }
      try { native.dispose(); } catch (error) { failures.push(error); }
      for (const stream of [stdin, stdout, stderr]) stream.off("error", this.handleStreamError);
      throw new MxcProcessContractError("Native process attachment failed", { cause: new AggregateError(failures) });
    }
    this.completion = waiting.then(
      (result) => {
        if (!Number.isInteger(result.exitCode) || typeof result.timedOut !== "boolean") {
          throw new MxcProcessContractError("Invalid native process completion");
        }
        if (this.phase !== "cleanup-failed") this.phase = "terminated";
        return result;
      },
    ).catch((cause: unknown) => {
      this.phase = "cleanup-failed";
      if (cause instanceof MxcProcessContractError) throw cause;
      throw new MxcSupervisorLostError("Native process termination is unverified", { cause });
    });
    // Keep the rejection observed even before the forwarding loop attaches.
    void this.completion.catch(() => {});
  }

  get state(): string { return this.phase; }

  /** Resolves only after terminal settlement, output drain and successful disposal. */
  dispose(): Promise<void> {
    this.cleanup ??= this.stop();
    return this.cleanup;
  }

  private readonly handleStreamError = (): void => {
    void this.dispose().catch(() => {});
  };

  private async stop(): Promise<void> {
    const failures: unknown[] = [];
    const terminal = this.phase === "terminated";
    if (!terminal) this.phase = "stopping";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Teardown drains bounded native pipe buffers even when the caller stopped reading.
      this.stdout.resume();
      this.stderr.resume();
      const drained = Promise.all([
        finished(this.stdout, { cleanup: true }),
        finished(this.stderr, { cleanup: true }),
      ]);
      void drained.catch(() => {});
      this.stdin.end();
      if (!terminal) this.native.kill();
      await Promise.race([
        Promise.all([this.completion, drained]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MxcProcessCleanupError("Native process cleanup deadline exceeded")),
            TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
        }),
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      clearTimeout(timer);
      // dispose can reject wait asynchronously; completion already has a rejection observer.
      if (!this.disposed) {
        this.disposed = true;
        try { this.native.dispose(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) {
      this.phase = "cleanup-failed";
      throw new MxcProcessCleanupError("Native process cleanup is unverified", { cause: new AggregateError(failures) });
    }
    this.phase = "terminated";
    for (const stream of [this.stdin, this.stdout, this.stderr]) stream.off("error", this.handleStreamError);
  }
}
