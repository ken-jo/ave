// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewDetail } from "../../components/ChatSidePanelPreview.js";
import { PreviewDocumentHeader, PreviewDocumentLiveStrip, previewFormatLabel } from "../preview-document-chrome.js";
import type { AgentObservationEvent, DocumentObservationEvent, PreviewObservedTextDocument } from "../../../../shared/agent-observation.js";
import type { ChatPreviewTarget } from "../preview-targets.js";
import { en, ko } from "../../../../i18n/messages/generated/chatPreviewRail.js";

const renderDiagram = vi.hoisted(() => vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Flow</text></svg>' })));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderDiagram } }));

const SESSION = "text-agent-session";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATH = "/workspace/src/tools/report.ts";
const DOCUMENT: PreviewObservedTextDocument = { format: "text", content: "const total = 1;\nexport { total };",
  lines: ["const total = 1;", "export { total };"], totalLines: 2, truncated: false };
const FILE: ChatPreviewTarget = { kind: "file", id: "file-report", title: "report.ts", path: PATH,
  workspaceRoot: "/workspace", sourceLabel: "open document · builtin", canOpenExternal: true, createdOrder: 0 };
let previousAve: unknown;
let readFile: ReturnType<typeof vi.fn>;
let acknowledge: ReturnType<typeof vi.fn>;
let handlers: Set<(events: AgentObservationEvent[]) => void>;

beforeEach(() => {
  previousAve = window.ave;
  handlers = new Set();
  acknowledge = vi.fn(async () => ({ ok: true }));
  readFile = vi.fn(async () => ({ ok: true, path: PATH, content: DOCUMENT.content,
    lineCount: 2, truncated: false, document: DOCUMENT, observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } }));
  (window as unknown as { ave: unknown }).ave = { attach: { openExternal: vi.fn(async () => ({ ok: true })) }, preview: {
    readFile, acknowledgeObservation: acknowledge,
    onAgentObservation: vi.fn((handler: (events: AgentObservationEvent[]) => void) => {
      handlers.add(handler); return () => handlers.delete(handler);
    }),
  } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); (window as unknown as { ave: unknown }).ave = previousAve; });

function lineEvent(seq: number, line: number, before: string, after: string): DocumentObservationEvent {
  return { source: "document", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: PATH },
    seq, ts: 1_700_000_000_000, kind: "element", element: { kind: "line", line }, before, after, advisory: false };
}
async function emit(...events: AgentObservationEvent[]): Promise<void> {
  await act(async () => { handlers.forEach((handler) => handler(events)); });
}
async function openText() {
  const view = render(<PreviewDetail api={{} as never} sessionId={SESSION} target={FILE} />);
  await screen.findByTestId("document-text-lines");
  return view;
}

describe("shared document viewer chrome", () => {
  it.each([
    "/work/project/README",
    "/work/project.with-dot/README",
    "C:\\work\\project.with-dot\\README",
    "/work/project/.gitignore",
  ])("labels an extensionless file without exposing its directory: %s", (path) => {
    expect(previewFormatLabel(path)).toBe("Text");
  });

  it("uses one compact header with relative path and icon-only accessible actions", async () => {
    await openText();
    const header = screen.getByTestId("document-preview-header");
    expect(screen.getAllByTestId("document-preview-header")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "report.ts" })).toBeTruthy();
    expect(screen.getByTestId("preview-document-path").textContent).toBe("src/tools/");
    expect(screen.getByTestId("preview-document-path").title).toBe(PATH);
    expect(header.textContent).toBe("report.tssrc/tools/");
    expect(header.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "기본 앱으로 열기" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "복사" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "다시 불러오기" }).textContent).toBe("");
    expect(screen.queryByText("open document · builtin")).toBeNull();
    expect(screen.getByTestId("document-preview-footer").textContent).toBe("TypeScript · 2줄");
  });

  it("ignores browser events even when a document target identity is reused in the batch", async () => {
    await openText();
    await emit({ source: "browser", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: PATH, hostSessionId: SESSION },
      seq: 1, ts: 1_000, kind: "status", before: null, after: { code: "observation-error" } });
    expect(screen.queryByTestId("document-preview-live-strip")).toBeNull();
    expect(screen.queryByTestId("browser-preview-live-strip")).toBeNull();
  });

  it("has no live strip until this document receives agent activity", async () => {
    await openText();
    expect(screen.queryByTestId("document-preview-live-strip")).toBeNull();
    expect(screen.queryByTestId("document-line-change")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(readFile).toHaveBeenCalledWith(PATH, { workspaceRoot: "/workspace", sessionId: SESSION });
  });

  it("offers the default app after a host read even when the tool target had no picker grant", async () => {
    const canonicalPath = "/workspace/src/tools/canonical-report.ts";
    readFile.mockResolvedValueOnce({ ok: true, path: canonicalPath, content: DOCUMENT.content, document: DOCUMENT });
    const view = render(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, canOpenExternal: false }} />);
    const button = await screen.findByRole("button", { name: "기본 앱으로 열기" });
    fireEvent.click(button);
    expect(window.ave.attach.openExternal).toHaveBeenCalledWith(canonicalPath);
    expect(screen.getByTestId("preview-document-path").title).toBe(canonicalPath);
    expect(view.container.querySelector("input, textarea, [contenteditable=true]")).toBeNull();
    const header = screen.getByTestId("document-preview-header");
    expect([...view.container.querySelectorAll("button")].every((action) => header.contains(action))).toBe(true);
  });

  it("does not invent an external-open grant before a read or for an inline snippet", async () => {
    readFile.mockResolvedValueOnce({ ok: false, error: "read-failed" });
    const view = render(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, canOpenExternal: false }} />);
    expect(screen.queryByRole("button", { name: "기본 앱으로 열기" })).toBeNull();
    await screen.findByTestId("chat-side-panel-file-error");
    expect(screen.queryByRole("button", { name: "기본 앱으로 열기" })).toBeNull();
    view.rerender(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, inlineText: "Indexed source", canOpenExternal: false }} />);
    expect(screen.queryByRole("button", { name: "기본 앱으로 열기" })).toBeNull();
    view.rerender(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, inlineText: "Indexed source", canOpenExternal: true }} />);
    expect(screen.getByRole("button", { name: "기본 앱으로 열기" })).toBeTruthy();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("does not synthesize a script-associated default-app action from a successful preview read", async () => {
    const path = "/workspace/scripts/report.js";
    readFile.mockResolvedValueOnce({ ok: true, path, content: DOCUMENT.content, document: DOCUMENT });
    const view = render(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, path, canOpenExternal: false }} />);
    await screen.findByText(/const total = 1;/);
    expect(screen.queryByRole("button", { name: "기본 앱으로 열기" })).toBeNull();
    expect(screen.getByRole("button", { name: "복사" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toBeTruthy();
    view.rerender(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, path, canOpenExternal: true }} />);
    expect(screen.getByRole("button", { name: "기본 앱으로 열기" })).toBeTruthy();
  });

  it.each(["refusal", "rejection"] as const)("localizes a default-app %s in the shared slot without agent attribution", async (outcome) => {
    await openText();
    await emit(lineEvent(1, 1, "const total = 1;", "const total = 12;"));
    const open = vi.mocked(window.ave.attach.openExternal);
    if (outcome === "refusal") open.mockResolvedValueOnce({ ok: false, error: "raw private failure detail" });
    else open.mockRejectedValueOnce(new Error("raw private failure detail"));
    fireEvent.click(screen.getByRole("button", { name: "기본 앱으로 열기" }));
    const error = await screen.findByRole("alert");
    expect(error).toBe(screen.getByTestId("document-preview-live-strip"));
    expect(error.textContent).toBe("기본 앱으로 파일을 열지 못했습니다.");
    expect(error.querySelector("[aria-hidden=true]")).toBeNull();
    expect(error.textContent).not.toContain("raw private failure detail");
    expect(screen.getAllByTestId("document-preview-live-strip")).toHaveLength(1);
  });

  it("keeps an idle bound markdown preview formatted until confirmed line events arrive", async () => {
    const path = "/workspace/docs/readme.md";
    const document: PreviewObservedTextDocument = { format: "text", content: "# Report\nOriginal paragraph",
      lines: ["# Report", "Original paragraph"], totalLines: 2, truncated: false };
    readFile.mockResolvedValueOnce({ ok: true, path, content: document.content, document,
      observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } });
    render(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, path, title: "readme.md" }} />);
    expect(await screen.findByRole("heading", { name: "Report" })).toBeTruthy();
    expect(screen.queryByTestId("document-text-lines")).toBeNull();
    expect(screen.queryByTestId("document-preview-live-strip")).toBeNull();
    expect(acknowledge).toHaveBeenCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 0 });
    await emit({ ...lineEvent(1, 2, "Original paragraph", "Updated paragraph"), target: { id: TARGET, path } });
    expect(screen.queryByTestId("chat-side-panel-markdown")).toBeNull();
    expect(screen.getByTestId("document-line-value").textContent).toBe("Updated paragraph");
    expect(screen.getByTestId("document-preview-live-strip").textContent).toContain("에이전트가 수정함");
  });

  it("keeps an idle bound diagram and acknowledges its completed frame rather than its loading text", async () => {
    const path = "/workspace/docs/flow.mmd";
    const document: PreviewObservedTextDocument = { format: "text", content: "graph TD; A-->B;",
      lines: ["graph TD; A-->B;"], totalLines: 1, truncated: false };
    readFile.mockResolvedValueOnce({ ok: true, path, content: document.content, document,
      observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } });
    let finish!: (value: { svg: string }) => void;
    renderDiagram.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, path, title: "flow.mmd" }} />);
    await screen.findByText("다이어그램 렌더링 중…");
    expect(acknowledge).not.toHaveBeenCalled();
    await act(async () => { finish({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Flow</text></svg>' }); });
    const frame = await screen.findByTestId("chat-side-panel-mermaid-frame");
    expect(screen.queryByTestId("document-text-lines")).toBeNull();
    fireEvent.load(frame);
    expect(acknowledge).toHaveBeenCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 0 });
  });

  it("waits for every embedded diagram before acknowledging a formatted markdown baseline", async () => {
    const path = "/workspace/docs/diagrams.md";
    const lines = ["```mermaid", "graph TD; A-->B;", "```", "```mermaid", "graph TD; C-->D;", "```"];
    const document: PreviewObservedTextDocument = { format: "text", content: lines.join("\n"), lines, totalLines: 6, truncated: false };
    readFile.mockResolvedValueOnce({ ok: true, path, content: document.content, document,
      observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } });
    let first!: (value: { svg: string }) => void;
    let second!: (value: { svg: string }) => void;
    renderDiagram.mockReturnValueOnce(new Promise((resolve) => { first = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { second = resolve; }));
    render(<PreviewDetail api={{} as never} sessionId={SESSION} target={{ ...FILE, path, title: "diagrams.md" }} />);
    expect(await screen.findAllByText("다이어그램 렌더링 중…")).toHaveLength(2);
    expect(acknowledge).not.toHaveBeenCalled();
    await act(async () => { first({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>First</text></svg>' }); });
    fireEvent.load(await screen.findByTestId("chat-side-panel-mermaid-frame"));
    expect(acknowledge).not.toHaveBeenCalled();
    await act(async () => { second({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Second</text></svg>' }); });
    const frames = await screen.findAllByTestId("chat-side-panel-mermaid-frame");
    fireEvent.load(frames[1]);
    expect(acknowledge).toHaveBeenCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 0 });
    expect(screen.queryByTestId("document-preview-live-strip")).toBeNull();
  });

  it("subscribes before read and acknowledges only after the text is in the DOM", async () => {
    readFile.mockImplementation(async () => {
      expect(handlers.size).toBe(1);
      return { ok: true, path: PATH, content: DOCUMENT.content, document: DOCUMENT,
        observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } };
    });
    acknowledge.mockImplementation(async () => {
      expect(screen.getByTestId("document-text-lines").textContent).toContain("const total = 1;");
      return { ok: true };
    });
    await openText();
    expect(acknowledge).toHaveBeenCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 0 });
  });

  it("highlights changed lines and keeps the latest target distinct after the verified snapshot", async () => {
    await openText();
    await emit(lineEvent(1, 1, "const total = 1;", "const total = 12;"),
      lineEvent(2, 2, "export { total };", "export default total;"),
      { source: "document", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: PATH }, seq: 3,
        ts: 1_700_000_000_001, kind: "snapshot", before: null, after: { ...DOCUMENT,
          content: "const total = 12;\nexport default total;", lines: ["const total = 12;", "export default total;"] } });
    expect(screen.getAllByTestId("document-line-value").map((line) => line.textContent))
      .toEqual(["const total = 12;", "export default total;"]);
    expect(screen.getAllByTestId("document-line-change").map((line) => line.dataset.current)).toEqual(["false", "true"]);
    expect(screen.getByTestId("document-observation-summary").textContent).toBe("2곳 · 1–2줄");
    expect(screen.getByTestId("document-observation-status").textContent).toBe("에이전트가 수정함");
    expect(screen.getByText("Ave").getAttribute("aria-hidden")).toBe("true");
    expect(acknowledge).toHaveBeenLastCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 3 });
  });

  it("refuses unrelated, user and stale line events and releases the exact binding", async () => {
    const view = await openText();
    const event = lineEvent(1, 1, "const total = 1;", "wrong content");
    await emit({ ...event, sessionId: "other" }, { ...event, target: { id: TARGET, path: "/workspace/other.ts" } },
      { ...event, actor: "user" } as never);
    expect(screen.queryByTestId("document-preview-live-strip")).toBeNull();
    await emit(lineEvent(2, 1, "const total = 1;", "const total = 12;"));
    await emit(event);
    expect(screen.getByTestId("document-observation-summary").textContent).toBe("1곳 · 1–1줄");
    view.unmount();
    expect(handlers.size).toBe(0);
    expect(acknowledge).toHaveBeenCalledWith({ action: "release", targetId: TARGET, sessionId: SESSION, seq: 2 });
  });

  it("places resynchronization errors in the live-strip slot", async () => {
    await openText();
    await emit({ source: "document", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: PATH }, seq: 1,
      ts: 1_700_000_000_001, kind: "status", before: null, after: { code: "resync-required" } });
    expect(screen.getByTestId("document-preview-live-strip").getAttribute("role")).toBe("alert");
    expect(screen.getByRole("alert").textContent).toBe("실시간 업데이트를 다시 맞춰야 합니다. 파일을 다시 불러오세요.");
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    await waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
  });

  it("localizes activity labels, blank values and metadata in both catalogs", () => {
    expect(en["chatPreviewRail.documentObservationLive"]).toBe("Agent edited");
    expect(ko["chatPreviewRail.documentObservationLive"]).toBe("에이전트가 수정함");
    expect(en["chatPreviewRail.documentObservationReconciling"]).toBe("Agent editing");
    expect(ko["chatPreviewRail.documentObservationReconciling"]).toBe("에이전트 편집 중");
    expect(en["chatPreviewRail.documentObservationBlank"]).toBe("blank");
    expect(ko["chatPreviewRail.documentLineCount"]).toBe("{count}줄");
    expect(en["chatPreviewRail.openDefaultAppError"]).toBe("Could not open this file in the default app.");
    expect(ko["chatPreviewRail.openDefaultAppError"]).toBe("기본 앱으로 파일을 열지 못했습니다.");
    const view = render(<PreviewDocumentLiveStrip />);
    expect(view.container.innerHTML).toBe("");
  });

  it("ages activity recency while the strip remains visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    render(<PreviewDocumentLiveStrip status="live" summary="B2: 1 → 12" ts={1_700_000_000_000} />);
    expect(screen.getByTestId("document-preview-live-strip").querySelector("time")?.textContent).toBe("방금");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId("document-preview-live-strip").querySelector("time")?.textContent).toBe("1분");
  });

  it("ellipsizes a deep external parent while retaining the full path", () => {
    render(<PreviewDocumentHeader path="/outside/deep/nested/folder/report.xlsx" canOpenExternal={false} />);
    expect(screen.getByTestId("preview-document-path").textContent).toBe("…/nested/folder/");
    expect(screen.getByTestId("preview-document-path").title).toBe("/outside/deep/nested/folder/report.xlsx");
  });
});
