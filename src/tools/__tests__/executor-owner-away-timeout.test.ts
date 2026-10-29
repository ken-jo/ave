import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";

const resources = new PermissionTestResources();
const gates: ApprovalGate[] = [];
const audits: AuditLogger[] = [];

afterEach(async () => {
  for (const gate of gates.splice(0)) gate.disposeAll();
  vi.useRealTimers();
  for (const audit of audits.splice(0)) await audit.close();
  await resources.cleanup();
});

async function fixture() {
  const root = resources.makeTmpDir("ave-owner-away-result-");
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("strict");
  await manager.ensureProjectRulesLoaded(root);
  const execute = vi.fn(async () => ({ output: "effect completed", isError: false }));
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: "network_probe", description: "Network action", source: "builtin", category: "network",
    jsonSchema: { type: "object", properties: {} }, execute,
  }));
  const surface = makeMockWebContents();
  const shown = deferred<ApprovalRequest>();
  surface.send.mockImplementation((channel: string, request: ApprovalRequest) => {
    if (channel === IPC_APPROVAL_REQUEST) shown.resolve(request);
  });
  const gate = new ApprovalGate(surface as never);
  gates.push(gate);
  const audit = new AuditLogger(join(root, "audit"));
  audits.push(audit);
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, audit);
  const run = (headless = false) => executor.executeAll([
    { id: "owner-away-action", name: "network_probe", input: {} },
  ], {
    sessionId: "owner-away-session", executionCwd: root,
    permissionContext: { trustOrigin: "user-keyboard", headless, ownerUnattended: !headless },
  });
  return { gate, surface, shown: shown.promise, execute, run };
}

describe("owner-away executor feedback", () => {
  it("waits beyond both ordinary approval and execution deadlines by default before executing the handler", async () => {
    const current = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    let completed = false;
    const running = current.run();
    void running.then(() => { completed = true; });
    const card = await current.shown;
    await vi.advanceTimersByTimeAsync(Math.max(TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs, TOOL_TIMEOUT_POLICY.globalCeilingMs) * 2);
    expect(completed).toBe(false);
    expect(current.gate.pendingCount).toBe(1);
    expect(current.execute).not.toHaveBeenCalled();
    current.gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, current.surface as never);
    const [result] = await running;
    expect(result.content).toBe("effect completed");
    expect(result.is_error).toBeUndefined();
    expect(current.execute).toHaveBeenCalledTimes(1);
  });

  it("returns no-retry feedback to the model after the configured one-minute auto-skip", async () => {
    const current = await fixture();
    current.gate.setOwnerAwayAutoSkipMinutes(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const running = current.run();
    await current.shown;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(current.gate.pendingCount).toBe(1);
    expect(current.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const [result] = await running;
    expect(result.is_error).toBe(true);
    expect(result.content).toBe(NO_APPROVER_MESSAGE);
    expect(result.content).toContain("do not retry");
    expect(current.gate.pendingCount).toBe(0);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("denies true headless execution immediately without showing an owner-away card", async () => {
    const current = await fixture();
    const [result] = await current.run(true);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain(NO_APPROVER_MESSAGE);
    expect(current.surface.send).not.toHaveBeenCalled();
    expect(current.gate.pendingCount).toBe(0);
    expect(current.execute).not.toHaveBeenCalled();
  });
});
