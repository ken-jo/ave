// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { t } from "../../../../i18n/runtime.js";
import type { ToolEntryItem } from "../../../../lib/chat-stream-state.js";
import { WORKFLOW_TEMPLATE_PROPOSE_TOOL, type WorkflowTemplateProposal } from "../../../../shared/workflow-template-types.js";
import { ToolGroupCard } from "../ToolGroupCard.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const proposal: WorkflowTemplateProposal = {
  id: "proposal-3637afcd-ac29-47ca-a2d0-9c085394e68a",
  graphHash: "a".repeat(64),
  draft: {
    name: "Daily source report",
    scope: { kind: "all" },
    stages: [{
      id: "collect", name: "Collect sources", goal: "Read the source notes", inputs: [],
      toolScope: "read", allowSubAgents: false, gate: { type: "human" },
    }],
    edges: [],
  },
};
const tool: ToolEntryItem = {
  name: WORKFLOW_TEMPLATE_PROPOSE_TOOL, source: "builtin", status: "done", toolUseId: "proposal-call", displayOrder: 0,
  result: JSON.stringify({ status: "pending-confirmation", proposalId: proposal.id, graphHash: "b".repeat(64) }),
};

function showToolResult(entry: ToolEntryItem) {
  render(<TooltipProvider><ToolGroupCard group={{
    kind: "tool_group", groupId: "proposals", groupIds: ["proposals"], status: "done", tools: [entry],
  }} /></TooltipProvider>);
}

it("reviews the host graph and only confirms after the user clicks save", async () => {
  const getWorkflowTemplateProposal = vi.fn(async () => ({ ok: true, value: proposal }));
  const confirmWorkflowTemplate = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("aveApi", { getWorkflowTemplateProposal, confirmWorkflowTemplate });
  showToolResult(tool);

  expect(getWorkflowTemplateProposal).not.toHaveBeenCalled();
  expect(confirmWorkflowTemplate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.review") }));
  expect(await screen.findByRole("dialog", { name: proposal.draft.name })).toBeTruthy();
  expect(screen.getByText(proposal.graphHash)).toBeTruthy();
  expect(screen.getByText("Read the source notes")).toBeTruthy();
  expect(getWorkflowTemplateProposal).toHaveBeenCalledWith(proposal.id);
  expect(confirmWorkflowTemplate).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.confirmSave") }));
  expect(await screen.findByText(t("workflowTemplates.saved"))).toBeTruthy();
  expect(confirmWorkflowTemplate).toHaveBeenCalledExactlyOnceWith(proposal.id, {
    expectedGraphHash: proposal.graphHash, expectedDraftRevision: proposal.id,
  });
});

it("keeps a lookalike external result out of the confirmation surface", () => {
  showToolResult({ ...tool, source: "mcp" });
  expect(screen.queryByRole("button", { name: t("workflowTemplates.review") })).toBeNull();
});
