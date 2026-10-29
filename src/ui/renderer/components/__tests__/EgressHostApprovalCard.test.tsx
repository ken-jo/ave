// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EgressHostApprovalCard } from "../permissions/EgressHostApprovalCard.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

const TAB = "terminal:0a1b2c3d-1";

function terminalAsk(id: string, overrides: Partial<NonNullable<ApprovalRequest["egressHost"]>> = {}, tabId = TAB): ApprovalRequest {
  return {
    id,
    category: "tool",
    kind: "egress-host",
    toolName: "terminal",
    args: { host: "github.com", port: 443, tabId },
    reason: "A command in an isolated conversation terminal wants to connect to github.com:443.",
    createdAt: 0,
    allowedChoices: ["allow-once", "deny-once"],
    // Host rules are shell-origin: the host sends a conversation shell's ask with no rule to save.
    egressHost: { host: "github.com", port: 443, rule: null, network: "public", scopes: ["once", "tab", "always"], terminalTabId: tabId, ...overrides },
  } as unknown as ApprovalRequest;
}

let previousLocale: ReturnType<typeof getLocale>;
beforeEach(() => { previousLocale = getLocale(); });
afterEach(() => { setLocale(previousLocale); });

describe("EgressHostApprovalCard conversation isolated-shell grants", () => {
  it.each([
    { locale: "en" as const, body: "A command in this conversation's isolated shell wants to connect", conversation: "Conversation: Build fixes",
      allow: "Allow while this shell runs", lasts: "until this isolated shell exits (the conversation ends, or the shell exits and restarts)" },
    { locale: "ko" as const, body: "이 대화의 격리 셸에서 실행한 명령이", conversation: "대화: Build fixes",
      allow: "이 격리 셸 동안 허용", lasts: "이 격리 셸이 끝날 때까지만(대화가 끝나거나 셸이 종료되어 다시 시작될 때까지)" },
  ])("names the owning conversation's isolated shell and its lifetime [$locale]", ({ locale, body, conversation, allow, lasts }) => {
    setLocale(locale);
    const onDecide = vi.fn();
    render(<EgressHostApprovalCard request={terminalAsk("ask-1")} conversationLabel="Build fixes" onDecide={onDecide} />);
    const card = screen.getByTestId("egress-approval-card");
    expect(card.textContent).toContain(body);
    expect(card.textContent).toContain(conversation);
    expect(card.textContent).not.toContain(TAB);
    expect(card.textContent).not.toMatch(/workspace terminal|another window|Terminal tab|워크스페이스 터미널|다른 창|터미널 탭/u);
    expect(screen.getByTestId(TEST_IDS.allowSessionButton).textContent).toBe(allow);
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, { egressScope: "tab" });
    cleanup();
    render(<EgressHostApprovalCard
      request={terminalAsk("ask-2", { host: "10.0.0.5", network: "local", scopes: ["once", "tab"] })}
      conversationLabel="Build fixes"
      onDecide={vi.fn()}
    />);
    expect(screen.getByTestId("egress-approval-local-warning").textContent).toContain(lasts);
  });
});
