/** Host-owned login lifetime. Completion comes from the listener or runtime, never page content. */
export interface OAuthLoginOptions {
  completion: Promise<unknown>;
  onCancel(): void;
  timeoutMs: number;
}

export type OpenOAuthLogin = (url: string, options: OAuthLoginOptions) => Promise<void> | void;

let desktopOpener: OpenOAuthLogin | null = null;

/** Desktop startup installs the presentation capability; shared boot code stays presentation-free. */
export function installOAuthLoginOpener(opener: OpenOAuthLogin): () => void {
  desktopOpener = opener;
  return () => { if (desktopOpener === opener) desktopOpener = null; };
}

export const openOAuthLogin: OpenOAuthLogin = (url, options) => {
  if (!desktopOpener) throw new Error("OAuth login requires a desktop host");
  return desktopOpener(url, options);
};

/** A runtime-owned attempt can open one window and retire it on any terminal runtime result. */
export class OAuthLoginAttempt {
  private complete!: () => void;
  private finished = false;
  private opened = false;
  readonly completion = new Promise<void>((resolve) => { this.complete = resolve; });

  finish(): void {
    this.finished = true;
    this.complete();
  }

  open(url: string, openLogin: OpenOAuthLogin, timeoutMs: number, onCancel: () => void): void {
    if (this.opened || this.finished) return;
    this.opened = true;
    const cancel = () => {
      if (this.finished) return;
      this.finish();
      onCancel();
    };
    void Promise.resolve().then(() => {
      if (!this.finished) return openLogin(url, {
        completion: this.completion, timeoutMs, onCancel: cancel,
      });
    }).catch(cancel);
  }
}
import { SYSTEM_BROWSER_OAUTH_ENDPOINTS } from "./oauth-browser-policy.js";

export function requiresSystemBrowser(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return SYSTEM_BROWSER_OAUTH_ENDPOINTS.some(endpoint =>
      url.hostname === endpoint.hostname && url.pathname.startsWith(endpoint.pathPrefix));
  } catch {
    return false;
  }
}

export function isOAuthBrowserRefusal(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.hostname !== "accounts.google.com" || url.pathname !== "/signin/oauth/error") return false;
    const error = url.searchParams.get("authError") ?? "";
    const decoded = Buffer.from(error, "base64url").toString("utf8");
    return decoded.includes("disallowed_useragent") || error.includes("disallowed_useragent");
  } catch {
    return false;
  }
}
