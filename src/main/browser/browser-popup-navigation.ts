import type { BrowserActionTab } from "../../tools/browser-tools.js";
import type { BrowserGuest, BrowserTabRecord } from "./browser-tab-registry.js";
import { errorMessage } from "../../shared/error-message.js";
import { validateExternalUrl } from "../../shared/external-url.js";

type PopupResult = { error?: unknown };
interface PopupPolicy {
  nativeTab: BrowserTabRecord<BrowserGuest>;
  readonly leaseId: string | undefined;
  readonly pending: Promise<PopupResult>[];
  readonly ended: Promise<PopupResult[]>;
  error?: Error;
  controlsNative(): boolean;
  active(): boolean;
  retire(): void;
  open(url: string): Promise<void>;
}

const popupPolicies = new WeakMap<object, PopupPolicy>();

export function _browserPopupNavigationStateForTest(guest: object): { pending: number } {
  return { pending: popupPolicies.get(guest)?.pending.length ?? 0 };
}

/** Native popup provenance follows rebinding without transferring the retired action's lease. */
export function rebindBrowserPopupNavigation<G extends BrowserGuest>(guest: G, tab: BrowserTabRecord<G>): void {
  const policy = popupPolicies.get(guest);
  if (policy) policy.nativeTab = tab;
}

/** Retiring a lease drains its work while retaining native denial for the agent-created page. */
export function retireBrowserPopupNavigation(guest: object, leaseId?: string): void {
  const policy = popupPolicies.get(guest);
  if (policy && (leaseId === undefined || policy.leaseId === leaseId)) policy.retire();
}

export function setBrowserPopupNavigation<G extends BrowserGuest>(target: BrowserActionTab<G>): void {
  const guest = target.tab.guest;
  if (!guest || !target.authorizeSite) return;
  const previous = popupPolicies.get(guest);
  if (previous && previous.leaseId === target.leaseId && previous.active()) return;
  previous?.retire();
  const tab = target.tab;
  const leaseId = target.leaseId;
  let openSitePopup = target.openSitePopup;
  let callerSignal = target.callerSignal;
  let end!: (results: PopupResult[]) => void;
  const ended = new Promise<PopupResult[]>(resolve => { end = resolve; });
  const policy: PopupPolicy = {
    nativeTab: tab,
    leaseId,
    pending: [],
    ended,
    controlsNative: () => policy.nativeTab.guest !== guest || policy.nativeTab.opener === "agent",
    active: () => !policy.error && leaseId !== undefined && tab.guest === guest && policy.controlsNative() && !guest.isDestroyed()
      && tab.controlMode !== "human-paused" && tab.lease?.id === leaseId && !callerSignal?.aborted,
    retire: () => {
      if (policy.error) return;
      policy.error = new Error("Browser popup authority changed");
      callerSignal?.removeEventListener("abort", policy.retire);
      callerSignal = undefined;
      openSitePopup = undefined;
      policy.pending.length = 0;
      end([{ error: policy.error }]);
    },
    open: async (url) => {
      if (!policy.active()) throw new Error("Browser popup authority changed");
      if (!openSitePopup) throw new Error("Browser popup opening unavailable");
      await openSitePopup(url);
    },
  };
  popupPolicies.set(guest, policy);
  callerSignal?.addEventListener("abort", policy.retire, { once: true });
  if (!policy.active()) policy.retire();
}

/** The native callback cannot await consent; the originating command drains these results before releasing its lease. */
export async function awaitBrowserPopupNavigation(guest: object, leaseId: string): Promise<void> {
  const policy = popupPolicies.get(guest);
  if (!policy || policy.leaseId !== leaseId) return;
  if (!policy.active()) policy.retire();
  if (policy.error) throw new Error(`Browser popup could not open: ${errorMessage(policy.error)}`);
  while (policy.pending.length > 0) {
    const results = await Promise.race([Promise.all(policy.pending.splice(0)), policy.ended]);
    const failed = results.find(result => "error" in result);
    if (failed) throw new Error(`Browser popup could not open: ${errorMessage(failed.error)}`);
  }
}

export function handleAgentBrowserPopup(guest: object, url: string, hasBody: boolean): boolean {
  const policy = popupPolicies.get(guest);
  if (!policy) return false;
  if (!policy.controlsNative()) { policy.retire(); return false; }
  if (!policy.active()) { policy.retire(); return true; }
  if (!hasBody && validateExternalUrl(url).ok) {
    policy.pending.push(policy.open(url).then(() => ({}), error => ({ error })));
  }
  return true;
}
