/** Grant lifetimes differ by origin: once means one shell call or one terminal connection; session ends with its conversation (deleted, or the app quits); tab ends with its shell.
 * Project (keyed by the project root of the call's working directory) and always (global) persist until revoked; every grant binds the approved network class, and persistent grants also bind shell versus terminal origin.
 * The scope names are the owner's five-choice card (2026-10-25, five-choice network card): Deny, once, session, project, always. Earlier names (`conversation`, `workspace`) are not accepted anywhere. */
import type { EgressGrantScope } from "./sandbox-capability-info.js";

export type { EgressGrantScope };

/** Every scope a grant can name. */
const EGRESS_GRANT_SCOPES: readonly EgressGrantScope[] = ["once", "session", "tab", "project", "always"];

/** What kind of sandboxed process an ask is for, and so which ladder of scopes it offers, narrowest first. A shell tool call's grant can last its session or its project;
 * a terminal's its tab. Terminals have no "This project": every tab is anchored to the app's one default workspace, which agent shell calls share, so it would name no tab's own work. */
export type EgressAskOrigin = "shell" | "terminal";

export const EGRESS_GRANT_SCOPE_LADDERS: Readonly<Record<EgressAskOrigin, readonly EgressGrantScope[]>> = {
  shell: ["once", "session", "project", "always"],
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

/** A "This session" grant (held in memory until its conversation is deleted or the app quits), as Settings lists it. */
export interface SessionEgressGrant {
  readonly scope: "session";
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
export type ListedEgressGrant = SessionEgressGrant | TabEgressGrant | PersistentEgressGrant;

/** Which grant a revoke names. */
export type RevocableEgressGrant =
  | Pick<PersistentEgressGrant, "scope" | "origin" | "host" | "port" | "network" | "projectRoot">
  | Pick<SessionEgressGrant, "scope" | "sessionId" | "host" | "port" | "network">
  | Pick<TabEgressGrant, "scope" | "tabId" | "host" | "port" | "network">;

/** A persistent grant, as Settings lists it. */
export interface PersistentEgressGrant {
  readonly scope: "project" | "always";
  /** What made the grant, and the only kind of process it covers (a project grant is always a shell call's). */
  readonly origin: EgressAskOrigin;
  /** Set for `project` grants only: the project root (repository root when one is found) of the call's working directory. */
  readonly projectRoot?: string;
  readonly host: string;
  readonly port: number;
  /** Missing only on legacy grants, which cover public destinations exclusively. */
  readonly network?: EgressGrantNetwork;
  /** ISO time the grant was made. */
  readonly grantedAt: string;
}
