import { browserWorkspaceUrl, type BrowserPermissionChoice, type BrowserSitePermission } from "../../shared/browser-workspace.js";
import type { BrowserWorkspaceStore } from "./browser-workspace-store.js";

export interface BrowserPermissionDetails { readonly requestingUrl?: string; readonly isMainFrame?: boolean; readonly mediaTypes?: readonly string[]; readonly mediaType?: string }
export interface BrowserPermissionContext { readonly guestId: number; readonly windowId: number; readonly documentGeneration: number; readonly url: string }
export interface BrowserPermissionPrompt { readonly windowId: number; readonly guestId: number; readonly origin: string; readonly permissions: readonly BrowserSitePermission[] }
export interface BrowserSitePermissionDeps {
  readonly store: BrowserWorkspaceStore;
  currentContext(guestId: number): BrowserPermissionContext | null;
  /** The user's choice, or null when the question ended without one (nothing is remembered then). */
  prompt(request: BrowserPermissionPrompt): Promise<BrowserPermissionChoice | null>;
  fullscreenAvailable(windowId: number): boolean;
}

function capabilities(permission: string, details: BrowserPermissionDetails): readonly BrowserSitePermission[] | null {
  if (permission === "media") {
    const media = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : []);
    if (media.length === 0 || media.some((item) => item !== "audio" && item !== "video")) return null;
    return [...new Set(media.map((item) => item === "video" ? "camera" as const : "microphone" as const))];
  }
  return permission === "geolocation" || permission === "notifications" || permission === "fullscreen" ? [permission] : null;
}

export class BrowserSitePermissionPolicy {
  private readonly documentGrants = new Set<string>();
  /** A "Block" answer holds for the document that asked, so a page that asks again in a loop is not re-prompted. */
  private readonly documentDenials = new Set<string>();
  constructor(private readonly deps: BrowserSitePermissionDeps) {}
  private context(guestId: number, details: BrowserPermissionDetails): (BrowserPermissionContext & { origin: string }) | null {
    const context = this.deps.currentContext(guestId);
    if (!context || details.isMainFrame !== true) return null;
    const current = browserWorkspaceUrl(context.url);
    const requesting = browserWorkspaceUrl(details.requestingUrl);
    if (!current || !requesting || current !== requesting) return null;
    return { ...context, origin: new URL(current).origin };
  }
  private key(context: BrowserPermissionContext, permission: BrowserSitePermission): string {
    return `${context.guestId}:${context.documentGeneration}:${permission}`;
  }
  invalidateGuest(guestId: number): void {
    for (const set of [this.documentGrants, this.documentDenials]) for (const key of set) if (key.startsWith(`${guestId}:`)) set.delete(key);
  }
  invalidateAll(): void { this.documentGrants.clear(); this.documentDenials.clear(); }
  check(guestId: number, permission: string, details: BrowserPermissionDetails): boolean {
    if (permission === "clipboard-sanitized-write") return this.deps.currentContext(guestId) !== null;
    const context = this.context(guestId, details);
    if (!context) return false;
    const requested = capabilities(permission, details);
    if (requested?.includes("fullscreen") && !this.deps.fullscreenAvailable(context.windowId)) return false;
    return requested !== null && requested.every((item) => {
      const decision = this.deps.store.peekDecision(context.origin, item);
      // Block for this document outranks everything the document was or is later granted.
      return decision !== "block" && !this.documentDenials.has(this.key(context, item)) && (decision === "allow" || this.documentGrants.has(this.key(context, item)));
    });
  }
  async request(guestId: number, permission: string, details: BrowserPermissionDetails): Promise<boolean> {
    if (permission === "clipboard-sanitized-write") return this.deps.currentContext(guestId) !== null;
    const context = this.context(guestId, details);
    if (!context) return false;
    const requested = capabilities(permission, details);
    if (!requested) return false;
    if (requested.includes("fullscreen") && !this.deps.fullscreenAvailable(context.windowId)) return false;
    const snapshot = await this.deps.store.snapshot();
    if (snapshot.storageStatus !== "ready") return false;
    const beforePrompt = this.context(guestId, details);
    if (!beforePrompt || beforePrompt.windowId !== context.windowId || beforePrompt.documentGeneration !== context.documentGeneration) return false;
    const decisions = requested.map((item) => this.deps.store.peekDecision(context.origin, item));
    if (decisions.includes("block")) return false;
    const ask = requested.filter((item, index) => decisions[index] !== "allow" && !this.documentGrants.has(this.key(context, item)));
    if (ask.some((item) => this.documentDenials.has(this.key(context, item)))) return false;
    if (ask.length) {
      const choice = await this.deps.prompt({ windowId: context.windowId, guestId, origin: context.origin, permissions: ask });
      if (choice === "block") for (const item of ask) { this.documentDenials.add(this.key(context, item)); this.documentGrants.delete(this.key(context, item)); }
      if (choice === "always-block") {
        for (const item of ask) await this.deps.store.setSitePermission({ origin: context.origin, permission: item, decision: "block" });
      }
      if (choice !== "allow-once") return false;
    }
    const live = this.context(guestId, details);
    if (!live || live.windowId !== context.windowId || live.documentGeneration !== context.documentGeneration || live.origin !== context.origin || requested.some((item) => this.deps.store.peekDecision(context.origin, item) === "block")) return false;
    if (requested.includes("fullscreen") && !this.deps.fullscreenAvailable(context.windowId)) return false;
    // Another question for the same document may have been answered Block while this one waited: Block holds.
    if (requested.some((item) => this.documentDenials.has(this.key(context, item)))) return false;
    for (const item of ask) this.documentGrants.add(this.key(context, item));
    return true;
  }
}
