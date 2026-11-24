import { describe, expect, it, vi } from "vitest";
import { _browserPopupNavigationStateForTest, awaitBrowserPopupNavigation, handleAgentBrowserPopup, retireBrowserPopupNavigation, setBrowserPopupNavigation } from "../browser-popup-navigation.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import type { BrowserActionTab } from "../../../tools/browser-tools.js";
import type { BrowserGuest } from "../browser-tab-registry.js";

describe("agent popup navigation", () => {
  it("routes agent popups through site admission and blocks non-web and body-bearing popups", async () => {
    const guest = { isDestroyed: () => false };
    const open = vi.fn(async () => {});
    const target = { tab: { guest, opener: "agent", controlMode: "agent-active", lease: { id: "lease" } }, leaseId: "lease", authorizeSite: async () => {}, openSitePopup: open } as unknown as BrowserActionTab<BrowserGuest>;
    setBrowserPopupNavigation(target);
    expect(handleAgentBrowserPopup(guest, "https://other.example", false)).toBe(true);
    await awaitBrowserPopupNavigation(guest, "lease");
    expect(open).toHaveBeenCalledExactlyOnceWith("https://other.example");
    expect(handleAgentBrowserPopup(guest, "javascript:void(0)", false)).toBe(true);
    expect(handleAgentBrowserPopup(guest, "https://other.example", true)).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    target.tab.controlMode = "human-paused";
    expect(handleAgentBrowserPopup(guest, "https://other.example", false)).toBe(true);
  });
  it("denies repeated post-lease popups without retaining pending results", async () => {
    const guest = { isDestroyed: () => false };
    const open = vi.fn(async () => {});
    const target = { tab: { guest, opener: "agent", controlMode: "agent-active", lease: { id: "lease" } }, leaseId: "lease", authorizeSite: async () => {}, openSitePopup: open } as unknown as BrowserActionTab<BrowserGuest>;
    setBrowserPopupNavigation(target);
    target.tab.lease = null;
    for (let index = 0; index < 20_000; index++) expect(handleAgentBrowserPopup(guest, "https://other.example/", false)).toBe(true);
    expect(_browserPopupNavigationStateForTest(guest).pending).toBe(0);
    expect(open).not.toHaveBeenCalled();
    await Promise.resolve();
  });
  it("rejects an in-flight popup wait promptly when the caller ends", async () => {
    const guest = { isDestroyed: () => false };
    const controller = new AbortController();
    const opened = deferred<void>();
    const target = { tab: { guest, opener: "agent", controlMode: "agent-active", lease: { id: "lease" } }, leaseId: "lease", callerSignal: controller.signal,
      authorizeSite: async () => {}, openSitePopup: () => opened.promise } as unknown as BrowserActionTab<BrowserGuest>;
    setBrowserPopupNavigation(target);
    handleAgentBrowserPopup(guest, "https://other.example/", false);
    const pending = awaitBrowserPopupNavigation(guest, "lease");
    const outcome = pending.then(() => "opened", () => "retired");
    controller.abort(new Error("turn ended"));
    try {
      await expect(Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("still pending"), 10))])).resolves.toBe("retired");
      expect(_browserPopupNavigationStateForTest(guest).pending).toBe(0);
    } finally { opened.resolve(); await outcome; }
  });
  it("retains an already rejected popup result for the originating lease", async () => {
    const guest = { isDestroyed: () => false };
    const target = { tab: { guest, opener: "agent", controlMode: "agent-active", lease: { id: "lease" } }, leaseId: "lease", authorizeSite: async () => {},
      openSitePopup: async () => { throw new Error("site consent denied"); } } as unknown as BrowserActionTab<BrowserGuest>;
    setBrowserPopupNavigation(target);
    handleAgentBrowserPopup(guest, "https://other.example/", false);
    await Promise.resolve();
    await expect(awaitBrowserPopupNavigation(guest, "other-lease")).resolves.toBeUndefined();
    await expect(awaitBrowserPopupNavigation(guest, "lease")).rejects.toThrow("Browser popup could not open: site consent denied");
  });
  it("keeps retirement of an old lease or reused guest ID from cancelling current authority", async () => {
    const guest = { id: 7, isDestroyed: () => false };
    const replacement = { id: 7, isDestroyed: () => false };
    const open = vi.fn(async () => {});
    const target = { tab: { guest, opener: "agent", controlMode: "agent-active", lease: { id: "new-lease" } }, leaseId: "new-lease", authorizeSite: async () => {}, openSitePopup: open } as unknown as BrowserActionTab<BrowserGuest>;
    setBrowserPopupNavigation(target);
    retireBrowserPopupNavigation(guest, "old-lease");
    retireBrowserPopupNavigation(replacement, "new-lease");
    expect(handleAgentBrowserPopup(guest, "https://other.example/", false)).toBe(true);
    await awaitBrowserPopupNavigation(guest, "new-lease");
    expect(open).toHaveBeenCalledOnce();
    target.tab.opener = "user";
    expect(handleAgentBrowserPopup(guest, "https://other.example/", false)).toBe(false);
  });
  it("removes the caller abort listener when authority retires", () => {
    const guest = { isDestroyed: () => false };
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const target = { tab: { guest, opener: "agent", controlMode: "agent-active", lease: { id: "lease" } }, leaseId: "lease", callerSignal: controller.signal,
      authorizeSite: async () => {}, openSitePopup: async () => {} } as unknown as BrowserActionTab<BrowserGuest>;
    setBrowserPopupNavigation(target);
    retireBrowserPopupNavigation(guest, "lease");
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
    retireBrowserPopupNavigation(guest, "lease");
    expect(remove).toHaveBeenCalledOnce();
  });
});
