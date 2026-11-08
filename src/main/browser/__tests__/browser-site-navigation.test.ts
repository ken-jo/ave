import { describe, expect, it, vi } from "vitest";
import { gateBrowserSiteNavigation } from "../browser-site-navigation.js";
import type { CdpSession } from "../browser-action-guard.js";

function navigation() {
  let event: (method: string, params: Record<string, unknown>) => void = () => {};
  const send = vi.fn(async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {});
  const cdp: CdpSession = { send, onEvent: (listener) => { event = listener; return () => { event = () => {}; }; } };
  const paused = (id: string, url: string, frameId = "main") => event("Fetch.requestPaused", { requestId: id, frameId, resourceType: "Document", request: { url, method: "POST", postData: "unchanged" } });
  return { cdp, send, paused };
}

describe("browser site navigation admission", () => {
  it("holds click and submit navigation until consent without replaying the request", async () => {
    const n = navigation();
    let allow = () => {};
    const authorize = vi.fn(() => new Promise<void>((resolve) => { allow = resolve; }));
    const stop = await gateBrowserSiteNavigation(n.cdp, "main", { active: () => true, authorize });
    n.paused("click", "https://other.example/path");
    expect(authorize).toHaveBeenCalledWith("https://other.example/path");
    expect(n.send).not.toHaveBeenCalledWith("Fetch.continueRequest", expect.anything());
    allow();
    await vi.waitFor(() => expect(n.send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "click" }));
    stop();
  });
  it("checks every redirect hop and refuses denied and non-web destinations", async () => {
    const n = navigation();
    const authorize = vi.fn(async (url: string) => { if (url.includes("denied")) throw new Error("denied"); });
    const stop = await gateBrowserSiteNavigation(n.cdp, "main", { active: () => true, authorize });
    n.paused("first", "https://first.example");
    n.paused("redirect", "https://denied.example");
    n.paused("scheme", "file:///example");
    await vi.waitFor(() => expect(n.send).toHaveBeenCalledWith("Fetch.failRequest", { requestId: "redirect", errorReason: "Aborted" }));
    expect(n.send).toHaveBeenCalledWith("Fetch.failRequest", { requestId: "scheme", errorReason: "Aborted" });
    expect(authorize.mock.calls).toEqual([["https://first.example"], ["https://denied.example"]]);
    stop();
  });
  it("refuses an unknown document frame instead of treating it as a subframe", async () => {
    const n = navigation();
    const authorize = vi.fn(async () => {});
    const stop = await gateBrowserSiteNavigation(n.cdp, "main", { active: () => true, authorize });
    n.paused("unknown", "https://other.example", "unknown-frame");
    await vi.waitFor(() => expect(n.send).toHaveBeenCalledWith("Fetch.failRequest", { requestId: "unknown", errorReason: "Aborted" }));
    expect(authorize).not.toHaveBeenCalled();
    stop();
  });

  it("denies a pending answer after takeover or cancellation", async () => {
    const n = navigation();
    let active = true;
    let allow = () => {};
    const stop = await gateBrowserSiteNavigation(n.cdp, "main", { active: () => active, authorize: () => new Promise<void>((resolve) => { allow = resolve; }) });
    n.paused("pending", "https://other.example");
    active = false;
    allow();
    await vi.waitFor(() => expect(n.send).toHaveBeenCalledWith("Fetch.failRequest", { requestId: "pending", errorReason: "Aborted" }));
    expect(n.send).not.toHaveBeenCalledWith("Fetch.continueRequest", expect.anything());
    stop();
  });
});
