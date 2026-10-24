import type { ChildProcess } from "node:child_process";

// This module has no runtime imports. Test fixtures load it from inside a
// mocked `node:child_process` factory, which must not cycle back through it.

/** The host exits after this long without a request; the next one starts a fresh host. */
export const WINDOWS_ACL_HOST_IDLE_MS = 30_000;

/** One request line. Paths and SIDs are data the host decodes, never script text. */
export interface WindowsAclRequest {
  readonly id: number;
  readonly paths: readonly string[];
  readonly capSids: readonly string[];
  readonly skipPackage: boolean;
}

/** The fixed process a host runs: the script travels in `args`, never in a request. */
export interface WindowsAclHostLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly windowsHide: true; readonly env: Readonly<Record<string, string>> };
}

export interface WindowsAclLimits {
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/**
 * Writes one request line and resolves with the next reply line, unparsed.
 * The caller validates the reply and calls `discard` when it is refused.
 */
export interface WindowsAclTransport {
  request(request: WindowsAclRequest, launch: WindowsAclHostLaunch, limits: WindowsAclLimits): Promise<string>;
  /** Kill the host, if any; idempotent. The next request starts a fresh host. */
  discard(): void;
}

export type WindowsAclHostSpawn = (command: string, args: readonly string[], options: WindowsAclHostLaunch["options"]) => ChildProcess;

/**
 * The seam both the product and the test fixtures use. Fixtures install a
 * request-level transport here; the product uses its own host otherwise.
 */
export const windowsAclTransportSeam: { override?: WindowsAclTransport } = {};

/**
 * A host process failure: timeout, oversized reply, exit, error output,
 * extra output or a failed write. Callers see it as they saw a failed probe
 * process before, not as an access-rule refusal.
 */
export class WindowsAclHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsAclHostError";
  }
}

interface PendingRequest {
  readonly resolve: (line: string) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly maxBytes: number;
  readonly chunks: Buffer[];
  bytes: number;
}

const MAX_ERROR_OUTPUT_CHARS = 1024;

/** JSON with every non-ASCII code unit escaped, so the host's input code page cannot alter a path. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x00-\x7e]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Pipes are sockets in a real child; they must not keep the parent alive either. */
function unrefStream(stream: object | null): void {
  const unref: unknown = stream ? Reflect.get(stream, "unref") : undefined;
  if (typeof unref === "function") unref.call(stream);
}

/**
 * One long-lived ACL host process. It starts lazily, answers one request at a
 * time, exits after {@link WINDOWS_ACL_HOST_IDLE_MS} idle, and never keeps the
 * parent alive. Any failure kills it and rejects the request in flight; there
 * is no retry, and the next request starts a fresh host.
 */
export class WindowsAclHost implements WindowsAclTransport {
  private child: ChildProcess | undefined;
  private launchKey: string | undefined;
  private pending: PendingRequest | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  /** Hosts this instance has started; tests read it to tell reuse from a fresh start. */
  starts = 0;

  constructor(private readonly spawnHost: WindowsAclHostSpawn, private readonly idleMs = WINDOWS_ACL_HOST_IDLE_MS) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  request(request: WindowsAclRequest, launch: WindowsAclHostLaunch, limits: WindowsAclLimits): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Callers serialize requests; a second one in flight would read the first one's reply.
      if (this.pending) {
        reject(new WindowsAclHostError("Windows ACL host is busy"));
        return;
      }
      this.clearIdleTimer();
      const key = JSON.stringify(launch);
      if (this.child && this.launchKey !== key) this.discard();
      let started: ChildProcess;
      try {
        started = this.child ?? this.start(launch, key);
      } catch (error) {
        reject(error);
        return;
      }
      const child = started;
      this.pending = {
        resolve,
        reject,
        maxBytes: limits.maxBytes,
        chunks: [],
        bytes: 0,
        timer: setTimeout(() => this.fail(child, new WindowsAclHostError("Windows ACL host timed out")), limits.timeoutMs),
      };
      const line = `${asciiJson({ id: request.id, paths: request.paths, capSids: request.capSids, skipPackage: request.skipPackage })}\n`;
      try {
        child.stdin!.write(line, (error) => {
          if (error) this.fail(child, error);
        });
      } catch (error) {
        this.fail(child, error);
      }
    });
  }

  discard(): void {
    if (this.child) this.fail(this.child, new WindowsAclHostError("Windows ACL host was stopped"));
    this.clearIdleTimer();
  }

  private start(launch: WindowsAclHostLaunch, key: string): ChildProcess {
    const child = this.spawnHost(launch.command, launch.args, launch.options);
    this.child = child;
    this.launchKey = key;
    this.starts += 1;
    // Listeners stay attached after a failure so late events of a killed host are absorbed.
    child.on("error", (error) => this.fail(child, error));
    child.on("exit", (code, signal) => this.fail(child, new WindowsAclHostError(`Windows ACL host exited (${code ?? signal})`)));
    child.stdin?.on("error", (error) => this.fail(child, error));
    child.stdout?.on("data", (chunk: Buffer | string) => this.receive(child, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => this.fail(child, new WindowsAclHostError(
      `Windows ACL host failed: ${String(chunk).slice(0, MAX_ERROR_OUTPUT_CHARS)}`)));
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) unrefStream(stream);
    return child;
  }

  private receive(child: ChildProcess, chunk: Buffer): void {
    if (child !== this.child) return;
    const pending = this.pending;
    if (!pending) {
      this.fail(child, new WindowsAclHostError("Windows ACL host wrote outside a request"));
      return;
    }
    const newline = chunk.indexOf(0x0a);
    const head = newline === -1 ? chunk : chunk.subarray(0, newline);
    pending.bytes += head.length;
    if (pending.bytes > pending.maxBytes) {
      this.fail(child, new WindowsAclHostError("Windows ACL host reply exceeds its limit"));
      return;
    }
    pending.chunks.push(head);
    if (newline === -1) return;
    // Exactly one line answers one request; anything after it is not trusted.
    if (newline + 1 < chunk.length) {
      this.fail(child, new WindowsAclHostError("Windows ACL host wrote more than one reply"));
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    this.idleTimer = setTimeout(() => this.discard(), this.idleMs);
    this.idleTimer.unref?.();
    pending.resolve(Buffer.concat(pending.chunks).toString("utf8").replace(/\r$/, ""));
  }

  private fail(child: ChildProcess, error: unknown): void {
    if (child !== this.child) return;
    this.child = undefined;
    this.launchKey = undefined;
    this.clearIdleTimer();
    try { child.kill(); } catch { /* An exited host has nothing left to kill. */ }
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
