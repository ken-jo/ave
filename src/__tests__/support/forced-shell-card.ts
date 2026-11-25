// Fixtures for executor tests of the forced shell ask: a probed shell tool and cards the "person" answers.
import { vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { saveApprovalCardRule } from "../../permissions/approval-rule-save.js";
import type { PermissionManager } from "../../permissions/permission-manager.js";
import type { Tool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { sentApprovalCards } from "../test-helpers.js";

export function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
}

export function probe(create: () => Tool, execute: (ctx: ToolExecutionContext) => void): ToolRegistry {
  const tool = create();
  vi.spyOn(tool, "execute").mockImplementation(async (_input, ctx) => {
    execute(ctx);
    return { output: "executed", isError: false };
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  return registry;
}

export function cardGate(choice: "allow-once" | "deny-once" | "allow-session", beforeAnswer?: () => void) {
  let gate: ApprovalGate;
  const send = vi.fn((channel: string, request: ApprovalRequest) => {
    if (channel !== "ave:approval:request") return;
    beforeAnswer?.();
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice, nonce: request.nonce, hmac: request.hmac }, webContents as never);
  });
  const webContents = { isDestroyed: () => false, send };
  gate = new ApprovalGate(webContents as never);
  return { gate, cards: () => sentApprovalCards<ApprovalRequest>({ send } as never) };
}

// The person picks "This session": the card saves through the pending request, then answers allow once.
export function sessionGate(pm: PermissionManager, beforeAnswer?: () => void) {
  let gate: ApprovalGate;
  const saves: unknown[] = [];
  const send = vi.fn((channel: string, request: ApprovalRequest) => {
    if (channel !== "ave:approval:request") return;
    void (async () => {
      beforeAnswer?.();
      const snapshot = defined(gate.getRequestSnapshot(request.id) ?? undefined, "request snapshot");
      // As the approval IPC does: the save is the card's own policy transition.
      const token = gate.beginApprovalRuleSave(request.id, pm.getPolicyEpoch());
      const saved = await saveApprovalCardRule(snapshot, { action: "allow", scope: "session" },
        { decision: "allow", scope: "session", displayedVerdictAtApproval: snapshot.verdictAtApproval }, pm);
      gate.completeApprovalRuleSave(token, pm.getPolicyEpoch(), saved.ok ? saved.scope : undefined);
      saves.push(saved);
      gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, webContents as never);
    })();
  });
  const webContents = { isDestroyed: () => false, send };
  gate = new ApprovalGate(webContents as never);
  return { gate, saves, cards: () => sentApprovalCards<ApprovalRequest>({ send } as never) };
}
