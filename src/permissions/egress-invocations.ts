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
 * The id is a label, not a credential (anthropics/sandbox-runtime#591): a
 * confined process that learns another live id can present it. It is 16
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
interface ShellEgressOwner {
  readonly kind: "shell";
  readonly toolName: "bash" | "powershell";
  /** The provider's tool-use id, when the call carried one. Never the key. */
  readonly toolUseId: string | undefined;
}

/** One workspace terminal tab, for the life of the shell it runs. */
interface TerminalEgressOwner {
  readonly kind: "terminal";
  readonly tabId: string;
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

export interface EgressInvocation {
  /** The value passed to ASRT as `commandId`. */
  readonly token: string;
  readonly owner: EgressInvocationOwner;
  /** Forget the token. Idempotent; call it once the process has exited. */
  release(): void;
}

const live = new Map<string, EgressInvocationOwner>();

/** The token length in characters: 16 random bytes, hex-encoded. */
export const EGRESS_INVOCATION_TOKEN_LENGTH = 32;

export function openEgressInvocation(owner: EgressInvocationOwner): EgressInvocation {
  let token = randomBytes(EGRESS_INVOCATION_TOKEN_LENGTH / 2).toString("hex");
  // 128 random bits do not collide in practice; a collision would silently
  // merge two owners, so it is re-drawn rather than assumed away.
  while (live.has(token)) token = randomBytes(EGRESS_INVOCATION_TOKEN_LENGTH / 2).toString("hex");
  live.set(token, owner);
  let released = false;
  return {
    token,
    owner,
    release: () => {
      if (released) return;
      released = true;
      live.delete(token);
    },
  };
}

/** The live owner of a token, or undefined for a released or foreign key. */
export function egressInvocationOwner(token: string): EgressInvocationOwner | undefined {
  return live.get(token);
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
