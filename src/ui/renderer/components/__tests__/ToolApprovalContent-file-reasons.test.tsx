// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { t } from "../../../../i18n/runtime.js";

/** File approval cards state the host's reason for asking and the place a change really lands. */
function fileRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-file-reason",
    category: "tool",
    kind: "tool",
    toolName: "write_file",
    toolCategory: "write",
    args: { path: "/work/project/linked.txt", content: "x" },
    target: { filePath: "/work/project/linked.txt" },
    reason: "This write requires approval.",
    source: "builtin",
    createdAt: 0,
    requireExplicit: true,
    trustOrigin: "llm-tool-arg",
    ...overrides,
  } as ApprovalRequest;
}

function outsideRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return fileRequest({
    kind: "out-of-allowed-dir",
    reason: "The target escapes the project boundary.",
    outOfAllowedDir: { candidatePath: "/work/project/linked.txt", suggestedParent: "/work/project", currentAllowed: ["/work/project"], adjacencyWarnings: [] },
    ...overrides,
  });
}

describe("symlink-escape card", () => {
  const escape = { reasonCode: "project-escape", allowedChoices: ["allow-once", "deny-once"],
    target: { filePath: "/work/project/linked.txt", canonicalPath: "/Users/me/Outside-Target.txt" } } as Partial<ApprovalRequest>;

  it.each([["folder", outsideRequest(escape)], ["tool", fileRequest(escape)]] as const)("shows the real target and the escape reason on the %s card", (_kind, request) => {
    renderApproval(request, vi.fn());
    expect(screen.getByTestId("approval-real-target")).toHaveTextContent(`${t("toolApprovalDialog.realTarget")} /Users/me/Outside-Target.txt`);
    expect(screen.getByTestId("approval-ask-reason")).toHaveTextContent(t("toolApprovalDialog.reasonProjectEscape"));
  });

  it("spells hidden characters in the real target and warns about them", () => {
    const rlo = String.fromCodePoint(0x202e);
    renderApproval(fileRequest({ ...escape, target: { filePath: "/work/project/linked.txt", canonicalPath: `/Users/me/safe${rlo}gnp.exe` } }), vi.fn());
    expect(screen.getByTestId("approval-real-target")).toHaveTextContent("/Users/me/safe⟨U+202E⟩gnp.exe");
    expect(screen.getByTestId("tool-approval-card").textContent).not.toContain(rlo);
    expect(screen.getByTestId("approval-hidden-characters-warning")).toBeInTheDocument();
  });

  it("shows no real-target line when the spelling is the location", () => {
    renderApproval(fileRequest(), vi.fn());
    expect(screen.queryByTestId("approval-real-target")).toBeNull();
  });
});
