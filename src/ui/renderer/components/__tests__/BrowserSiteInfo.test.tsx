// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceApi, BrowserWorkspaceState } from "../../../../shared/browser-workspace.js";
import { __setBrowserPageStatusForTest } from "../../preview/browser-page-status.js";
import { BrowserSiteInfo } from "../BrowserSiteInfo.js";

vi.mock("../../../../i18n/react.js", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const TAB = "browser:one";
function state(url: string, fullscreen = false): BrowserWorkspaceState {
  return {
    revision: 1, bookmarks: [], history: [], downloads: [], storageStatus: "ready", capabilities: { fullscreen },
    sitePermissions: [{ origin: "https://a.example", permission: "camera", decision: "block" }, { origin: "https://b.example", permission: "microphone", decision: "allow" }],
    tabs: [{ tabId: TAB, documentGeneration: 4, url, title: "", zoomFactor: 1 }],
    pages: [{ tabId: TAB, loading: false, loadError: null, prompts: [] }],
  };
}
function mount(grant: "this-site" | "any-site" | null) {
  const api = {
    agentSiteGrant: vi.fn(async () => ({ ok: true, value: { grant } })),
    revokeAgentSiteGrant: vi.fn(async () => ({ ok: true, value: null })),
    clearSiteData: vi.fn(async () => ({ ok: true, value: null })),
    setSitePermission: vi.fn(async () => ({ ok: true, value: null })),
  };
  render(<BrowserSiteInfo api={api as unknown as BrowserWorkspaceApi} tabId={TAB} chrome="card" />);
  return api;
}
afterEach(() => { cleanup(); act(() => __setBrowserPageStatusForTest(null)); });

describe("site information", () => {
  it("shows a failed read of the agent's access as a failure, not as no access, and the next document reads it again", async () => {
    act(() => __setBrowserPageStatusForTest(state("https://a.example/")));
    const api = mount("this-site");
    api.agentSiteGrant.mockResolvedValueOnce({ ok: false, error: "stale-document" } as never);
    act(() => __setBrowserPageStatusForTest({ ...state("https://a.example/"), revision: 2, tabs: [{ tabId: TAB, documentGeneration: 5, url: "https://a.example/", title: "", zoomFactor: 1 }] }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("browser-site-info-agent")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("browserWorkspace.failed");
    act(() => __setBrowserPageStatusForTest({ ...state("https://a.example/"), revision: 3, tabs: [{ tabId: TAB, documentGeneration: 6, url: "https://a.example/", title: "", zoomFactor: 1 }] }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("browser-site-info-agent").getAttribute("data-grant")).toBe("this-site");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows the host's own facts for the site: its origin, an encrypted connection, this site's rules, and no fullscreen row the host cannot grant", async () => {
    act(() => __setBrowserPageStatusForTest(state("https://a.example/deep/page?x=1")));
    mount(null);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("browser-site-info-origin").textContent).toBe("https://a.example");
    expect(screen.getByTestId("browser-site-info-connection").getAttribute("data-secure")).toBe("true");
    expect((screen.getByTestId("browser-site-info-permission-camera") as HTMLSelectElement).value).toBe("block");
    // The other site's rule does not leak into this one.
    expect((screen.getByTestId("browser-site-info-permission-microphone") as HTMLSelectElement).value).toBe("ask");
    expect(screen.queryByTestId("browser-site-info-permission-fullscreen")).toBeNull();
    expect(screen.getByTestId("browser-site-info-agent").getAttribute("data-grant")).toBe("none");
    expect(screen.queryByTestId("browser-site-info-revoke")).toBeNull();
  });
  it("says a plain HTTP connection is not encrypted, and changes a rule and clears data for exactly this site and document", async () => {
    act(() => __setBrowserPageStatusForTest(state("http://a.example/", true)));
    const api = mount(null);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("browser-site-info-connection").getAttribute("data-secure")).toBe("false");
    expect(screen.getByTestId("browser-site-info-connection").textContent).toBe("browserSiteInfo.notSecure");
    expect(screen.getByTestId("browser-site-info-permission-fullscreen")).toBeTruthy();
    await act(async () => { fireEvent.change(screen.getByTestId("browser-site-info-permission-camera"), { target: { value: "allow" } }); });
    expect(api.setSitePermission).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 4, origin: "http://a.example", permission: "camera", decision: "allow" });
    await act(async () => { fireEvent.click(screen.getByTestId("browser-site-info-clear")); });
    expect(api.clearSiteData).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 4, origin: "http://a.example" });
    expect(screen.getByTestId("browser-site-info-cleared")).toBeTruthy();
  });
  it("shows what the agent may open here and takes it back", async () => {
    act(() => __setBrowserPageStatusForTest(state("https://a.example/")));
    const api = mount("any-site");
    await act(async () => { await Promise.resolve(); });
    expect(api.agentSiteGrant).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 4, origin: "https://a.example" });
    expect(screen.getByTestId("browser-site-info-agent").textContent).toContain("browserSiteInfo.agentAny");
    await act(async () => { fireEvent.click(screen.getByTestId("browser-site-info-revoke")); });
    expect(api.revokeAgentSiteGrant).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 4, origin: "https://a.example" });
    expect(screen.getByTestId("browser-site-info-agent").getAttribute("data-grant")).toBe("none");
    expect(screen.queryByTestId("browser-site-info-revoke")).toBeNull();
  });
  it("says so when the tab shows no site", () => {
    act(() => __setBrowserPageStatusForTest(state("about:blank")));
    const api = mount(null);
    expect(screen.getByTestId("browser-site-info").textContent).toBe("browserSiteInfo.noSite");
    expect(api.agentSiteGrant).not.toHaveBeenCalled();
  });
});
