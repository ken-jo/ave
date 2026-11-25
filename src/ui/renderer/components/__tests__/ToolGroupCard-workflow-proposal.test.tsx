// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { t } from "../../../../i18n/runtime.js";
import type { ToolEntryItem } from "../../../../lib/chat-stream-state.js";
import { WORKFLOW_TEMPLATE_PROPOSE_TOOL, type TemplateStage, type WorkflowTemplateProposal } from "../../../../shared/workflow-template-types.js";
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

async function reviewStage(stage: TemplateStage) {
  const reviewed = {
    ...proposal,
    draft: { ...proposal.draft, stages: [stage], setupCommands: ["prepare-report"] },
  };
  vi.stubGlobal("aveApi", { getWorkflowTemplateProposal: async () => ({ ok: true, value: reviewed }) });
  showToolResult(tool);
  fireEvent.click(screen.getByRole("button", { name: t("workflowTemplates.review") }));
  return within(await screen.findByRole("dialog", { name: reviewed.draft.name }));
}

const reportEnvelope = {
  commands: ["render <report>\u202e"],
  writePaths: ["reports/**"], readRoots: ["/archive/sources"],
  tools: [], network: [], mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
  outputs: [], budget: { rounds: 4, minutes: 3, costUsd: 0.1 },
};

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

it("shows stage capabilities as visible text in the confirmation dialog", async () => {
  const dialog = await reviewStage({
    ...proposal.draft.stages[0],
    toolScope: "all",
    allowSubAgents: true,
    envelope: reportEnvelope,
    requestedOutputs: [{ kind: "send-message", toolName: "deliver_report", owner: "server", ownerId: "reports" }],
  });

  for (const [key, value] of [
    ["commands", "render <report>⟨U+202E⟩"],
    ["setupCommands", "prepare-report"],
    ["writePaths", "reports/**"],
    ["readRoots", "/archive/sources"],
    ["requestedOutputs", "send-message · deliver_report (server/reports)"],
    ["subAgents", t("workflowTemplates.subAgentsAllowed")],
    ["declaredTools", t("workflowTemplates.none")],
    ["networkHosts", t("workflowTemplates.none")],
  ]) {
    const field = dialog.getByText(t(`workflowTemplates.${key}`)).parentElement!;
    expect(within(field).getByText(value)).toBeVisible();
  }
});

it("shows the data-sending flag per tool and names the sending service", async () => {
  const dialog = await reviewStage({
    ...proposal.draft.stages[0],
    toolScope: "all",
    envelope: {
      ...reportEnvelope,
      tools: ["read_file"],
      mcpReadOnlyTools: ["sources.read"],
      mcpGenerationTools: [{ name: "media.render", effect: "generate", dataSent: true }],
      pluginGenerationTools: [{ name: "assets.crop", effect: "generate", dataSent: false }],
      network: [{ host: "reports.example", port: 8443 }],
    },
  });

  expect(dialog.getByText(`media.render · ${t("workflowTemplates.sendsToService", { service: "media" })}`)).toBeVisible();
  expect(dialog.getByText(`assets.crop · ${t("workflowTemplates.keepsInputsLocal")}`)).toBeVisible();
  expect(dialog.getByText(`read_file · ${t("workflowTemplates.noDataSentFlag")}`)).toBeVisible();
  expect(dialog.getByText(`sources.read · ${t("workflowTemplates.noDataSentFlag")}`)).toBeVisible();
  expect(dialog.getByText("reports.example:8443")).toBeVisible();
});
