// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserControlFixture } from "../../../../__tests__/support/browser-control-fixture.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import type { BrowserObservationEvent, BrowserObservationPreviewMessage, BrowserObservationPreviewRequest } from "../../../../shared/agent-observation.js";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";
import type { AveApi, AvePreviewApi } from "../../types.js";
import { t } from "../../../../i18n/runtime.js";
import { AgentBrowserPipLayer } from "../AgentBrowserPipLayer.js";
import { connectBrowserObservations } from "../browser-observation-bridge.js";
import { registerBrowserTabHost } from "../agent-browser-bridge.js";
import { clampBrowserPipPosition } from "../browser-pip-position.js";
import { clearWebSurfaceSlot, isSurfaceDragActive, noteWebSurfaceFavicon, publishLiveWebTabs,
  requestWebSurfaceLayout, setWebSurfaceSlot, setWebSurfaceUrl, withdrawLiveWebTabs } from "../web-surfaces.js";

const TAB = "browser:pip-1";
const SECOND_TAB = "browser:pip-2";
const source = Symbol("pip-tabs");
let emit: (events: BrowserObservationEvent[]) => void;
let emitFrame: (message: BrowserObservationPreviewMessage) => void;
let control: (state: BrowserTabControlState) => void;
let disconnect: () => void;
let unregister: () => void;
let slot: HTMLDivElement;
let api: AveApi;
const open = vi.fn();
const previewRequests = vi.fn(async (_request: BrowserObservationPreviewRequest) => ({ ok: true }));

function action(seq = 1, tabId = TAB): BrowserObservationEvent & { kind: "action" } {
  return { source: "browser", actor: "agent", sessionId: "fixture-session", target: { id: `target-${tabId}`, path: "browser", hostSessionId: "parent" },
    seq, ts: seq, kind: "action", before: null, after: { action: "snapshot", tabId: `handle-${tabId}`, rendererTabId: tabId,
      title: "Preview page", url: "https://example.test/" } };
}
const cards = () => screen.queryAllByTestId("agent-browser-pip-card");
const openButton = () => screen.getByRole("button", { name: t("agentBrowser.openPreview", { title: "Preview page" }) });
const hideButton = () => screen.getByRole("button", { name: t("agentBrowser.hidePreview", { title: "Preview page" }) });
function show() { return render(<AgentBrowserPipLayer api={api} onOpen={open} />); }
function activate() { act(() => { control(browserControlFixture([TAB])); emit([action()]); }); }

beforeEach(async () => {
  vi.clearAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1243 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.dataset.testid === "agent-browser-pip-card" ? 240 : 600, 150);
  });
  slot = document.createElement("div");
  slot.style.display = "none";
  document.body.append(slot);
  setWebSurfaceSlot(TAB, slot);
  publishLiveWebTabs(source, new Set([TAB, SECOND_TAB]));
  setWebSurfaceUrl(TAB, "https://example.test/");
  api = makeMockAveApi({ browserTabs: true }).api as unknown as AveApi;
  unregister = registerBrowserTabHost(api, { sessionId: () => "fixture-session", hasTab: () => true, selectTab: () => {}, closeTab: () => {} });
  const controls = api.browserTabs;
  if (!controls) throw new Error("Browser controls missing");
  const handler = vi.mocked(controls.onControl).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error("Browser control subscription missing");
  control = handler;
  await act(async () => {});
  disconnect = connectBrowserObservations({
    onAgentObservation: (handler: typeof emit) => { emit = handler; return () => {}; },
    onObservationPreview: (handler: typeof emitFrame) => { emitFrame = handler; return () => {}; }, acknowledgeObservation: async () => ({ ok: true }),
    requestObservationPreview: previewRequests,
  } as unknown as AvePreviewApi);
});
afterEach(async () => {
  cleanup(); disconnect(); unregister(); clearWebSurfaceSlot(TAB, slot); slot.remove();
  withdrawLiveWebTabs(source); await Promise.resolve(); vi.restoreAllMocks();
});

describe("window agent browser previews", () => {
  it("sizes a portrait picture to its captured aspect and leaves stack padding for its shadow", () => {
    show(); activate();
    act(() => emitFrame({ kind: "frame", targetId: `target-${TAB}`, sessionId: "fixture-session", tabId: `handle-${TAB}`,
      frame: 1, mimeType: "image/jpeg", data: "portrait", width: 200, height: 400, ts: 1 }));
    const picture = screen.getByTestId("browser-observation-preview");
    expect(Number.parseFloat(picture.style.aspectRatio)).toBe(0.5);
    expect(cards()[0]?.style.width).toBe("240px");
    expect(cards()[0]?.style.height).toBe("");
    expect(picture.contains(screen.getByText(t("agentBrowser.live")))).toBe(true);
    act(() => emitFrame({ kind: "state", targetId: `target-${TAB}`, sessionId: "fixture-session", tabId: `handle-${TAB}`, state: "stopped" }));
    expect(Number.parseFloat(picture.style.aspectRatio)).toBe(0.5);
    expect(screen.getByTestId("agent-browser-pip-layer").className).toContain("p-8");
    expect(screen.getByTestId("agent-browser-pip-layer").className).toContain("pb-12");
    expect(screen.getByTestId("agent-browser-pip-layer").className).toContain("right-4");
  });
  it.each(["approval", "question"])("reserves an ordinary %s outside the settle wrapper and stays below decision surfaces", (kind) => {
    const composer = document.createElement("div"); composer.dataset.testid = "composer";
    const decision = document.createElement("section"); decision.dataset.pipReservation = kind;
    document.body.append(composer, decision);
    composer.getBoundingClientRect = () => new DOMRect(0, 674, 1243, 100);
    decision.getBoundingClientRect = () => new DOMRect(800, 450, 400, 220);
    show(); activate();
    const layer = screen.getByTestId("agent-browser-pip-layer");
    expect(layer.style.height).toBe("418px");
    expect(layer.className).toContain("z-30");
    decision.remove(); composer.remove();
  });
  it("shows no card without tabs or observations, then hides only the tab actually visible in the panel", () => {
    show(); expect(cards()).toHaveLength(0);
    activate(); expect(cards()).toHaveLength(1);
    act(() => { slot.style.display = "block"; requestWebSurfaceLayout(); });
    expect(cards()).toHaveLength(0);
    act(() => { slot.style.display = "none"; requestWebSurfaceLayout(); });
    expect(cards()).toHaveLength(1);
    act(() => control(browserControlFixture([], "human", 2)));
    expect(cards()).toHaveLength(0);
  });
  it("stays dismissed for snapshots and scrolls in the same turn, then reappears for a new turn or actual activation", async () => {
    show(); activate(); fireEvent.click(hideButton()); expect(cards()).toHaveLength(0);
    act(() => requestWebSurfaceLayout()); expect(cards()).toHaveLength(0);
    const starts = () => previewRequests.mock.calls.filter(([request]) => (request as { action: string }).action === "start").length;
    const before = starts();
    act(() => emit([action(2)])); expect(cards()).toHaveLength(0);
    const scroll = action(3);
    act(() => emit([{ ...scroll, after: { ...scroll.after, action: "scroll" } }]));
    expect(cards()).toHaveLength(0); expect(starts()).toBe(before);
    const nextTurn = { ...action(4), target: { ...action().target, id: "next-turn" } };
    act(() => emit([nextTurn])); expect(cards()).toHaveLength(1);
    fireEvent.click(hideButton());
    await act(async () => { slot.style.display = "block"; });
    await act(async () => { slot.style.display = "none"; });
    expect(cards()).toHaveLength(1);
  });
  it("opens with Enter and hides with Delete or the close button", async () => {
    const user = userEvent.setup(); show(); activate();
    openButton().focus(); await user.keyboard("{Enter}"); expect(open).toHaveBeenCalledWith(TAB);
    await user.keyboard("{Delete}"); expect(cards()).toHaveLength(0);
    act(() => emit([{ ...action(2), target: { ...action().target, id: "keyboard-next-turn" } }])); fireEvent.click(hideButton()); expect(cards()).toHaveLength(0);
  });
  it("shows two separate cards with child titles and suppresses ended children", () => {
    const fixture = makeMockAveApi({ browserTabs: true });
    // Use this layer's own window API subscription, with the existing control connection.
    const view = render(<AgentBrowserPipLayer api={fixture.api as unknown as AveApi} onOpen={open} />);
    act(() => {
      setWebSurfaceUrl(SECOND_TAB, "https://example.test/");
      fixture.emitAgentSpawnEvent({ spawnId: "child", childSessionId: "fixture-session", parentSessionId: "parent", type: "start",
        taskState: "TASK_STATE_SUBMITTED", title: "Research task" });
      control(browserControlFixture([TAB, SECOND_TAB])); emit([action(), action(1, SECOND_TAB)]);
    });
    expect(cards()).toHaveLength(2); expect(cards()[0]?.textContent).toContain("Research task");
    act(() => fixture.emitAgentSpawnEvent({ spawnId: "child", childSessionId: "fixture-session", parentSessionId: "parent", type: "done",
      taskState: "TASK_STATE_COMPLETED" }));
    expect(cards()).toHaveLength(0); view.unmount();
  });
  it("renders a favicon and title chip without a screencast below 480px", () => {
    show(); activate();
    act(() => { Object.defineProperty(window, "innerWidth", { value: 360 }); noteWebSurfaceFavicon(TAB, "data:image/png;base64,AA=="); fireEvent.resize(window); });
    expect(cards()[0]).toHaveAttribute("data-compact", "true");
    expect(openButton().querySelector("img")).not.toBeNull();
    expect(screen.queryByTestId("browser-observation-preview")).toBeNull();
  });
  it("releases the shared drag state when a dragged card disappears", () => {
    show(); activate();
    const button = openButton(); button.setPointerCapture = vi.fn();
    fireEvent(button, Object.assign(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }),
      { isPrimary: true, pointerId: 1 }));
    expect(isSurfaceDragActive()).toBe(true);
    fireEvent.click(hideButton()); expect(isSurfaceDragActive()).toBe(false);
  });
});

it.each([
  [{ x: -40, y: -3 }, { width: 1243, height: 800 }, { x: 0, y: 0 }],
  [{ x: 2000, y: 1000 }, { width: 1243, height: 800 }, { x: 1003, y: 650 }],
  [{ x: 1003, y: 650 }, { width: 360, height: 500 }, { x: 120, y: 350 }],
  [{ x: 10, y: 20 }, { width: 120, height: 80 }, { x: 0, y: 0 }],
])("clamps a card to the available window area %j", (point, area, expected) => {
  expect(clampBrowserPipPosition(point, { width: 240, height: 150 }, area)).toEqual(expected);
});
