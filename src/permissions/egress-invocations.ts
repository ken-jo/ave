/**
 * Egress invocation tokens: who opened a connection through the ASRT proxy.
 *
 * ASRT runs one proxy for the whole process, and its network config is
 * process-global, so the proxy alone cannot say which Bash call, terminal tab
 * or plugin worker a connection came from. Each wrap is therefore given a
 * `commandId`: ASRT puts it in the proxy username (`srt.<base64>`), records
 * every proxy deny under it, and (with the carried attribution patch) hands it
 * to the ask callback. This module mints those ids and maps them back to the
 * invocation that owns them.
 *
 * In the proxy username the id is a label, not a credential
 * (anthropics/sandbox-runtime#591): a confined process that learns another
 * live id can present it. So on macOS and Linux each id also gets its own
 * proxy listener (the carried ASRT patch's `openInvocationListener`, opened by
 * the wrap): the sandbox profile lets only that invocation reach it, and the
 * ask callback trusts the listener, not the username (see
 * `egress-identity.ts`). It is 16
 * random bytes as 32 hex characters, so it cannot be guessed, it is longer
 * than ASRT's 22-character floor for per-command network lists, and it stays
 * well inside the 100 characters ASRT keys violations on. Provider tool-use
 * ids are never used as keys: their length and secrecy are not ours.
 *
 * An entry lives exactly as long as the process it was minted for. Every
 * holder calls `release()` once that process has exited; a deny that arrives
 * after release, or under a key this process never minted, is "unattributed".
 */
import { randomBytes } from "node:crypto";

/** A Bash or PowerShell tool call. */
export interface ShellEgressOwner {
  readonly kind: "shell";
  readonly toolName: "bash" | "powershell";
  /** The provider's tool-use id, when the call carried one. Never the key. */
  readonly toolUseId: string | undefined;
  /**
   * What an egress ask for this call needs to know. Required: a shell call
   * that cannot say whether anyone can answer is treated as one nobody can.
   */
  readonly context: ShellEgressContext;
}

/** Where a shell call runs, for the egress ask and its grants. */
export interface ShellEgressContext {
  /** The conversation the call belongs to; undefined outside a conversation. */
  readonly sessionId: string | undefined;
  /** The conversation's working directory: what "This workspace" grants key on. */
  readonly workspaceRoot: string | undefined;
  /** Whether a person can answer an ask for this call right now. */
  readonly approvalSurface: "interactive" | "unavailable";
}

/**
 * One workspace terminal tab, for the life of the shell it runs. A terminal is
 * always in the foreground: the person who typed the command is at the tab, so
 * an egress ask for it is drawn in the tab (design F).
 */
export interface TerminalEgressOwner {
  readonly kind: "terminal";
  readonly tabId: string;
  /** The workspace root the tab's shell is anchored to: what "This workspace" keys on. */
  readonly workspaceRoot: string;
}

/** What plugin-owned code a confined, non-interactive process runs. */
type WorkerEgressRole = "plugin-child" | "worker" | "hook" | "mcp-server";

/**
 * Plugin-owned code: a plugin child, a delegated worker, a bundled hook or a
 * bundled MCP stdio server. All of them are non-interactive, which is what
 * the later ask callback needs to know.
 */
export interface WorkerEgressOwner {
  readonly kind: "worker";
  readonly role: WorkerEgressRole;
  /** The owning plugin; undefined only for an MCP server no plugin bundles. */
  readonly pluginId: string | undefined;
  /** The worker's own id (role "worker") or the MCP server's id (role "mcp-server"). */
  readonly instanceId?: string;
}

export type EgressInvocationOwner = ShellEgressOwner | TerminalEgressOwner | WorkerEgressOwner;

export interface EgressInvocationOptions {
  /** Ends a pending egress ask for this invocation (the call was cancelled). */
  readonly abortSignal?: AbortSignal;
}

export interface EgressInvocation {
  /** The value passed to ASRT as `commandId`. */
  readonly token: string;
  readonly owner: EgressInvocationOwner;
  /**
   * The process group the invocation's process leads (its pid, for a child
   * spawned in its own session or group). Passed to the sandbox when the
   * token is released, so an ended invocation's listener port is not handed
   * back while anything that process started is still running. Call it once
   * the process has started; a non-positive or non-integer pid is a bug.
   */
  noteProcessGroup(pgid: number): void;
  /** Forget the token. Idempotent; call it once the process has exited. */
  release(): void;
}

/** What a release listener learns about the invocation that ended. */
export interface EgressInvocationRelease {
  /** Who the token belonged to. */
  readonly owner: EgressInvocationOwner;
  /** The process group noted with `noteProcessGroup`, if any. */
  readonly processGroup: number | undefined;
}

interface LiveInvocation {
  readonly owner: EgressInvocationOwner;
  readonly abortSignal: AbortSignal | undefined;
}

const live = new Map<string, LiveInvocation>();
const releaseListeners = new Set<(token: string, release: EgressInvocationRelease) => void>();

/** The token length in characters: 16 random bytes, hex-encoded. */
export const EGRESS_INVOCATION_TOKEN_LENGTH = 32;

export function openEgressInvocation(owner: EgressInvocationOwner, options: EgressInvocationOptions = {}): EgressInvocation {
  let token = randomBytes(EGRESS_INVOCATION_TOKEN_LENGTH / 2).toString("hex");
  // 128 random bits do not collide in practice; a collision would silently
  // merge two owners, so it is re-drawn rather than assumed away.
  while (live.has(token)) token = randomBytes(EGRESS_INVOCATION_TOKEN_LENGTH / 2).toString("hex");
  live.set(token, { owner, abortSignal: options.abortSignal });
  let released = false;
  let processGroup: number | undefined;
  return {
    token,
    owner,
    noteProcessGroup: (pgid) => {
      if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`egress invocation: invalid process group ${String(pgid)}`);
      processGroup = pgid;
    },
    release: () => {
      if (released) return;
      released = true;
      live.delete(token);
      for (const listener of releaseListeners) listener(token, { owner, processGroup });
    },
  };
}

/** The live owner of a token, or undefined for a released or foreign key. */
export function egressInvocationOwner(token: string): EgressInvocationOwner | undefined {
  return live.get(token)?.owner;
}

/** The abort signal a live invocation was opened with, if any. */
export function egressInvocationAbortSignal(token: string): AbortSignal | undefined {
  return live.get(token)?.abortSignal;
}

/**
 * Run `listener` with each token as it is released, after it is forgotten.
 * The sandbox adapter closes the invocation's proxy listener here and the
 * grant store drops its "Allow once" hosts. Returns the unsubscribe.
 */
export function onEgressInvocationReleased(listener: (token: string, release: EgressInvocationRelease) => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

/**
 * The attribution key a violation's `encodedCommand` carries. ASRT encodes the
 * key as plain base64 of its first 100 characters (`encodeSandboxedCommand`),
 * so a 32-character token decodes back to itself. The bytes come over a
 * carrier the sandboxed process can write (the proxy username), so the result
 * is only ever used as a lookup key, never displayed or stored.
 */
export function decodeEgressAttributionKey(encodedCommand: string): string {
  return Buffer.from(encodedCommand, "base64").toString("utf8");
}

/** Number of live tokens. For tests and diagnostics. */
export function liveEgressInvocationCount(): number {
  return live.size;
}
