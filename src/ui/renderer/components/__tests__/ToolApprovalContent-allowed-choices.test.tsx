// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import { selectDecision } from "./support/decision-bar.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { buildPermissionEvaluationContext } from "../../../../permissions/evaluation-context.js";

function makeOneShotPluginRequest(): ApprovalRequest {
  return {
    id: "plugin-operation-grant-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "portal_checkin_write",
    toolCategory: "write",
    args: { operation: "clock" },
    reason: "plugin operation grant",
    source: "plugin",
    sourcePluginId: "sampleportal",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    reviewerVerdict: { level: "medium", reason: "test" },
  };
}

describe("ToolApprovalContent allowed choices", () => {
  it("remembers an ordinary request with unavailable review only when the host permits it", async () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    const request: ApprovalRequest = {
      ...makeOneShotPluginRequest(),
      id: "ordinary-unassessed-shell", source: "builtin", toolName: "bash", toolCategory: "shell",
      args: { command: "printf hello" }, reviewerVerdict: undefined, allowedChoices: undefined,
      persistentAllowAllowed: true, approvalCacheKey: "scoped-exact-request",
      persistentApprovalCwd: "/workspace/project",
      evaluationContext: buildPermissionEvaluationContext({
        policyMode: "auto", headless: false, source: "builtin", category: "shell", trustOrigin: "user-keyboard",
        executionCwd: "/workspace/project", allowedDirectories: ["/workspace/project"],
        pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [],
      }),
    };
    renderApproval(request, onDecide);
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("/workspace/project");
    // The lasting exact approval is the project one, selected from the allow dropdown.
    selectDecision("allow-project");
    const always = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(always).toBeEnabled();
    fireEvent.click(always);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      requestId: request.id, args: '{"command":"printf hello"}',
      scope: "persistent", verdictAtApproval: "high", approvalCacheKey: request.approvalCacheKey,
    }));
  });

  it("keeps a non-recordable ordinary request disabled even when its displayed risk is medium", () => {
    const request = { ...makeOneShotPluginRequest(), allowedChoices: undefined, persistentAllowAllowed: false };
    renderApproval(request, vi.fn());
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
  });

  it("honors a host one-shot approval contract", () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(makeOneShotPluginRequest(), onDecide);

    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent("거부");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent("이번 세션 동안 허용");
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();

    const approve = screen.getByTestId(TEST_IDS.approveButton);
    expect(approve).toHaveTextContent("한 번만 허용");
    fireEvent.click(approve);

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
    expect(record).not.toHaveBeenCalled();

    onDecide.mockClear();
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));

    expect(onDecide).toHaveBeenCalledWith("deny-once");

    onDecide.mockClear();
    fireEvent.keyDown(approve, { key: "a", code: "KeyA" });

    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
