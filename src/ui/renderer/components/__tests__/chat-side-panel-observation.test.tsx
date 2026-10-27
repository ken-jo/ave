// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { approvalSurfaceStub, emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import { makeMockAveApi, makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import type { DocumentObservationEvent, ObservationRequest } from "../../../../shared/agent-observation.js";
import type { PreviewTableDocument } from "../../../../shared/preview-document.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";
import { chatSidePanelLauncherTestId } from "../../../../shared/test-ids.js";
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import type { ChatPreviewTarget } from "../../preview/preview-targets.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
import type { AveApi } from "../../types.js";
import { ChatSidePanel } from "../ChatSidePanel.js";
import { WebSurfaceLayer } from "../WebSurfaceLayer.js";

const SESSION = "document-panel-session";
const FIRST_TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRESH_TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TERMINAL_TARGET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
type PreviewRoute = "content" | "file-browser";

function workbook(value: string): PreviewTableDocument {
  return { format: "xlsx", needsRecalculation: false, sheetNames: ["Sheet1"], totalSheets: 1,
    sheetsTruncated: false, sheet: { index: 0, name: "Sheet1", rows: [[value]], firstRow: 0, firstColumn: 0,
      totalRows: 1, totalColumns: 1, rowsTruncated: false, columnsTruncated: false,
      cellsTruncated: false, clippedCells: [] } };
}

function RetainedPanel({ api, target }: { api: AveApi; target: Extract<ChatPreviewTarget, { kind: "file" }> }) {
  const workspaceTabs = useWorkspaceTabs();
  const [visible, setVisible] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(target.id);
  return <>
    <button onClick={() => setVisible(true)}>Reopen panel</button>
    <button onClick={() => workspaceTabs.openInEphemeral({ source: "preview", targetId: target.id })}>Open document tab</button>
    <button onClick={() => workspaceTabs.openAgentBrowserTab("https://example.test/agent", "agent-browser-request", true)}>Open agent browser</button>
    <ChatSidePanel api={api} visible={visible} sessionId={SESSION} targets={[target]}
      files={[{ id: "document-file", path: target.path, label: target.title, detail: target.path,
        sourceLabel: "read_file", operation: "read", canOpenExternal: false, previewTargetId: target.id }]}
      selectedId={selectedId} onSelect={setSelectedId} workspaceTabs={workspaceTabs}
      subAgentSpawns={[]} width={SIDE_PANEL_MIN_WIDTH} onWidthChange={() => {}} onWidthCommit={() => {}}
      onClose={() => setVisible(false)} activity={emptyToolActivity()} />
    <WebSurfaceLayer api={api} />
  </>;
}

function openPreview(route: PreviewRoute): void {
  if (route === "content") {
    fireEvent.click(screen.getByText("Open document tab"));
    return;
  }
  fireEvent.pointerDown(screen.getByTestId("chat-side-panel-add-tab"), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByTestId("chat-side-panel-add-tab"));
  fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId(`menu-${route}`)));
}

let previousAve: unknown;
beforeEach(() => {
  previousAve = (window as unknown as { ave?: unknown }).ave;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (window as unknown as { ave?: unknown }).ave = previousAve;
});

describe("retained panel document observation", () => {
  it.each((["xlsx", "text"] as const).flatMap((format) =>
    (["content", "file-browser"] as const).flatMap((route) =>
      (["side-chat", "browser"] as const).map((background) => ({ format, route, background }))),
  ))("releases $format observation in $route with a retained $background and reads a fresh baseline", async ({ format, route, background }) => {
    const { api: mockApi } = makeMockAveApi({ sideChat: true, browserTabs: true });
    const namespace = makeMockAveNamespace().ns;
    const path = format === "xlsx" ? "/ws/book.xlsx" : "/ws/source.ts";
    const target: Extract<ChatPreviewTarget, { kind: "file" }> = { id: "document-target", kind: "file", title: format === "xlsx" ? "book.xlsx" : "source.ts",
      path, sourceLabel: "read_file", createdOrder: 0, workspaceRoot: "/ws", canOpenExternal: false };
    const handlers = new Set<(events: DocumentObservationEvent[]) => void>();
    const onAgentObservation = vi.fn((handler: (events: DocumentObservationEvent[]) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    });
    // The panel's terminal strip subscribes alongside the document view while the panel is visible.
    const terminalBinding = { targetId: TERMINAL_TARGET, sessionId: SESSION, seq: 0 };
    const acknowledgeObservation = vi.fn(async (request: ObservationRequest) =>
      request.action === "subscribe-terminal" ? { ok: true, observation: terminalBinding } : { ok: true });
    const terminalSubscriptions = () => acknowledgeObservation.mock.calls.filter(([request]) => request.action === "subscribe-terminal").length;
    let reopened = false;
    const baseline = () => ({ targetId: reopened ? FRESH_TARGET : FIRST_TARGET, sessionId: SESSION, seq: 0 });
    const readDocument = vi.fn(async () => ({ ok: true as const, path, bytes: 1024,
      document: workbook(reopened ? "Fresh disk value" : "Initial disk value"), observation: baseline() }));
    const readFile = vi.fn(async () => ({ ok: true, path, content: reopened ? "Fresh disk value" : "Initial disk value",
      lineCount: 1, truncated: false, observation: baseline() }));
    (window as unknown as { ave: unknown }).ave = { ...namespace,
      preview: { ...namespace.preview, readDocument, readFile, onAgentObservation, acknowledgeObservation } };
    render(<TooltipProvider><ApprovalSurfaceProvider value={approvalSurfaceStub()}>
      <RetainedPanel api={mockApi as unknown as AveApi} target={target} />
    </ApprovalSurfaceProvider></TooltipProvider>);
    if (background === "side-chat") fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("side-chat")));
    else fireEvent.click(screen.getByText("Open agent browser"));
    const retained = background === "side-chat" ? screen.getByTestId("side-chat-view") : document.querySelector("webview");
    expect(retained).not.toBeNull();
    openPreview(route);
    await screen.findByText("Initial disk value");
    await waitFor(() => expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "rendered",
      targetId: FIRST_TARGET, sessionId: SESSION, seq: 0 }));
    // One document view subscriber and one terminal strip subscriber.
    expect(handlers.size).toBe(2);
    expect(terminalSubscriptions()).toBe(1);
    const event = (seq: number, after: string): DocumentObservationEvent => ({ source: "document", actor: "agent", sessionId: SESSION,
      target: { id: FIRST_TARGET, path }, kind: "element", seq, ts: 1_700_000_000_000,
      element: format === "xlsx" ? { kind: "cell", sheet: "Sheet1", row: 0, column: 0 } : { kind: "line", line: 1 },
      before: "Initial disk value", after, advisory: true });
    act(() => { handlers.forEach((handler) => handler([event(1, "Agent overlay")])); });
    await screen.findByText("Agent overlay");
    const body = screen.getByTestId(format === "xlsx" ? "chat-side-panel-table-preview" : "chat-side-panel-file-preview");
    fireEvent.click(screen.getByTestId("chat-side-panel-close"));
    expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "release", targetId: FIRST_TARGET, sessionId: SESSION, seq: 1 });
    expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "release", ...terminalBinding });
    expect(handlers.size).toBe(0);
    expect(retained?.isConnected).toBe(true);
    // The hidden body stays mounted (sheet, scroll and page position survive) without agent overlays.
    expect(body.isConnected).toBe(true);
    expect(screen.queryByText("Agent overlay")).toBeNull();
    const read = format === "xlsx" ? readDocument : readFile;
    expect(read).toHaveBeenCalledTimes(1);
    reopened = true;
    act(() => { handlers.forEach((handler) => handler([event(2, "Hidden edit")])); });
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Reopen panel"));
    expect(screen.getByText("Initial disk value")).toBeTruthy();
    await screen.findByText("Fresh disk value");
    expect(body.isConnected).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onAgentObservation).toHaveBeenCalledTimes(4);
    expect(handlers.size).toBe(2);
    expect(terminalSubscriptions()).toBe(2);
    expect(retained?.isConnected).toBe(true);
    await waitFor(() => expect(acknowledgeObservation).toHaveBeenCalledWith({ action: "rendered",
      targetId: FRESH_TARGET, sessionId: SESSION, seq: 0 }));
    act(() => { handlers.forEach((handler) => handler([event(3, "Stale binding")])); });
    expect(screen.queryByText("Stale binding")).toBeNull();
    expect(screen.queryByText("Agent overlay")).toBeNull();
  });
});
