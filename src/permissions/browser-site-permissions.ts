import { browserOrigin } from "../shared/browser-tools.js";
import { validateExternalUrl } from "../shared/external-url.js";
import type { BrowserSiteChoice } from "../shared/permissions-events.js";

export class BrowserSitePermissions {
  private readonly sessions = new Map<string, Set<string>>();

  allows(sessionId: string, url: string): boolean {
    const origin = browserOrigin(url);
    const allowed = this.sessions.get(sessionId);
    return validateExternalUrl(url).ok && origin !== null && (allowed?.has("*") === true || allowed?.has(origin) === true);
  }

  allow(sessionId: string, url: string, choice: BrowserSiteChoice): void {
    const origin = browserOrigin(url);
    if (!sessionId || origin === null || !validateExternalUrl(url).ok) throw new Error("Invalid browser site grant");
    const allowed = this.sessions.get(sessionId) ?? new Set<string>();
    allowed.add(choice === "any-site" ? "*" : origin);
    this.sessions.set(sessionId, allowed);
  }

  /** What lets this session's agent open the site right now: a grant for the site, for any site, or nothing. */
  granted(sessionId: string, url: string): BrowserSiteChoice | null {
    const origin = browserOrigin(url);
    const allowed = this.sessions.get(sessionId);
    if (origin === null || !allowed) return null;
    return allowed.has("*") ? "any-site" : allowed.has(origin) ? "this-site" : null;
  }

  /**
   * The user takes back the agent's access to a site. Whatever allowed it goes: the site's own grant, and the any-site
   * grant when that is what allowed it, since the site would stay open to the agent otherwise. The next request for the
   * site asks again, exactly as a first request does.
   */
  revoke(sessionId: string, url: string): boolean {
    const origin = browserOrigin(url);
    const allowed = this.sessions.get(sessionId);
    if (origin === null || !allowed) return false;
    const removed = [allowed.delete(origin), allowed.delete("*")].some(Boolean);
    if (allowed.size === 0) this.sessions.delete(sessionId);
    return removed;
  }

  clear(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  clearMatching(matches: (sessionId: string) => boolean): boolean {
    let cleared = false;
    for (const sessionId of this.sessions.keys()) if (matches(sessionId)) cleared = this.clear(sessionId) || cleared;
    return cleared;
  }
}
