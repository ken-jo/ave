import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemorySaveNoticeStrip } from "../MemorySaveNoticeStrip.js";
import type { MemorySaveResultEvent, MemoryUndoResult } from "../../../../shared/memory-save-result.js";

const SESSION = "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10";
const TOKEN = "11111111-2222-4333-8444-555555555555";
const ENTRY = { id: "m1", filename: "timeout.md", title: "결제 API 타임아웃은 10초", scope: "project" as const };

function harness(undo: MemoryUndoResult = { ok: true, undone: "created", title: ENTRY.title }) {
  let emit: (event: MemorySaveResultEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const api = {
    onMemorySaveResult: vi.fn((handler: (event: MemorySaveResultEvent) => void) => {
      emit = handler;
      return unsubscribe;
    }),
    memoryUndo: vi.fn(async () => undo),
  };
  const onOpenMemory = vi.fn();
  const view = render(<MemorySaveNoticeStrip api={api} sessionId={SESSION} onOpenMemory={onOpenMemory} />);
  return { api, onOpenMemory, unsubscribe, view, emit: (event: MemorySaveResultEvent) => act(() => emit(event)) };
}

describe("MemorySaveNoticeStrip", () => {
  it("shows a save in this conversation with undo and view, and ignores other conversations", () => {
    const { emit, onOpenMemory } = harness();
    emit({ sessionId: "another-session", result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    expect(screen.queryByRole("status")).toBeNull();

    emit({ sessionId: SESSION, anchorMessageId: "msg-1", result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    expect(screen.getByRole("status").textContent).toContain("기억에 저장 · 결제 API 타임아웃은 10초");
    fireEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(onOpenMemory).toHaveBeenCalledWith("결제 API 타임아웃은 10초");
  });

  it("offers no undo for an update", () => {
    const { emit } = harness();
    emit({ sessionId: SESSION, result: { status: "saved", op: "updated", entry: ENTRY } });
    expect(screen.getByRole("status").textContent).toContain("기억에 저장");
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
    expect(screen.getByRole("button", { name: "보기" })).toBeTruthy();
  });

  it("undoes a save once and says so", async () => {
    const { emit, api } = harness();
    emit({ sessionId: SESSION, result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("저장을 되돌렸어요 · 결제 API 타임아웃은 10초"));
    expect(api.memoryUndo).toHaveBeenCalledWith(TOKEN);
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
  });

  it("explains an undo refused because the memory changed again", async () => {
    const { emit } = harness({ ok: false, error: "changed" });
    emit({ sessionId: SESSION, result: { status: "saved", op: "deleted", entry: ENTRY, undoToken: TOKEN } });
    expect(screen.getByRole("status").textContent).toContain("기억에서 삭제 · 결제 API 타임아웃은 10초");
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("다시 바뀐 기억이라 되돌리지 않았어요"));
    expect(screen.getByRole("button", { name: "보기" })).toBeTruthy();
  });

  it.each([
    ["credential", "저장하지 않음 · 키나 비밀번호 같은 값이 있어요"],
    ["sensitive-input", "저장하지 않음 · 키나 비밀번호 같은 값이 있어요"],
    ["external-context", "저장하지 않음 · 지시문이나 외부 내용이 섞여 있어요"],
    ["unsafe-text", "저장하지 않음 · 지시문이나 외부 내용이 섞여 있어요"],
    ["reviewer-unavailable", "저장하지 못했어요 · 잠시 뒤 다시 해 주세요"],
  ] as const)("says why %s was not saved", (reason, text) => {
    const { emit } = harness();
    emit({ sessionId: SESSION, result: { status: "skipped", reason } });
    expect(screen.getByRole("status").textContent).toContain(text);
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
  });

  it("keeps the latest three notices, lets one be dismissed, and clears on a conversation switch", () => {
    const { emit, view, api, unsubscribe } = harness();
    for (const title of ["하나", "둘", "셋", "넷"]) {
      emit({ sessionId: SESSION, result: { status: "saved", op: "updated", entry: { ...ENTRY, title } } });
    }
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([
      expect.stringContaining("둘"), expect.stringContaining("셋"), expect.stringContaining("넷"),
    ]);
    fireEvent.click(screen.getAllByRole("button", { name: "알림 닫기" })[0]!);
    expect(screen.getAllByRole("status")).toHaveLength(2);

    view.rerender(<MemorySaveNoticeStrip api={api} sessionId="next-session" onOpenMemory={vi.fn()} />);
    expect(unsubscribe).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
