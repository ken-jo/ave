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
    browserWorkspace: { stopLoad: vi.fn(async () => ({ ok: true, value: null })), load: vi.fn(async () => ({ ok: true, value: null })), answerPrompt: vi.fn(async () => ({ ok: true, value: null })), userNavigation: vi.fn(async () => ({ ok: true, value: null })), zoom: vi.fn(async () => ({ ok: true, value: null })) },
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
    pages: [{ tabId: TAB, loading, loadError: null, prompts: [] }],
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

  it("draws the page's permission question under the row with the host's origin and sends the chosen answer", () => {
    const { api } = mount(ids);
    expect(screen.queryByTestId("browser-page-prompt")).toBeNull();
    const state = pageState(false);
    const prompts = [
      { id: "prompt-4", kind: "permission" as const, origin: "https://a.example", permissions: ["geolocation" as const] },
      { id: "prompt-5", kind: "permission" as const, origin: "https://a.example", permissions: ["camera" as const] },
    ];
    act(() => __setBrowserPageStatusForTest({ ...state, pages: [{ tabId: TAB, loading: false, loadError: null, prompts }] }, api));
    expect(screen.getAllByTestId("browser-page-prompt")).toHaveLength(1);
    expect(screen.getByTestId("browser-page-prompt-origin").textContent).toBe("https://a.example");
    expect(screen.getByTestId("browser-page-prompt").textContent).toContain("위치");
    fireEvent.click(screen.getByTestId("browser-page-prompt-always-block"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenCalledWith({ tabId: TAB, promptId: "prompt-4", answer: { kind: "permission", choice: "always-block" } });
    fireEvent.click(screen.getByTestId("browser-page-prompt-block"));
    fireEvent.click(screen.getByTestId("browser-page-prompt-allow-once"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenCalledTimes(3);
  });

  it("tells main the unload is the user's before a page with a document navigates, and asks nothing of the user", async () => {
    const page = guest("https://a.example/start");
    act(() => setWebSurfaceElement(TAB, page.element));
    const { api, onNavigate, address } = mount(ids);
    act(() => __setBrowserPageStatusForTest(pageState(false), api));
    const order: string[] = [];
    vi.mocked(api.browserWorkspace?.userNavigation as never as () => Promise<unknown>).mockImplementation(async () => { order.push("mark"); return { ok: true, value: null }; });
    onNavigate.mockImplementation(() => { order.push("navigate"); });
    fireEvent.change(address(), { target: { value: "https://b.example/" } });
    await act(async () => { fireEvent.submit(address().closest("form") as HTMLFormElement); });
    expect(api.browserWorkspace?.userNavigation).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 2 });
    expect(order).toEqual(["mark", "navigate"]);
    await act(async () => { fireEvent.click(screen.getByTestId(ids.back)); });
    expect(api.browserWorkspace?.userNavigation).toHaveBeenCalledTimes(2);
    expect(page.element.goBack).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("browser-page-prompt")).toBeNull();
  });

  it("asks Leave or Stay in the tab for a navigation the page started", () => {
    const { api } = mount(ids);
    act(() => __setBrowserPageStatusForTest({ ...pageState(false), pages: [{ tabId: TAB, loading: false, loadError: null,
      prompts: [{ id: "prompt-9", kind: "leave", origin: "https://a.example" }] }] }, api));
    expect(screen.getByTestId("browser-page-prompt")).toHaveAttribute("data-kind", "leave");
    fireEvent.click(screen.getByTestId("browser-page-prompt-stay"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenCalledWith({ tabId: TAB, promptId: "prompt-9", answer: { kind: "leave", leave: false } });
    fireEvent.click(screen.getByTestId("browser-page-prompt-leave"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenLastCalledWith({ tabId: TAB, promptId: "prompt-9", answer: { kind: "leave", leave: true } });
  });

  it("returns to the page's real address when a load ends without becoming the page, and shows a failed address", async () => {
    const page = guest("https://a.example/start");
    act(() => setWebSurfaceElement(TAB, page.element));
    const { api, address } = mount(ids);
    act(() => __setBrowserPageStatusForTest(pageState(false), api));
    fireEvent.change(address(), { target: { value: "https://b.example/file.zip" } });
    await act(async () => { fireEvent.submit(address().closest("form") as HTMLFormElement); });
    expect(address().value).toBe("https://b.example/file.zip");
    act(() => __setBrowserPageStatusForTest({ ...pageState(true), revision: 2 }, api));
    act(() => __setBrowserPageStatusForTest({ ...pageState(false), revision: 3 }, api));
    expect(address().value).toBe("https://a.example/start");

    act(() => __setBrowserPageStatusForTest({ ...pageState(false), revision: 4, pages: [{ tabId: TAB, loading: false, prompts: [],
      loadError: { reason: "dns", code: -105, detail: "ERR_NAME_NOT_RESOLVED", url: "https://missing.invalid/" } }] }, api));
    expect(address().value).toBe("https://missing.invalid/");
  });

  it("offers Open for a mail link with its address as text, and only Dismiss for a link the app cannot open", () => {
    const { api } = mount(ids);
    const show = (prompt: object) => act(() => __setBrowserPageStatusForTest({ ...pageState(false), pages: [{ tabId: TAB, loading: false, loadError: null, prompts: [prompt as never] }] }, api));
    show({ id: "prompt-2", kind: "external", origin: "https://a.example", scheme: "mailto", target: "<b>someone@example.com</b>", openable: true });
    expect(screen.getByTestId("browser-page-prompt-target").textContent).toBe(" <b>someone@example.com</b>");
    fireEvent.click(screen.getByTestId("browser-page-prompt-open"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenCalledWith({ tabId: TAB, promptId: "prompt-2", answer: { kind: "external", open: true } });
    show({ id: "prompt-3", kind: "external", origin: "https://a.example", scheme: "ms-settings", target: "", openable: false });
    expect(screen.queryByTestId("browser-page-prompt-open")).toBeNull();
    expect(screen.getByTestId("browser-page-prompt").textContent).toContain("ms-settings:");
    fireEvent.click(screen.getByTestId("browser-page-prompt-dismiss"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenLastCalledWith({ tabId: TAB, promptId: "prompt-3", answer: { kind: "external", open: false } });
  });

  it("collects a user name and password for the origin main named, and forgets them with the prompt", () => {
    const { api } = mount(ids);
    const show = (id: string) => act(() => __setBrowserPageStatusForTest({ ...pageState(false), pages: [{ tabId: TAB, loading: false, loadError: null,
      prompts: [{ id, kind: "signIn", origin: "https://files.example:8443", realm: "<i>Staff</i>" }] }] }, api));
    show("prompt-6");
    expect(screen.getByTestId("browser-page-prompt-origin").textContent).toBe("https://files.example:8443");
    expect(screen.getByTestId("browser-page-prompt-realm").textContent).toContain("<i>Staff</i>");
    const password = screen.getByTestId("browser-page-prompt-password") as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.change(screen.getByTestId("browser-page-prompt-username"), { target: { value: "ken" } });
    fireEvent.change(password, { target: { value: "secret" } });
    fireEvent.submit(screen.getByTestId("browser-page-prompt-sign-in"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenCalledWith({ tabId: TAB, promptId: "prompt-6", answer: { kind: "signIn", credentials: { username: "ken", password: "secret" } } });
    show("prompt-7");
    expect((screen.getByTestId("browser-page-prompt-password") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByTestId("browser-page-prompt-sign-in-cancel"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenLastCalledWith({ tabId: TAB, promptId: "prompt-7", answer: { kind: "signIn", credentials: null } });
  });

  it("shows a page dialog's text as plain text under the origin and sends the user's choice", () => {
    const { api } = mount(ids);
    const show = (prompt: object) => act(() => __setBrowserPageStatusForTest({ ...pageState(false), pages: [{ tabId: TAB, loading: false, loadError: null, prompts: [prompt as never] }] }, api));
    const base = { kind: "dialog", origin: "https://a.example", canBlock: false };
    show({ ...base, id: "prompt-1", dialog: "alert", message: "<img src=x onerror=alert(1)>\nSaved" });
    expect(screen.getByTestId("browser-page-prompt-origin").textContent).toBe("https://a.example");
    expect(screen.getByTestId("browser-page-prompt-message").textContent).toBe("<img src=x onerror=alert(1)>\nSaved");
    expect(screen.getByTestId("browser-page-prompt-message").querySelector("img")).toBeNull();
    expect(screen.queryByTestId("browser-page-prompt-cancel")).toBeNull();
    expect(screen.queryByTestId("browser-page-prompt-block-dialogs")).toBeNull();
    fireEvent.click(screen.getByTestId("browser-page-prompt-ok"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenLastCalledWith({ tabId: TAB, promptId: "prompt-1", answer: { kind: "dialog", accept: true, block: false } });

    show({ ...base, id: "prompt-2", dialog: "confirm", message: "Delete?", canBlock: true });
    fireEvent.submit(screen.getByTestId("browser-page-prompt-dialog"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenLastCalledWith({ tabId: TAB, promptId: "prompt-2", answer: { kind: "dialog", accept: true, block: false } });
    fireEvent.click(screen.getByTestId("browser-page-prompt-cancel"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenLastCalledWith({ tabId: TAB, promptId: "prompt-2", answer: { kind: "dialog", accept: false, block: false } });
    fireEvent.click(screen.getByTestId("browser-page-prompt-block-dialogs"));
    expect(api.browserWorkspace?.answerPrompt).toHaveBeenLastCalledWith({ tabId: TAB, promptId: "prompt-2", answer: { kind: "dialog", accept: false, block: true } });
  });
});

describe("zoom in the address row", () => {
  it("shows the page's zoom, lists a level outside the presets as itself, and changes it with the document's proof", async () => {
    const { api } = mount(SIDE_PANEL_ADDRESS_ROW_TEST_IDS);
    expect(screen.queryByTestId("browser-zoom")).toBeNull();
    const state = pageState(false);
    const tab = state.tabs[0];
    if (!tab) throw new Error("the fixture has no tab");
    act(() => __setBrowserPageStatusForTest({ ...state, tabs: [{ ...tab, zoomFactor: 1.728 }] }));
    const select = screen.getByTestId("browser-zoom") as HTMLSelectElement;
    expect(select.value).toBe("1.728");
    expect(select.selectedOptions[0]?.textContent).toBe("173%");
    await act(async () => { fireEvent.change(select, { target: { value: "1.25" } }); });
    expect(api.browserWorkspace?.zoom).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 2, factor: 1.25 });
  });
});
