/**
 * How long a person's allow for a sandboxed process's network destination
 * lasts. Shared by main (the grant store
 * and the approval gate) and the renderer (the ask card, the terminal tab's
 * banner and Settings).
 *
 *   - `once`: this tool call only; for a terminal, this one connection.
 *   - `conversation`: this conversation, until the app restarts (shell tool calls).
 *   - `tab`: this terminal tab, until its shell exits (workspace terminals).
 *   - `workspace`: this working directory, until revoked in Settings (shell tool calls).
 *   - `always`: every workspace, until revoked in Settings.
 *
 * A grant covers only the network class shown at approval. A persistent
 * grant also records its origin (a shell tool call or workspace terminal)
 * and only ever covers that origin.
 */
import type { EgressGrantScope } from "./sandbox-capability-info.js";

export type { EgressGrantScope };

/** Every scope a grant can name. */
const EGRESS_GRANT_SCOPES: readonly EgressGrantScope[] = ["once", "conversation", "tab", "workspace", "always"];

/**
 * What kind of sandboxed process an ask is for, and so which ladder of scopes
 * it offers, narrowest first. A shell tool call's grant can last its
 * conversation or its working directory; a terminal's its tab. Terminals have
 * no "This workspace": every tab is anchored to the app's one default
 * workspace, which agent shell calls share, so it would name no tab's own work.
 */
export type EgressAskOrigin = "shell" | "terminal";

export const EGRESS_GRANT_SCOPE_LADDERS: Readonly<Record<EgressAskOrigin, readonly EgressGrantScope[]>> = {
  shell: ["once", "conversation", "workspace", "always"],
  terminal: ["once", "tab", "always"],
};

export function isEgressGrantScope(value: unknown): value is EgressGrantScope {
  return typeof value === "string" && (EGRESS_GRANT_SCOPES as readonly string[]).includes(value);
}

/** The destination class shown when a grant was approved. */
export type EgressGrantNetwork = "public" | "local" | "unverified";

export function isEgressGrantNetwork(value: unknown): value is EgressGrantNetwork {
  return value === "public" || value === "local" || value === "unverified";
}

/** A "This conversation" grant (held in memory until the app restarts), as Settings lists it. */
export interface ConversationEgressGrant {
  readonly scope: "conversation";
  readonly sessionId: string;
  readonly host: string;
  readonly port: number;
  /** Missing only on legacy grants, which cover public destinations exclusively. */
  readonly network?: EgressGrantNetwork;
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
  /** Missing only on legacy grants, which cover public destinations exclusively. */
  readonly network?: EgressGrantNetwork;
  /** ISO time the grant was made. */
  readonly grantedAt: string;
}

/** Every grant Settings lists and can revoke. */
export type ListedEgressGrant = ConversationEgressGrant | TabEgressGrant | PersistentEgressGrant;

/** Which grant a revoke names. */
export type RevocableEgressGrant =
  | Pick<PersistentEgressGrant, "scope" | "origin" | "host" | "port" | "network" | "workspaceRoot">
  | Pick<ConversationEgressGrant, "scope" | "sessionId" | "host" | "port" | "network">
  | Pick<TabEgressGrant, "scope" | "tabId" | "host" | "port" | "network">;

/** A persistent grant, as Settings lists it. */
export interface PersistentEgressGrant {
  readonly scope: "workspace" | "always";
  /** What made the grant, and the only kind of process it covers (a workspace grant is always a shell call's). */
  readonly origin: EgressAskOrigin;
  /** Set for `workspace` grants only. */
  readonly workspaceRoot?: string;
  readonly host: string;
  readonly port: number;
  /** Missing only on legacy grants, which cover public destinations exclusively. */
  readonly network?: EgressGrantNetwork;
  /** ISO time the grant was made. */
  readonly grantedAt: string;
}
