import { browserWorkspaceUrl, type BrowserSitePermission } from "../../shared/browser-workspace.js";
import type { BrowserWorkspaceStore } from "./browser-workspace-store.js";

export interface BrowserPermissionDetails { readonly requestingUrl?: string; readonly isMainFrame?: boolean; readonly mediaTypes?: readonly string[]; readonly mediaType?: string }
export interface BrowserPermissionContext { readonly guestId: number; readonly windowId: number; readonly documentGeneration: number; readonly url: string }
export interface BrowserPermissionPrompt { readonly windowId: number; readonly origin: string; readonly permissions: readonly BrowserSitePermission[] }
export interface BrowserSitePermissionDeps {
  readonly store: BrowserWorkspaceStore;
  currentContext(guestId: number): BrowserPermissionContext | null;
  prompt(request: BrowserPermissionPrompt): Promise<boolean>;
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
    for (const key of this.documentGrants) if (key.startsWith(`${guestId}:`)) this.documentGrants.delete(key);
  }
  invalidateAll(): void { this.documentGrants.clear(); }
  check(guestId: number, permission: string, details: BrowserPermissionDetails): boolean {
    if (permission === "clipboard-sanitized-write") return this.deps.currentContext(guestId) !== null;
    const context = this.context(guestId, details);
    if (!context) return false;
    const requested = capabilities(permission, details);
    if (requested?.includes("fullscreen") && !this.deps.fullscreenAvailable(context.windowId)) return false;
    return requested !== null && requested.every((item) => {
      const decision = this.deps.store.peekDecision(context.origin, item);
      return decision !== "block" && (decision === "allow" || this.documentGrants.has(this.key(context, item)));
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
    if (ask.length && !await this.deps.prompt({ windowId: context.windowId, origin: context.origin, permissions: ask })) return false;
    const live = this.context(guestId, details);
    if (!live || live.windowId !== context.windowId || live.documentGeneration !== context.documentGeneration || live.origin !== context.origin || requested.some((item) => this.deps.store.peekDecision(context.origin, item) === "block")) return false;
    if (requested.includes("fullscreen") && !this.deps.fullscreenAvailable(context.windowId)) return false;
    for (const item of ask) this.documentGrants.add(this.key(context, item));
    return true;
  }
}
