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

function memorySearchPanelApi(): AveApi {
  const { api } = makeMockAveApi();
  Object.assign(api, {
    memoryGetIndex: vi.fn(async () => ""),
    memoryGetDetail: vi.fn(async () => ({ ok: true, origin: { status: "absent" }, history: { entries: [] }, usage: { entries: [] } })),
    memoryListEntries: vi.fn(async () => []),
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
  api.memoryListEntries.mockImplementation(async () => entries);
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
  it("shows all memories from the source conversation after opening one search result", async () => {
    const api = memorySearchPanelApi();
    const origin = { v: 1 as const, sessionId: "shared-source" };
    const entries = [
      { id: "m1", filename: "timeout.md", title: "타임아웃", content: "기준", excerpt: "기준", origin, updatedAt: RECENT },
      { id: "m2", filename: "retries.md", title: "재시도", content: "두 번", excerpt: "두 번", origin, updatedAt: RECENT },
    ];
    Object.assign(api, {
      memoryListEntries: vi.fn(async () => entries),
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
      origin: { status: "resolved", sessionId: "source-session", messageId: "source-message", title: "원본 대화", quote: "타임아웃을 기억해 줘", messageOrdinal: 2 },
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
