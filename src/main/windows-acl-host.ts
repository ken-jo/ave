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
  /**
   * Make the current account the owner of every path before reading it. The
   * host takes the owner from its own token; a request never names one.
   */
  readonly setOwner: boolean;
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
 * Writes one request line and resolves with its reply after the matching end
 * marker, unparsed. The caller validates the reply and discards refusals.
 */
export interface WindowsAclTransport {
  request(request: WindowsAclRequest, launch: WindowsAclHostLaunch, limits: WindowsAclLimits): Promise<string>;
  /** Kill the host, if any; idempotent. The next request starts a fresh host. */
  discard(): void;
}

export type WindowsAclHostSpawn = (command: string, args: readonly string[], options: WindowsAclHostLaunch["options"]) => ChildProcess;

/**
 * Fixtures install a request-level transport through the guarded setter.
 * Product callers can only read the seam.
 */
let transportOverride: WindowsAclTransport | undefined;
export const windowsAclTransportSeam = Object.freeze({
  get override(): WindowsAclTransport | undefined { return transportOverride; },
});

export function _setWindowsAclTransportForTest(transport: WindowsAclTransport | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Windows ACL transport override is test-only");
  transportOverride = transport;
}

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
  readonly endMarker: string;
  reply?: string;
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
        endMarker: `END ${request.id}`,
        bytes: 0,
        timer: setTimeout(() => this.fail(child, new WindowsAclHostError("Windows ACL host timed out")), limits.timeoutMs),
      };
      const line = `${asciiJson({ id: request.id, paths: request.paths, capSids: request.capSids, skipPackage: request.skipPackage, setOwner: request.setOwner })}\n`;
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
    pending.bytes += chunk.length;
    // Count framing separately from the caller's reply budget.
    const framingBytes = Buffer.byteLength(pending.endMarker) + 4;
    if (pending.bytes > pending.maxBytes + framingBytes) {
      this.fail(child, new WindowsAclHostError("Windows ACL host reply exceeds its limit"));
      return;
    }
    pending.chunks.push(chunk);
    let buffered = Buffer.concat(pending.chunks);
    pending.chunks.length = 0;
    for (let newline = buffered.indexOf(0x0a); newline !== -1; newline = buffered.indexOf(0x0a)) {
      const line = buffered.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffered = buffered.subarray(newline + 1);
      if (pending.reply === undefined) {
        if (Buffer.byteLength(line) > pending.maxBytes) {
          this.fail(child, new WindowsAclHostError("Windows ACL host reply exceeds its limit"));
          return;
        }
        pending.reply = line;
      } else {
        // Do not settle on the reply newline: the end marker bounds the
        // response even when an extra line arrives in a later pipe chunk.
        if (line !== pending.endMarker || buffered.length !== 0) {
          this.fail(child, new WindowsAclHostError("Windows ACL host wrote more than one reply"));
          return;
        }
        this.complete(pending);
        return;
      }
    }
    if (pending.reply === undefined && buffered.length - Number(buffered.at(-1) === 0x0d) > pending.maxBytes) {
      this.fail(child, new WindowsAclHostError("Windows ACL host reply exceeds its limit"));
      return;
    }
    pending.chunks.push(buffered);
  }

  private complete(pending: PendingRequest): void {
    this.pending = undefined;
    clearTimeout(pending.timer);
    this.idleTimer = setTimeout(() => this.discard(), this.idleMs);
    this.idleTimer.unref?.();
    pending.resolve(pending.reply!);
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
