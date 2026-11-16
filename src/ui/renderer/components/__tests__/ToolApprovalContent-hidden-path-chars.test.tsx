// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { t } from "../../../../i18n/runtime.js";

/** F01: the name a person approves must be the name that is written; hidden characters are spelled, never rendered. */
const RLO = String.fromCodePoint(0x202e);
const SPOOFED = `/work/project/safe${RLO}gnp.exe`;
const SPELLED = "/work/project/safe\u27e8U+202E\u27e9gnp.exe";

afterEach(() => {
  vi.unstubAllGlobals();
});

function writeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-hidden-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "write_file",
    toolCategory: "write",
    args: { path: SPOOFED, content: "x" },
    target: { filePath: SPOOFED },
    reason: "User confirmation required",
    source: "builtin",
    createdAt: 0,
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    ...overrides,
  } as ApprovalRequest;
}

function visibleText(): string {
  return screen.getByTestId("tool-approval-card").textContent ?? "";
}

describe("approval card paths with hidden characters", () => {
  it("spells a bidi override in the write target, summary, detail row and full input", () => {
    renderApproval(writeRequest(), vi.fn());
    expect(screen.getByTestId("approval-action-primary")).toHaveTextContent(SPELLED);
    expect(screen.getByTestId("approval-impact-summary")).toHaveTextContent("safe\u27e8U+202E\u27e9gnp.exe");
    expect(screen.getByTestId("tool-approval-input")).toHaveTextContent(SPELLED);
    expect(visibleText()).not.toContain(RLO);
    expect(screen.getByTestId("approval-hidden-characters-warning")).toHaveTextContent(t("toolApprovalDialog.hiddenCharactersWarning"));
  });

  it("spells a bidi override quoted by a reviewer or host reason", () => {
    renderApproval(writeRequest({ reason: `writes safe${RLO}gnp.exe outside the plan` }), vi.fn());
    expect(screen.getByTestId("approval-impact-summary")).toHaveTextContent("writes safe\u27e8U+202E\u27e9gnp.exe outside the plan");
    expect(visibleText()).not.toContain(RLO);
  });

  it("spells a line break inside a path instead of starting a new line", () => {
    const path = "/work/project/a\n/etc/passwd";
    renderApproval(writeRequest({ args: { path, content: "x" }, target: { filePath: path } }), vi.fn());
    expect(screen.getByTestId("approval-action-primary").textContent).toBe("/work/project/a\u27e8U+000A\u27e9/etc/passwd");
    expect(screen.getByTestId("approval-hidden-characters-warning")).toBeInTheDocument();
  });

  it("spells the candidate and the parent folder on an outside-project card", () => {
    renderApproval(writeRequest({
      kind: "out-of-allowed-dir",
      target: undefined,
      args: {},
      outOfAllowedDir: {
        candidatePath: SPOOFED,
        suggestedParent: `/work/pro${RLO}ject`,
        currentAllowed: ["/other"],
        adjacencyWarnings: [],
      },
    }), vi.fn());
    expect(screen.getByTestId("approval-path-grant-candidate").textContent).toBe(SPELLED);
    expect(screen.getByTestId("approval-path-grant-parent").textContent).toBe("/work/pro\u27e8U+202E\u27e9ject");
    expect(visibleText()).not.toContain(RLO);
    expect(screen.getByTestId("approval-hidden-characters-warning")).toBeInTheDocument();
  });

  it("shows no warning for an ordinary path", () => {
    renderApproval(writeRequest({ args: { path: "/work/project/a.txt", content: "x" }, target: { filePath: "/work/project/a.txt" } }), vi.fn());
    expect(screen.queryByTestId("approval-hidden-characters-warning")).toBeNull();
    expect(screen.getByTestId("approval-action-primary").textContent).toBe("/work/project/a.txt");
  });
});
