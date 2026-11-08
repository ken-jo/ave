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

  clear(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  clearMatching(matches: (sessionId: string) => boolean): boolean {
    let cleared = false;
    for (const sessionId of this.sessions.keys()) if (matches(sessionId)) cleared = this.clear(sessionId) || cleared;
    return cleared;
  }
}
