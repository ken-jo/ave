// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentObservationEvent, BrowserObservationEvent, BrowserObservationPreviewMessage } from "../../../../shared/agent-observation.js";
import type { AvePreviewApi } from "../../types.js";
import { connectBrowserObservations } from "../browser-observation-bridge.js";
import { BrowserObservationPreviewStore, isElementShown } from "../browser-observation-preview.js";
import { isHiddenWebSurfaceObserved } from "../web-surfaces.js";
import { BrowserObservationPreview } from "../BrowserObservationPreview.js";

const SESSION = "browser-session";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING = { targetId: TARGET, sessionId: SESSION, tabId: "tab-1" };
function action(seq: number, rendererTabId = "browser:1", tabId = "tab-1"): BrowserObservationEvent {
  return { source: "browser", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: "browser", hostSessionId: SESSION }, seq,
    ts: 1_700_000_000_000 + seq, kind: "action", before: null,
    after: { action: "click", tabId, rendererTabId, url: "https://example.test/", title: "Example" } };
}
function frame(number: number, binding = BINDING): BrowserObservationPreviewMessage & { kind: "frame" } {
  return { ...binding, kind: "frame", frame: number, mimeType: "image/jpeg", data: `frame${number}`, width: 640, height: 400, ts: number };
}

let emitEvents!: (events: AgentObservationEvent[]) => void;
let emitPreview!: (message: BrowserObservationPreviewMessage) => void;
let requests: ReturnType<typeof vi.fn>;
let disconnect: (() => void) | undefined;
let visible: boolean;
const probe = () => visible;

beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  requests = vi.fn(async () => ({ ok: true }));
  const api = {
    onAgentObservation: (handler: typeof emitEvents) => { emitEvents = handler; return () => {}; },
    acknowledgeObservation: async () => ({ ok: true }),
    onObservationPreview: (handler: typeof emitPreview) => { emitPreview = handler; return () => {}; },
    requestObservationPreview: requests,
  } as unknown as AvePreviewApi;
  disconnect = connectBrowserObservations(api);
});
afterEach(() => { cleanup(); disconnect?.(); disconnect = undefined; vi.useRealTimers(); });

function actions() { return requests.mock.calls.map(([request]) => request.action as string); }
function show() {
  return render(<BrowserObservationPreview tabId="browser:1" sessionId={SESSION} probe={probe}>
    <div data-testid="notice">open elsewhere</div>
  </BrowserObservationPreview>);
}

describe("agent browser live preview panel", () => {
  it("leaves the slot notice alone and requests nothing without an agent action on this tab", () => {
    show();
    act(() => emitEvents([action(1, "browser:other")]));
    expect(screen.getByTestId("notice")).toBeTruthy();
    expect(screen.queryByTestId("browser-observation-preview")).toBeNull();
    expect(requests).not.toHaveBeenCalled();
  });

  it("binds to the exact action target and tab handle, paints frames and acknowledges each painted frame", async () => {
    show();
    act(() => emitEvents([action(1)]));
    expect(requests).toHaveBeenCalledWith({ action: "start", ...BINDING, frame: 0 });
    act(() => emitPreview(frame(1)));
    const image = screen.getByRole("img") as HTMLImageElement;
    expect(image.src).toBe("data:image/jpeg;base64,frame1");
    expect(requests).toHaveBeenCalledTimes(1);
    fireEvent.load(image);
    expect(requests).toHaveBeenLastCalledWith({ action: "rendered", ...BINDING, frame: 1 });
    act(() => emitPreview({ ...BINDING, kind: "state", state: "updating" }));
    // The stale real frame stays, marked as updating.
    expect(screen.getByTestId("browser-observation-preview-updating")).toBeTruthy();
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe("data:image/jpeg;base64,frame1");
    act(() => emitPreview(frame(2)));
    expect(screen.queryByTestId("browser-observation-preview-updating")).toBeNull();
    // A frame for another tab handle never paints here.
    act(() => emitPreview(frame(3, { ...BINDING, tabId: "tab-2" })));
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe("data:image/jpeg;base64,frame2");
  });

  it("stops and drops the frame when the panel stays mounted but becomes invisible", async () => {
    show();
    act(() => emitEvents([action(1)]));
    act(() => emitPreview(frame(1)));
    expect(screen.getByRole("img")).toBeTruthy();
    visible = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    // Still mounted, no longer shown.
    expect(screen.getByTestId("browser-observation-preview")).toBeTruthy();
    expect(actions()).toEqual(["start", "stop"]);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("notice")).toBeTruthy();
    // Frames that still arrive after the stop are not retained.
    act(() => emitPreview(frame(2)));
    expect(screen.queryByRole("img")).toBeNull();
    visible = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(actions()).toEqual(["start", "stop", "start"]);
  });

  it("stops at once when the hosting panel reports itself hidden, even while its styles still paint", async () => {
    const view = render(<BrowserObservationPreview tabId="browser:1" sessionId={SESSION} probe={probe} active>
      <div data-testid="notice">open elsewhere</div>
    </BrowserObservationPreview>);
    act(() => emitEvents([action(1)]));
    act(() => emitPreview(frame(1)));
    expect(screen.getByRole("img")).toBeTruthy();
    view.rerender(<BrowserObservationPreview tabId="browser:1" sessionId={SESSION} probe={probe} active={false}>
      <div data-testid="notice">open elsewhere</div>
    </BrowserObservationPreview>);
    expect(actions()).toEqual(["start", "stop"]);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("never starts while the panel is hidden from the first paint", async () => {
    visible = false;
    show();
    act(() => emitEvents([action(1)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(requests).not.toHaveBeenCalled();
  });

  it("stops on unmount and resumes a parked preview on the next agent action", async () => {
    const view = show();
    act(() => emitEvents([action(1)]));
    act(() => emitPreview({ ...BINDING, kind: "state", state: "stopped" }));
    expect(screen.getByTestId("notice")).toBeTruthy();
    act(() => emitEvents([action(2)]));
    expect(actions()).toEqual(["start", "start"]);
    view.unmount();
    expect(actions()).toEqual(["start", "start", "stop"]);
  });
});

describe("agent browser preview retention", () => {
  it("keeps nothing for bindings no shown element requested and forgets a binding when it stops", () => {
    const api = { requestObservationPreview: vi.fn(async () => ({ ok: true })), onObservationPreview: () => () => {} };
    const store = new BrowserObservationPreviewStore(api as unknown as AvePreviewApi);
    store.accept(frame(1));
    expect(store.get(BINDING)).toBeUndefined();
    store.start(BINDING);
    store.accept(frame(1));
    expect(store.get(BINDING)?.frame?.frame).toBe(1);
    store.accept(frame(1));
    store.accept({ ...frame(2), mimeType: "image/png" } as unknown as BrowserObservationPreviewMessage);
    expect(store.get(BINDING)?.frame?.frame).toBe(1);
    store.stop(BINDING);
    expect(store.get(BINDING)).toBeUndefined();
  });
});

describe("panel visibility probe", () => {
  function element(parentStyle = "") {
    const parent = document.createElement("div");
    parent.setAttribute("style", parentStyle);
    const child = document.createElement("div");
    parent.append(child);
    document.body.append(parent);
    child.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 110, width: 200, height: 100, toJSON: () => ({}) });
    return { parent, child };
  }
  afterEach(() => { document.body.replaceChildren(); });

  it("counts a laid-out element in the viewport as shown", () => {
    expect(isElementShown(element().child)).toBe(true);
  });
  it.each(["display: none", "visibility: hidden", "opacity: 0"])("treats a mounted panel under %s as hidden", (style) => {
    expect(isElementShown(element(style).child)).toBe(false);
  });
  it("treats hidden ancestors, zero size, off-viewport placement and a hidden document as hidden", () => {
    const hidden = element();
    hidden.parent.hidden = true;
    expect(isElementShown(hidden.child)).toBe(false);
    const empty = element();
    empty.child.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
    expect(isElementShown(empty.child)).toBe(false);
    const away = element();
    away.child.getBoundingClientRect = () => ({ x: -500, y: 0, left: -500, top: 0, right: -100, bottom: 100, width: 400, height: 100, toJSON: () => ({}) });
    expect(isElementShown(away.child)).toBe(false);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(isElementShown(element().child)).toBe(false);
    visibility.mockRestore();
    const detached = document.createElement("div");
    expect(isElementShown(detached)).toBe(false);
  });
});

it("keeps hidden painting only while a shown preview is admitted and drops it on stop or unmount", () => {
  const view = render(<BrowserObservationPreview tabId="browser:1" sessionId={SESSION} probe={probe} observeHidden />);
  act(() => emitEvents([action(1)]));
  expect(isHiddenWebSurfaceObserved("browser:1")).toBe(true);
  act(() => emitPreview({ ...BINDING, kind: "state", state: "stopped" }));
  expect(isHiddenWebSurfaceObserved("browser:1")).toBe(false);
  act(() => emitEvents([action(2)]));
  expect(isHiddenWebSurfaceObserved("browser:1")).toBe(true);
  view.unmount();
  expect(isHiddenWebSurfaceObserved("browser:1")).toBe(false);
});

it("crops a thumbnail at the top-left and keeps the live badge inside its fixed picture box", () => {
  render(<div style={{ width: 240, height: 135 }}><BrowserObservationPreview tabId="browser:1" sessionId={SESSION} probe={probe} observeHidden thumbnail /></div>);
  act(() => emitEvents([action(1)]));
  act(() => emitPreview({ ...frame(1), width: 200, height: 400 }));
  const picture = screen.getByTestId("browser-observation-preview");
  expect(picture.style.aspectRatio).toBe("");
  expect(screen.getByRole("img").className).toContain("object-cover");
  expect(screen.getByRole("img").className).toContain("object-left-top");
  expect(screen.getByRole("img").parentElement).toBe(picture);
  expect(screen.getByText("실시간").parentElement).toBe(picture);
});

it.each(["overflow: hidden", "overflow-y: auto", "overflow-y: scroll", "overflow-y: clip"])(
  "rejects a picture wholly clipped by an ancestor with %s while still inside the window", (style) => {
    const scrollport = document.createElement("div"); scrollport.style.cssText = style;
    const picture = document.createElement("div"); scrollport.append(picture); document.body.append(scrollport);
    scrollport.getBoundingClientRect = () => new DOMRect(20, 250, 240, 300);
    picture.getBoundingClientRect = () => new DOMRect(20, 100, 240, 140);
    expect(isElementShown(picture)).toBe(false);
    picture.getBoundingClientRect = () => new DOMRect(20, 240, 240, 140);
    expect(isElementShown(picture)).toBe(true);
    scrollport.remove();
  },
);

it("lets a dragged fixed card escape its old stack's scroll clipping", () => {
  const stack = document.createElement("div"); stack.style.cssText = "position: fixed; overflow: auto";
  const card = document.createElement("div"); card.style.cssText = "position: fixed; overflow: hidden";
  const picture = document.createElement("div"); card.append(picture); stack.append(card); document.body.append(stack);
  stack.getBoundingClientRect = () => new DOMRect(700, 200, 240, 300);
  card.getBoundingClientRect = picture.getBoundingClientRect = () => new DOMRect(20, 100, 240, 140);
  expect(isElementShown(picture)).toBe(true);
  stack.remove();
});

it("stops and drops the screencast and hidden painting when scrolling the picture wholly outside the stack", () => {
  const scrollport = document.createElement("div"); scrollport.style.overflowY = "auto";
  scrollport.getBoundingClientRect = () => new DOMRect(20, 250, 240, 300); document.body.append(scrollport);
  const view = render(<BrowserObservationPreview tabId="browser:1" sessionId={SESSION} observeHidden />, { container: scrollport });
  act(() => emitEvents([action(1)]));
  const picture = screen.getByTestId("browser-observation-preview");
  let y = 300;
  picture.getBoundingClientRect = () => new DOMRect(20, y, 240, 140);
  fireEvent.scroll(scrollport);
  expect(actions()).toEqual(["start"]);
  act(() => emitPreview(frame(1)));
  expect(isHiddenWebSurfaceObserved("browser:1")).toBe(true);
  y = 100;
  fireEvent.scroll(scrollport);
  expect(actions()).toEqual(["start", "stop"]);
  expect(screen.queryByRole("img")).toBeNull();
  expect(isHiddenWebSurfaceObserved("browser:1")).toBe(false);
  y = 300;
  fireEvent.scroll(scrollport);
  expect(actions()).toEqual(["start", "stop", "start"]);
  view.unmount(); scrollport.remove();
});

it.each(["new-action", "scroll-restart"])("ignores an older failed capture start after a successful %s", async (scope) => {
  const pending: Array<(result: { ok: boolean }) => void> = [];
  const api = { requestObservationPreview: vi.fn((request: { action: string }) => request.action === "start"
    ? new Promise<{ ok: boolean }>((resolve) => pending.push(resolve)) : Promise.resolve({ ok: true })), onObservationPreview: () => () => {} };
  const store = new BrowserObservationPreviewStore(api as unknown as AvePreviewApi);
  store.start(BINDING);
  if (scope === "scroll-restart") store.stop(BINDING);
  store.start(BINDING);
  pending[1]?.({ ok: true }); await Promise.resolve();
  pending[0]?.({ ok: false }); await Promise.resolve();
  expect(store.get(BINDING)?.status).toBe("live");
  store.dispose();
});
