// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceApi } from "../../../../shared/browser-workspace.js";
import { t, translate } from "../../../../i18n/index.js";
import { deferred } from "../../../../__tests__/support/deferred.js";
import { BrowserCaptureControls } from "../browser-capture-controls.js";
import { registerComposerTarget, resetComposerTargetsForTest } from "../../preview/composer-targets.js";
import { setWebSurfaceElement } from "../../preview/web-surfaces.js";
import { useAttachmentPicker } from "../../hooks/use-attachment-picker.js";
import type { Attachment } from "../../types/attachments.js";

const TAB = "browser:capture";
const PANE_SESSION = Symbol();
const getSessionIdentity = () => PANE_SESSION;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetComposerTargetsForTest(); setWebSurfaceElement(TAB, null); });

function mount(paneChatGroupId?: string) {
  vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  const attachImage = vi.fn(async () => true);
  registerComposerTarget({ groupId: "conversation", kind: "conversation", attach: () => true, attachImage, available: () => true, element: () => null });
  const capture = vi.fn(async () => ({ ok: true, value: { tabId: TAB, documentGeneration: 2, dataUrl: "data:image/png;base64,aW1hZ2U=", width: 200, height: 100, bytes: 5, truncated: false } }));
  const getState = vi.fn(async () => ({ ok: true, value: { tabs: [{ tabId: TAB, documentGeneration: 2, zoomFactor: 1.25 }] } }));
  const api = { capture, getState } as unknown as BrowserWorkspaceApi;
  const guest = document.createElement("div");
  guest.getBoundingClientRect = () => ({ x: 100, y: 150, width: 500, height: 400 } as DOMRect);
  setWebSurfaceElement(TAB, guest);
  const view = render(<BrowserCaptureControls api={api} tabId={TAB} composerGroupId="conversation" paneChatGroupId={paneChatGroupId} />);
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

  it("reports attachment rejection separately from a capture failure", async () => {
    const { capture, attachImage } = mount();
    attachImage.mockRejectedValueOnce(new Error("attachment failed"));
    await choose("browser-capture-viewport");
    expect(await screen.findByRole("alert")).toHaveTextContent(t("browserCapture.attachmentFailed"));

    capture.mockRejectedValueOnce(new Error("capture failed"));
    await choose("browser-capture-viewport");
    expect(await screen.findByRole("alert")).toHaveTextContent(t("browserCapture.failed"));
    expect(attachImage).toHaveBeenCalledOnce();
    for (const locale of ["en", "ko"] as const) {
      expect(translate(locale, "browserCapture.failed")).not.toBe(translate(locale, "browserCapture.attachmentFailed"));
    }
  });

  it("does not attach when the pane chat first opens during capture", async () => {
    const groupId = "pane:new-chat";
    const { capture } = mount(groupId);
    const pending = deferred<Awaited<ReturnType<typeof capture>>>();
    capture.mockReturnValueOnce(pending.promise);
    await choose("browser-capture-viewport");
    expect(capture).toHaveBeenCalledOnce();

    const dock = render(<div />).container;
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
    const attachImage = vi.fn(async () => true);
    registerComposerTarget({ groupId, kind: "side-chat", getSessionIdentity, attach: () => true, attachImage, available: () => true, element: () => dock });
    await act(async () => {
      pending.resolve({ ok: true, value: { tabId: TAB, documentGeneration: 2, dataUrl: "data:image/png;base64,aW1hZ2U=", width: 200, height: 100, bytes: 5, truncated: false } });
    });
    expect(attachImage).not.toHaveBeenCalled();
  });

  it("discards a pending capture when a different browser replaces its toolbar in the same pane", async () => {
    const groupId = "pane:shared-tile";
    const { api, capture, rerender, attachImage } = mount(groupId);
    const dock = render(<div />).container;
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
    const attachOriginal = vi.fn(async () => true);
    const unregister = registerComposerTarget({ groupId, kind: "side-chat", getSessionIdentity, attach: () => true, attachImage: attachOriginal, available: () => true, element: () => dock });
    const pending = deferred<Awaited<ReturnType<typeof capture>>>();
    capture.mockReturnValueOnce(pending.promise);
    await choose("browser-capture-viewport");
    expect(capture).toHaveBeenCalledOnce();

    rerender(<BrowserCaptureControls key="replacement" api={api} tabId="browser:replacement" paneChatGroupId={groupId} />);
    unregister();
    const attachReplacement = vi.fn(async () => true);
    registerComposerTarget({ groupId, kind: "side-chat", getSessionIdentity, attach: () => true, attachImage: attachReplacement, available: () => true, element: () => dock });
    await act(async () => {
      pending.resolve({ ok: true, value: { tabId: TAB, documentGeneration: 2, dataUrl: "data:image/png;base64,aW1hZ2U=", width: 200, height: 100, bytes: 5, truncated: false } });
    });
    expect(attachReplacement).not.toHaveBeenCalled();
    expect(attachOriginal).not.toHaveBeenCalled();
    expect(attachImage).not.toHaveBeenCalled();
  });

  it.each(["hide", "replace composer", "replace browser"] as const)("releases a staged capture if the user can %s while it is attaching", async (change) => {
    const groupId = "pane:capture-draft";
    const { api, rerender } = mount(groupId);
    const image = { ok: true, path: "/work/capture.png", dataUrl: "data:image/png;base64,aW1hZ2U=", mimeType: "image/png", width: 200, height: 100, bytes: 5 };
    const staged = deferred<typeof image>();
    const saveClipboardImage = vi.fn(async () => change === "hide" ? staged.promise : image);
    const readImage = vi.fn(async () => change === "hide" ? image : staged.promise);
    const release = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("ave", { attach: { saveClipboardImage, readImage, release } });
    const dock = render(<div />).container;
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 100));
    const { result, unmount } = renderHook(() => {
      const [attachments, setAttachments] = useState<Attachment[]>([]);
      const [draft, setQuestion] = useState("");
      const picker = useAttachmentPicker({ attachmentNCounter: useRef(0), composerRef: useRef(null), setAttachments, setQuestion, imagesEnabled: true });
      return { attachments, draft, attachImage: picker.attachImage };
    });
    const unregister = registerComposerTarget({ groupId, kind: "side-chat", getSessionIdentity, attach: () => true, attachImage: result.current.attachImage, available: () => true, element: () => dock });
    await choose("browser-capture-viewport");
    expect(change === "hide" ? saveClipboardImage : readImage).toHaveBeenCalledOnce();

    const attachReplacement = vi.fn(async () => true);
    if (change === "hide") dock.hidden = true;
    if (change === "replace composer") {
      unregister();
      unmount();
      registerComposerTarget({ groupId, kind: "side-chat", getSessionIdentity, attach: () => true, attachImage: attachReplacement, available: () => true, element: () => dock });
    }
    if (change === "replace browser") {
      rerender(<BrowserCaptureControls key="replacement" api={api} tabId="browser:replacement" paneChatGroupId={groupId} />);
    }
    await act(async () => { staged.resolve(image); });

    expect.soft(release).toHaveBeenCalledExactlyOnceWith([image.path]);
    expect.soft(result.current.attachments).toEqual([]);
    expect.soft(result.current.draft).toBe("");
    expect(attachReplacement).not.toHaveBeenCalled();
    if (change !== "replace browser") expect(screen.getByRole("alert")).toHaveTextContent(t("browserCapture.attachmentFailed"));
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

  it("abandons delayed area selection after focus moves to another input", async () => {
    const { getState, capture, container } = mount();
    const input = document.createElement("input");
    container.appendChild(input);
    const state = await getState();
    let releaseState!: () => void;
    getState.mockReturnValueOnce(new Promise((resolve) => { releaseState = () => resolve(state); }));
    const closeAutoFocus = await openCaptureMenu();
    const areaItem = screen.getByTestId("browser-capture-area");
    act(() => { areaItem.focus(); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { fireEvent.keyDown(areaItem, { key: "Enter" }); });
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
    expect(closeAutoFocus).not.toHaveBeenCalled();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(closeAutoFocus).toHaveBeenCalledOnce();
    const inputFocus = vi.spyOn(input, "focus");
    act(() => { input.focus(); });
    expect(input).toHaveFocus();
    await act(async () => { releaseState(); });
    expect(input).toHaveFocus();
    expect(inputFocus).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
    expect(screen.getByTestId("browser-capture-menu")).toBeEnabled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("preserves an outside input after selection is canceled before the menu close handoff", async () => {
    const { container } = mount();
    const input = document.createElement("input");
    container.appendChild(input);
    const closeAutoFocus = await openCaptureMenu();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { fireEvent.click(screen.getByTestId("browser-capture-area")); });
    expect(screen.getByTestId("browser-capture-overlay")).toHaveFocus();
    const triggerFocus = vi.spyOn(screen.getByTestId("browser-capture-menu"), "focus");
    const inputFocus = vi.spyOn(input, "focus");
    fireEvent.pointerDown(input, { button: 0 });
    act(() => { input.focus(); });
    expect(screen.queryByTestId("browser-capture-overlay")).toBeNull();
    expect(input).toHaveFocus();
    expect(closeAutoFocus).not.toHaveBeenCalled();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(closeAutoFocus).toHaveBeenCalledOnce();
    expect(input).toHaveFocus();
    expect(inputFocus).toHaveBeenCalledOnce();
    expect(triggerFocus).not.toHaveBeenCalled();
  });

  it.each(["Escape", "trigger"])("returns menu focus exactly once after %s dismissal", async (dismissal) => {
    mount();
    const closeAutoFocus = await openCaptureMenu();
    const trigger = screen.getByTestId("browser-capture-menu");
    const triggerFocus = vi.spyOn(trigger, "focus");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    if (dismissal === "Escape") fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    else fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(closeAutoFocus).not.toHaveBeenCalled();
    expect(triggerFocus).not.toHaveBeenCalled();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(closeAutoFocus).toHaveBeenCalledOnce();
    expect(triggerFocus).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("moves keyboard item activation to the overlay without restoring the trigger", async () => {
    mount();
    const closeAutoFocus = await openCaptureMenu();
    const areaItem = screen.getByTestId("browser-capture-area");
    act(() => { areaItem.focus(); });
    const triggerFocus = vi.spyOn(screen.getByTestId("browser-capture-menu"), "focus");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { fireEvent.keyDown(areaItem, { key: "Enter" }); });
    const overlay = screen.getByTestId("browser-capture-overlay");
    expect(overlay).toHaveFocus();
    const overlayFocus = vi.spyOn(overlay, "focus");
    expect(closeAutoFocus).not.toHaveBeenCalled();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(closeAutoFocus).toHaveBeenCalledOnce();
    expect(overlay).toHaveFocus();
    expect(overlayFocus).not.toHaveBeenCalled();
    expect(triggerFocus).not.toHaveBeenCalled();
  });
});
