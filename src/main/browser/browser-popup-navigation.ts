import type { BrowserActionTab } from "../../tools/browser-tools.js";
import type { BrowserGuest } from "./browser-tab-registry.js";
import { errorMessage } from "../../shared/error-message.js";
import { validateExternalUrl } from "../../shared/external-url.js";

interface PopupPolicy {
  readonly leaseId: string | undefined;
  readonly pending: Promise<{ error?: unknown }>[];
  active(): boolean;
  open(url: string): Promise<void>;
}

const popupPolicies = new WeakMap<object, PopupPolicy>();

export function setBrowserPopupNavigation<G extends BrowserGuest>(target: BrowserActionTab<G>): void {
  const guest = target.tab.guest;
  if (!guest || !target.authorizeSite) return;
  popupPolicies.set(guest, {
    leaseId: target.leaseId,
    pending: [],
    active: () => target.tab.opener === "agent" && target.tab.controlMode !== "human-paused",
    open: async (url) => {
      if (guest.isDestroyed() || target.tab.guest !== guest || target.tab.lease?.id !== target.leaseId || target.callerSignal?.aborted) throw new Error("Browser popup authority changed");
      if (!target.openSitePopup) throw new Error("Browser popup opening unavailable");
      await target.openSitePopup(url);
    },
  });
}

/** The native callback cannot await consent; the originating command drains these results before releasing its lease. */
export async function awaitBrowserPopupNavigation(guest: object, leaseId: string): Promise<void> {
  const policy = popupPolicies.get(guest);
  if (!policy || policy.leaseId !== leaseId) return;
  while (policy.pending.length > 0) {
    const results = await Promise.all(policy.pending.splice(0));
    const failed = results.find(result => "error" in result);
    if (failed) throw new Error(`Browser popup could not open: ${errorMessage(failed.error)}`);
  }
}

export function handleAgentBrowserPopup(guest: object, url: string, hasBody: boolean): boolean {
  const policy = popupPolicies.get(guest);
  if (!policy?.active()) return false;
  if (!hasBody && validateExternalUrl(url).ok) {
    policy.pending.push(policy.open(url).then(() => ({}), error => ({ error })));
  }
  return true;
}
