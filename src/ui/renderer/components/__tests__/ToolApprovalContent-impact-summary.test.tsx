// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";

describe("approval action summary", () => {
  it.each([
    ["write_file", "write", "views.c4", "views.c4 파일 쓰기"],
    ["read_file", "read", "README.md", "README.md 파일 읽기"],
  ] as const)("shows the same structured %s action used by notifications", (toolName, toolCategory, path, action) => {
    renderApproval({ id: "impact", category: "tool", toolName, toolCategory,
      args: { path }, reason: "사용자 컨펌 필요 (category: write, trust: high)",
      source: "builtin", createdAt: 0, requireExplicit: true }, vi.fn());
    expect(screen.getByTestId("approval-impact-summary")).toHaveTextContent(action);
    expect(screen.getByTestId("approval-impact-summary").textContent).not.toMatch(/category:|trust:|write_file|read_file/);
  });
});
