import type { WebContents } from "electron";

type ApprovalOwner =
  | { readonly surface: WebContents | null }
  | { readonly parentSessionId: string };

function requireIdentity(identity: string): void {
  if (typeof identity !== "string" || identity.trim().length === 0) {
    throw new Error("approval-surface: empty identity");
  }
}

function requireSurface(owner: WebContents | null): void {
  if (owner !== null && (typeof owner !== "object" || typeof owner.isDestroyed !== "function")) {
    throw new Error("approval-surface: invalid owner registration");
  }
}

/** Store explicit delivery attachments without borrowing another run's surface. */
export class ApprovalSurfaceRegistry {
  private readonly sessions = new Map<string, ApprovalOwner>();
  private readonly terminals = new Map<string, WebContents | null>();
  private readonly terminalSessions = new Map<string, string>();
  private unattributed: WebContents | null = null;

  register(sessionId: string, owner: WebContents | null): void {
    requireIdentity(sessionId);
    requireSurface(owner);
    this.sessions.set(sessionId, { surface: owner });
  }

  /** Keep a live parent link so children follow ownership transfers immediately. */
  inherit(sessionId: string, parentSessionId: string | undefined): void {
    requireIdentity(sessionId);
    if (parentSessionId === undefined) {
      this.register(sessionId, null);
      return;
    }
    requireIdentity(parentSessionId);
    const visited = new Set([sessionId]);
    let cursor = parentSessionId;
    for (;;) {
      if (visited.has(cursor)) throw new Error("approval-surface: cyclic parent registration");
      visited.add(cursor);
      const owner = this.sessions.get(cursor);
      if (!owner || "surface" in owner) break;
      cursor = owner.parentSessionId;
    }
    this.sessions.set(sessionId, { parentSessionId });
  }

  /** Replacing a run's session revokes the outgoing session's surface authority. */
  move(previousSessionId: string, sessionId: string): void {
    requireIdentity(previousSessionId);
    requireIdentity(sessionId);
    const owner = this.sessions.get(previousSessionId);
    if (!owner) throw new Error("approval-surface: unregistered outgoing session");
    if (previousSessionId === sessionId) return;
    if ("parentSessionId" in owner) this.inherit(sessionId, owner.parentSessionId);
    else this.register(sessionId, owner.surface);
    this.sessions.delete(previousSessionId);
  }

  release(sessionId: string): void {
    requireIdentity(sessionId);
    this.sessions.delete(sessionId);
  }

  registerTerminal(tabId: string, owner: WebContents | null): void {
    requireIdentity(tabId);
    requireSurface(owner);
    this.terminalSessions.delete(tabId);
    this.terminals.set(tabId, owner);
  }

  /** Confined terminal delivery follows its conversation's live host attachment. */
  bindTerminalSession(tabId: string, sessionId: string): void {
    requireIdentity(tabId);
    requireIdentity(sessionId);
    this.terminals.delete(tabId);
    this.terminalSessions.set(tabId, sessionId);
  }

  releaseTerminal(tabId: string): void {
    requireIdentity(tabId);
    this.terminals.delete(tabId);
    this.terminalSessions.delete(tabId);
  }

  registerUnattributed(owner: WebContents | null): void {
    requireSurface(owner);
    this.unattributed = owner;
  }

  /** Revocation never settles a pending card: without turn abort it waits for the normal deny timeout. */
  releaseOwner(owner: WebContents): void {
    requireSurface(owner);
    if (owner === null) throw new Error("approval-surface: invalid owner release");
    for (const [sessionId, registered] of this.sessions) {
      if ("surface" in registered && registered.surface === owner) this.register(sessionId, null);
    }
    for (const [tabId, registered] of this.terminals) {
      if (registered === owner) this.terminals.set(tabId, null);
    }
    if (this.unattributed === owner) this.unattributed = null;
  }

  resolve(sessionId: string | undefined, terminalTabId?: string): WebContents | null {
    let surface: WebContents | null;
    if (terminalTabId !== undefined) {
      requireIdentity(terminalTabId);
      const terminalSessionId = this.terminalSessions.get(terminalTabId);
      if (terminalSessionId !== undefined) return this.resolve(terminalSessionId);
      surface = this.terminals.get(terminalTabId) ?? null;
    } else if (sessionId === undefined) {
      surface = this.unattributed;
    } else {
      requireIdentity(sessionId);
      const visited = new Set<string>();
      let cursor = sessionId;
      for (;;) {
        if (visited.has(cursor)) throw new Error("approval-surface: cyclic parent registration");
        visited.add(cursor);
        const owner = this.sessions.get(cursor);
        if (!owner) return null;
        if ("surface" in owner) {
          surface = owner.surface;
          break;
        }
        cursor = owner.parentSessionId;
      }
    }
    return surface && !surface.isDestroyed() ? surface : null;
  }
}

export type ApprovalSurfaceUpdate =
  | { kind: "attach"; sessionId: string; surface: WebContents | null }
  | { kind: "inherit"; sessionId: string; parentSessionId: string | undefined }
  | { kind: "move"; previousSessionId: string; sessionId: string }
  | { kind: "release"; sessionId: string }
  | { kind: "attach-terminal"; tabId: string; surface: WebContents | null }
  | { kind: "bind-terminal-session"; tabId: string; sessionId: string }
  | { kind: "release-terminal"; tabId: string }
  | { kind: "attach-unattributed"; surface: WebContents | null }
  | { kind: "release-owner"; surface: WebContents };

const registeredApprovalSurfaces = new ApprovalSurfaceRegistry();

/** Read-only delivery lookup; all attachment and lifecycle updates use one host function. */
export const approvalSurfaceRegistry: Readonly<Pick<ApprovalSurfaceRegistry, "resolve">> = Object.freeze({
  resolve: (sessionId: string | undefined, terminalTabId?: string) =>
    registeredApprovalSurfaces.resolve(sessionId, terminalTabId),
});

/**
 * App windows are one trust level; a defense against a compromised app renderer
 * would need a trusted-chrome approval surface (main-process-drawn prompt plus
 * native input proof), which is out of scope for this PR.
 * User-driven attachment may transfer delivery ownership. Host-only provenance,
 * remote origin and parent adjudication remain host-authored; registration never
 * supplies the signed native card answer required to resume paused automation.
 */
export function updateApprovalSurface(update: ApprovalSurfaceUpdate): void {
  if (update === null || typeof update !== "object") {
    throw new Error("approval-surface: invalid update operation");
  }
  switch (update.kind) {
    case "attach":
      return registeredApprovalSurfaces.register(update.sessionId, update.surface);
    case "inherit":
      return registeredApprovalSurfaces.inherit(update.sessionId, update.parentSessionId);
    case "move":
      return registeredApprovalSurfaces.move(update.previousSessionId, update.sessionId);
    case "release":
      return registeredApprovalSurfaces.release(update.sessionId);
    case "attach-terminal":
      return registeredApprovalSurfaces.registerTerminal(update.tabId, update.surface);
    case "bind-terminal-session":
      return registeredApprovalSurfaces.bindTerminalSession(update.tabId, update.sessionId);
    case "release-terminal":
      return registeredApprovalSurfaces.releaseTerminal(update.tabId);
    case "attach-unattributed":
      return registeredApprovalSurfaces.registerUnattributed(update.surface);
    case "release-owner":
      return registeredApprovalSurfaces.releaseOwner(update.surface);
    default:
      throw new Error("approval-surface: invalid update operation");
  }
}
