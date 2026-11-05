import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryDetailContent } from "../MemoryDetailContent.js";
import type { MemoryDetailResult } from "../../../../shared/memory-detail.js";

const DETAIL: Extract<MemoryDetailResult, { ok: true }> = {
  ok: true,
  origin: { status: "resolved", sessionId: "source", messageId: "message-2", title: "Timeout discussion", quote: "Keep the gateway timeout at 8 seconds", messageOrdinal: 2 },
  history: { entries: [
    { v: 1, memoryId: "timeout", at: "2026-11-01T10:00:00Z", op: "created", actor: "capture", after: "8 seconds" },
    { v: 1, memoryId: "timeout", at: "2026-11-02T10:00:00Z", op: "updated", actor: "assistant", before: "8 seconds", after: "10 seconds", sessionId: "correction" },
  ], historyIncomplete: true, truncatedBefore: "2026-10-01T00:00:00Z" },
  usage: { entries: [
    { memoryId: "timeout", at: "2026-11-03T12:00:00Z", via: "injected", sessionId: "injected-session" },
    { memoryId: "timeout", at: "2026-11-03T12:01:00Z", via: "searched", sessionId: "searched-session", anchorMessageId: "question" },
    { memoryId: "timeout", at: "2026-11-02T12:00:00Z", via: "read", sessionId: "read-session" },
  ], limited: true },
};

describe("memory detail", () => {
  it("shows a live origin quote and opens the precise source message", async () => {
    const onOpenSession = vi.fn(async () => true);
    const onSameOrigin = vi.fn();
    render(<MemoryDetailContent detail={DETAIL} onOpenSession={onOpenSession} onSameOrigin={onSameOrigin} />);
    expect(screen.getByText(DETAIL.origin.status === "resolved" ? DETAIL.origin.quote! : "")).toBeTruthy();
    expect(screen.getByText("2번째 메시지")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "대화에서 보기" }));
    expect(onOpenSession).toHaveBeenCalledWith("source", "message-2");
    fireEvent.click(screen.getByRole("button", { name: "이 대화의 다른 기억" }));
    expect(onSameOrigin).toHaveBeenCalledWith("source");
  });

  it("shows newest changes first, before/after markup, missing history and rotation", async () => {
    render(<MemoryDetailContent detail={DETAIL} onSameOrigin={vi.fn()} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /변경 이력/ }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: /변경 이력/ }));
    const panel = await screen.findByRole("tabpanel", { name: /변경 이력/ });
    expect(panel.querySelector("del")?.textContent).toBe("8 seconds");
    expect(panel.querySelector("ins")?.textContent).toBe("10 seconds");
    expect(within(panel).getByRole("status").textContent).toContain("일부 변경");
    expect(panel.textContent).toContain("이전 기록은 오래되어 정리되었습니다");
    expect(panel.textContent).not.toContain("assistant");
    expect(panel.textContent).not.toContain("capture");
  });

  it("filters use kinds and opens the logged conversation anchor", async () => {
    const onOpenSession = vi.fn(async () => true);
    render(<MemoryDetailContent detail={DETAIL} onOpenSession={onOpenSession} onSameOrigin={vi.fn()} />);
    const tab = screen.getByRole("tab", { name: /사용 기록/ });
    fireEvent.mouseDown(tab, { button: 0 }); fireEvent.click(tab);
    const panel = await screen.findByRole("tabpanel", { name: /사용 기록/ });
    fireEvent.click(within(panel).getByRole("button", { name: /^검색됨/ }));
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    fireEvent.click(within(rows[0]!).getByRole("button"));
    expect(onOpenSession).toHaveBeenCalledWith("searched-session", "question");
    expect(within(panel).getByRole("status")).toBeTruthy();
  });

  it.each(["absent", "unavailable"] as const)("explains an %s origin without inventing a source quote", (status) => {
    const origin = status === "absent" ? { status } : { status, sessionId: "deleted" };
    render(<MemoryDetailContent detail={{ ...DETAIL, origin }} onSameOrigin={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "대화에서 보기" })).toBeNull();
    expect(screen.getByText(status === "absent" ? "배운 대화가 기록되지 않았습니다." : "원본 대화가 삭제되었거나 읽을 수 없습니다.")).toBeTruthy();
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("renders a typed read failure instead of an empty history", () => {
    render(<MemoryDetailContent detail={{ ok: false, error: "read-failed" }} onSameOrigin={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("불러오지 못했습니다");
    expect(screen.queryByRole("tab")).toBeNull();
  });
});
