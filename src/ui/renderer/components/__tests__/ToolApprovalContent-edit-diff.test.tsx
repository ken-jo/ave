// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { t } from "../../../../i18n/runtime.js";

/** An edit approval card shows the change itself; it used to show only the path. */
afterEach(() => {
  vi.unstubAllGlobals();
});

function editRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-edit-1",
    category: "tool",
    kind: "tool",
    allowedChoices: ["allow-once", "deny-once"],
    toolName: "edit_file",
    toolCategory: "write",
    args: { path: "/work/project/src/index.ts", oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 3;" },
    target: { filePath: "/work/project/src/index.ts" },
    reason: "User confirmation required",
    source: "builtin",
    createdAt: 0,
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    ...overrides,
  } as ApprovalRequest;
}

const kinds = (root: HTMLElement) => [...root.querySelectorAll("[data-diff-kind]")].map(row => row.getAttribute("data-diff-kind"));

describe("approval card edit diff", () => {
  it("shows the requested edit as a line diff outside the collapsed details", () => {
    renderApproval(editRequest(), vi.fn());
    const diff = screen.getByTestId("approval-edit-diff");
    expect(diff).toHaveAttribute("data-added", "1");
    expect(diff).toHaveAttribute("data-removed", "1");
    expect(kinds(diff)).toEqual(["context", "removed", "added"]);
    expect(diff).toHaveTextContent("const b = 2;");
    expect(diff).toHaveTextContent("const b = 3;");
    expect(diff.closest("details")).toBeNull();
  });

  it("shows every replacement of a multi-edit", () => {
    renderApproval(editRequest({
      toolName: "multi_edit",
      args: { path: "/work/project/a.ts", replacements: [{ oldText: "one", newText: "1" }, { oldText: "two", newText: "2" }] },
    }), vi.fn());
    const diff = screen.getByTestId("approval-edit-diff");
    expect(diff).toHaveAttribute("data-added", "2");
    expect(diff).toHaveAttribute("data-removed", "2");
    expect(diff.querySelectorAll('[data-testid="file-diff-hunk"]')).toHaveLength(2);
  });

  it("collapses a long change to twelve rows until Show all is pressed", () => {
    const newText = Array.from({ length: 40 }, (_, index) => `added ${index}`).join("\n");
    renderApproval(editRequest({ args: { path: "/work/project/a.ts", oldText: "", newText } }), vi.fn());
    const diff = screen.getByTestId("approval-edit-diff");
    expect(kinds(diff)).toHaveLength(12);
    const toggle = screen.getByTestId("approval-edit-diff-toggle");
    expect(toggle).toHaveTextContent(t("toolApprovalDialog.changeShowAll", { count: 40 }));
    fireEvent.click(toggle);
    expect(kinds(diff)).toHaveLength(40);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("spells hidden characters inside the changed text", () => {
    const rlo = String.fromCodePoint(0x202e);
    renderApproval(editRequest({ args: { path: "/work/project/a.ts", oldText: "safe", newText: `safe${rlo}evil` } }), vi.fn());
    const diff = screen.getByTestId("approval-edit-diff");
    expect(diff).toHaveTextContent("safe⟨U+202E⟩evil");
    expect(diff.textContent).not.toContain(rlo);
  });

  it("is absent for tools that are not edits and for non-builtin tools named like one", () => {
    renderApproval(editRequest({ toolName: "write_file", args: { path: "/work/project/a.ts", content: "x" } }), vi.fn());
    expect(screen.queryByTestId("approval-edit-diff")).toBeNull();
  });
});
