/**
 * How long a person's allow for a sandboxed process's network destination
 * lasts (design B and F, owner 2026-10-16). Shared by main (the grant store
 * and the approval gate) and the renderer (the ask card, the terminal tab's
 * banner and Settings).
 *
 *   - `once`: this tool call, or this connection's terminal shell, only.
 *   - `conversation`: this conversation, until the app restarts (shell tool calls).
 *   - `tab`: this terminal tab, until it closes (workspace terminals).
 *   - `workspace`: this working directory, until revoked in Settings.
 *   - `always`: every workspace, until revoked in Settings.
 */
import type { EgressGrantScope } from "./sandbox-capability-info.js";

export type { EgressGrantScope };

/** Every scope a grant can name. */
const EGRESS_GRANT_SCOPES: readonly EgressGrantScope[] = ["once", "conversation", "tab", "workspace", "always"];

/**
 * What kind of sandboxed process an ask is for, and so which ladder of scopes
 * it offers, narrowest first. The ladders differ only in their second rung:
 * a shell tool call's grant can last its conversation, a terminal's its tab.
 */
export type EgressAskOrigin = "shell" | "terminal";

export const EGRESS_GRANT_SCOPE_LADDERS: Readonly<Record<EgressAskOrigin, readonly EgressGrantScope[]>> = {
  shell: ["once", "conversation", "workspace", "always"],
  terminal: ["once", "tab", "workspace", "always"],
};

export function isEgressGrantScope(value: unknown): value is EgressGrantScope {
  return typeof value === "string" && (EGRESS_GRANT_SCOPES as readonly string[]).includes(value);
}

/** A "This conversation" grant (held in memory until the app restarts), as Settings lists it. */
export interface ConversationEgressGrant {
  readonly scope: "conversation";
  readonly sessionId: string;
  readonly host: string;
  readonly port: number;
  /** ISO time the grant was made. */
  readonly grantedAt: string;
}

/** A "This tab" grant (held in memory until the terminal tab closes), as Settings lists it. */
export interface TabEgressGrant {
  readonly scope: "tab";
  /** The workspace terminal tab's id (`terminal:<scope>-<n>`). */
  readonly tabId: string;
  readonly host: string;
  readonly port: number;
  /** ISO time the grant was made. */
  readonly grantedAt: string;
}

/** Every grant Settings lists and can revoke. */
export type ListedEgressGrant = ConversationEgressGrant | TabEgressGrant | PersistentEgressGrant;

/** Which grant a revoke names. */
export type RevocableEgressGrant =
  | Pick<PersistentEgressGrant, "scope" | "host" | "port" | "workspaceRoot">
  | Pick<ConversationEgressGrant, "scope" | "sessionId" | "host" | "port">
  | Pick<TabEgressGrant, "scope" | "tabId" | "host" | "port">;

/** A persistent grant, as Settings lists it. */
export interface PersistentEgressGrant {
  readonly scope: "workspace" | "always";
  /** Set for `workspace` grants only. */
  readonly workspaceRoot?: string;
  readonly host: string;
  readonly port: number;
  /** ISO time the grant was made. */
  readonly grantedAt: string;
}
