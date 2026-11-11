// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceApi } from "../../../../shared/browser-workspace.js";
import { BrowserCaptureControls } from "../browser-capture-controls.js";
import { registerComposerTarget, resetComposerTargetsForTest } from "../../preview/composer-targets.js";
import { setWebSurfaceElement } from "../../preview/web-surfaces.js";

const TAB = "browser:capture";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); resetComposerTargetsForTest(); setWebSurfaceElement(TAB, null); });

function mount() {
  const attachImage = vi.fn(async () => true);
  registerComposerTarget({ groupId: "conversation", kind: "conversation", attach: () => true, attachImage, available: () => true, element: () => null });
  const capture = vi.fn(async () => ({ ok: true, value: { tabId: TAB, documentGeneration: 2, dataUrl: "data:image/png;base64,aW1hZ2U=", width: 200, height: 100, bytes: 5, truncated: false } }));
  const getState = vi.fn(async () => ({ ok: true, value: { tabs: [{ tabId: TAB, documentGeneration: 2, zoomFactor: 1.25 }] } }));
  const api = { capture, getState } as unknown as BrowserWorkspaceApi;
  const guest = document.createElement("div");
  guest.getBoundingClientRect = () => ({ x: 100, y: 150, width: 500, height: 400 } as DOMRect);
  setWebSurfaceElement(TAB, guest);
  const view = render(<BrowserCaptureControls api={api} tabId={TAB} composerGroupId="conversation" />);
  return { ...view, api, capture, getState, attachImage, guest };
}

async function openCaptureMenu() {
  fireEvent.pointerDown(screen.getByTestId("browser-capture-menu"), { button: 0, ctrlKey: false });
  const menu = await screen.findByRole("menu");
  const closeAutoFocus = vi.fn();
  menu.addEventListener("focusScope.autoFocusOnUnmount", closeAutoFocus, { once: true });
  return closeAutoFocus;
}

async function choose(testId: string) {
  const closeAutoFocus = await openCaptureMenu();
  await act(async () => { fireEvent.click(screen.getByTestId(testId)); });
  // Menu removal precedes its deferred focus handoff.
  await waitFor(() => expect(closeAutoFocus).toHaveBeenCalledOnce());
}

describe("browser user captures", () => {
  it("captures a full page and hands the image to its conversation composer", async () => {
    const { capture, attachImage } = mount();
    await choose("browser-capture-full-page");
    await waitFor(() => expect(attachImage).toHaveBeenCalledWith("aW1hZ2U="));
    expect(capture).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 2, fullPage: true });
  });

  it("normalizes a host drag rectangle by the guest zoom without injecting an overlay", async () => {
    const { capture, guest } = mount();
    await choose("browser-capture-area");
    const overlay = await screen.findByTestId("browser-capture-overlay");
    expect(overlay.parentElement).toBe(document.body);
    expect(guest).not.toContainElement(overlay);
    expect({ left: overlay.style.left, top: overlay.style.top, width: overlay.style.width, height: overlay.style.height })
      .toEqual({ left: "100px", top: "150px", width: "500px", height: "400px" });
    overlay.setPointerCapture = vi.fn();
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 125, clientY: 175 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 375, clientY: 300 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 375, clientY: 300 });
    await waitFor(() => expect(capture).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 2, clip: { x: 20, y: 20, width: 200, height: 100 } }));
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
  });

  it("cancels area selection with Escape without capturing", async () => {
    const { capture } = mount();
    await choose("browser-capture-area");
    const overlay = await screen.findByTestId("browser-capture-overlay");
    expect(overlay).toHaveFocus();
    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("returns focus to the capture menu when area selection cannot start", async () => {
    const { getState } = mount();
    getState.mockResolvedValueOnce({ ok: false, error: "no-such-tab" } as never);
    await choose("browser-capture-area");
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByTestId("browser-capture-menu")).toHaveFocus());
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
  });

  it("keeps a drag owned by its initiating pointer", async () => {
    const { capture } = mount();
    await choose("browser-capture-area");
    const overlay = await screen.findByTestId("browser-capture-overlay");
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 125, clientY: 175 });
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 2, clientX: 150, clientY: 200 });
    fireEvent.pointerMove(overlay, { pointerId: 2, clientX: 500, clientY: 500 });
    fireEvent.pointerCancel(overlay, { pointerId: 2 });
    fireEvent.pointerUp(overlay, { pointerId: 2, clientX: 500, clientY: 500 });
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getByTestId("browser-capture-overlay")).toBe(overlay);
    expect(screen.getByTestId("browser-capture-rectangle").style.width).toBe("0px");
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 375, clientY: 300 });
    await waitFor(() => expect(capture).toHaveBeenCalledWith({ tabId: TAB, documentGeneration: 2, clip: { x: 20, y: 20, width: 200, height: 100 } }));
  });

  it("cancels a drag if its guest moved or resized", async () => {
    const { capture, guest } = mount();
    await choose("browser-capture-area");
    const overlay = await screen.findByTestId("browser-capture-overlay");
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 125, clientY: 175 });
    guest.getBoundingClientRect = () => ({ x: 105, y: 150, width: 490, height: 400 } as DOMRect);
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 375, clientY: 300 });
    expect(capture).not.toHaveBeenCalled();
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
  });

  it.each([{ documentGeneration: 3, zoomFactor: 1.25 }, { documentGeneration: 2, zoomFactor: 1.5 }])("refuses an area captured after document or zoom changed (%j)", async (current) => {
    const { capture, getState } = mount();
    await choose("browser-capture-area");
    const overlay = await screen.findByTestId("browser-capture-overlay");
    getState.mockResolvedValueOnce({ ok: true, value: { tabs: [{ tabId: TAB, ...current }] } });
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 125, clientY: 175 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 375, clientY: 300 });
    await screen.findByRole("alert");
    expect(capture).not.toHaveBeenCalled();
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
  });

  it("preserves selection focus and listeners across an unrelated parent render", async () => {
    const { rerender, api } = mount();
    const closeAutoFocus = await openCaptureMenu();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { fireEvent.click(screen.getByTestId("browser-capture-area")); });
    const overlay = screen.getByTestId("browser-capture-overlay");
    expect(overlay).toHaveFocus();
    const focus = vi.spyOn(overlay, "focus");
    rerender(<BrowserCaptureControls api={api} tabId={TAB} composerGroupId="conversation" />);
    expect(closeAutoFocus).not.toHaveBeenCalled();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(closeAutoFocus).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();
    expect(screen.getByTestId("browser-capture-overlay")).toBe(overlay);
    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
  });

  it("keeps a later keyboard focus choice when the menu close handoff is delayed", async () => {
    mount();
    const closeAutoFocus = await openCaptureMenu();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { fireEvent.click(screen.getByTestId("browser-capture-area")); });
    const overlay = screen.getByTestId("browser-capture-overlay");
    expect(overlay).toHaveFocus();
    const trigger = screen.getByTestId("browser-capture-menu");
    act(() => { trigger.focus(); });
    expect(trigger).toHaveFocus();
    expect(closeAutoFocus).not.toHaveBeenCalled();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(closeAutoFocus).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
  });

  it("focuses area selection when its state arrives after the menu closes", async () => {
    const { getState } = mount();
    const state = await getState();
    let releaseState!: () => void;
    getState.mockReturnValueOnce(new Promise((resolve) => { releaseState = () => resolve(state); }));
    await choose("browser-capture-area");
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
    await act(async () => { releaseState(); });
    expect(screen.getByTestId("browser-capture-overlay")).toHaveFocus();
  });
});
