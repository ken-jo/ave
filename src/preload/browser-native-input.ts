import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import { BROWSER_NATIVE_HOLE_ATTRIBUTE, parseBrowserNativeInput, parseBrowserNativeInputState, type BrowserNativeInput, type BrowserNativeInputModifier } from "../shared/browser-native-input.js";

type PageIdentity = Pick<BrowserNativeInput, "tabId" | "webContentsId" | "epoch">;

/** Only real pointer events over the native page hole leave the host document. */
export function installBrowserNativeInput(document: Document = globalThis.document): () => void {
  let gesture: (PageIdentity & { sequence: number }) | null = null;
  let hover: PageIdentity | null = null;
  let nextSequence = 0;
  const matches = (a: PageIdentity, b: PageIdentity) => a.tabId === b.tabId && a.webContentsId === b.webContentsId && a.epoch === b.epoch;
  const identityAt = (x: number, y: number): PageIdentity | null => {
    const hole = document.elementFromPoint(x, y)?.closest(`[${BROWSER_NATIVE_HOLE_ATTRIBUTE}]`);
    const value = hole?.getAttribute(BROWSER_NATIVE_HOLE_ATTRIBUTE);
    if (!value) return null;
    try {
      const identity: unknown = JSON.parse(value);
      if (!identity || typeof identity !== "object") return null;
      const parsed = parseBrowserNativeInput({ ...identity, sequence: 1, type: "mouseMove", x, y, button: "left", clickCount: 0, modifiers: [] });
      return parsed ? { tabId: parsed.tabId, webContentsId: parsed.webContentsId, epoch: parsed.epoch } : null;
    } catch { return null; }
  };
  const modifiersFor = (event: MouseEvent): BrowserNativeInputModifier[] => {
    const modifiers: BrowserNativeInputModifier[] = [];
    if (event.shiftKey) modifiers.push("shift");
    if (event.ctrlKey) modifiers.push("control");
    if (event.altKey) modifiers.push("alt");
    if (event.metaKey) modifiers.push("meta");
    if (event.buttons & 1) modifiers.push("leftbuttondown");
    if (event.buttons & 4) modifiers.push("middlebuttondown");
    if (event.buttons & 2) modifiers.push("rightbuttondown");
    return modifiers;
  };
  const forward = (event: MouseEvent | WheelEvent): void => {
    if (!event.isTrusted) return;
    if (event.type === "mousemove" && event.buttons === 0) gesture = null;
    if (event.type === "mousedown") gesture = null;
    const hit = identityAt(event.clientX, event.clientY);
    if (!gesture && hover && (!hit || !matches(hover, hit))) {
      ipcRenderer.send(CHANNELS.browser.nativeInput, { ...hover, sequence: ++nextSequence, type: "mouseLeave", x: event.clientX,
        y: event.clientY, button: "left", clickCount: 0, modifiers: [] } satisfies BrowserNativeInput);
      hover = null;
    }
    if (hit) hover = hit;
    // A tab or resize drag that began in app UI never becomes a page gesture.
    if (!gesture && (event.type === "mouseup" || event.type === "mousemove" && event.buttons !== 0)) return;
    const identity = event.type === "wheel" || event.type === "mousedown" ? hit : gesture ?? hit;
    if (!identity) return;
    const type = event.type === "mousedown" ? "mouseDown" : event.type === "mouseup" ? "mouseUp" : event.type === "wheel" ? "mouseWheel" : "mouseMove";
    const button = event.button === 1 ? "middle" : event.button === 2 ? "right" : "left";
    const wheel = event as WheelEvent;
    const unit = event.type !== "wheel" || wheel.deltaMode === 0 ? 1 : wheel.deltaMode === 1 ? 16 : document.documentElement.clientHeight;
    const input = parseBrowserNativeInput({
      ...identity, sequence: ++nextSequence, type, x: event.clientX, y: event.clientY, button,
      clickCount: Math.min(3, Math.max(0, event.detail)), modifiers: modifiersFor(event),
      ...(type === "mouseWheel" ? { deltaX: -wheel.deltaX * unit, deltaY: -wheel.deltaY * unit } : {}),
    });
    if (!input) return;
    if (type === "mouseDown") gesture = { ...identity, sequence: input.sequence };
    if (type === "mouseUp" && event.buttons === 0) gesture = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send(CHANNELS.browser.nativeInput, input);
  };
  const contextMenu = (event: MouseEvent): void => {
    if (!event.isTrusted || !identityAt(event.clientX, event.clientY)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const leaveDocument = (event: MouseEvent): void => {
    if (!event.isTrusted || !hover) return;
    ipcRenderer.send(CHANNELS.browser.nativeInput, { ...hover, sequence: ++nextSequence, type: "mouseLeave", x: event.clientX,
      y: event.clientY, button: "left", clickCount: 0, modifiers: modifiersFor(event) } satisfies BrowserNativeInput);
    hover = null;
  };
  const options = { capture: true, passive: false };
  const inputState = (_event: unknown, value: unknown): void => {
    const state = parseBrowserNativeInputState(value);
    if (!state) throw new Error("invalid-native-browser-input-state");
    if (state.type === "cancel") {
      if (gesture && matches(gesture, state) && gesture.sequence === state.sequence) gesture = null;
      if (hover && matches(hover, state)) hover = null;
      return;
    }
    for (const element of document.querySelectorAll<HTMLElement>(`[${BROWSER_NATIVE_HOLE_ATTRIBUTE}]`)) {
      const raw = element.getAttribute(BROWSER_NATIVE_HOLE_ATTRIBUTE);
      if (!raw) continue;
      try {
        const identity: PageIdentity = JSON.parse(raw);
        if (matches(identity, state)) element.style.cursor = state.type === "cursor" ? state.cursor
          : `url("${state.dataUrl}") ${state.hotspot.x} ${state.hotspot.y}, auto`;
      } catch { /* A retired sentinel can lose its identity during delivery. */ }
    }
  };
  for (const name of ["mousedown", "mouseup", "mousemove", "wheel"] as const) document.addEventListener(name, forward, options);
  document.addEventListener("contextmenu", contextMenu, options);
  document.addEventListener("mouseleave", leaveDocument, options);
  ipcRenderer.on(CHANNELS.browser.nativeInputState, inputState);
  return () => {
    for (const name of ["mousedown", "mouseup", "mousemove", "wheel"] as const) document.removeEventListener(name, forward, options);
    document.removeEventListener("contextmenu", contextMenu, options);
    document.removeEventListener("mouseleave", leaveDocument, options);
    ipcRenderer.removeListener(CHANNELS.browser.nativeInputState, inputState);
    gesture = null;
  };
}
