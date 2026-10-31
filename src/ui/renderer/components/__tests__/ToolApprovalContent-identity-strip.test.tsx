// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

/** Every approval card displays the host-owned tool identity. */
afterEach(() => {
  vi.unstubAllGlobals();
});

function baseRequest(): ApprovalRequest {
  return {
    id: "req-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "agent_spawn",
    toolCategory: "meta",
    args: { title: "t" },
    reason: "review",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    reviewerVerdict: { level: "high", reason: "test" },
  };
}

describe("ToolApprovalContent identity strip", () => {
  it("names the tool on a plain request (unchanged behavior)", () => {
    renderApproval(baseRequest(), vi.fn());
    expect(screen.getByTestId("approval-tool-identity")).toHaveTextContent("agent_spawn");
  });

  it("renders a path-grant request inside the same frame, identity strip included", () => {
    // Path grants share approval framing while allow-always retains parent-directory semantics.
    renderApproval({
      ...baseRequest(),
      kind: "out-of-allowed-dir",
      toolName: "write_file",
      toolCategory: "write",
      outOfAllowedDir: {
        candidatePath: "/workspace/out/report.md",
        suggestedParent: "/workspace/out",
        currentAllowed: ["/workspace/project"],
        adjacencyWarnings: [],
      },
    }, vi.fn());
    expect(screen.getByTestId("tool-approval-panel")).toBeInTheDocument();
    expect(screen.getByTestId("approval-tool-identity")).toHaveTextContent("write_file");
    // The one generic decision row serves path grants too.
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.approvalReviewDetails)).toBeInTheDocument();
    expect(screen.getByTestId("approval-path-grant-evidence")).toBeInTheDocument();
  });

  it("panel A/D shortcuts are inert for a path-grant request", () => {
    // The user may have navigated to the allow-always (parent grant) scope;
    // the generic A shortcut would commit a plain allow-once and silently
    // discard that selection. These shortcuts never existed for this kind
    // before the frame unification and must stay absent (review MAJOR).
    const onDecide = vi.fn();
    const { allowedChoices: _unconstrained, ...openChoices } = baseRequest();
    renderApproval({
      ...openChoices,
      kind: "out-of-allowed-dir",
      toolName: "write_file",
      toolCategory: "write",
      outOfAllowedDir: {
        candidatePath: "/workspace/out/report.md",
        suggestedParent: "/workspace/out",
        currentAllowed: ["/workspace/project"],
        adjacencyWarnings: [],
      },
    }, onDecide);
    const panel = screen.getByTestId("tool-approval-panel");
    // Focus the parent-grant decision, as a keyboard user would before committing.
    screen.getByTestId(TEST_IDS.allowSessionButton).focus();
    fireEvent.keyDown(panel, { key: "a" });
    fireEvent.keyDown(panel, { key: "d" });
    expect(onDecide).not.toHaveBeenCalled();
  });
});
