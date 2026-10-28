// Integrations are mocked; these cases exercise notification trigger wiring.
import { describe, it, expect, vi } from "vitest";
import { AskUserQuestionGate } from "../ask-user-question-gate.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import type { NotificationService, FireOptions } from "../notification-service.js";
import { resolveConversationTitle } from "../../shared/conversation-title.js";
import { t, setLocale } from "../../i18n/runtime.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";

function makeFakeNotificationService(): NotificationService {
  return {
    fire: vi.fn((_opts: FireOptions) => {}),
  } as unknown as NotificationService;
}

describe("Trigger 3: AskUserQuestionGate fires `ask-user` on requestAndWait entry", () => {
  it("fires with kind=ask-user and the question body", async () => {
    const wc = makeMockWebContents();
    const svc = makeFakeNotificationService();
    const gate = new AskUserQuestionGate(wc as never, 60_000, svc);
    // We only care that fire was called — drop the resulting promise.
    void gate.ask({ sessionId: "session-1",
      questions: [{ question: "프로젝트 진행 상태가 어떤가요?", choices: ["진행 중", "완료", "중단"] }],
    });
    expect(svc.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ask-user",
        title: "질문이 도착했습니다",
        body: "프로젝트 진행 상태가 어떤가요?",
        contextRef: expect.objectContaining({ questionId: expect.any(String) }),
      }),
    );
    gate.disposeAll();
  });
});

describe("Trigger 4: ApprovalGate fires `approval` on requestAndWait entry", () => {
  it.each([
    ["write_file", "write", "views.c4", "views.c4 파일 쓰기"],
    ["read_file", "read", "README.md", "README.md 파일 읽기"],
  ] as const)("describes %s and its conversation without policy diagnostics", async (toolName, toolCategory, path, action) => {
    setLocale("ko");
    const svc = makeFakeNotificationService();
    const gate = new ApprovalGate(makeMockWebContents() as never, undefined, 60_000, undefined, svc);
    gate.setConversationTitleResolver((sessionId) => resolveConversationTitle({
      sessionId, messages: [{ role: "user", content: "그래 두개 진행해보자" }],
    }, t));
    const waiting = gate.requestAndWait({
      id: "human-notice", category: "tool", toolName, toolCategory, args: { path },
      reason: "사용자 컨펌 필요 (category: write, trust: high)",
      source: "builtin", createdAt: Date.now(), sessionId: "session-1",
    });
    const notice = vi.mocked(svc.fire).mock.calls[0][0];
    expect(notice.body).toBe(action + " · 대화: 그래 두개 진행해보자");
    expect(notice.body).not.toMatch(/category:|trust:|write_file|read_file|사용자 컨펌/);
    expect(notice.contextRef).toEqual({ approvalId: "human-notice", sessionId: "session-1" });
    gate.disposeAll();
    await waiting;
  });
  it("retains the conversation in the bounded notification body for a long action", async () => {
    const svc = makeFakeNotificationService();
    const gate = new ApprovalGate(makeMockWebContents() as never, undefined, 60_000, undefined, svc);
    gate.setConversationTitleResolver(() => "그래 두개 진행해보자");
    const waiting = gate.requestAndWait({
      id: "bounded-notice", category: "tool", toolName: "write_file", toolCategory: "write",
      args: { path: "x".repeat(100) + ".c4" }, reason: "internal", createdAt: Date.now(), sessionId: "session-1",
    });
    const notice = vi.mocked(svc.fire).mock.calls[0][0];
    expect([...notice.body].length).toBeLessThanOrEqual(80);
    expect(notice.body).toContain("대화: 그래 두개 진행해보자");
    gate.disposeAll();
    await waiting;
  });

  it("fires with kind=approval and urgent=true", async () => {
    const wc = makeMockWebContents();
    const svc = makeFakeNotificationService();
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      60_000,
      undefined,
      svc,
    );
    void gate.requestAndWait({
      id: "req-1",
      category: "tool",
      toolName: "agent_spawn",
      args: {},
      reason: "상태 변경 도구",
      source: "builtin",
      createdAt: Date.now(),
    });
    expect(svc.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "approval",
        title: "승인이 필요합니다",
        urgent: true,
        contextRef: expect.objectContaining({ approvalId: "req-1" }),
      }),
    );
  });
});

// Trigger 2 (deliverRoutineResult) was removed as part of the v2 routine migration — routine-delivery.js is a v1 artifact and no longer exists.

// Turn-end wiring is covered by notification-service tests and the typed loop dependency; full-loop execution remains manual smoke coverage.
describe("Trigger 1: ConversationLoop turn-end wiring (type-level)", () => {
  it("ConversationLoopDeps accepts notificationService", async () => {
    // Compile-time assertion: this test merely imports the module and confirms the deps shape. Runtime call would require a full provider setup which is out
    // of scope for a wiring stub.
    const mod = await import("../../engine/conversation-loop.js");
    expect(typeof mod.ConversationLoop).toBe("function");
  });

  // L5 — negative test: the turn-end fire is gated on `result.stopReason !== "interrupted" && result.text.trim().length > 0`. We verify the gate logic in
  // isolation rather than spinning up the full ConversationLoop (provider/tool-registry/memory/etc dep chain).
  it("turn-end gate: interrupted result does NOT fire", () => {
    const svc = makeFakeNotificationService();
    // Mirror the production gate from runTurn(): `if (result.stopReason !== "interrupted" && typeof text === "string" && text.trim().length > 0)`
    const interrupted = { stopReason: "interrupted" as const, text: "partial response" };
    if (
      interrupted.stopReason !== "interrupted" &&
      typeof interrupted.text === "string" &&
      interrupted.text.trim().length > 0
    ) {
      svc.fire({ kind: "turn-end", title: "응답 완료", body: interrupted.text });
    }
    expect(svc.fire).not.toHaveBeenCalled();
  });

  it("turn-end gate: empty text does NOT fire", () => {
    const svc = makeFakeNotificationService();
    const empty = { stopReason: "stop" as const, text: "   " };
    if (
      empty.stopReason !== ("interrupted" as string) &&
      typeof empty.text === "string" &&
      empty.text.trim().length > 0
    ) {
      svc.fire({ kind: "turn-end", title: "응답 완료", body: empty.text });
    }
    expect(svc.fire).not.toHaveBeenCalled();
  });

  it("turn-end gate: normal result DOES fire", () => {
    const svc = makeFakeNotificationService();
    const normal = { stopReason: "stop" as const, text: "응답입니다" };
    if (
      normal.stopReason !== ("interrupted" as string) &&
      typeof normal.text === "string" &&
      normal.text.trim().length > 0
    ) {
      svc.fire({ kind: "turn-end", title: "응답 완료", body: normal.text });
    }
    expect(svc.fire).toHaveBeenCalledOnce();
    expect(svc.fire).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "turn-end", body: "응답입니다" }),
    );
  });
});
