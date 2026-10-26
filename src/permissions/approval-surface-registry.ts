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

/** Host registrations are the sole authority for approval delivery and native consent. */
export class ApprovalSurfaceRegistry {
  private readonly sessions = new Map<string, ApprovalOwner>();
  private readonly terminals = new Map<string, WebContents | null>();
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
    this.terminals.set(tabId, owner);
  }

  releaseTerminal(tabId: string): void {
    requireIdentity(tabId);
    this.terminals.delete(tabId);
  }

  registerUnattributed(owner: WebContents | null): void {
    requireSurface(owner);
    this.unattributed = owner;
  }

  /** Revocation never settles a pending card: without turn abort it waits for the normal deny timeout. */
  releaseOwner(owner: WebContents): void {
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

export const approvalSurfaceRegistry = new ApprovalSurfaceRegistry();
