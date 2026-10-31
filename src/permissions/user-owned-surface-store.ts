import { isUserOwnedSurface, isUserOwnedSurfaceChoice, type UserOwnedSurface, type UserOwnedSurfaceChoice } from "../shared/permissions-events.js";

/** Conversation-local choices; no child inheritance and no persisted authority. */
export class UserOwnedSurfaceStore {
  private readonly sessions = new Map<string, Map<UserOwnedSurface, UserOwnedSurfaceChoice>>();

  get(sessionId: string, surface: UserOwnedSurface): UserOwnedSurfaceChoice {
    return this.sessions.get(sessionId)?.get(surface) ?? "ask";
  }

  set(sessionId: string, surface: UserOwnedSurface, choice: UserOwnedSurfaceChoice): void {
    if (!sessionId.trim() || !isUserOwnedSurface(surface) || !isUserOwnedSurfaceChoice(choice)) throw new Error("Invalid user-owned surface choice");
    let choices = this.sessions.get(sessionId);
    if (!choices) { choices = new Map(); this.sessions.set(sessionId, choices); }
    choices.set(surface, choice);
  }

  clear(sessionId: string): boolean { return this.sessions.delete(sessionId); }

  clearMatching(matches: (sessionId: string) => boolean): boolean {
    let cleared = false;
    for (const sessionId of this.sessions.keys()) if (matches(sessionId)) cleared = this.sessions.delete(sessionId) || cleared;
    return cleared;
  }
}
