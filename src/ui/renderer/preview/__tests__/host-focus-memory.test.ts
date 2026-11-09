// @vitest-environment jsdom
/** The agent holds a page's keyboard focus only while it acts: the renderer remembers where focus was in the app and gives
 * it back when main says the action is done, unless the user has already moved focus somewhere else. */
import { afterEach, describe, expect, it, vi } from "vitest";
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
  return { memory, detach, composer: get("composer"), other: get("other"), page: get("page") };
}

afterEach(() => {
  document.body.innerHTML = "";
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

it("reasserts the current host control after a parked touch changes native frame focus without a DOM focus event", () => {
  const { memory, detach, composer, page } = setup();
  composer.focus();
  const blur = vi.spyOn(composer, "blur");
  const focus = vi.spyOn(composer, "focus");
  // The embedder still names the composer while the native focused frame belongs to its guest.
  memory.restore(page);
  expect(blur).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(document.activeElement).toBe(composer);
  detach();
});

it("preserves the selected visible guest when a parked guest returns native routing", () => {
  const { memory, detach, page } = setup();
  const visibleGuest = document.createElement("webview");
  visibleGuest.tabIndex = 0;
  const frame = document.createElement("iframe");
  const root = document.createElement("div").attachShadow({ mode: "open" });
  root.append(frame);
  vi.spyOn(visibleGuest, "shadowRoot", "get").mockReturnValue(root);
  document.body.append(visibleGuest);
  visibleGuest.focus();
  const focus = vi.spyOn(frame, "focus").mockImplementation(() => {});
  memory.restore(page);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(document.activeElement).toBe(visibleGuest);
  visibleGuest.remove();
  detach();
});
