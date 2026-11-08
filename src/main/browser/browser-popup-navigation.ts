import type { BrowserActionTab } from "../../tools/browser-tools.js";
import type { BrowserGuest } from "./browser-tab-registry.js";
import { validateExternalUrl } from "../../shared/external-url.js";

const popupPolicies = new WeakMap<object, { active(): boolean; open(url: string): Promise<void> }>();

export function setBrowserPopupNavigation<G extends BrowserGuest>(target: BrowserActionTab<G>): void {
  const guest = target.tab.guest;
  if (!guest || !target.authorizeSite) return;
  popupPolicies.set(guest, {
    active: () => target.tab.opener === "agent" && target.tab.controlMode !== "human-paused",
    open: async (url) => {
      if (guest.isDestroyed() || target.tab.guest !== guest || target.tab.lease?.id !== target.leaseId || target.callerSignal?.aborted) throw new Error("Browser popup authority changed");
      if (!target.openSitePopup) throw new Error("Browser popup opening unavailable");
      await target.openSitePopup(url);
    },
  });
}

export function handleAgentBrowserPopup(guest: object, url: string, hasBody: boolean): boolean {
  const policy = popupPolicies.get(guest);
  if (!policy?.active()) return false;
  if (!hasBody && validateExternalUrl(url).ok) void policy.open(url).catch(() => {});
  return true;
}
