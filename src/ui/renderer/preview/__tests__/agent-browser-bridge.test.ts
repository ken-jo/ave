/** Each browser operation targets exactly one owning store; new tabs go beside the requesting conversation. */
import { describe, expect, it, vi } from "vitest";
import { bindGuestToTab, closeBrowserTab, registerBrowserTabHost, navigateBrowserTabAsUser, routeBrowserTabOp, type BrowserTabHost } from "../agent-browser-bridge.js";
import type { AveApi } from "../../types.js";
import { noteWebSurfaceFavicon, setWebSurfaceElement, webSurfaceFavicon } from "../web-surfaces.js";

function host(sessionId: string | null, tabs: string[]): BrowserTabHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sessionId: () => sessionId,
    hasTab: (tabId) => tabs.includes(tabId),
    openAgentTab: vi.fn((url, requestId, active) => calls.push(`new ${url} ${requestId} ${active}`)),
    selectTab: vi.fn((tabId) => calls.push(`select ${tabId}`)),
    closeTab: vi.fn((tabId) => calls.push(`close ${tabId}`)),
  };
}

describe("user browser navigation", () => {
  it("quietly ignores a close for a tab no host holds", () => {
    const owner = host("session", ["browser:live"]);
    const unregister = registerBrowserTabHost({} as AveApi, owner);
    try {
      expect(() => closeBrowserTab("browser:missing")).not.toThrow();
      expect(owner.calls).toEqual([]);
    } finally { unregister(); }
  });
  it("waits for main to confirm takeover before navigating", async () => {
    let resolveStop!: (result: { ok: true }) => void;
    const stop = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveStop = resolve; }));
    const navigate = vi.fn();
    const navigation = navigateBrowserTabAsUser({ browserTabs: { stop } } as unknown as AveApi, "browser:1", navigate);
    expect(stop).toHaveBeenCalledWith("browser:1");
    expect(navigate).not.toHaveBeenCalled();
    resolveStop({ ok: true });
    await navigation;
    expect(navigate).toHaveBeenCalledOnce();
  });

  it.each(["refused", "rejected", "unavailable"])("does not navigate when takeover is %s", async (failure) => {
    const stop = failure === "rejected"
      ? vi.fn(async () => { throw new Error("disconnected"); })
      : vi.fn(async () => ({ ok: false, error: "bad-request" }));
    const api = (failure === "unavailable" ? {} : { browserTabs: { stop } }) as unknown as AveApi;
    const navigate = vi.fn();
    await navigateBrowserTabAsUser(api, "browser:1", navigate);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("guest binding", () => {
  it("shares data-only favicon metadata for every bound guest and clears it on main-frame navigation", () => {
    const guest = Object.assign(document.createElement("webview"), { getWebContentsId: () => 31 });
    const unbind = bindGuestToTab({ browserTabs: { bindTab: vi.fn().mockResolvedValue({ ok: true }) } } as unknown as AveApi, guest, "browser:icon", undefined);
    const publish = () => guest.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: ["https://example.test/icon.png", "data:image/png;base64,YQ=="] }));
    try {
      publish();
      expect(webSurfaceFavicon("browser:icon")).toBe("data:image/png;base64,YQ==");
      guest.dispatchEvent(Object.assign(new Event("did-navigate"), { isMainFrame: false }));
      expect(webSurfaceFavicon("browser:icon")).not.toBeNull();
      guest.dispatchEvent(new Event("did-navigate"));
      expect(webSurfaceFavicon("browser:icon")).toBeNull();
      unbind();
      publish();
      expect(webSurfaceFavicon("browser:icon")).toBeNull();
    } finally { unbind(); noteWebSurfaceFavicon("browser:icon", null); }
  });
  it.each(["refused", "disconnected"])("retries a rejected bind on the next dom-ready and remembers only an accepted guest (%s)", async (failure) => {
    const bindTab = vi.fn().mockResolvedValue({ ok: true });
    if (failure === "refused") bindTab.mockResolvedValueOnce({ ok: false, error: "guest-not-hosted" });
    else bindTab.mockRejectedValueOnce(new Error("disconnected"));
    const guest = Object.assign(document.createElement("webview"), { getWebContentsId: () => 31 });
    const unbind = bindGuestToTab({ browserTabs: { bindTab } } as unknown as AveApi, guest, "browser:early", "browser-op-early");
    try {
      await Promise.resolve();
      guest.dispatchEvent(new Event("dom-ready"));
      await Promise.resolve();
      expect(bindTab).toHaveBeenCalledTimes(2);
      expect(bindTab).toHaveBeenLastCalledWith({ tabId: "browser:early", webContentsId: 31, requestId: "browser-op-early" });
      guest.dispatchEvent(new Event("dom-ready"));
      await Promise.resolve();
      expect(bindTab).toHaveBeenCalledTimes(2);
    } finally {
      unbind();
    }
  });

  it("keeps a newer guest bound when an earlier bind is rejected", async () => {
    let rejectEarlier!: (result: { ok: false; error: string }) => void;
    const bindTab = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { rejectEarlier = resolve; }))
      .mockResolvedValue({ ok: true });
    let guestId = 31;
    const guest = Object.assign(document.createElement("webview"), { getWebContentsId: () => guestId });
    const unbind = bindGuestToTab({ browserTabs: { bindTab } } as unknown as AveApi, guest, "browser:early", "browser-op-early");
    try {
      guestId = 32;
      guest.dispatchEvent(new Event("did-attach"));
      await Promise.resolve();
      rejectEarlier({ ok: false, error: "guest-not-hosted" });
      await Promise.resolve();
      guest.dispatchEvent(new Event("dom-ready"));
      expect(bindTab).toHaveBeenCalledTimes(2);
      expect(bindTab).toHaveBeenLastCalledWith({ tabId: "browser:early", webContentsId: 32, requestId: "browser-op-early" });
    } finally {
      unbind();
    }
  });

  it("cancels an attach retry when dom-ready successfully binds the guest first", async () => {
    vi.useFakeTimers();
    const bindTab = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "guest-not-live" })
      .mockResolvedValue({ ok: true });
    const guest = Object.assign(document.createElement("webview"), { getWebContentsId: () => 31 });
    const unbind = bindGuestToTab({ browserTabs: { bindTab } } as unknown as AveApi, guest, "browser:early", undefined);
    try {
      await Promise.resolve();
      guest.dispatchEvent(new Event("dom-ready"));
      await Promise.resolve();
      expect(bindTab).toHaveBeenCalledTimes(2);
      await vi.runAllTimersAsync();
      expect(bindTab).toHaveBeenCalledTimes(2);
    } finally {
      unbind();
      vi.useRealTimers();
    }
  });
});

describe("routeBrowserTabOp", () => {
  it("focuses only the exact connected visible guest without selecting a different surface", () => {
    const guest = document.createElement("webview");
    const focus = vi.spyOn(guest, "focus");
    vi.spyOn(guest, "getBoundingClientRect").mockReturnValue({ width: 300, height: 200 } as DOMRect);
    document.body.append(guest);
    setWebSurfaceElement("browser:focus", guest);
    try {
      const candidate = host("s1", ["browser:focus"]);
      routeBrowserTabOp({ requestId: "f1", op: "focus", tabId: "browser:missing" }, [candidate]);
      expect(focus).not.toHaveBeenCalled();
      routeBrowserTabOp({ requestId: "f2", op: "focus", tabId: "browser:focus" }, [candidate]);
      expect(focus).toHaveBeenCalledOnce();
      guest.style.visibility = "hidden";
      routeBrowserTabOp({ requestId: "f3", op: "focus", tabId: "browser:focus" }, [candidate]);
      expect(focus).toHaveBeenCalledOnce();
      guest.style.visibility = "visible";
      guest.setAttribute("inert", "");
      routeBrowserTabOp({ requestId: "f4", op: "focus", tabId: "browser:focus" }, [candidate]);
      expect(focus).toHaveBeenCalledOnce();
      expect(candidate.calls).toEqual([]);
    } finally { setWebSurfaceElement("browser:focus", null); guest.remove(); }
  });
  it("opens beside the exact named conversation, and uses the first view only when none is named", () => {
    const first = host("s1", []);
    const second = host("s2", []);
    routeBrowserTabOp({ requestId: "r1", op: "new", url: "https://a.example/", sessionId: "s2", active: false }, [first, second]);
    routeBrowserTabOp({ requestId: "r2", op: "new", url: "https://b.example/", sessionId: "other", active: true }, [first, second]);
    routeBrowserTabOp({ requestId: "r3", op: "new", url: "https://c.example/", active: true }, [first, second]);
    expect(second.calls).toEqual(["new https://a.example/ r1 false"]);
    expect(first.calls).toEqual(["new https://c.example/ r3 true"]);
  });

  it("never opens the agent's new tab in a host that only holds tabs (the main area's web panels)", () => {
    const { openAgentTab: _unused, ...mainArea } = host(null, ["browser:7"]);
    const panels = mainArea as BrowserTabHost & { calls: string[] };
    const chat = host("s1", []);
    routeBrowserTabOp({ requestId: "r1", op: "new", url: "https://a.example/", active: false }, [panels, chat]);
    routeBrowserTabOp({ requestId: "r2", op: "select", tabId: "browser:7" }, [panels, chat]);
    expect(chat.calls).toEqual(["new https://a.example/ r1 false"]);
    expect(panels.calls).toEqual(["select browser:7"]);
  });

  it("selects or closes in the view that holds the tab, and nowhere else", () => {
    const first = host("s1", ["browser:1"]);
    const second = host("s2", ["browser:2"]);
    routeBrowserTabOp({ requestId: "r1", op: "select", tabId: "browser:2" }, [first, second]);
    routeBrowserTabOp({ requestId: "r2", op: "close", tabId: "browser:1" }, [first, second]);
    routeBrowserTabOp({ requestId: "r3", op: "close", tabId: "browser:9" }, [first, second]);
    expect(first.calls).toEqual(["close browser:1"]);
    expect(second.calls).toEqual(["select browser:2"]);
  });

  it("routes restore-focus to no store", () => {
    const a = host("s1", ["browser:0"]);
    routeBrowserTabOp({ requestId: "r9", op: "restore-focus", tabId: "browser:0" }, [a]);
    expect(a.calls).toEqual([]);
  });
});
