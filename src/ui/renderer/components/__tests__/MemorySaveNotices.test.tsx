import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { memo, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemorySaveNoticeRows, useComposerTextFlag, useMemorySaveNotices, type ComposerTextFlag } from "../MemorySaveNotices.js";
import type { MemorySaveResultEvent, MemoryUndoResult } from "../../../../shared/memory-save-result.js";

const SESSION = "0b6f3f43-3c5e-4f5f-9a51-2b0b6c1e9d10";
const TOKEN = "11111111-2222-4333-8444-555555555555";
const ENTRY = { id: "m1", filename: "timeout.md", title: "결제 API 타임아웃은 10초", scope: "project" as const };

type Api = Parameters<typeof useMemorySaveNotices>[0];
type Retry = { onRetry: () => void; composerHasText: ComposerTextFlag };

/** A fixed composer state for 다시 시도. */
function composerFlag(hasText: boolean): ComposerTextFlag {
  return { get: () => hasText, subscribe: () => () => {} };
}

function Rows({ api, sessionId, onOpenMemory, retry }: {
  api: Api;
  sessionId: string;
  onOpenMemory: (title: string) => void;
  retry?: Retry;
}) {
  const controller = useMemorySaveNotices(api, sessionId);
  return <MemorySaveNoticeRows notices={controller.notices} controller={controller} onOpenMemory={onOpenMemory} {...(retry ? { retry } : {})} />;
}

type IpcUndoResult = MemoryUndoResult | { ok: false; error: "invalid-input" | "write-failed" };

function harness(undo: () => Promise<IpcUndoResult> = async () => ({ ok: true, undone: "created", title: ENTRY.title }), retry?: Retry) {
  let emit: (event: MemorySaveResultEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const api = {
    onMemorySaveResult: vi.fn((handler: (event: MemorySaveResultEvent) => void) => {
      emit = handler;
      return unsubscribe;
    }),
    memoryUndo: vi.fn(undo),
  };
  const onOpenMemory = vi.fn();
  const view = render(<Rows api={api} sessionId={SESSION} onOpenMemory={onOpenMemory} {...(retry ? { retry } : {})} />);
  return { api, onOpenMemory, unsubscribe, view, emit: (event: MemorySaveResultEvent) => act(() => emit(event)) };
}

describe("MemorySaveNotices", () => {
  it("shows a save in this conversation with undo and view, and ignores other conversations", () => {
    const { emit, onOpenMemory } = harness();
    emit({ sessionId: "another-session", result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    expect(screen.queryByRole("status")).toBeNull();

    emit({ sessionId: SESSION, anchorMessageId: "msg-1", result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    expect(screen.getByRole("status").textContent).toContain("기억에 저장 · 결제 API 타임아웃은 10초");
    fireEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(onOpenMemory).toHaveBeenCalledWith("결제 API 타임아웃은 10초");
  });

  it("undoes an update back to what it replaced", async () => {
    const { emit, api } = harness(async () => ({ ok: true, undone: "updated", title: ENTRY.title }));
    emit({ sessionId: SESSION, result: { status: "saved", op: "updated", entry: ENTRY, undoToken: TOKEN } });
    expect(screen.getByRole("status").textContent).toContain("기억에 저장");
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("변경을 되돌렸어요 · 결제 API 타임아웃은 10초"));
    expect(api.memoryUndo).toHaveBeenCalledWith(TOKEN);
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
    const { emit } = harness(async () => ({ ok: false, error: "changed" }));
    emit({ sessionId: SESSION, result: { status: "saved", op: "deleted", entry: ENTRY, undoToken: TOKEN } });
    expect(screen.getByRole("status").textContent).toContain("기억에서 삭제 · 결제 API 타임아웃은 10초");
    // A deleted memory has nothing to show in the panel, so its notice offers only 되돌리기.
    expect(screen.queryByRole("button", { name: "보기" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("다시 바뀐 기억이라 되돌리지 않았어요"));
    expect(screen.getByRole("button", { name: "보기" })).toBeTruthy();
  });

  it.each(["not-found", "invalid-input"] as const)("ends an undo the host answers %s, saying it can no longer undo", async (error) => {
    const { emit } = harness(async () => ({ ok: false, error }));
    emit({ sessionId: SESSION, result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("오래된 알림이라 이제는 되돌릴 수 없어요"));
    expect(screen.getByRole("status").textContent).not.toContain("다시 바뀐");
    // The same token would be refused again, so nothing offers it.
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("keeps undo available when the undo call fails, so it can be tried again", async () => {
    let calls = 0;
    const { emit } = harness(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ipc gone");
      return { ok: true, undone: "created", title: ENTRY.title };
    });
    emit({ sessionId: SESSION, result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(calls).toBe(1));
    await waitFor(() => expect((screen.getByRole("button", { name: "다시 시도" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("status").textContent).toContain("되돌리지 못했어요 · 결제 API 타임아웃은 10초");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("저장을 되돌렸어요"));
  });

  it.each(["write-failed"] as const)("keeps the undo for a retry when the host answers %s", async (error) => {
    let calls = 0;
    const { emit, api } = harness(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error } : { ok: true, undone: "created", title: ENTRY.title };
    });
    emit({ sessionId: SESSION, result: { status: "saved", op: "created", entry: ENTRY, undoToken: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("되돌리지 못했어요 · 결제 API 타임아웃은 10초"));
    expect(screen.getByRole("status").textContent).not.toContain("오래된 알림");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("저장을 되돌렸어요"));
    expect(api.memoryUndo).toHaveBeenNthCalledWith(2, TOKEN);
  });

  it.each([
    ["credential", "저장하지 않음 · 키나 비밀번호 같은 값이 있어요", "키, 비밀번호, 토큰"],
    ["sensitive-input", "저장하지 않음 · 키나 비밀번호 같은 값이 있어요", "키, 비밀번호, 토큰"],
    ["external-context", "저장하지 않음 · 지시문이나 외부 내용이 섞여 있어요", "외부 내용을 읽은 뒤"],
    ["unsafe-text", "저장하지 않음 · 지시문이나 외부 내용이 섞여 있어요", "숨은 문자"],
    ["reviewer-unavailable", "저장하지 못했어요 · 잠시 뒤 다시 해 주세요", "아무것도 저장되지 않았으니"],
  ] as const)("says why %s was not saved, with details on request", (reason, text, detail) => {
    const { emit } = harness();
    emit({ sessionId: SESSION, result: { status: "skipped", reason } });
    expect(screen.getByRole("status").textContent).toContain(text);
    expect(screen.queryByRole("button", { name: "되돌리기" })).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain(detail);
    fireEvent.click(screen.getByRole("button", { name: "자세히" }));
    expect(screen.getByRole("status").textContent).toContain(detail);
  });

  it("tells a reviewer skip apart from a failure, with nothing to retry", () => {
    const { emit } = harness(undefined, { onRetry: vi.fn(), composerHasText: composerFlag(false) });
    emit({ sessionId: SESSION, result: { status: "skipped", reason: "reviewer-skip" } });
    expect(screen.getByRole("status").textContent).toContain("저장하지 않음 · 기억해 둘 만한 내용을 찾지 못했어요");
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(screen.queryByRole("button", { name: "자세히" })).toBeNull();
  });

  it("offers 다시 시도 on a failed save only when a retry is given, disabled while the composer holds text", () => {
    const onRetry = vi.fn();
    const first = harness(undefined, { onRetry, composerHasText: composerFlag(false) });
    first.emit({ sessionId: SESSION, result: { status: "skipped", reason: "invalid-review" } });
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledOnce();
    first.view.unmount();

    const busy = harness(undefined, { onRetry, composerHasText: composerFlag(true) });
    busy.emit({ sessionId: SESSION, result: { status: "skipped", reason: "invalid-review" } });
    expect((screen.getByRole("button", { name: "다시 시도" }) as HTMLButtonElement).disabled).toBe(true);
    busy.view.unmount();

    const none = harness();
    none.emit({ sessionId: SESSION, result: { status: "skipped", reason: "invalid-review" } });
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("follows the composer for 다시 시도 without redrawing what holds the rows", () => {
    let emit: (event: MemorySaveResultEvent) => void = () => {};
    const api = {
      onMemorySaveResult: vi.fn((handler: (event: MemorySaveResultEvent) => void) => { emit = handler; return () => {}; }),
      memoryUndo: vi.fn(async () => ({ ok: true as const, undone: "created" as const, title: ENTRY.title })),
    };
    let transcriptRenders = 0;
    // Stands in for the memoized transcript: it redraws only when what it is handed changes.
    const Transcript = memo(function Transcript({ flag }: { flag: ComposerTextFlag }) {
      transcriptRenders += 1;
      const controller = useMemorySaveNotices(api, SESSION);
      return <MemorySaveNoticeRows notices={controller.notices} controller={controller} onOpenMemory={() => {}} retry={{ onRetry: () => {}, composerHasText: flag }} />;
    });
    let setText: (value: string) => void = () => {};
    function View() {
      const [text, set] = useState("");
      setText = set;
      const flag = useComposerTextFlag(text.trim() !== "");
      return <Transcript flag={flag} />;
    }
    render(<View />);
    act(() => emit({ sessionId: SESSION, result: { status: "skipped", reason: "invalid-review" } }));
    const before = transcriptRenders;
    const button = () => screen.getByRole("button", { name: "다시 시도" }) as HTMLButtonElement;
    expect(button().disabled).toBe(false);

    act(() => setText("새 질문"));
    expect(button().disabled).toBe(true);
    act(() => setText(""));
    expect(button().disabled).toBe(false);
    expect(transcriptRenders).toBe(before);
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

    view.rerender(<Rows api={api} sessionId="next-session" onOpenMemory={vi.fn()} />);
    expect(unsubscribe).toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
