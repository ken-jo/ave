// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentObservationEvent, BrowserObservationEvent, BrowserObservationPreviewMessage } from "../../../../shared/agent-observation.js";
import type { AvePreviewApi } from "../../types.js";
import { connectBrowserObservations } from "../browser-observation-bridge.js";
import { BrowserObservationPreviewStore, isElementShown } from "../browser-observation-preview.js";
import { BrowserObservationPreview } from "../BrowserObservationPreview.js";

const SESSION = "browser-session";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING = { targetId: TARGET, sessionId: SESSION, tabId: "tab-1" };
function action(seq: number, rendererTabId = "browser:1", tabId = "tab-1"): BrowserObservationEvent {
  return { source: "browser", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: "browser", hostSessionId: SESSION }, seq,
    ts: 1_700_000_000_000 + seq, kind: "action", before: null,
    after: { action: "click", tabId, rendererTabId, url: "https://example.test/", title: "Example" } };
}
function frame(number: number, binding = BINDING): BrowserObservationPreviewMessage {
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
