// Client proxy usernames are labels, never credentials; trust the kernel-bound per-invocation listener. Mint 16 random bytes rather than provider IDs to satisfy length/secrecy bounds. Release at process exit; unknown or late keys become unattributed.
import { randomBytes } from "node:crypto";

// A Bash or PowerShell tool call.
export interface ShellEgressOwner {
  readonly kind: "shell";
  readonly toolName: "bash" | "powershell";
  // The provider's tool-use id, when the call carried one. Never the key.
  readonly toolUseId: string | undefined;
  // What an egress ask for this call needs to know. Required: a shell call that cannot say whether anyone can answer is treated as one nobody can.
  readonly context: ShellEgressContext;
}

// Where a shell call runs, for the egress ask and its grants.
export interface ShellEgressContext {
  // The conversation the call belongs to; undefined outside a conversation.
  readonly sessionId: string | undefined;
  // The conversation's working directory: what "This workspace" grants key on.
  readonly workspaceRoot: string | undefined;
  // Whether a person can answer an ask for this call right now.
  readonly approvalSurface: "interactive" | "unavailable";
}

// One confined terminal incarnation. Delivery follows its conversation; legacy callers may provide only the opaque terminal identity.
export interface TerminalEgressOwner {
  readonly kind: "terminal";
  readonly tabId: string;
  readonly sessionId?: string;
}

// What plugin-owned code a confined, non-interactive process runs.
type WorkerEgressRole = "plugin-child" | "worker" | "hook" | "mcp-server";

// A plugin child, a delegated worker, a hook (bundled or the user's own) or an MCP stdio server. All of them are non-interactive, which is what the later ask callback needs to know.
export interface WorkerEgressOwner {
  readonly kind: "worker";
  readonly role: WorkerEgressRole;
  // The owning plugin; undefined for an MCP server no plugin bundles or a user hook. Without a plugin there is no extension allowlist: such a process may reach the model endpoints only (`workerEgressAllowedDomains`).
  readonly pluginId: string | undefined;
  // The worker's id, the MCP server's id, or a user hook's hashed id.
  readonly instanceId?: string;
  /** Offline services never inherit an extension allowlist or model endpoints. */
  readonly network?: "offline";
}

export type EgressInvocationOwner = ShellEgressOwner | TerminalEgressOwner | WorkerEgressOwner;

export interface EgressInvocationOptions {
  // Ends a pending egress ask for this invocation (the call was cancelled).
  readonly abortSignal?: AbortSignal;
}

export interface EgressInvocation {
  // The value passed to ASRT as `commandId`.
  readonly token: string;
  readonly owner: EgressInvocationOwner;
  // The process group the invocation's process leads (its pid, for a child spawned in its own session or group). Passed to the sandbox when the token is released, so an ended invocation's listener port is not handed back while anything that process started is still running. Call it once the process has started; a non-positive or non-integer pid is a bug.
  noteProcessGroup(pgid: number): void;
  // Forget the token. Idempotent; call it once the process has exited.
  release(): void;
}

// What a release listener learns about the invocation that ended.
export interface EgressInvocationRelease {
  // Who the token belonged to.
  readonly owner: EgressInvocationOwner;
  // The process group noted with `noteProcessGroup`, if any.
  readonly processGroup: number | undefined;
}

interface LiveInvocation {
  readonly owner: EgressInvocationOwner;
  readonly abortSignal: AbortSignal | undefined;
}

const live = new Map<string, LiveInvocation>();
const releaseListeners = new Set<(token: string, release: EgressInvocationRelease) => void>();

// The token length in characters: 16 random bytes, hex-encoded.
export const EGRESS_INVOCATION_TOKEN_LENGTH = 32;

export function openEgressInvocation(owner: EgressInvocationOwner, options: EgressInvocationOptions = {}): EgressInvocation {
  let token = randomBytes(EGRESS_INVOCATION_TOKEN_LENGTH / 2).toString("hex");
  // 128 random bits do not collide in practice; a collision would silently merge two owners, so it is re-drawn rather than assumed away.
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

// The live owner of a token, or undefined for a released or foreign key.
export function egressInvocationOwner(token: string): EgressInvocationOwner | undefined {
  return live.get(token)?.owner;
}

// The abort signal a live invocation was opened with, if any.
export function egressInvocationAbortSignal(token: string): AbortSignal | undefined {
  return live.get(token)?.abortSignal;
}

// Run `listener` with each token as it is released, after it is forgotten. The sandbox adapter closes the invocation's proxy listener here and the grant store drops its "Allow once" hosts. Returns the unsubscribe.
export function onEgressInvocationReleased(listener: (token: string, release: EgressInvocationRelease) => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

// The attribution key a violation's `encodedCommand` carries. ASRT encodes the key as plain base64 of its first 100 characters (`encodeSandboxedCommand`), so a 32-character token decodes back to itself. The bytes come over a carrier the sandboxed process can write (the proxy username), so the result is only ever used as a lookup key, never displayed or stored.
export function decodeEgressAttributionKey(encodedCommand: string): string {
  return Buffer.from(encodedCommand, "base64").toString("utf8");
}

// Number of live tokens. For tests and diagnostics.
export function liveEgressInvocationCount(): number {
  return live.size;
}
