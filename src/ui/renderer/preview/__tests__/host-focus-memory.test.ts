// @vitest-environment jsdom
/** The agent holds a page's keyboard focus only while it acts: the renderer remembers where focus was in the app and gives
 * it back when main says the action is done, unless the user has already moved focus somewhere else. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTabRegistry } from "../../../../main/browser/browser-tab-registry.js";
import { HostFocusMemory } from "../agent-browser-bridge.js";

function setup() {
  document.body.innerHTML = `
    <textarea data-testid="composer"></textarea>
    <button data-testid="other">Other</button>
    <webview data-testid="page" tabindex="0"></webview>`;
  const memory = new HostFocusMemory(document);
  const detach = memory.attach();
  const get = (id: string) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ width: 100, height: 100 } as DOMRect);
    return element;
  };
  return { memory, detach, composer: get("composer") as HTMLTextAreaElement, other: get("other"), page: get("page") };
}

beforeEach(() => { vi.spyOn(window, "focus").mockImplementation(() => {}); });

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.body.removeAttribute("tabindex");
});

describe("HostFocusMemory", () => {
  it("gives focus back to the composer after the page took it", () => {
    const { memory, detach, composer, page } = setup();
    composer.focus();
    page.focus();
    expect(document.activeElement).toBe(page);
    memory.restore();
    expect(document.activeElement).toBe(composer);
    detach();
  });

  it("skips a remembered element that has gone (a closed approval card's button)", () => {
    const { memory, detach, composer, page } = setup();
    const cardButton = document.createElement("button");
    document.body.appendChild(cardButton);
    composer.focus();
    cardButton.focus();
    page.focus();
    cardButton.remove();
    memory.restore();
    expect(document.activeElement).toBe(composer);
    detach();
  });

  it("leaves focus alone when the user already moved it off the page", () => {
    const { memory, detach, composer, other, page } = setup();
    composer.focus();
    page.focus();
    other.focus();
    memory.restore();
    expect(document.activeElement).toBe(other);
    detach();
  });

  it("does not remember the page itself, and drops focus when nothing remembered is usable", () => {
    const { memory, detach, composer, page } = setup();
    composer.focus();
    page.focus();
    composer.setAttribute("inert", "");
    memory.restore();
    expect(document.activeElement).not.toBe(page);
    expect(document.activeElement).not.toBe(composer);

    composer.removeAttribute("inert");
    composer.focus();
    page.focus();
    composer.remove();
    memory.restore();
    expect(document.activeElement).not.toBe(page);
    detach();
  });

  it("stops listening once detached", () => {
    const { memory, detach, composer, other, page } = setup();
    composer.focus();
    detach();
    other.focus();
    page.focus();
    memory.restore();
    expect(document.activeElement).toBe(composer);
  });
});


it.each(["composer", "user-page", "child-page"])("restores the exact prior target after visible native focus borrowing: %s", async prior => {
  const { memory, detach, composer, page, other } = setup();
  const previous = prior === "composer" ? composer : document.createElement("webview");
  previous.tabIndex = 0;
  if (prior !== "composer") Object.assign(previous, { getWebContentsId: () => prior === "user-page" ? 81 : 82 });
  if (previous !== composer) document.body.appendChild(previous);
  vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({ width: 100, height: 100 } as DOMRect);
  const registry = new BrowserTabRegistry();
  let url = "about:blank";
  const guest = { id: 71, isDestroyed: () => false, getURL: () => url, getTitle: () => "Page", isFocused: () => document.activeElement === page, focus: () => page.focus() };
  let requestId = "";
  registry.setRendererLink({ isWindowVisible: () => true, sendControl: () => {}, sendTabOp: (windowId, request) => {
    requestId = request.requestId;
    if (request.op === "focus") guest.focus();
    if (request.op === "capture-focus") registry.completeFocus(windowId, request.requestId, memory.capture(request.requestId, page));
    if (request.op === "restore-focus" && request.receiptId) registry.completeFocus(windowId, request.requestId, memory.restoreReceipt(request.receiptId, page, request.preserveFocus));
    return true;
  } });
  const opening = registry.requestTabOp(1, { op: "new", url: "https://a.example/", actor: { sessionId: "child" } });
  registry.guestAttached(guest, 1);
  registry.bindTab(1, { tabId: "background", webContentsId: 71, requestId });
  const opened = await opening;
  if (!opened.ok) throw new Error("Missing opened tab");
  url = "https://a.example/";
  const tab = registry.liveTabInWindow(opened.tabId, 1);
  if (!tab) throw new Error("Missing tab");
  registry.setActiveSurface(1, { kind: "browser", tabId: "background" });
  registry.setAgentTabAwake(71, true);
  for (const outcome of ["success", "cancel", "user-focus", "takeover"] as const) {
    const lease = registry.acquireControl(tab, { sessionId: "child" });
    composer.focus();
    previous.focus();
    try {
        await registry.focusGuest(71);
        expect(document.activeElement).toBe(page);
        if (outcome === "user-focus") other.focus();
        if (outcome === "takeover") { guest.focus(); registry.userInput(71, { type: "keyDown" }); }
        if (outcome === "cancel") registry.releaseControl(tab.handle, lease.id);
        await registry.releaseFocus(71, lease.id);
      expect(document.activeElement).toBe(outcome === "user-focus" ? other : outcome === "takeover" ? page : previous);
    } finally { registry.releaseControl(tab.handle, lease.id); if (outcome === "takeover") registry.resume(1, "background"); }
  }
  detach();
});


it.each(["hidden", "replaced", "wrong-borrower"])("refuses a focus receipt with a changed target: %s", change => {
  const { memory, detach, composer, page, other } = setup();
  let guestId = 91;
  const previous = document.createElement("webview");
  previous.tabIndex = 0;
  Object.assign(previous, { getWebContentsId: () => guestId });
  document.body.appendChild(previous);
  vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({ width: 100, height: 100 } as DOMRect);
  composer.focus(); previous.focus();
  expect(memory.capture("receipt", page)).toBe(true);
  page.focus();
  if (change === "hidden") previous.hidden = true;
  if (change === "replaced") guestId = 92;
  expect(memory.restoreReceipt("receipt", change === "wrong-borrower" ? other : page)).toBe(false);
  expect(document.activeElement).toBe(page);
  if (change === "wrong-borrower") expect(memory.restoreReceipt("receipt", page)).toBe(true);
  detach();
});

it.each(["body", "removed-approval", "disabled-approval"])("returns borrowed focus to the composer when the prior host target is %s", previousKind => {
  const { memory, detach, composer, page } = setup();
  composer.focus();
  let previous: HTMLElement;
  if (previousKind === "body") {
    composer.blur();
    previous = document.body;
  } else {
    previous = document.createElement("button");
    document.body.appendChild(previous);
    previous.focus();
  }
  vi.spyOn(previous, "getBoundingClientRect").mockReturnValue({ width: 100, height: 100 } as DOMRect);
  expect(memory.capture("visible-action", page)).toBe(true);
  page.focus();
  if (previousKind === "removed-approval") previous.remove();
  if (previousKind === "disabled-approval") previous.setAttribute("disabled", "");
  expect(memory.restoreReceipt("visible-action", page)).toBe(true);
  expect(document.activeElement).toBe(composer);
  detach();
});

it("restores remembered host focus after both the borrowing page and approval are removed", () => {
  const { memory, detach, composer, page, other } = setup();
  composer.focus();
  other.focus();
  expect(memory.capture("closed-action", page)).toBe(true);
  page.focus();
  other.remove();
  page.remove();
  expect(memory.restoreReceipt("closed-action", null)).toBe(true);
  expect(document.activeElement).toBe(composer);
  detach();
});


it("retires a disconnected borrowing guest receipt before the next action", () => {
  const { memory, detach, composer, page } = setup();
  vi.spyOn(composer, "getBoundingClientRect").mockReturnValue({ width: 100, height: 100 } as DOMRect);
  const replacement = document.createElement("webview"); replacement.tabIndex = 0;
  document.body.appendChild(replacement);
  composer.focus();
  expect(memory.capture("old-action", page)).toBe(true);
  page.focus(); page.remove();
  expect(memory.restoreReceipt("old-action", replacement)).toBe(false);
  composer.focus();
  expect(memory.capture("new-action", replacement)).toBe(true);
  replacement.focus();
  expect(memory.restoreReceipt("new-action", replacement)).toBe(true);
  expect(document.activeElement).toBe(composer);
  detach();
});

it.each(["rename", "queued-editor"])("keeps the active %s draft without DOM blur or refocus", kind => {
  const { memory, detach, composer, page } = setup();
  composer.value = "unfinished draft";
  composer.focus();
  const onBlur = vi.fn(() => { if (kind === "rename") composer.remove(); });
  composer.addEventListener("blur", onBlur);
  const focus = vi.spyOn(composer, "focus");
  memory.restore(page);
  expect(onBlur).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(composer.value).toBe("unfinished draft");
  expect(document.activeElement).toBe(composer);
  detach();
});

it("does not invoke an editor blur handler that would move focus", () => {
  const { memory, detach, composer, other, page } = setup();
  composer.focus();
  const onBlur = vi.fn(() => other.focus());
  composer.addEventListener("blur", onBlur);
  memory.restore(page);
  expect(onBlur).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(composer);
  detach();
});

it("keeps focus moved synchronously during the frame handoff", () => {
  const { memory, detach, composer, other, page } = setup();
  composer.focus();
  vi.mocked(window.focus).mockImplementation(() => other.focus());
  memory.restore(page);
  expect(document.activeElement).toBe(other);
  detach();
});

it("leaves focus untouched when the host window has lost foreground focus", () => {
  const { memory, detach, composer, page } = setup();
  composer.focus();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const blur = vi.spyOn(composer, "blur");
  const focus = vi.spyOn(composer, "focus");
  memory.restore(page);
  expect(window.focus).not.toHaveBeenCalled();
  expect(blur).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(composer);
  detach();
});

it("returns to the selected visible guest through its frame without blurring its DOM element", () => {
  const { memory, detach, page } = setup();
  const visibleGuest = document.createElement("webview");
  visibleGuest.tabIndex = 0;
  const frame = document.createElement("iframe");
  document.body.append(frame, visibleGuest);
  const root = document.createElement("div").attachShadow({ mode: "open" });
  vi.spyOn(root, "querySelector").mockReturnValue(frame);
  vi.spyOn(visibleGuest, "shadowRoot", "get").mockReturnValue(root);
  visibleGuest.focus();
  if (!frame.contentWindow) throw new Error("Missing frame window");
  const nativeFocus = vi.spyOn(frame.contentWindow, "focus").mockImplementation(() => {});
  const blur = vi.spyOn(visibleGuest, "blur");
  const focus = vi.spyOn(visibleGuest, "focus");
  memory.restore(page);
  expect(nativeFocus).toHaveBeenCalledOnce();
  expect(blur).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(visibleGuest);
  detach();
});

it("uses remembered controls only when no editor is active", () => {
  const { memory, detach, composer, page } = setup();
  composer.focus();
  composer.blur();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const focus = vi.spyOn(composer, "focus");
  memory.restore(page);
  expect(focus).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(document.activeElement).toBe(composer);
  detach();
});

it("does not activate the native frame if a fallback callback yields foreground focus", () => {
  const { memory, detach, composer, page } = setup();
  composer.focus();
  composer.blur();
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  composer.addEventListener("focus", () => { focused.mockReturnValue(false); });
  memory.restore(page);
  expect(document.activeElement).toBe(composer);
  expect(window.focus).not.toHaveBeenCalled();
  detach();
});

it("preserves editing in the current child frame without focusing its DOM element", () => {
  const { memory, detach, page } = setup();
  const editorFrame = document.createElement("iframe");
  document.body.append(editorFrame);
  editorFrame.focus();
  if (!editorFrame.contentWindow) throw new Error("Missing editor frame");
  const nativeFocus = vi.spyOn(editorFrame.contentWindow, "focus").mockImplementation(() => {});
  const domFocus = vi.spyOn(editorFrame, "focus");
  const blur = vi.spyOn(editorFrame, "blur");
  memory.restore(page);
  expect(nativeFocus).toHaveBeenCalledOnce();
  expect(domFocus).not.toHaveBeenCalled();
  expect(blur).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editorFrame);
  detach();
});

it("returns a parked page to the host frame without blurring its DOM element", () => {
  const { memory, detach, page } = setup();
  page.focus();
  const blur = vi.spyOn(page, "blur");
  const focus = vi.spyOn(page, "focus");
  memory.restore(page);
  expect(window.focus).toHaveBeenCalledOnce();
  expect(blur).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  detach();
});

it("keeps a fallback callback that deliberately returns focus to the body", () => {
  const { memory, detach, composer, other, page } = setup();
  document.body.tabIndex = -1;
  other.focus();
  composer.focus();
  composer.blur();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  composer.addEventListener("focus", () => document.body.focus());
  memory.restore(page);
  expect(document.activeElement).toBe(document.body);
  document.body.removeAttribute("tabindex");
  detach();
});
