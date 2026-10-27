// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

function makeAgentActionRequest(
  trustOrigin: string,
  toolName = "permission:set-mode",
  source: ApprovalRequest["source"] | null = "builtin",
): ApprovalRequest {
  return {
    id: "agent-action-1",
    category: "agent-action",
    kind: "agent-action",
    toolName,
    toolCategory: "meta",
    args: { mode: "allow" },
    reason: "external permission mutation",
    ...(source === null ? {} : { source }),
    createdAt: Date.now(),
    requireExplicit: true,
    sourcePluginId: "local-api",
    approvalScope: "permission-mode",
    trustOrigin,
    reviewerVerdict: { level: "medium", reason: "test" },
  };
}

describe("ToolApprovalContent external agent-action affordances", () => {
  it("keeps the three decisions visible but disables persistence for local-api actions", () => {
    const onDecide = vi.fn();
    const { container } = renderApproval(makeAgentActionRequest("local-api"), onDecide);

    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent("거부");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent("이번 세션 동안 허용");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(container.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toBeNull();

    const approve = screen.getByTestId(TEST_IDS.approveButton);
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("keeps persistence visible but disabled for user-keyboard agent actions", () => {
    renderApproval(makeAgentActionRequest("user-keyboard"), vi.fn());

    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent("거부");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent("이번 세션 동안 허용");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toHaveTextContent("한 번만 허용");
  });

  it.each([
    ["explicit builtin source", "builtin"],
    ["omitted legacy source", null],
  ] as const)("forces one-shot approval for remote-wire agent actions with %s", (_label, source) => {
    const onDecide = vi.fn();
    renderApproval(makeAgentActionRequest("a2a-remote-wire", "a2a-send", source), onDecide);

    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent("이번 세션 동안 허용");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    const approve = screen.getByTestId(TEST_IDS.approveButton);
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });

  it("keeps persistence visible but disabled for plugin agent actions", () => {
    const onDecide = vi.fn();
    renderApproval(makeAgentActionRequest("a2a-remote-wire", "a2a-send", "plugin"), onDecide);

    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent("이번 세션 동안 허용");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    const approve = screen.getByTestId(TEST_IDS.approveButton);
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});
