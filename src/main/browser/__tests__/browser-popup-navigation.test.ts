import { describe, expect, it, vi } from "vitest";
import { awaitBrowserPopupNavigation, handleAgentBrowserPopup, setBrowserPopupNavigation } from "../browser-popup-navigation.js";
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
    expect(handleAgentBrowserPopup(guest, "https://other.example", false)).toBe(false);
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
});
