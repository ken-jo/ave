import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemorySearchPanel } from "../MemorySearchPanel.js";
import type { AveApi } from "../../types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";

type UserEventDriver = {
  click(target: HTMLElement): Promise<void>;
};

function setupUser(): UserEventDriver {
  return (userEvent as unknown as { setup: () => UserEventDriver }).setup();
}

function summariesForNotes(notes: Extract<Awaited<ReturnType<AveApi["memoryGetSummaries"]>>, { ok: true }>["notes"]) {
  return {
    ok: true as const,
    notes,
    entries: notes.filter((note) => note.id).map((note) => ({
      id: note.id!, kind: note.kind,
      origin: note.origin ? { status: "recorded" as const, sessionId: note.origin.sessionId } : { status: "absent" as const },
      useCount: 0, createdAt: note.createdAt, updatedAt: note.updatedAt,
    })),
    scopeCounts: { project: notes.filter((note) => !note.id || note.projectRoot).length, global: notes.filter((note) => note.id && !note.projectRoot).length, defaultProject: 0, defaultProjectApplicable: false },
  };
}

function memorySearchPanelApi(): AveApi {
  const { api } = makeMockAveApi();
  Object.assign(api, {
    memoryGetIndex: vi.fn(async () => ""),
    memoryGetDetail: vi.fn(async () => ({ ok: true, origin: { status: "absent" }, history: { entries: [] }, usage: { entries: [] } })),
    memoryGetSummaries: vi.fn(async () => summariesForNotes([])),
    memoryListSessions: vi.fn(async () => [
      {
        sessionId: "11111111-2222-3333-4444-555555555555",
        title: "분기 후 확인 대화",
        matchedMessage: "캘린더 세션 목록에서 열어야 하는 대화입니다.",
        timestamp: "2026-05-20T08:00:00.000Z",
      },
    ]),
    memorySearchEntries: vi.fn(async () => []),
    memorySearchSessions: vi.fn(async () => []),
  });
  return api as unknown as AveApi;
}

const noFix = vi.fn(async () => true);

const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const PROJECT = { projectRoot: "C:\\workspace\\alpha", projectName: "alpha" };

function panelWithMemories() {
  const api = memorySearchPanelApi() as unknown as ReturnType<typeof makeMockAveApi>["api"];
  let entries = [
    { id: "m1", filename: "timeout.md", title: "결제 API 타임아웃은 8초", content: "# 결제 API 타임아웃은 8초\n\n게이트웨이 기준", updatedAt: RECENT, projectRoot: PROJECT.projectRoot, projectName: "alpha" },
    { filename: "old.md", title: "오래된 메모", content: "# 오래된 메모\n\n지난달", updatedAt: OLD },
  ];
  const deletedEntry = entries[0]!;
  api.memoryGetSummaries.mockImplementation(async () => summariesForNotes(entries));
  api.memoryGetIndex.mockImplementation(async () => "# MEMORY\n\n지침");
  api.memoryDeleteEntry.mockImplementation(async (filename: string) => {
    entries = entries.filter((entry) => entry.filename !== filename);
    return { ok: true, undoToken: "11111111-2222-4333-8444-555555555555" };
  });
  api.memoryUndo.mockImplementation(async () => {
    entries = [deletedEntry, ...entries];
    return { ok: true, undone: "deleted", title: deletedEntry.title };
  });
  return api;
}

describe("MemorySearchPanel", () => {
  it("intersects kind and source with counts, keeps legacy notes reachable and clears an empty filter", async () => {
    const api = memorySearchPanelApi();
    const notes = [
      { filename: "fact.md", title: "배운 사실", content: "사실", kind: "fact" as const, source: "assistant" as const },
      { filename: "preference.md", title: "사용자 선호", content: "선호", kind: "preference" as const, source: "user" as const },
      { filename: "legacy.md", title: "이전 형식", content: "메모" },
    ];
    Object.assign(api, { memoryGetSummaries: vi.fn(async () => summariesForNotes(notes)), memoryGetIndex: vi.fn(async () => "# Instructions\n\nIndex") });
    render(<MemorySearchPanel api={api} onAskAveToFix={noFix} />);
    const kinds = await screen.findByRole("group", { name: "종류" });
    const sources = screen.getByRole("group", { name: "저장 방식" });
    await waitFor(() => expect(within(kinds).getByRole("button", { name: "전체 3" })).toBeTruthy());
    expect(within(kinds).getByRole("button", { name: "메모 1" })).toBeTruthy();
    expect(within(sources).getByRole("button", { name: "기록 없음 1" })).toBeTruthy();
    const user = (userEvent as unknown as { setup: () => { tab(): Promise<void>; keyboard(keys: string): Promise<void> } }).setup();
    const fact = within(kinds).getByRole("button", { name: "사실 1" });
    fact.focus();
    await user.keyboard("{Enter}");
    expect(fact.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /사용자 선호/ })).toBeNull();
    expect(within(sources).getByRole("button", { name: "사용자 0" })).toBeTruthy();
    fireEvent.click(within(sources).getByRole("button", { name: "사용자 0" }));
    expect(screen.getByText("선택한 필터에 맞는 기억이 없습니다.")).toBeTruthy();
    expect(screen.queryByText(/아직 저장된 기억이 없습니다/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "필터 지우기" }));
    expect(screen.getByRole("button", { name: /사용자 선호/ })).toBeTruthy();
    fireEvent.click(within(sources).getByRole("button", { name: "기록 없음 1" }));
    expect(screen.getByRole("button", { name: /^이전 형식/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /메모리 인덱스/ })).toBeNull();
  });

  it("re-queries saved changes and replaces the filtered list rather than appending event entries", async () => {
    const api = memorySearchPanelApi();
    const note = { filename: "fact.md", title: "배운 사실", content: "사실", kind: "fact" as const, source: "assistant" as const };
    const getSummaries = vi.fn().mockResolvedValue(summariesForNotes([note]));
    let notify!: Parameters<AveApi["onMemorySaveResult"]>[0];
    const unsubscribe = vi.fn();
    Object.assign(api, { memoryGetSummaries: getSummaries, onMemorySaveResult: vi.fn((handler) => { notify = handler; return unsubscribe; }) });
    const { unmount } = render(<MemorySearchPanel api={api} onAskAveToFix={noFix} />);
    const kinds = await screen.findByRole("group", { name: "종류" });
    fireEvent.click(await within(kinds).findByRole("button", { name: "사실 1" }));
    getSummaries.mockResolvedValue(summariesForNotes([]));
    notify({ sessionId: "session", result: { status: "saved", op: "deleted", entry: { id: "deleted", filename: "fact.md", title: "Event only", scope: "global" } } });
    await waitFor(() => expect(within(kinds).getByRole("button", { name: "사실 0" })).toBeTruthy());
    expect(getSummaries).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /^배운 사실/ })).toBeNull();
    expect(screen.queryByText("Event only")).toBeNull();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("counts the search results inside the selected scope and leaves chat history independent", async () => {
    const api = memorySearchPanelApi();
    const notes = [
      { id: "project", filename: "project.md", title: "프로젝트 사실", content: "사실", projectRoot: PROJECT.projectRoot, kind: "fact" as const, source: "user" as const },
      { id: "global", filename: "global.md", title: "전역 사실", content: "사실", kind: "fact" as const, source: "assistant" as const },
    ];
    Object.assign(api, {
      memoryGetSummaries: vi.fn(async () => summariesForNotes(notes)),
      memorySearchEntries: vi.fn(async () => [{ ...notes[0], excerpt: "검색한 사실" }]),
      memorySearchSessions: vi.fn(async () => [{ sessionId: "chat", title: "검색 대화", matchedMessage: "검색", timestamp: RECENT }]),
    });
    render(<MemorySearchPanel api={api} project={PROJECT} onAskAveToFix={noFix} />);
    const kinds = await screen.findByRole("group", { name: "종류" });
    await within(kinds).findByRole("button", { name: "사실 2" });
    fireEvent.click(within(screen.getByRole("region", { name: "기억 범위" })).getByRole("button", { name: /^alpha/ }));
    expect(within(kinds).getByRole("button", { name: "사실 1" })).toBeTruthy();
    fireEvent.click(within(kinds).getByRole("button", { name: "사실 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "메모리 검색" }), { target: { value: "검색" } });
    await waitFor(() => expect(api.memorySearchEntries).toHaveBeenCalledWith("검색", { projectRoot: PROJECT.projectRoot, projectName: "alpha", includeUnscoped: false }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "저장 방식" })).getByRole("button", { name: "사용자 1" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /전역 사실/ })).toBeNull();
    await setupUser().click(screen.getByRole("tab", { name: /^채팅 목록/ }));
    expect(await screen.findByRole("button", { name: /검색 대화/ })).toBeTruthy();
  });

  it.each([
    ["C:\\workspace\\alpha", "c:/WORKSPACE/ALPHA/"],
    ["/workspace/alpha", "/workspace/alpha/"],
    ["\\\\server\\share\\workspace", "//SERVER/SHARE/WORKSPACE/"],
  ])("omits the duplicate default-project card for equivalent roots %s and %s", async (projectRoot, defaultRoot) => {
    render(<MemorySearchPanel api={memorySearchPanelApi()} project={{ projectRoot, projectName: "alpha" }} defaultProject={{ projectRoot: defaultRoot, projectName: "default", isDefault: true }} onAskAveToFix={noFix} />);
    const scopes = await screen.findByRole("region", { name: "기억 범위" });
    expect(within(scopes).queryByText("기본 프로젝트", { exact: true })).toBeNull();
    expect(within(scopes).getAllByRole("button")).toHaveLength(2);
  });

  it("shows only the summary failure instead of claiming the project has no memories", async () => {
    const api = memorySearchPanelApi();
    const onStartConversation = vi.fn(async () => true);
    Object.assign(api, { memoryGetSummaries: vi.fn(async () => ({ ok: false, error: "read-failed" })) });
    render(<MemorySearchPanel api={api} project={PROJECT} onStartConversation={onStartConversation} onAskAveToFix={noFix} />);
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toBe("기억 목록 요약을 불러오지 못했습니다. 패널을 다시 열어 주세요.");
    expect(screen.getByTestId("memory-search-panel").textContent).toBe(warning.textContent);
    expect(screen.queryByRole("button", { name: "새 대화에서 알려 주기" })).toBeNull();
    expect(screen.queryByText(/아직 저장된 기억이 없습니다/)).toBeNull();
    expect(onStartConversation).not.toHaveBeenCalled();
    expect(api.memoryGetDetail).not.toHaveBeenCalled();
  });

  it("opens a new conversation from an empty project and shows global memories beside it", async () => {
    const api = memorySearchPanelApi();
    const note = { id: "global-memory", filename: "global.md", title: "모든 프로젝트의 선호", content: "짧게 답변", updatedAt: OLD };
    Object.assign(api, { memoryGetSummaries: vi.fn(async () => ({ ...summariesForNotes([note]), scopeCounts: { project: 0, global: 1, defaultProject: 3, defaultProjectApplicable: false } })) });
    const onStartConversation = vi.fn(async () => true);
    render(<MemorySearchPanel api={api} project={PROJECT} defaultProject={{ projectRoot: "C:\\workspace\\default", projectName: "default", isDefault: true }} onStartConversation={onStartConversation} onAskAveToFix={noFix} />);
    const globalList = await screen.findByRole("complementary", { name: "전역 기억" });
    expect(within(globalList).getByRole("button", { name: /모든 프로젝트의 선호/ })).toBeTruthy();
    expect(screen.getByRole("region", { name: "기억 범위" }).textContent).toContain("여기엔 적용 안 됨");
    fireEvent.click(screen.getByRole("button", { name: "새 대화에서 알려 주기" }));
    await waitFor(() => expect(onStartConversation).toHaveBeenCalledTimes(1));
    expect(api.memoryGetDetail).not.toHaveBeenCalled();
  });

  it("does not label an unscoped legacy note as global", async () => {
    const api = memorySearchPanelApi();
    const note = { filename: "legacy.md", title: "이전 기억", content: "이전 형식의 본문", updatedAt: OLD };
    Object.assign(api, { memoryGetSummaries: vi.fn(async () => summariesForNotes([note])) });
    render(<MemorySearchPanel api={api} project={{ ...PROJECT, isDefault: true }} onAskAveToFix={noFix} />);
    const row = await screen.findByRole("button", { name: /^이전 기억/ });
    expect(row.textContent).not.toContain("전역");
  });

  it("shows idle wording and a recent saved band with source and save time", async () => {
    const api = memorySearchPanelApi();
    const oldAt = new Date(Date.now() - 38 * 24 * 60 * 60 * 1000).toISOString();
    const notes = [
      { id: "unused", filename: "unused.md", title: "안 쓰는 콜백", content: "지난 연동", createdAt: oldAt, updatedAt: oldAt },
      { id: "recent", filename: "recent.md", title: "새로 배운 선호", content: "세 줄 요약", createdAt: RECENT, updatedAt: RECENT },
    ];
    const summaries = summariesForNotes(notes);
    summaries.entries[1]!.origin = { status: "recorded", sessionId: "review-source" };
    Object.assign(api, { memoryGetSummaries: vi.fn(async () => ({ ...summaries, entries: summaries.entries.map((entry) => entry.id === "recent" ? { ...entry, origin: { status: "recorded", sessionId: "review-source", title: "원본 논의" } } : entry) })) });
    render(<MemorySearchPanel api={api} onAskAveToFix={noFix} />);
    const idleRow = await screen.findByRole("button", { name: /안 쓰는 콜백/ });
    expect(idleRow.textContent).toContain("38일 동안 안 쓰임");
    expect(idleRow.textContent).not.toContain("0회");
    const band = await screen.findByTestId("memory-recent-strip");
    expect(band.textContent).toContain("지난 7일 · 묻지 않고 바로 저장됨");
    expect(band.textContent).toContain("원본 논의");
    expect(band.textContent).toContain("1시간 전");
  });

  it("loads one summary batch and no full details for a list of memories", async () => {
    const api = memorySearchPanelApi();
    const notes = Array.from({ length: 60 }, (_, index) => ({ id: `memory-${index}`, filename: `memory-${index}.md`, title: `기억 ${index}`, content: `본문 ${index}`, updatedAt: OLD }));
    const memoryGetSummaries = vi.fn(async () => summariesForNotes(notes));
    Object.assign(api, { memoryGetSummaries });
    render(<MemorySearchPanel api={api} onAskAveToFix={noFix} />);
    await screen.findByRole("button", { name: /^기억 59/ });
    expect(memoryGetSummaries).toHaveBeenCalledTimes(1);
    expect(api.memoryGetDetail).not.toHaveBeenCalled();
  });

  it("keeps a selected memory detail cached when the search changes", async () => {
    const api = memorySearchPanelApi();
    const note = { id: "cached-memory", filename: "cached.md", title: "검색할 기억", content: "본문", updatedAt: OLD };
    const memoryGetSummaries = vi.fn(async () => summariesForNotes([note]));
    Object.assign(api, { memoryGetSummaries, memorySearchEntries: vi.fn(async () => [{ ...note, excerpt: note.content }]) });
    render(<MemorySearchPanel api={api} onAskAveToFix={noFix} />);
    fireEvent.click(await screen.findByRole("button", { name: /^검색할 기억/ }));
    await screen.findByRole("tab", { name: /변경 이력/ });
    expect(api.memoryGetDetail).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "메모리 검색" }), { target: { value: "검색할" } });
    await waitFor(() => expect(api.memorySearchEntries).toHaveBeenCalledWith("검색할"));
    await screen.findByRole("tab", { name: /변경 이력/ });
    expect(api.memoryGetDetail).toHaveBeenCalledTimes(1);
    expect(memoryGetSummaries).toHaveBeenCalledTimes(1);
  });

  it("shows all memories from the source conversation after opening one search result", async () => {
    const api = memorySearchPanelApi();
    const origin = { v: 1 as const, sessionId: "shared-source" };
    const entries = [
      { id: "m1", filename: "timeout.md", title: "타임아웃", content: "기준", excerpt: "기준", origin, updatedAt: RECENT },
      { id: "m2", filename: "retries.md", title: "재시도", content: "두 번", excerpt: "두 번", origin, updatedAt: RECENT },
    ];
    Object.assign(api, {
      memoryGetSummaries: vi.fn(async () => summariesForNotes(entries)),
      memorySearchEntries: vi.fn(async () => [entries[0]!]),
      memoryGetDetail: vi.fn(async () => ({ ok: true, origin: { status: "resolved", sessionId: "shared-source" }, history: { entries: [] }, usage: { entries: [] } })),
    });
    render(<MemorySearchPanel api={api} onAskAveToFix={noFix} initialQuery={{ text: "타임아웃", nonce: 1 }} />);
    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /타임아웃/ }));
    fireEvent.click(await screen.findByRole("button", { name: "이 대화의 다른 기억" }));
    expect(await screen.findByRole("button", { name: /재시도/, pressed: false })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "메모리 검색" }) as HTMLInputElement).value).toBe("");
  });

  it("opens origin, history and use log for a selected managed memory", async () => {
    const api = panelWithMemories();
    Object.assign(api, { memoryGetDetail: vi.fn(async () => ({
      ok: true,
      origin: { status: "resolved", sessionId: "source-session", messageId: "source-message", title: "원본 대화", quote: "타임아웃을 기억해 줘" },
      history: { entries: [{ v: 1, memoryId: "m1", at: RECENT, op: "created", actor: "capture", after: "게이트웨이 기준" }] },
      usage: { entries: [{ memoryId: "m1", at: RECENT, via: "injected", sessionId: "used-session" }] },
    })) });
    const onOpenSession = vi.fn(async () => true);
    render(<MemorySearchPanel api={api as unknown as AveApi} project={PROJECT} onOpenSession={onOpenSession} onAskAveToFix={noFix} />);
    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /결제 API 타임아웃은 8초/ }));
    expect(await screen.findByText("타임아웃을 기억해 줘")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /변경 이력 1/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /사용 기록 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "대화에서 보기" }));
    expect(onOpenSession).toHaveBeenCalledWith("source-session", "source-message");
    expect(api.memoryGetDetail).toHaveBeenCalledWith("m1", { ...PROJECT, includeUnscoped: false });
  });

  it("opens a selected chat session from the memory session list", async () => {
    const api = memorySearchPanelApi();
    const onOpenSession = vi.fn(async () => true);
    const user = setupUser();

    render(<MemorySearchPanel api={api} onOpenSession={onOpenSession} onAskAveToFix={noFix} />);

    await user.click(await screen.findByRole("tab", { name: /채팅 목록/ }));
    const row = await screen.findByRole("button", { name: /채팅 열기: 분기 후 확인 대화/ });
    fireEvent.click(row);

    await waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555");
    });
  });

  it("keeps the row inspectable when session loading fails", async () => {
    const api = memorySearchPanelApi();
    const onOpenSession = vi.fn(async () => false);
    const user = setupUser();

    render(<MemorySearchPanel api={api} onOpenSession={onOpenSession} onAskAveToFix={noFix} />);

    await user.click(await screen.findByRole("tab", { name: /채팅 목록/ }));
    fireEvent.click(await screen.findByRole("button", { name: /채팅 열기: 분기 후 확인 대화/ }));

    await waitFor(() => expect(screen.getByText("로드 실패")).toBeTruthy());
    expect(screen.getByText("캘린더 세션 목록에서 열어야 하는 대화입니다.")).toBeTruthy();
  });
  it("has no review tab: every memory is saved at once", async () => {
    render(<MemorySearchPanel api={memorySearchPanelApi()} onAskAveToFix={noFix} />);
    expect(await screen.findByRole("tab", { name: /기억/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /검토 대기/ })).toBeNull();
  });

  it("deletes a memory and restores it from the toast", async () => {
    const api = panelWithMemories();
    render(<MemorySearchPanel api={api as unknown as AveApi} project={PROJECT} onAskAveToFix={noFix} />);

    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /결제 API 타임아웃은 8초/ }));
    fireEvent.click(screen.getByRole("button", { name: "기억 삭제: 결제 API 타임아웃은 8초" }));

    await waitFor(() => expect(api.memoryDeleteEntry).toHaveBeenCalledWith("timeout.md", {
      projectRoot: PROJECT.projectRoot, projectName: "alpha", includeUnscoped: false,
    }));
    expect(await screen.findByText("\"결제 API 타임아웃은 8초\" 를 삭제했습니다")).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole("tabpanel", { name: /^기억/ })).queryByRole("button", { name: /결제 API 타임아웃은 8초/, pressed: false })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(api.memoryUndo).toHaveBeenCalledWith("11111111-2222-4333-8444-555555555555"));
    expect(await screen.findByText("\"결제 API 타임아웃은 8초\" 를 되살렸습니다")).toBeTruthy();
    expect(await within(screen.getByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /결제 API 타임아웃은 8초/, pressed: true })).toBeTruthy();
  });

  it.each(["write-failed"] as const)("keeps the toast's undo for a retry when the host answers %s", async (error) => {
    const api = panelWithMemories();
    const restore = api.memoryUndo.getMockImplementation()!;
    api.memoryUndo.mockImplementationOnce(async () => ({ ok: false, error }));
    render(<MemorySearchPanel api={api as unknown as AveApi} onAskAveToFix={noFix} />);

    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /결제 API 타임아웃은 8초/ }));
    fireEvent.click(screen.getByRole("button", { name: "기억 삭제: 결제 API 타임아웃은 8초" }));
    fireEvent.click(await screen.findByRole("button", { name: "되돌리기" }));

    expect(await screen.findByText("되돌리지 못했어요 · 결제 API 타임아웃은 8초")).toBeTruthy();
    expect(screen.queryByText("더 새로운 기억이 자리를 차지해 되살리지 않았어요")).toBeNull();
    api.memoryUndo.mockImplementationOnce(restore);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("\"결제 API 타임아웃은 8초\" 를 되살렸습니다")).toBeTruthy();
    expect(api.memoryUndo).toHaveBeenNthCalledWith(2, "11111111-2222-4333-8444-555555555555");
  });

  it.each([
    ["changed", "더 새로운 기억이 자리를 차지해 되살리지 않았어요"],
    ["not-found", "이 되돌리기는 이제 쓸 수 없어요"],
    ["invalid-input", "이 되돌리기는 이제 쓸 수 없어요"],
  ] as const)("says why an undo answered %s, without offering it again", async (error, text) => {
    const api = panelWithMemories();
    api.memoryUndo.mockImplementationOnce(async () => ({ ok: false, error }));
    render(<MemorySearchPanel api={api as unknown as AveApi} onAskAveToFix={noFix} />);

    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /결제 API 타임아웃은 8초/ }));
    fireEvent.click(screen.getByRole("button", { name: "기억 삭제: 결제 API 타임아웃은 8초" }));
    fireEvent.click(await screen.findByRole("button", { name: "되돌리기" }));

    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("offers Ave 에게 고치기 on a search result, as a notice's 보기 or 최근 저장 opens one", async () => {
    const api = panelWithMemories();
    // Found only by the search, so the row cannot come from the full list shown before the query.
    api.memorySearchEntries.mockImplementation(async () => [
      { id: "m9", filename: "gateway.md", title: "게이트웨이 재시도는 두 번", excerpt: "운영 기준", updatedAt: RECENT },
    ]);
    render(<MemorySearchPanel api={api as unknown as AveApi} onAskAveToFix={noFix} initialQuery={{ text: "게이트웨이", nonce: 1 }} />);

    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /게이트웨이 재시도는 두 번/ }));
    expect(screen.getByRole("button", { name: "Ave 에게 기억 고치기: 게이트웨이 재시도는 두 번" })).toBeTruthy();
  });

  it("asks Ave to fix a memory in its own project, and offers nothing for the instructions file", async () => {
    const api = panelWithMemories();
    const onAskAveToFix = vi.fn(async () => false);
    render(<MemorySearchPanel api={api as unknown as AveApi} onAskAveToFix={onAskAveToFix} />);

    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /결제 API 타임아웃은 8초/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ave 에게 기억 고치기: 결제 API 타임아웃은 8초" }));
    await waitFor(() => expect(onAskAveToFix).toHaveBeenCalledWith({
      id: "m1", title: "결제 API 타임아웃은 8초", content: "게이트웨이 기준", projectRoot: PROJECT.projectRoot, projectName: "alpha",
    }));
    expect(await screen.findByText("지금은 고치기 대화를 열 수 없어요")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("tabpanel", { name: /^기억/ })).getByRole("button", { name: /메모리 인덱스/ }));
    expect(screen.queryByRole("button", { name: /기억 삭제: MEMORY/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /기억 삭제:/ })).toBeNull();
  });

  it("offers no 고치기 for a legacy note without an id, which can still be deleted", async () => {
    render(<MemorySearchPanel api={panelWithMemories() as unknown as AveApi} onAskAveToFix={noFix} />);

    fireEvent.click(await within(await screen.findByRole("tabpanel", { name: /^기억/ })).findByRole("button", { name: /오래된 메모/ }));
    expect(screen.getByRole("button", { name: "기억 삭제: 오래된 메모" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ave 에게 기억 고치기: 오래된 메모" })).toBeNull();
  });

  it("lists memories saved in the last week as 최근 저장, newest first", async () => {
    const api = panelWithMemories();
    render(<MemorySearchPanel api={api as unknown as AveApi} onAskAveToFix={noFix} />);

    const strip = await screen.findByTestId("memory-recent-strip");
    expect(strip.textContent).toContain("최근 저장 1");
    expect(strip.textContent).toContain("결제 API 타임아웃은 8초");
    expect(strip.textContent).not.toContain("오래된 메모");
  });

  it("opens with the search a notice asked for", async () => {
    const api = panelWithMemories();
    render(<MemorySearchPanel api={api as unknown as AveApi} onAskAveToFix={noFix} initialQuery={{ text: "타임아웃", nonce: 1 }} />);
    expect(((await screen.findByRole("textbox", { name: "메모리 검색" })) as HTMLInputElement).value).toBe("타임아웃");
  });
});
