// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";

describe("write approval review rows", () => {
  it("names the item a write changes and whether it connects to this chat, without the raw input", () => {
    renderApproval({ id: "sched-update", category: "tool", toolName: "routine_schedule", toolCategory: "write",
      args: { action: "update", routineId: "r-42", prePrompt: "x" }, reason: "write",
      source: "builtin", createdAt: 0, requireExplicit: true }, vi.fn());
    expect(screen.getByTestId("tool-approval-input").textContent).toBe("r-42");
  });

  it("shows 이 대화에 연결 as its own row when a write connects to this chat", () => {
    renderApproval({ id: "sched-add", category: "tool", toolName: "routine_schedule", toolCategory: "write",
      args: { execution: "llm-session", prePrompt: "check", connectToThisChat: true }, reason: "write",
      source: "builtin", createdAt: 0, requireExplicit: true }, vi.fn());
    expect(screen.getByTestId("tool-approval-connect-row")).toHaveTextContent("이 대화에 연결");
  });
});
