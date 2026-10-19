/**
 * How long a person's allow for a sandboxed shell's network destination
 * lasts (design B, owner 2026-10-16). Shared by main (the grant store and the
 * approval gate) and the renderer (the ask card and Settings).
 *
 *   - `once`: this tool call only.
 *   - `conversation`: this conversation, until the app restarts.
 *   - `workspace`: this working directory, until revoked in Settings.
 *   - `always`: every workspace, until revoked in Settings.
 */
export type EgressGrantScope = "once" | "conversation" | "workspace" | "always";

/** Every scope, narrowest first: the order the ask offers them in. */
export const EGRESS_GRANT_SCOPES: readonly EgressGrantScope[] = ["once", "conversation", "workspace", "always"];

export function isEgressGrantScope(value: unknown): value is EgressGrantScope {
  return typeof value === "string" && (EGRESS_GRANT_SCOPES as readonly string[]).includes(value);
}

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
