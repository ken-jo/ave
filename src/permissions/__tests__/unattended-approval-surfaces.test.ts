import { expect, it, vi } from "vitest";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { AskUserQuestionGate } from "../../main/ask-user-question-gate.js";
import { BrowserPagePrompts } from "../../main/browser/browser-page-prompts.js";
import { createElicitationResolverFactory } from "../../mcp/mcp-elicitation-resolver.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { buildSingleFlightAgentActionApprover } from "../agent-action-approver.js";
import { ApprovalGate, type ApprovalRequestInput } from "../approval-gate.js";
import { createExtensionStartAsker } from "../extension-start-asker.js";
import {
  __resetExtensionStartsForTest, ExtensionStartConsentRequiredError, listPendingExtensionStarts,
  runExtensionStart, setExtensionStartAsker,
} from "../extension-start-consent.js";

function unattended<T>(run: () => T): T {
  return turnExtensionPolicyContext.run({ unattendedStage: true, allowExternalHooks: false }, run);
}

async function withLiveGate(run: (gate: ApprovalGate) => Promise<void>): Promise<void> {
  const surface = makeMockWebContents();
  const audit = { log: vi.fn() };
  const gate = new ApprovalGate(surface as never, undefined, 25, audit as never);
  const remote = { onPending: vi.fn(), onSettled: vi.fn() };
  const unobserve = gate.observePendingApprovals(remote);
  try {
    await unattended(() => run(gate));
    expect(surface.send).not.toHaveBeenCalled();
    expect(remote.onPending).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ output: expect.stringContaining("[approval:unattended-approval-denied]") }));
  } finally {
    unobserve();
    gate.disposeAll();
  }
}

it.each([
  ["browser site", { toolName: "browser_tab_new", browserSite: "https://example.test", source: "builtin", forceExplicit: true, durableApprovalRecordAllowed: false }],
  ["directory", { toolName: "read_file", kind: "out-of-allowed-dir" }],
  ["plugin effect", { toolName: "plugin_tool", category: "agent-action", kind: "agent-action", source: "plugin" }],
  ["plugin operation", { toolName: "plugin_tool", kind: "tool", source: "plugin" }],
  ["egress", {
    toolName: "sandbox_network", kind: "egress-host", durableApprovalRecordAllowed: false,
    allowedChoices: ["allow-once", "deny-once"],
    egressHost: { host: "example.test", port: 443, network: "public", scopes: ["once"], rule: null },
  }],
  ["hook command", { toolName: "hook_command", kind: "tool", source: "builtin" }],
  ["permission mode", { toolName: "permission_mode", kind: "agent-action", source: "builtin" }],
] satisfies [string, Partial<ApprovalRequestInput>][])("denies a nested %s approval before local or remote delivery", async (_label, shape) => {
  await withLiveGate(async gate => {
    await expect(gate.requestAndWait({
      id: "nested", category: "tool", sessionId: "scheduled-stage",
      args: {}, reason: "Approval required", createdAt: Date.now(), ...shape,
    })).resolves.toMatchObject({ choice: "deny-once", reasonCode: "unattended-approval-denied" });
  });
});

it("declines MCP elicitation before local or remote delivery", async () => {
  await withLiveGate(async approvalGate => {
    const resolve = createElicitationResolverFactory({ approvalGate })("server");
    await expect(resolve("question", { method: "elicitation/create", mode: "form", message: "Continue?" })).resolves.toEqual({ action: "decline" });
  });
});

it("refuses a nested agent action without a receipt or a card", async () => {
  await withLiveGate(async gate => {
    const approve = buildSingleFlightAgentActionApprover(gate);
    if (!approve) throw new Error("Agent action approval was not wired");
    await expect(approve({ toolName: "agent_action", args: {}, reason: "Continue?", trustOrigin: "llm-tool-arg" })).resolves.toBeNull();
  });
});

it("refuses an unconfined extension start without a card or a deferred request", async () => {
  const ask = vi.fn();
  const notify = vi.fn();
  setExtensionStartAsker({ ask, notify });
  const start = { key: "worker:extension/helper", kind: "worker", label: "Helper" } as const;
  const spawn = vi.fn(async () => { throw new ExtensionStartConsentRequiredError("no-backend", { key: start.key, identity: "identity" }); });
  try {
    for (const session of [undefined, { sessionId: "scheduled-stage", attended: true }]) {
      await expect(unattended(() => runExtensionStart(start, session, spawn))).rejects.toThrow("unattended-approval-denied");
    }
    expect(listPendingExtensionStarts()).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
  } finally {
    __resetExtensionStartsForTest();
  }
});

it("denies a direct extension-start card request before local or remote delivery", async () => {
  await withLiveGate(async approvalGate => {
    const asker = createExtensionStartAsker({ approvalGate, reason: () => "Start helper?", notify: vi.fn() });
    await expect(asker.ask([
      { key: "plugin-child:extension", identity: "identity", kind: "plugin-child", label: "Extension", cause: "no-backend" },
    ], { sessionId: "scheduled-stage" })).resolves.toBe("no-approver");
  });
});

it("refuses a composer question without consulting the attached desktop", async () => {
  const surface = makeMockWebContents();
  const resolve = vi.fn(() => surface as never);
  const gate = new AskUserQuestionGate(resolve, 25);
  try {
    await expect(unattended(() => gate.ask({
      sessionId: "scheduled-stage", questions: [{ question: "Continue?", choices: ["Read report"] }],
    }))).resolves.toMatchObject({ dismissed: true, reasonCode: "unattended-approval-denied" });
    expect(resolve).not.toHaveBeenCalled();
    expect(surface.send).not.toHaveBeenCalled();
  } finally {
    gate.disposeAll();
  }
});

it("refuses a browser page prompt before it appears in the workspace", async () => {
  const changed = vi.fn();
  const prompts = new BrowserPagePrompts(changed);
  const response = unattended(() => prompts.ask(2, "permission", { origin: "https://example.test", permissions: ["geolocation"] }));
  try {
    expect(prompts.list(2)).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    await expect(response).resolves.toBeNull();
  } finally {
    prompts.dismissGuest(2);
  }
});
