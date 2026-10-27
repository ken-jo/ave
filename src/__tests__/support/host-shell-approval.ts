import { vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { buildHostShellExecutionPermitBinding, mintHostShellExecutionPermit, type HostShellToolName } from "../../permissions/host-shell-execution-permit.js";
import type { HostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import type { ToolExecutionContext } from "../../tools/base.js";

let approvalSequence = 0;

/** Issue actual desktop consent for exactly one native shell invocation. */
export async function mintOneShotHostShellPermit(input: {
  plan: HostShellExecutionPlan;
  toolName: HostShellToolName;
  toolUseId: string;
  rawInput: unknown;
  context: Pick<ToolExecutionContext, "cwd" | "extraAllowedDirectories">;
}) {
  const binding = buildHostShellExecutionPermitBinding({
    plan: input.plan, toolName: input.toolName, toolUseId: input.toolUseId, rawInput: input.rawInput,
    executionCwd: input.context.cwd, extraAllowedDirectories: input.context.extraAllowedDirectories,
  });
  if (binding === undefined) throw new Error("Shell fixture has no valid action binding");
  const webContents = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  const gate = new ApprovalGate(webContents as never);
  const id = `native-shell-${++approvalSequence}`;
  const pending = gate.requestAndWait({
    id, category: "tool", toolCategory: "shell", toolName: input.toolName, args: input.rawInput,
    reason: "Exercise an explicitly approved native shell invocation", source: "builtin", createdAt: Date.now(),
    allowedChoices: ["allow-once", "deny-once"], forceExplicit: true, hostShellExecutionPermitBinding: binding,
  });
  const request = webContents.send.mock.calls[0]?.[1] as ApprovalRequest | undefined;
  if (request?.nonce === undefined || request.hmac === undefined) throw new Error("Shell fixture did not receive a sealed request");
  gate.resolveFromDesktopRenderer(id, { requestId: id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, webContents as never);
  const permit = mintHostShellExecutionPermit({ plan: input.plan, binding, approvalDecision: await pending });
  if (permit === undefined) throw new Error("Desktop consent did not issue a shell permit");
  return permit;
}
