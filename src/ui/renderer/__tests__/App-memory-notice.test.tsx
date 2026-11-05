// @vitest-environment jsdom
/** A memory notice in a conversation leads to the memory panel, and "Ave 에게 고치기" opens a new chat whose composer names the memory. */
import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../App.js";
import { makeMockAveApi, makeMockAveNamespace } from "../../../../test/renderer/mock-ave-api.js";
import type { MemorySaveResultEvent } from "../../../shared/memory-save-result.js";

const DEFAULT_ROOT = "C:\\Users\\example\\.ave\\workspace";
const FIRST_SESSION = "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10";
const NEXT_SESSION = "9e8d7c6b-5a49-4382-9716-0f1e2d3c4b5a";
const TITLE = "결제 API 타임아웃은 8초";

type HistoryMessage = { index: number; role: "user" | "assistant"; content: string; messageId: string };

function mountApp(firstMessages: HistoryMessage[] = [], sessions?: Array<{ id: string; title: string; modifiedAt: string }>) {
  const { api } = makeMockAveApi({ currentSession: FIRST_SESSION, ...(sessions ? { sessions } : {}) });
  const { ns } = makeMockAveNamespace();
  (ns as unknown as { workspace: { listRoots: ReturnType<typeof vi.fn> } }).workspace.listRoots.mockImplementation(async () => ({
    ok: true,
    defaultRoot: DEFAULT_ROOT,
    roots: [{ path: DEFAULT_ROOT, isDefault: true }],
  }));
  let sessionId = FIRST_SESSION;
  let sessionProject: { projectRoot?: string; projectName?: string } = {};
  api.chatNew.mockImplementation(async (project?: { projectRoot?: string; projectName?: string }) => {
    // A new chat is a new conversation: the next history read names it.
    sessionId = NEXT_SESSION;
    sessionProject = project ?? {};
    return { ok: true };
  });
  // Loading a conversation from the sidebar makes it the one the next history read names.
  api.chatSessionResume.mockImplementation(async (id: string) => {
    sessionId = id;
    return { ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 };
  });
  api.chatGetHistory.mockImplementation(async () => ({
    sessionId,
    messages: sessionId === FIRST_SESSION ? firstMessages : [],
    ...sessionProject,
  }) as never);
  api.memoryListEntries.mockImplementation(async () => [
    { id: "m1", filename: "timeout.md", title: TITLE, content: `# ${TITLE}\n\n게이트웨이 기준`, updatedAt: new Date().toISOString() },
  ]);
  let emit: (event: MemorySaveResultEvent) => void = () => {};
  api.onMemorySaveResult.mockImplementation((handler: (event: MemorySaveResultEvent) => void) => {
    emit = handler;
    return () => {};
  });

  vi.stubGlobal("aveApi", api);
  vi.stubGlobal("ave", ns);
  (window as unknown as { aveApi: unknown }).aveApi = api;
  (window as unknown as { ave: unknown }).ave = ns;
  return { api, emit: (event: MemorySaveResultEvent) => act(() => emit(event)), ...render(<App />) };
}

describe("App memory notices and Ave 에게 고치기", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("anchors a notice under its message, and 다시 시도 puts a failed /remember back in the composer", async () => {
    const { api, emit } = mountApp([
      { index: 0, role: "user", content: "/remember 결제 타임아웃은 8초", messageId: "u1" },
      { index: 1, role: "assistant", content: "기억하지 못했어요.", messageId: "a1" },
      { index: 2, role: "user", content: "다음 질문", messageId: "u2" },
      { index: 3, role: "assistant", content: "답", messageId: "a2" },
    ]);
    await waitFor(() => expect(api.onMemorySaveResult).toHaveBeenCalled());
    await screen.findByText("다음 질문");

    emit({ sessionId: FIRST_SESSION, anchorMessageId: "u1", result: { status: "skipped", reason: "reviewer-unavailable" } });
    const log = screen.getByTestId("chat-transcript-log");
    const notice = await within(log).findByText("저장하지 못했어요 · 잠시 뒤 다시 해 주세요");
    // Under the /remember row, before the next question; never in the composer dock.
    expect(screen.getByText("/remember 결제 타임아웃은 8초").compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(screen.getByText("다음 질문")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(log).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("/remember 결제 타임아웃은 8초"));
    expect(api.chatSend).not.toHaveBeenCalled();

    // A notice with no row on screen follows the last row.
    emit({ sessionId: FIRST_SESSION, result: { status: "saved", op: "created", entry: { id: "m2", filename: "b.md", title: "B", scope: "global" } } });
    const trailing = await within(log).findByText("기억에 저장 · B");
    expect(screen.getByText("답").compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the save in the conversation, opens the panel on 보기, and starts a prefilled fix chat", async () => {
    const { api, emit } = mountApp();
    await waitFor(() => expect(api.onMemorySaveResult).toHaveBeenCalled());
    await waitFor(() => expect(api.chatGetHistory).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    // Unsent text in the empty chat that the fix chat replaces must survive.
    fireEvent.change(document.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "게이트웨이가 10초로 바뀌었어" } });

    emit({
      sessionId: FIRST_SESSION,
      result: { status: "saved", op: "created", entry: { id: "m1", filename: "timeout.md", title: TITLE, scope: "global" }, undoToken: "11111111-2222-4333-8444-555555555555" },
    });
    const notices = await screen.findByTestId("memory-save-notices");
    expect(notices.textContent).toContain(`기억에 저장 · ${TITLE}`);

    fireEvent.click(within(notices).getByRole("button", { name: "보기" }));
    const panel = await screen.findByTestId("memory-search-panel");
    expect((within(panel).getByRole("textbox", { name: "메모리 검색" }) as HTMLInputElement).value).toBe(TITLE);

    fireEvent.click(await within(await within(panel).findByRole("tabpanel")).findByRole("button", { name: new RegExp(TITLE) }));
    fireEvent.click(within(panel).getByRole("button", { name: `Ave 에게 기억 고치기: ${TITLE}` }));

    await waitFor(() => expect(api.chatNew).toHaveBeenCalledWith({ projectRoot: DEFAULT_ROOT, projectName: expect.any(String) }));
    await waitFor(() => {
      const composer = document.querySelector("textarea") as HTMLTextAreaElement | null;
      expect(composer?.value).toBe(`기억 "${TITLE}" 를 고쳐 줘: 게이트웨이가 10초로 바뀌었어`);
    });
    // The cursor waits in the composer, after the request, for the user to add the correction.
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("textarea")));
    // The card above the composer names the memory being fixed.
    const card = await screen.findByTestId("memory-fix-card");
    expect(card.textContent).toContain("메모리에서 열림 · 고칠 기억");
    expect(card.textContent).toContain(TITLE);
    expect(card.textContent).toContain("게이트웨이 기준");
    // Nothing is sent until the user sends it.
    expect(api.chatSend).not.toHaveBeenCalled();

  });
  it("drops the fix card once its request is sent, so returning to that chat leaves focus where it was", async () => {
    const sessions = [
      { id: FIRST_SESSION, title: "첫 대화", modifiedAt: new Date(2026, 0, 2).toISOString() },
      { id: NEXT_SESSION, title: "고치기 대화", modifiedAt: new Date(2026, 0, 3).toISOString() },
    ];
    const { api, emit, container } = mountApp([], sessions);
    await waitFor(() => expect(api.onMemorySaveResult).toHaveBeenCalled());
    await waitFor(() => expect(api.chatGetHistory).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    emit({
      sessionId: FIRST_SESSION,
      result: { status: "saved", op: "created", entry: { id: "m1", filename: "timeout.md", title: TITLE, scope: "global" } },
    });
    fireEvent.click(within(await screen.findByTestId("memory-save-notices")).getByRole("button", { name: "보기" }));
    const panel = await screen.findByTestId("memory-search-panel");
    fireEvent.click(await within(await within(panel).findByRole("tabpanel")).findByRole("button", { name: new RegExp(TITLE) }));
    fireEvent.click(within(panel).getByRole("button", { name: `Ave 에게 기억 고치기: ${TITLE}` }));
    await screen.findByTestId("memory-fix-card");
    const composer = () => document.querySelector("textarea") as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(composer()));

    fireEvent.change(composer(), { target: { value: `${composer().value}10초로 바뀌었어` } });
    fireEvent.keyDown(composer(), { key: "Enter", code: "Enter" });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("memory-fix-card")).toBeNull());

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-collapse-toggle"]');
    if (toggle && toggle.getAttribute("aria-pressed") !== "true") await act(async () => { fireEvent.click(toggle); });
    const sidebarRow = (id: string) => waitFor(() => {
      const row = container.querySelector<HTMLButtonElement>(`[data-testid="sidebar-session-${id}"]`);
      if (!row) throw new Error("row not rendered");
      return row;
    });
    await act(async () => { fireEvent.click(await sidebarRow(FIRST_SESSION)); });
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(FIRST_SESSION));
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => { fireEvent.click(await sidebarRow(NEXT_SESSION)); });
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(NEXT_SESSION));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });

    expect(document.activeElement).not.toBe(composer());
    expect(screen.queryByTestId("memory-fix-card")).toBeNull();
  });
});
