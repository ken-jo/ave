import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentObservationEvent, DocumentObservationEvent } from "../../../../shared/agent-observation.js";
import { emitObservations } from "../../../../__tests__/support/document-observation-events.js";
import type { PreviewPageDocument } from "../../../../shared/preview-page-document.js";
import { PageDocumentPreview } from "../PageDocumentPreview.js";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";

const PATH = "/workspace/document.docx";
const SESSION = "page-session";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTLINE: PreviewPageDocument = { format: "docx", totalPages: 1, pagesTruncated: false,
  elements: [{ element: { kind: "paragraph", paragraph: 0 }, text: "Old paragraph" },
    { element: { kind: "paragraph", paragraph: 0, run: 0 }, text: "Old paragraph" }],
  page: { index: 0, paragraphs: ["Old paragraph"], textTruncated: false, png: null, width: 0, height: 0 } };
let previousAve: typeof window.ave;
let previousLocale: ReturnType<typeof getLocale>;
let handlers: Set<(events: AgentObservationEvent[]) => void>;
let acknowledge: ReturnType<typeof vi.fn>;
let read: ReturnType<typeof vi.fn>;

beforeEach(() => {
  previousAve = window.ave;
  previousLocale = getLocale();
  setLocale("en");
  handlers = new Set();
  acknowledge = vi.fn(async () => ({ ok: true }));
  read = vi.fn(async () => ({ ok: true, path: PATH, bytes: 42, document: OUTLINE,
    observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } }));
  window.ave = { attach: { openExternal: vi.fn(async () => ({ ok: true })) }, preview: {
    readDocument: read, acknowledgeObservation: acknowledge,
    onAgentObservation: (handler: (events: AgentObservationEvent[]) => void) => {
      handlers.add(handler); return () => { handlers.delete(handler); };
    },
  } } as never;
});
afterEach(() => { window.ave = previousAve; setLocale(previousLocale); vi.restoreAllMocks(); });

function elementEvent(seq = 1): Extract<DocumentObservationEvent, { kind: "element" }> {
  return { source: "document", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: PATH }, seq, ts: 1_700_000_000_000,
    kind: "element", element: { kind: "paragraph", paragraph: 0, run: 0 }, before: "Old paragraph", after: "New paragraph", advisory: false };
}
function snapshot(document: PreviewPageDocument, seq: number): DocumentObservationEvent {
  return { source: "document", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: PATH }, seq, ts: 1_700_000_000_000,
    kind: "snapshot", before: null, after: document };
}

describe("read-only page observation rendering", () => {
  it("releases its binding while the panel is hidden, keeps the page, and re-reads a fresh baseline when shown", async () => {
    const view = render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await screen.findByText("Old paragraph");
    expect(handlers.size).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    view.rerender(<PageDocumentPreview path={PATH} sessionId={SESSION} observe={false} />);
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ action: "release", targetId: TARGET })));
    expect(handlers.size).toBe(0);
    expect(screen.getByText("Old paragraph")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);
    view.rerender(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(handlers.size).toBe(1));
  });

  it("keeps an idle user view free of activity and acknowledges the committed outline", async () => {
    const view = render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await screen.findByText("Old paragraph");
    expect(screen.queryByTestId("document-preview-live-strip")).toBeNull();
    expect(acknowledge).toHaveBeenCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 0 });
    expect(view.container.querySelector("input,textarea,[contenteditable=true]")).toBeNull();
    expect(handlers.size).toBe(1);
  });

  it("shows verified paragraph/run changes through the existing binding and preserves source highlighting", async () => {
    render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await screen.findByText("Old paragraph");
    const after = { ...OUTLINE, elements: OUTLINE.elements!.map((entry) => ({ ...entry, text: "New paragraph" })),
      page: { ...OUTLINE.page, paragraphs: ["New paragraph"] } };
    await emitObservations(handlers, elementEvent(), snapshot(after, 2));
    expect(screen.getByTestId("document-observation-summary")).toHaveTextContent("Paragraph 1, run 1: Old paragraph → New paragraph");
    expect(screen.getByText("New paragraph").getAttribute("data-observation-current")).toBe("true");
    expect(acknowledge).toHaveBeenLastCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 2 });
  });

  it("waits for each rendered image before advancing the snapshot acknowledgement", async () => {
    const rendered: PreviewPageDocument = { ...OUTLINE, page: { ...OUTLINE.page, png: "first", width: 10, height: 10 } };
    read.mockResolvedValueOnce({ ok: true, path: PATH, document: rendered,
      observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } });
    render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    fireEvent.load(await screen.findByTestId("chat-side-panel-pdf-page"));
    expect(acknowledge).toHaveBeenLastCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 0 });
    await emitObservations(handlers, snapshot({ ...rendered, page: { ...rendered.page, png: "second" } }, 1));
    expect(acknowledge).toHaveBeenCalledTimes(1);
    fireEvent.load(screen.getByTestId("chat-side-panel-pdf-page"));
    expect(acknowledge).toHaveBeenLastCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 1 });
  });

  it("rejects unrelated and stale events and releases the exact binding on unmount", async () => {
    const view = render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await screen.findByText("Old paragraph");
    await emitObservations(handlers, { ...elementEvent(), sessionId: "other-session" },
      { ...elementEvent(), target: { id: TARGET, path: "/workspace/other.docx" } },
      { ...elementEvent(), actor: "user" } as never);
    expect(screen.queryByTestId("document-preview-live-strip")).toBeNull();
    await emitObservations(handlers, elementEvent(2));
    await emitObservations(handlers, { ...elementEvent(1), after: "Stale text" });
    expect(screen.getByTestId("document-observation-summary").textContent).not.toContain("Stale text");
    view.unmount();
    expect(handlers.size).toBe(0);
    expect(acknowledge).toHaveBeenLastCalledWith({ action: "release", targetId: TARGET, sessionId: SESSION, seq: 2 });
  });

  it("releases a failed image binding immediately and only once", async () => {
    read.mockResolvedValueOnce({ ok: true, path: PATH, document: { ...OUTLINE,
      page: { ...OUTLINE.page, png: "broken image", width: 10, height: 10 } },
      observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } });
    const view = render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    fireEvent.error(await screen.findByTestId("chat-side-panel-pdf-page"));
    expect(handlers.size).toBe(0);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith({ action: "release", targetId: TARGET, sessionId: SESSION, seq: 0 });
    expect(screen.getByTestId("chat-side-panel-file-error")).toBeTruthy();
    view.unmount();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("ends observation after a terminal render acknowledgement failure", async () => {
    acknowledge.mockResolvedValueOnce({ ok: false, error: "unauthorized" });
    const view = render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await screen.findByText("Old paragraph");
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith({ action: "release", targetId: TARGET, sessionId: SESSION, seq: 0 }));
    expect(handlers.size).toBe(0);
    expect(screen.getByTestId("document-preview-live-strip").getAttribute("role")).toBe("alert");
    view.unmount();
    expect(acknowledge.mock.calls.filter(([request]) => request.action === "release")).toHaveLength(1);
  });

  it("clears source markers on revocation and shows conversion failures as localized errors", async () => {
    const view = render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await screen.findByText("Old paragraph");
    await emitObservations(handlers, elementEvent(), { source: "document", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: PATH },
      seq: 2, ts: 1_700_000_000_000, kind: "status", before: null, after: { code: "reload-required" } });
    expect(view.container.querySelector("[data-observation-current]")).toBeNull();
    view.unmount();
    read.mockResolvedValueOnce({ ok: false, error: "engine-confinement-unavailable", message: "private raw diagnostic" });
    render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    expect(await screen.findByTestId("chat-side-panel-file-error")).toHaveTextContent("Secure isolation");
    expect(screen.queryByText("private raw diagnostic")).toBeNull();
  });

  it("identifies the changed slide shape without treating another shape as current", async () => {
    const slides: PreviewPageDocument = { ...OUTLINE, format: "pptx", elements: [
      { element: { kind: "shape", slide: 0, shapeId: "heading" }, text: "Title" },
      { element: { kind: "shape", slide: 0, shapeId: "body" }, text: "Body" },
    ] };
    read.mockResolvedValueOnce({ ok: true, path: PATH, document: slides,
      observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } });
    render(<PageDocumentPreview path={PATH} sessionId={SESSION} observe />);
    await screen.findByText("Title");
    const event = elementEvent();
    if (event.kind !== "element") throw new Error("Invalid element fixture");
    await emitObservations(handlers, { ...event, element: { kind: "shape", slide: 0, shapeId: "body" }, before: "Body", after: "Updated body" });
    expect(screen.getByText("Body").getAttribute("data-observation-current")).toBe("true");
    expect(screen.getByText("Title").getAttribute("data-observation-current")).toBeNull();
    expect(screen.getByTestId("document-observation-summary")).toHaveTextContent("Slide 1, shape body");
  });
});
