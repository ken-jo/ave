// @vitest-environment jsdom
/** One address row serves every browser host, so each host's ids are run through the same behaviour. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import type { AveApi } from "../../types.js";
import { setWebSurfaceElement } from "../../preview/web-surfaces.js";
import { __setBrowserPageStatusForTest } from "../../preview/browser-page-status.js";
import type { BrowserWorkspaceState } from "../../../../shared/browser-workspace.js";
import { BrowserAddressRow, SIDE_PANEL_ADDRESS_ROW_TEST_IDS, WEB_PANEL_ADDRESS_ROW_TEST_IDS, type BrowserAddressRowTestIds } from "../BrowserAddressRow.js";

const TAB = "browser:row";

function guest(initialUrl: string) {
  const element = document.createElement("webview") as unknown as HTMLElement & Record<string, unknown>;
  let url = initialUrl;
  Object.assign(element, {
    getURL: () => url, getTitle: () => "Page", canGoBack: () => true, canGoForward: () => false,
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(),
  });
  return { element, move(next: string) { url = next; element.dispatchEvent(new Event("did-navigate")); } };
}

function mount(testIds: BrowserAddressRowTestIds, options: { fallbackUrl?: string | null; stopOk?: boolean } = {}) {
  const onNavigate = vi.fn();
  const api = {
    getSettings: vi.fn(async () => ({ webView: { addressSearchEngine: "duckduckgo" } })),
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    browserTabs: { stop: vi.fn(async () => ({ ok: options.stopOk ?? true })) },
    browserWorkspace: { stopLoad: vi.fn(async () => ({ ok: true, value: null })), load: vi.fn(async () => ({ ok: true, value: null })) },
  } as unknown as AveApi;
  render(<TooltipProvider><BrowserAddressRow api={api} tabId={TAB} chrome="card" testIds={testIds}
    fallbackUrl={options.fallbackUrl === undefined ? "https://a.example/start" : options.fallbackUrl} onNavigate={onNavigate} /></TooltipProvider>);
  return { api, onNavigate, address: () => screen.getByTestId(testIds.address) as HTMLInputElement };
}

afterEach(() => { act(() => { setWebSurfaceElement(TAB, null); __setBrowserPageStatusForTest(null); }); });

function pageState(loading: boolean): BrowserWorkspaceState {
  return {
    revision: 1, bookmarks: [], history: [], sitePermissions: [], downloads: [], storageStatus: "ready", capabilities: { fullscreen: false },
    tabs: [{ tabId: TAB, documentGeneration: 2, url: "https://a.example/start", title: "", zoomFactor: 1 }],
    pages: [{ tabId: TAB, loading, loadError: null }],
  };
}

describe.each([
  ["side panel", SIDE_PANEL_ADDRESS_ROW_TEST_IDS],
  ["web pane", WEB_PANEL_ADDRESS_ROW_TEST_IDS],
])("BrowserAddressRow in the %s", (_host, ids) => {
  it("keeps what the user is typing when the page reports a new address, and restores the real one on Escape", () => {
    const page = guest("https://a.example/start");
    act(() => setWebSurfaceElement(TAB, page.element));
    const { address } = mount(ids);
    expect(address().value).toBe("https://a.example/start");
    address().focus();
    fireEvent.change(address(), { target: { value: "half typed" } });
    act(() => page.move("https://a.example/redirected"));
    expect(address().value).toBe("half typed");
    fireEvent.keyDown(address(), { key: "Escape" });
    expect(address().value).toBe("https://a.example/redirected");
  });

  it("drops the draft when focus leaves the field for the page", () => {
    const page = guest("https://a.example/start");
    act(() => setWebSurfaceElement(TAB, page.element));
    const { address } = mount(ids);
    address().focus();
    fireEvent.change(address(), { target: { value: "abandoned" } });
    fireEvent.blur(address(), { relatedTarget: document.body });
    expect(address().value).toBe("https://a.example/start");
  });

  it("submits with Go, taking the tab back before it navigates", async () => {
    const { api, onNavigate, address } = mount(ids);
    fireEvent.change(address(), { target: { value: "localhost:3000" } });
    await act(async () => { fireEvent.click(screen.getByTestId(ids.go)); });
    expect(api.browserTabs?.stop).toHaveBeenCalledWith(TAB);
    expect(onNavigate).toHaveBeenCalledWith("http://localhost:3000/");
    expect(address().value).toBe("http://localhost:3000/");
  });

  it("does not navigate when the takeover is refused", async () => {
    const { onNavigate, address } = mount(ids, { stopOk: false });
    fireEvent.change(address(), { target: { value: "example.com" } });
    await act(async () => { fireEvent.submit(address().closest("form") as HTMLFormElement); });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("reports a refused address under the row and clears the report on the next edit", async () => {
    const { onNavigate, address } = mount(ids);
    fireEvent.change(address(), { target: { value: "https://bad host/" } });
    await act(async () => { fireEvent.submit(address().closest("form") as HTMLFormElement); });
    expect(screen.getByTestId(ids.error)).toHaveAttribute("role", "alert");
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.change(address(), { target: { value: "https://good.example/" } });
    expect(screen.queryByTestId(ids.error)).toBeNull();
  });

  it("drives back and reload on the page itself and shows an empty bootstrap page as no address", () => {
    const page = guest("about:blank");
    act(() => setWebSurfaceElement(TAB, page.element));
    const { address } = mount(ids, { fallbackUrl: null });
    expect(address().value).toBe("");
    expect(screen.getByTestId(ids.reload)).toBeDisabled();
    expect(screen.getByTestId(ids.openExternal)).toBeDisabled();
    act(() => page.move("https://a.example/loaded"));
    expect(screen.getByTestId(ids.forward)).toBeDisabled();
    expect(screen.getByTestId(ids.back)).toBeEnabled();
    expect(screen.getByTestId(ids.openExternal)).toBeEnabled();
  });

  it("turns reload into stop and shows the loading line while the page loads", async () => {
    const page = guest("https://a.example/start");
    act(() => setWebSurfaceElement(TAB, page.element));
    const { api } = mount(ids);
    expect(screen.getByTestId(ids.reload)).toBeEnabled();
    expect(screen.queryByTestId("browser-loading-line")).toBeNull();

    act(() => __setBrowserPageStatusForTest(pageState(true), api));
    expect(screen.queryByTestId(ids.reload)).toBeNull();
    expect(screen.getByTestId("browser-loading-line")).toHaveAttribute("role", "progressbar");
    await act(async () => { fireEvent.click(screen.getByTestId(ids.stop)); });
    expect(api.browserTabs?.stop).toHaveBeenCalledWith(TAB);
    expect(api.browserWorkspace?.stopLoad).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 2 });

    act(() => __setBrowserPageStatusForTest(pageState(false), api));
    expect(screen.queryByTestId(ids.stop)).toBeNull();
    expect(screen.getByTestId(ids.reload)).toBeEnabled();
    expect(screen.queryByTestId("browser-loading-line")).toBeNull();
  });

  it("loads the page again when the user enters the address the tab is already pointed at", async () => {
    const { api, onNavigate, address } = mount(ids);
    act(() => __setBrowserPageStatusForTest(pageState(false), api));
    fireEvent.change(address(), { target: { value: "https://a.example/start" } });
    await act(async () => { fireEvent.submit(address().closest("form") as HTMLFormElement); });
    expect(onNavigate).toHaveBeenCalledWith("https://a.example/start");
    expect(api.browserWorkspace?.load).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 2, url: "https://a.example/start" });
    fireEvent.change(address(), { target: { value: "https://a.example/other" } });
    await act(async () => { fireEvent.submit(address().closest("form") as HTMLFormElement); });
    expect(api.browserWorkspace?.load).toHaveBeenCalledOnce();
  });
});
