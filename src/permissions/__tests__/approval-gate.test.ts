import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import "../../__tests__/support/trusted-powershell.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApprovalFreshIdentityRequiredError,
  ApprovalGate,
  approvalAnswererAuditToken,
  consumeHostApprovedOneShotExecutionBinding,
  IPC_APPROVAL_SETTLED,
  isHostApprovalRejectedDecision,
  isHostApprovalTimeoutDecision,
  remoteControllerOriginAuditToken,
  signApprovalRequest,
  UNATTRIBUTED_APPROVAL_SESSION_ID,
} from "../approval-gate.js";
import type {
  ApprovalAnswerer,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalSignatureFields,
} from "../approval-gate.js";
import type { HostShellExecutionPermitBinding } from "../host-shell-execution-permit.js";
import {
  buildHostShellExecutionPlan,
  getHostShellExecutionPlanAuditProjection,
} from "../host-shell-execution-plan.js";
import {
  __resetActiveSandboxCapabilityForTest,
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
} from "../sandbox-capability.js";
import {
  auditRowTexts,
  makePlatformBridgeAuthority,
  makeTestPolicy,
  auditRowStartingWith,
} from "./test-helpers.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";

// Mock WebContents

function makeMockWebContents(
  opts: { isDestroyed?: boolean; sendThrows?: boolean } = {},
) {
  return {
    send: vi.fn(() => {
      if (opts.sendThrows) throw new Error("webContents destroyed (race)");
    }),
    isDestroyed: vi.fn(() => opts.isDestroyed ?? false),
  };
}

// requestAndWait accepts the unsealed input; the gate owns `requireExplicit`.
type RequestInput = ApprovalRequestInput;

function makeRequest(overrides?: Partial<RequestInput>): RequestInput {
  return {
    id: "req-1",
    category: "tool",
    toolName: "agent_spawn",
    args: { title: "test", instructions: "hello" },
    reason: "상태 변경 도구 (trust: high, category: write)",
    source: "builtin",
    createdAt: Date.now(),
    ...overrides,
  };
}

// helper — pull the most recent (nonce, hmac) issued by the gate from the mock webContents.send call log, so tests can echo them back unchanged in the ApprovalDecision.
function lastSentNonceHmac(wc: ReturnType<typeof makeMockWebContents>): {
  nonce: string;
  hmac: string;
} {
  const cards = sentApprovalCards<ApprovalRequest>(wc);
  const last = cards[cards.length - 1]!;
  return { nonce: last.nonce as string, hmac: last.hmac as string };
}

// The request ids the gate announced as no longer answerable, in order.
function announcedSettledIds(
  wc: ReturnType<typeof makeMockWebContents>,
): string[] {
  return wc.send.mock.calls
    .map((call) => call as unknown as [string, { requestId: string }])
    .filter(([channel]) => channel === IPC_APPROVAL_SETTLED)
    .map(([, payload]) => payload.requestId);
}

// The text of every audit row a gate wrote, in order.
function makeAuditingGate(): {
  wc: ReturnType<typeof makeMockWebContents>;
  auditLogger: { log: ReturnType<typeof vi.fn> };
  gate: ApprovalGate;
} {
  const wc = makeMockWebContents();
  const auditLogger = { log: vi.fn() };
  const gate = new ApprovalGate(
    wc as never,
    undefined,
    1_000,
    auditLogger as never,
  );
  return { wc, auditLogger, gate };
}

describe("ApprovalGate", () => {
  it.each(["timeout", "shutdown", "abort"] as const)("settles %s even when the live owner lookup fails after parking", async (termination) => {
    vi.useFakeTimers();
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    let broken = false;
    const gate = new ApprovalGate(() => {
      if (broken) throw new Error("owner identity contract failed");
      return wc as never;
    }, undefined, 1_000, auditLogger as never);
    const controller = new AbortController();
    const request = makeRequest({ sessionId: "owner-session", abortSignal: controller.signal });
    const pending = gate.requestAndWait(request);
    try {
      const integrity = lastSentNonceHmac(wc);
      broken = true;
      expect(() => gate.listPendingRendererRequests(wc as never)).toThrow("owner identity contract failed");
      expect(() => gate.resolveFromDesktopRenderer(request.id, {
        requestId: request.id, choice: "allow-once", ...integrity,
      }, wc as never)).toThrow("owner identity contract failed");
      expect(gate.pendingCount).toBe(1);
      if (termination === "timeout") await vi.advanceTimersByTimeAsync(1_000);
      else if (termination === "shutdown") gate.disposeAll();
      else controller.abort(new Error("turn stopped"));
      await expect(pending).resolves.toMatchObject({ choice: "deny-once" });
      expect(gate.pendingCount).toBe(0);
      expect(announcedSettledIds(wc)).toContain(request.id);
      expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
        type: "approval", output: expect.stringContaining("[approval:notification-owner-failed]"),
      }));
    } finally {
      gate.disposeAll();
      vi.useRealTimers();
    }
  });

  it("requestAndWait resolves when resolve() is called", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest();

    const promise = gate.requestAndWait(req);

    // gate enriches req with requireExplicit + mints nonce/hmac before sending
    expect(wc.send).toHaveBeenCalledWith(
      "ave:approval:request",
      expect.objectContaining({
        id: req.id,
        toolName: req.toolName,
        requireExplicit: true,
        nonce: expect.any(String),
        hmac: expect.any(String),
      }),
    );

    const { nonce, hmac } = lastSentNonceHmac(wc);
    const decision: ApprovalDecision = {
      requestId: req.id,
      choice: "allow-once",
      nonce,
      hmac,
    };
    gate.resolve(req.id, decision);

    const result = await promise;
    expect(result.choice).toBe("allow-once");
    expect(result.requestId).toBe("req-1");
  });

  it("moves a pending card to its current owner and dismisses each surface that displayed it", async () => {
    const windowA = makeMockWebContents();
    const windowB = makeMockWebContents();
    let owner = windowA;
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(() => owner as never, undefined, undefined, auditLogger as never);
    const promise = gate.requestAndWait(makeRequest({ id: "req-two-windows" }));
    expect(gate.listPendingRendererRequests(windowB as never)).toEqual([]);
    owner = windowB;
    expect(gate.listPendingRendererRequests(windowA as never)).toEqual([]);
    expect(gate.listPendingRendererRequests(windowB as never).map((req) => req.id)).toEqual(["req-two-windows"]);

    const { nonce, hmac } = lastSentNonceHmac(windowA);
    const decision = { requestId: "req-two-windows", choice: "allow-once" as const, nonce, hmac };
    expect(gate.resolveFromDesktopRenderer("req-two-windows", decision, windowA as never)).toBeNull();
    expect(gate.pendingCount).toBe(1);
    expect(auditRowTexts(auditLogger).some((row) => row.startsWith("[approval:surface-owner-required] req-two-windows"))).toBe(true);
    expect(gate.resolveFromDesktopRenderer("req-two-windows", decision, windowB as never)).toMatchObject({ choice: "allow-once" });
    await promise;
    expect(announcedSettledIds(windowA)).toEqual(["req-two-windows"]);
    expect(announcedSettledIds(windowB)).toEqual(["req-two-windows"]);
  });

  it("listPendingRendererRequests hands back the parked request exactly as it was sent, and nothing once it is answered", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const promise = gate.requestAndWait(makeRequest({ id: "req-parked" }));

    const sent = (wc.send.mock.calls[0] as unknown as [string, ApprovalRequest])[1];
    expect(gate.listPendingRendererRequests(wc as never)).toEqual([sent]);

    const { nonce, hmac } = lastSentNonceHmac(wc);
    gate.resolve("req-parked", { requestId: "req-parked", choice: "deny-once", nonce, hmac });
    await promise;
    expect(gate.listPendingRendererRequests(wc as never)).toEqual([]);
  });

  it.each([
    { choice: "allow-once", forced: true },
    { choice: "allow-once", forced: false },
    { choice: "allow-session", forced: false },
    { choice: "allow-always", forced: false },
  ] as const)("issues one exact-action receipt for authenticated $choice with forced=$forced", async ({ choice, forced }) => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      makeTestPolicy({ requireExplicitApproval: false }),
      undefined,
      auditLogger as never,
    );
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only reason that must not enter the audit log",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const binding: HostShellExecutionPermitBinding = Object.freeze({
      plan,
      planIdentity: "host-shell-execution-plan/v4:win32:windows-partial-shell-acl-unsafe",
      toolName: "bash",
      toolUseId: "receipt-tool-use",
      command: "echo receipt",
      requestedCwd: "subdir",
      executionCwd: "C:/repo",
      resolvedCwd: "C:/repo/subdir",
      timeoutSeconds: 30,
      executionMode: "default",
      justification: undefined,
      runInBackground: false,
      allowedDirectories: Object.freeze(["c:/repo/extra"]),
    });
    const req = makeRequest({
      id: "req-host-shell-receipt",
      toolName: "bash",
      toolCategory: "shell",
      args: {
        command: binding.command,
        cwd: binding.requestedCwd,
        timeoutSeconds: binding.timeoutSeconds,
      },
      ...(forced ? { allowedChoices: ["allow-once", "deny-once"] as const, forceExplicit: true as const } : {}),
      hostShellExecutionPermitBinding: binding,
    });

    const promise = gate.requestAndWait(req);
    const sent = (wc.send.mock.calls[0] as unknown as [string, ApprovalRequest])[1];
    expect(sent).toMatchObject({
      executionPlan: getHostShellExecutionPlanAuditProjection(plan),
      requireExplicit: true,
    });
    expect(sent.allowedChoices).toEqual(forced ? ["allow-once", "deny-once"] : undefined);
    expect(sent.sandboxCapability).toBeUndefined();
    expect(JSON.stringify(sent.executionPlan)).not.toContain(binding.command);
    expect(JSON.stringify(sent.executionPlan)).not.toContain(binding.executionCwd);
    expect(sent).not.toHaveProperty("forceExplicit");
    expect(sent).not.toHaveProperty("hostShellExecutionPermitBinding");

    gate.resolve(req.id, {
      requestId: req.id,
      choice,
      nonce: sent.nonce,
      hmac: sent.hmac,
    });
    const decision = await promise;
    const auditText = JSON.stringify(auditLogger.log.mock.calls);
    expect(auditText).toContain(`executionPlan.identity=${plan.identity}`);
    expect(auditText).toContain("executionPlan.requestedSandbox=true");
    expect(auditText).toContain("executionPlan.mode=plain");
    expect(auditText).toContain("executionPlan.fallbackReason=windows-partial-shell-acl-unsafe");
    expect(auditText).toContain("executionPlan.capability.kind=none");
    expect(auditText).not.toContain(binding.command);
    expect(auditText).not.toContain(binding.requestedCwd!);
    expect(auditText).not.toContain(binding.executionCwd);
    expect(auditText).not.toContain(binding.resolvedCwd);
    expect(auditText).not.toContain("test-only reason that must not enter the audit log");
    expect(consumeHostApprovedOneShotExecutionBinding({ ...decision }, binding)).toBe(false);
    expect(consumeHostApprovedOneShotExecutionBinding(decision, binding)).toBe(true);
    expect(consumeHostApprovedOneShotExecutionBinding(decision, binding)).toBe(false);

    const wrongActionRequest = { ...req, id: "req-wrong-action" };
    const wrongActionPending = gate.requestAndWait(wrongActionRequest);
    const wrongActionCard = sentApprovalCards<ApprovalRequest>(wc).at(-1)!;
    gate.resolve(wrongActionRequest.id, { requestId: wrongActionRequest.id, choice, nonce: wrongActionCard.nonce, hmac: wrongActionCard.hmac });
    const wrongActionDecision = await wrongActionPending;
    expect(consumeHostApprovedOneShotExecutionBinding(wrongActionDecision, { ...binding, command: "echo different action" })).toBe(false);
    expect(consumeHostApprovedOneShotExecutionBinding(wrongActionDecision, binding)).toBe(false);
  });

  it("fails closed before renderer IPC when a Plan-B binding differs from the displayed shell request", async () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const binding: HostShellExecutionPermitBinding = Object.freeze({
      plan,
      planIdentity: plan.identity,
      toolName: "bash",
      toolUseId: "mismatch-tool-use",
      command: "echo host-only-command",
      requestedCwd: "subdir",
      executionCwd: "C:/repo",
      resolvedCwd: "C:/repo/subdir",
      timeoutSeconds: 30,
      executionMode: "default",
      justification: undefined,
      runInBackground: false,
      allowedDirectories: Object.freeze(["c:/repo/extra"]),
    });
    const cases = [
      {
        label: "tool",
        toolName: "powershell",
        args: { command: binding.command, cwd: binding.requestedCwd, timeoutSeconds: binding.timeoutSeconds },
      },
      {
        label: "command",
        toolName: binding.toolName,
        args: { command: "echo renderer-command", cwd: binding.requestedCwd, timeoutSeconds: binding.timeoutSeconds },
      },
      {
        label: "cwd",
        toolName: binding.toolName,
        args: { command: binding.command, cwd: "other", timeoutSeconds: binding.timeoutSeconds },
      },
      {
        label: "timeout",
        toolName: binding.toolName,
        args: { command: binding.command, cwd: binding.requestedCwd, timeoutSeconds: 31 },
      },
    ];

    for (const mismatch of cases) {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(wc as never, undefined, undefined, auditLogger as never);
      const result = await gate.requestAndWait(makeRequest({
        id: `req-host-shell-mismatch-${mismatch.label}`,
        toolName: mismatch.toolName,
        toolCategory: "shell",
        args: mismatch.args,
        allowedChoices: ["allow-once", "deny-once"],
        forceExplicit: true,
        hostShellExecutionPermitBinding: binding,
      }));

      expect(result).toMatchObject({ choice: "deny-once" });
      expect(isHostApprovalRejectedDecision(result)).toBe(true);
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
      expect(consumeHostApprovedOneShotExecutionBinding(result, binding)).toBe(false);
      const auditText = JSON.stringify(auditLogger.log.mock.calls);
      expect(auditText).toContain("[approval:host-shell-binding-mismatch]");
      expect(auditText).not.toContain(binding.command);
      expect(auditText).not.toContain(binding.executionCwd);
    }
  });

  it("rejects a structural executionPlan projection before it reaches the renderer or audit", async () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const leakedMarker = "must-not-cross-execution-plan-boundary";
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, undefined, auditLogger as never);

    const result = await gate.requestAndWait(makeRequest({
      id: "req-structural-execution-plan",
      executionPlan: {
        ...getHostShellExecutionPlanAuditProjection(plan),
        leakedMarker,
      } as never,
    }));

    expect(result).toMatchObject({ choice: "deny-once" });
    expect(isHostApprovalRejectedDecision(result)).toBe(true);
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    const auditText = JSON.stringify(auditLogger.log.mock.calls);
    expect(auditText).toContain("[approval:execution-plan-invalid]");
    expect(auditText).not.toContain(leakedMarker);
  });

  it("requires a supplied executionPlan to be the exact projection of the hidden Plan-B binding", async () => {
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "test-only",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const binding: HostShellExecutionPermitBinding = Object.freeze({
      plan,
      planIdentity: plan.identity,
      toolName: "bash",
      toolUseId: "plan-mismatch-tool-use",
      command: "echo host-only-command",
      requestedCwd: "subdir",
      executionCwd: "C:/repo",
      resolvedCwd: "C:/repo/subdir",
      timeoutSeconds: 30,
      executionMode: "default",
      justification: undefined,
      runInBackground: false,
      allowedDirectories: Object.freeze(["c:/repo/extra"]),
    });
    const otherPlan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: false,
      activeCapability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        reason: "inactive",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(wc as never, undefined, undefined, auditLogger as never);

    const result = await gate.requestAndWait(makeRequest({
      id: "req-binding-execution-plan-mismatch",
      toolName: binding.toolName,
      toolCategory: "shell",
      args: {
        command: binding.command,
        cwd: binding.requestedCwd,
        timeoutSeconds: binding.timeoutSeconds,
      },
      allowedChoices: ["allow-once", "deny-once"],
      forceExplicit: true,
      executionPlan: getHostShellExecutionPlanAuditProjection(otherPlan),
      hostShellExecutionPermitBinding: binding,
    }));

    expect(result).toMatchObject({ choice: "deny-once" });
    expect(isHostApprovalRejectedDecision(result)).toBe(true);
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    expect(consumeHostApprovedOneShotExecutionBinding(result, binding)).toBe(false);
    const auditText = JSON.stringify(auditLogger.log.mock.calls);
    expect(auditText).toContain("[approval:execution-plan-mismatch]");
    expect(auditText).toContain(`executionPlan.identity=${plan.identity}`);
    expect(auditText).not.toContain(binding.command);
    expect(auditText).not.toContain(binding.executionCwd);
  });

  it("audits agent-action issuer plugin id and scope on request and decision", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      auditLogger as never,
    );
    const req = makeRequest({
      id: "req-agent-action-1",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
      trustOrigin: "plugin-emitted",
    });

    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);
    gate.resolve(req.id, {
      requestId: req.id,
      choice: "allow-once",
      nonce,
      hmac,
    });
    await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

    const rows = auditLogger.log.mock.calls.map(([entry]) => {
      const auditEntry = entry as { input?: string; output?: string };
      return auditEntry.input ?? auditEntry.output ?? "";
    });
    const requested = rows.find((row) =>
      row.includes("[approval:requested] req-agent-action-1"),
    );
    const decided = rows.find((row) =>
      row.includes("[approval:decided] req-agent-action-1"),
    );
    expect(requested).toContain("category=agent-action");
    expect(requested).toContain("kind=agent-action");
    expect(requested).toContain("source=plugin");
    expect(requested).toContain("sourcePluginId=sample-plugin");
    expect(requested).toContain("approvalScope=agent_external_api_call");
    expect(decided).toContain("category=agent-action");
    expect(decided).toContain("kind=agent-action");
    expect(decided).toContain("source=plugin");
    expect(decided).toContain("sourcePluginId=sample-plugin");
    expect(decided).toContain("approvalScope=agent_external_api_call");
  });

  it("audits agent-action issuer plugin id and scope on timeout", async () => {
    vi.useFakeTimers();
    try {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        1_000,
        auditLogger as never,
      );
      const req = makeRequest({
        id: "req-agent-timeout",
        category: "agent-action",
        kind: "agent-action",
        toolCategory: "meta",
        source: "plugin",
        sourcePluginId: "sample-plugin",
        approvalScope: "agent_external_api_call",
      });

      const promise = gate.requestAndWait(req);
      vi.advanceTimersByTime(1_001);
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

      const rows = auditLogger.log.mock.calls.map(([entry]) => {
        const auditEntry = entry as { input?: string; output?: string };
        return auditEntry.input ?? auditEntry.output ?? "";
      });
      const timeout = rows.find((row) =>
        row.includes("[approval:timeout] req-agent-timeout"),
      );
      expect(timeout).toContain("category=agent-action");
      expect(timeout).toContain("kind=agent-action");
      expect(timeout).toContain("sourcePluginId=sample-plugin");
      expect(timeout).toContain("approvalScope=agent_external_api_call");
    } finally {
      vi.useRealTimers();
    }
  });

  it("audits agent-action issuer plugin id and scope on nonce mismatch", async () => {
    const wc = makeMockWebContents();
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      auditLogger as never,
    );
    const req = makeRequest({
      id: "req-agent-nonce-mismatch",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
    });

    const promise = gate.requestAndWait(req);
    const { hmac } = lastSentNonceHmac(wc);
    gate.resolve(req.id, {
      requestId: req.id,
      choice: "allow-once",
      nonce: "00000000000000000000000000000000",
      hmac,
    });
    await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

    const rows = auditLogger.log.mock.calls.map(([entry]) => {
      const auditEntry = entry as { input?: string; output?: string };
      return auditEntry.input ?? auditEntry.output ?? "";
    });
    const mismatch = rows.find((row) =>
      row.includes("[approval:nonce-mismatch] req-agent-nonce-mismatch"),
    );
    expect(mismatch).toContain("category=agent-action");
    expect(mismatch).toContain("kind=agent-action");
    expect(mismatch).toContain("sourcePluginId=sample-plugin");
    expect(mismatch).toContain("approvalScope=agent_external_api_call");
  });

  it("timeout returns deny-once after timeoutMs", async () => {
    vi.useFakeTimers();
    const wc = makeMockWebContents();
    // initialPolicy is now the 2nd arg — pass undefined to use default, timeoutMs is 3rd
    const gate = new ApprovalGate(wc as never, undefined, 1000); // 1s timeout
    const req = makeRequest({ id: "req-timeout" });

    const promise = gate.requestAndWait(req);

    // 타임아웃 경과
    vi.advanceTimersByTime(1001);

    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-timeout");
    expect(isHostApprovalTimeoutDecision(result)).toBe(true);
    expect(isHostApprovalRejectedDecision(result)).toBe(false);

    vi.useRealTimers();
  });

  it("concurrent requests do not cross-contaminate", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const req1 = makeRequest({ id: "req-a", toolName: "tool_a" });
    const req2 = makeRequest({ id: "req-b", toolName: "tool_b" });

    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    const callA = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const callB = wc.send.mock.calls[1] as [string, ApprovalRequest];
    // req-b를 먼저 응답
    gate.resolve("req-b", {
      requestId: "req-b",
      choice: "deny-once",
      nonce: callB[1].nonce,
      hmac: callB[1].hmac,
    });
    // req-a를 나중에 응답
    gate.resolve("req-a", {
      requestId: "req-a",
      choice: "allow-always",
      nonce: callA[1].nonce,
      hmac: callA[1].hmac,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.choice).toBe("allow-always");
    expect(r2.choice).toBe("deny-once");
    expect(r1.requestId).toBe("req-a");
    expect(r2.requestId).toBe("req-b");
  });

  it.each(["fresh", "unavailable", "error", "timeout", "malformed"] as const)("keeps a normal approval card after reviewer outcome %s", async (reviewerOutcome) => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ reviewerOutcome, reviewerVerdict: { level: "high", reason: "Needs a human decision" } });
    const pending = gate.requestAndWait(req);
    const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    expect(sent.allowedChoices).toBeUndefined();
    expect(sent.exactRecordAllowed).toBe(true);
    expect(sent).not.toHaveProperty("reviewerOutcome");
    gate.resolveFromDesktopRenderer(req.id, { requestId: req.id, choice: "allow-session", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
    await expect(pending).resolves.toMatchObject({ choice: "allow-session" });
  });

  // The card offers an exact Always deny only where the record handler would accept one (`one-shot-not-recordable` otherwise).
  it.each([
    [{}, true],
    [{ durableApprovalRecordAllowed: false as const }, false],
    [{ allowedChoices: ["allow-once", "deny-once"] as const }, false],
  ])("tells the card whether the exact-approval store records this request (%j)", async (restriction, recordable) => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ toolName: "write_file", toolCategory: "write", args: { path: "/workspace/a.txt" }, ...restriction });
    const pending = gate.requestAndWait(req);
    const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    expect(sent.exactRecordAllowed).toBe(recordable);
    expect(gate.getRequestSnapshot(req.id)?.durableApprovalRecordAllowed).toBe(recordable);
    gate.resolveFromDesktopRenderer(req.id, { requestId: req.id, choice: "deny-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
    await pending;
  });

  it("webContents.send is called with the correct channel and payload shape", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-shape" });

    gate.requestAndWait(req);

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as [
      string,
      ApprovalRequest,
    ];
    expect(channel).toBe("ave:approval:request");
    expect(payload.id).toBe("req-shape");
    expect(payload.toolName).toBe("agent_spawn");
    expect(payload.category).toBe("tool");
    expect(payload.source).toBe("builtin");
    // default policy: requireExplicitApproval = true
    expect(payload.requireExplicit).toBe(true);

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("requireExplicit=false가 페이로드에 포함됨 (policy.requireExplicitApproval=false)", async () => {
    const wc = makeMockWebContents();
    const policy = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, policy);
    const req = makeRequest({ id: "req-nonstrict" });

    gate.requestAndWait(req);

    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.requireExplicit).toBe(false);

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("a policy object without requireExplicitApproval keeps approval explicit", async () => {
    const wc = makeMockWebContents();
    const { requireExplicitApproval: _dropped, ...withoutField } = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, withoutField as never);
    const req = makeRequest({ id: "req-field-missing" });

    gate.requestAndWait(req);

    expect(sentApprovalCards<ApprovalRequest>(wc)[0]!.requireExplicit).toBe(true);

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("forceExplicit은 완화 정책에서도 명시적 승인을 유지한다", async () => {
    const wc = makeMockWebContents();
    const policy = makeTestPolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, policy);
    const req = makeRequest({ id: "req-forced-explicit", forceExplicit: true });

    gate.requestAndWait(req);

    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.requireExplicit).toBe(true);
    expect(payload).not.toHaveProperty("forceExplicit");

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("setPolicy 호출 후 다음 request에 새 requireExplicit 반영", async () => {
    const wc = makeMockWebContents();
    const strictPolicy = makeTestPolicy({ requireExplicitApproval: true });
    const gate = new ApprovalGate(wc as never, strictPolicy);

    // 첫 번째 request — strict
    const req1 = makeRequest({ id: "req-before" });
    gate.requestAndWait(req1);
    expect(sentApprovalCards<ApprovalRequest>(wc)[0]!.requireExplicit).toBe(true);
    gate.resolve(req1.id, { requestId: req1.id, choice: "deny-once" });

    // policy 교체
    gate.setPolicy(makeTestPolicy({ requireExplicitApproval: false }));
    expect(gate.policy.requireExplicitApproval).toBe(false);

    // 두 번째 request — lenient
    const req2 = makeRequest({ id: "req-after" });
    gate.requestAndWait(req2);
    expect(sentApprovalCards<ApprovalRequest>(wc)[1]!.requireExplicit).toBe(false);
    gate.resolve(req2.id, { requestId: req2.id, choice: "allow-once" });
  });

  it("resolve with unknown requestId is a no-op", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // 등록되지 않은 ID에 resolve — throw 없이 무시
    expect(() =>
      gate.resolve("unknown-id", {
        requestId: "unknown-id",
        choice: "allow-once",
      }),
    ).not.toThrow();
  });

  it("pendingCount tracks pending requests correctly", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    expect(gate.pendingCount).toBe(0);

    const req1 = makeRequest({ id: "cnt-1" });
    const req2 = makeRequest({ id: "cnt-2" });
    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    expect(gate.pendingCount).toBe(2);

    gate.resolve("cnt-1", { requestId: "cnt-1", choice: "allow-once" });
    await p1;
    expect(gate.pendingCount).toBe(1);

    gate.resolve("cnt-2", { requestId: "cnt-2", choice: "deny-once" });
    await p2;
    expect(gate.pendingCount).toBe(0);
  });

  it("denies a mutation immediately when no desktop surface exists", async () => {
    const gate = new ApprovalGate(null);
    const observer = vi.fn();
    const dispose = gate.observePendingApprovals({ onPending: observer, onSettled: observer });
    observer.mockClear();
    const result = await gate.requestAndWait(makeRequest({
      category: "agent-action", kind: "agent-action", toolCategory: "meta",
    }));
    expect(result.choice).toBe("deny-once");
    expect(isHostApprovalRejectedDecision(result)).toBe(true);
    expect(gate.pendingCount).toBe(0);
    expect(observer).not.toHaveBeenCalled();
    dispose();
  });

  it("attributes unattended denials and notifies without exposing an approval surface", async () => {
    const log = vi.fn();
    const onDenied = vi.fn(() => { throw new Error("stderr unavailable"); });
    const gate = new ApprovalGate(null, undefined, undefined, { log } as never, undefined, { onDenied });
    const onPending = vi.fn();
    const dispose = gate.observePendingApprovals({ onPending, onSettled: vi.fn() });
    const request = makeRequest({ category: "agent-action", kind: "agent-action", toolCategory: "meta" });
    const decision = await gate.requestAndWait(request);
    expect(decision.choice).toBe("deny-once");
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
    expect(onDenied).toHaveBeenCalledWith(request.id, request.toolName);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ output: expect.stringContaining("answeredBy=headless-exec") }));
    expect(onPending).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    dispose();
  });

  // F2: webContents lifecycle guards

  it("isDestroyed() true → deny-once immediately, no pending entry", async () => {
    const wc = makeMockWebContents({ isDestroyed: true });
    const auditLogger = { log: vi.fn() };
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      auditLogger as never,
    );
    const req = makeRequest({
      id: "req-destroyed",
      category: "agent-action",
      kind: "agent-action",
      toolCategory: "meta",
      source: "plugin",
      sourcePluginId: "sample-plugin",
      approvalScope: "agent_external_api_call",
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-destroyed");
    // send should never be called when already destroyed
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    const auditEntry = auditLogger.log.mock.calls[0]?.[0] as
      { output?: string } | undefined;
    expect(auditEntry?.output).toContain("sourcePluginId=sample-plugin");
    expect(auditEntry?.output).toContain(
      "approvalScope=agent_external_api_call",
    );
  });

  it("webContents.send throws → deny-once + pendingCount === 0", async () => {
    const wc = makeMockWebContents({ sendThrows: true });
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-send-throw" });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-send-throw");
    expect(gate.pendingCount).toBe(0);
  });

  it.each([
    { target: { filePath: "/workspace/../outside/.git/config" } },
  ])("presents the pipeline-selected card without reclassifying %j", async (input) => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest(input);
    const pending = gate.requestAndWait(req);
    const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    expect(gate.pendingCount).toBe(1);
    expect(sent.target).toEqual(input.target);
    gate.resolveFromDesktopRenderer(req.id, { requestId: req.id, choice: "deny-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
    await expect(pending).resolves.toMatchObject({ choice: "deny-once" });
  });

  it("waits without a timer for an owner-away card by default", async () => {
    vi.useFakeTimers();
    try {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never, undefined, 100);
      const req = makeRequest({ ownerUnattended: true });
      const pending = gate.requestAndWait(req);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(gate.pendingCount).toBe(1);
      const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
      expect(sent).not.toHaveProperty("ownerUnattended");
      gate.resolveFromDesktopRenderer(req.id, { requestId: req.id, choice: "allow-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
      await expect(pending).resolves.toMatchObject({ choice: "allow-once" });
    } finally { vi.useRealTimers(); }
  });

  it("auto-skips an owner-away card only after the configured interval with no-retry feedback", async () => {
    vi.useFakeTimers();
    try {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never, undefined, 100);
      gate.setOwnerAwayAutoSkipMinutes(2);
      const pending = gate.requestAndWait(makeRequest({ ownerUnattended: true }));
      await vi.advanceTimersByTimeAsync(119_999);
      expect(gate.pendingCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ choice: "deny-once", rememberPattern: "Nobody can approve this request; do not retry." });
      expect(gate.pendingCount).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([-1, 0.5, Infinity, NaN])("rejects invalid owner-away skip interval %s", (minutes) => {
    expect(() => new ApprovalGate(null).setOwnerAwayAutoSkipMinutes(minutes)).toThrow("nonnegative integer");
  });

  // D1: args DLP masking for UI payload

  it("D1: API key in args is masked in UI payload, original preserved in caller's object", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const originalArgs = {
      prompt: "use sk-abcdefghijklmnopqrstuvwxyz12345",
      email: "user@example.com",
      nested: { phone: "010-1234-5678", count: 3 },
    };
    const req = makeRequest({
      id: "req-dlp-args",
      toolName: "llm_call",
      args: originalArgs,
    });

    gate.requestAndWait(req);

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const maskedArgs = payload.args as typeof originalArgs;

    // UI payload is masked
    expect(maskedArgs.prompt).toBe("use [REDACTED:TOKEN]");
    expect(maskedArgs.email).toBe("***@example.com");
    expect(maskedArgs.nested.phone).toBe("010-****-****");
    expect(maskedArgs.nested.count).toBe(3);

    // Caller's original args object is NOT mutated — tool execution uses this
    expect(originalArgs.prompt).toBe("use sk-abcdefghijklmnopqrstuvwxyz12345");
    expect(originalArgs.email).toBe("user@example.com");
    expect(originalArgs.nested.phone).toBe("010-1234-5678");
    expect(req.args).toBe(originalArgs);

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("D1: args with no sensitive data pass through (deep-equal) unchanged", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dlp-clean",
      args: { title: "hello", items: ["a", "b"], n: 1 },
    });

    gate.requestAndWait(req);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.args).toEqual({ title: "hello", items: ["a", "b"], n: 1 });

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("D1: SSN and credit card in string args are masked", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-dlp-ssn",
      args: { memo: "주민번호 900101-1234567 카드 4111-1111-1111-1111" },
    });

    gate.requestAndWait(req);
    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const memo = (payload.args as { memo: string }).memo;
    expect(memo).toContain("******-*******");
    expect(memo).toContain("****-****-****-1111");
    expect(memo).not.toContain("900101-1234567");

    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  // D2: HMAC nonce / confused-deputy defense

  it("D2: happy path — valid nonce+hmac echo is honored", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-ok" });
    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);

    // Payload must carry a non-empty nonce + hmac
    expect(nonce).toMatch(/^[0-9a-f]+$/);
    expect(hmac).toMatch(/^[0-9a-f]+$/);

    gate.resolve("d2-ok", {
      requestId: "d2-ok",
      choice: "allow-once",
      nonce,
      hmac,
    });
    const result = await promise;
    expect(result.choice).toBe("allow-once");
  });

  it("D2: missing nonce/hmac → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-missing" });
    const promise = gate.requestAndWait(req);

    // Renderer neglects to echo nonce+hmac
    gate.resolve("d2-missing", {
      requestId: "d2-missing",
      choice: "allow-once",
    });

    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("approval integrity check failed");
    expect(gate.pendingCount).toBe(0);
  });

  it("D2: wrong nonce → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-badnonce" });
    const promise = gate.requestAndWait(req);
    const { hmac } = lastSentNonceHmac(wc);

    gate.resolve("d2-badnonce", {
      requestId: "d2-badnonce",
      choice: "allow-always",
      nonce: "00000000000000000000000000000000",
      hmac,
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.rememberPattern).toContain("approval integrity check failed");
  });

  it("D2: wrong hmac → forced deny-once", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "d2-badhmac" });
    const promise = gate.requestAndWait(req);
    const { nonce, hmac } = lastSentNonceHmac(wc);
    // Flip one hex char
    const tamperedHmac = (hmac[0] === "a" ? "b" : "a") + hmac.slice(1);

    gate.resolve("d2-badhmac", {
      requestId: "d2-badhmac",
      choice: "allow-once",
      nonce,
      hmac: tamperedHmac,
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
  });

  it("D2: replay of a prior request's nonce/hmac against a different request fails", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    // Issue two distinct approval requests
    const p1 = gate.requestAndWait(
      makeRequest({ id: "d2-req-1", toolName: "tool_a" }),
    );
    const p2 = gate.requestAndWait(
      makeRequest({ id: "d2-req-2", toolName: "tool_b" }),
    );
    const call1 = wc.send.mock.calls[0] as [string, ApprovalRequest];
    const call2 = wc.send.mock.calls[1] as [string, ApprovalRequest];

    // Attacker replays req-1's nonce/hmac inside a response claiming to decide req-2
    gate.resolve("d2-req-2", {
      requestId: "d2-req-2",
      choice: "allow-always",
      nonce: call1[1].nonce,
      hmac: call1[1].hmac,
    });
    const r2 = await p2;
    expect(r2.choice).toBe("deny-once");

    // Legitimate decide of req-1 still works
    gate.resolve("d2-req-1", {
      requestId: "d2-req-1",
      choice: "allow-once",
      nonce: call1[1].nonce,
      hmac: call1[1].hmac,
    });
    const r1 = await p1;
    expect(r1.choice).toBe("allow-once");
  });

  it("D2: nonce values are unique across requests (not constant)", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(makeRequest({ id: "d2-u1" }));
    gate.requestAndWait(makeRequest({ id: "d2-u2" }));
    const n1 = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1].nonce;
    const n2 = (wc.send.mock.calls[1] as [string, ApprovalRequest])[1].nonce;
    expect(n1).toBeTruthy();
    expect(n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });

  it("auto-injects sandboxCapability for tool-kind requests (round-4 test-engineer MAJOR)", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(makeRequest({ id: "req-sandbox-inject", source: "builtin" }));
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toEqual(
      resolveReviewerSandboxCapability("builtin", sent.toolName),
    );
  });

  // NO-LEAK INVARIANT (sandbox-capability.ts): "never report `asrt` for a worker this process did not wrap". A plugin operation-grant ask runs in an unwrapped long-lived worker, so the isolation row must never claim the host-shell ASRT confinement the process itself happens to have.
  it("never reports the process-global capability for a plugin execution ask", () => {
    const wc = makeMockWebContents();
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: process.platform,
      reason: "host-shell substrate confined for this test",
      confines: { filesystem: true, process: true, network: true },
    });
    try {
      const gate = new ApprovalGate(wc as never);
      gate.requestAndWait(
        makeRequest({
          id: "req-plugin-write",
          toolName: "sample_plugin_write",
          toolCategory: "write",
          source: "plugin",
        }),
      );
      const sent = (wc.send.mock.calls[0] as unknown as [string, ApprovalRequest])[1];
      expect(sent.sandboxCapability?.kind).toBe("none");
      expect(sent.sandboxCapability).toEqual(
        resolveReviewerSandboxCapability("plugin", "sample_plugin_write"),
      );
    } finally {
      __resetActiveSandboxCapabilityForTest();
    }
  });

  it("omits the isolation row when the request declares no source (fail closed)", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(makeRequest({ id: "req-no-source", source: undefined }));
    const sent = (wc.send.mock.calls[0] as unknown as [string, ApprovalRequest])[1];
    expect(sent.source).toBeUndefined();
    expect(sent.sandboxCapability).toBeUndefined();
  });

  it("preserves an explicitly-provided sandboxCapability without re-detecting (round-4 test-engineer MAJOR)", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const explicitCap = {
      kind: "none" as const,
      confidence: "verified" as const,
      platform: "darwin" as NodeJS.Platform,
      reason: "caller-supplied override",
    };
    gate.requestAndWait(
      makeRequest({
        id: "req-sandbox-explicit",
        sandboxCapability: explicitCap,
      }),
    );
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toEqual(explicitCap);
  });

  it("resolves the isolation row through the real substrate authority (round-6 test-engineer MAJOR)", () => {
    // Production-path integration test — the gate must reach the REAL resolveReviewerSandboxCapability, not a stub. A refactor that drops the wiring would silently break the dialog's "보안 격리" row in production but pass every stubbed unit test.
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(makeRequest({ id: "req-real-default", source: "builtin" }));
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeDefined();
    expect(sent.sandboxCapability?.kind).toMatch(/^(none|asrt)$/);
    expect(sent.sandboxCapability?.platform).toBe(process.platform);
  });

  it("does NOT inject sandboxCapability for toolCategory=meta requests (round-5 critic MAJOR-1)", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // Mode-change asks (permission-mode-apply.ts) and agent-action asks (agent-action-requester.ts) both pass toolCategory="meta". The sandbox row is meaningless on config-change cards — verify the injection is suppressed.
    gate.requestAndWait(
      makeRequest({
        id: "req-meta",
        toolName: "permission_mode_change",
        toolCategory: "meta",
        args: { fromMode: "default", toMode: "auto", durable: true },
      }),
    );
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeUndefined();
  });

  it("does NOT inject sandboxCapability for agent-action requests", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(
      makeRequest({
        id: "req-agent-action",
        category: "agent-action",
        kind: "agent-action",
        toolName: "sample_plugin_decide_approval_with_host",
        toolCategory: "meta",
        args: { approvalId: 42 },
        source: "plugin",
      }),
    );
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.category).toBe("agent-action");
    expect(sent.kind).toBe("agent-action");
    expect(sent.sandboxCapability).toBeUndefined();
  });

  it("does NOT inject sandboxCapability for out-of-allowed-dir kind (round-4 critic CRITICAL C2)", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    gate.requestAndWait(
      makeRequest({
        id: "req-oad",
        kind: "out-of-allowed-dir",
        toolName: "read_file",
        outOfAllowedDir: {
          candidatePath: "/some/path",
          suggestedParent: "/some",
          currentAllowed: [],
          adjacencyWarnings: [],
        },
      }),
    );
    const sent = (wc.send.mock.calls[0] as [string, ApprovalRequest])[1];
    expect(sent.sandboxCapability).toBeUndefined();
  });

  describe("conversation attribution", () => {
    // The gate's HMAC key is `private` in TypeScript only — it is an ordinary runtime property. Reading it lets a test mint the exact signature the gate would have produced for a *different* conversation, which is the only way to prove the attribution is inside the signing preimage rather than sitting beside it.
    function gateSessionKey(gate: ApprovalGate): Buffer {
      return (gate as unknown as { sessionKey: Buffer }).sessionKey;
    }

    function lastSentRequest(
      wc: ReturnType<typeof makeMockWebContents>,
    ): ApprovalRequest {
      const calls = wc.send.mock.calls;
      return (calls[calls.length - 1] as unknown as [string, ApprovalRequest])[1];
    }

    function auditRows(auditLogger: { log: ReturnType<typeof vi.fn> }): {
      sessionId: string;
      text: string;
    }[] {
      return auditLogger.log.mock.calls.map(([entry]) => {
        const row = entry as {
          sessionId: string;
          input?: string;
          output?: string;
        };
        return { sessionId: row.sessionId, text: row.input ?? row.output ?? "" };
      });
    }

    it("signs the attribution: the echoed signature verifies for its own conversation", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRequest({ id: "attr-roundtrip", sessionId: "conv-a" });

      const promise = gate.requestAndWait(req);

      const sent = lastSentRequest(wc);
      expect(sent.sessionId).toBe("conv-a");
      // The gate's own digest is exactly the signature over the attribution it emitted — binding the emit path to the shared signing function.
      expect(sent.hmac).toBe(
        signApprovalRequest(gateSessionKey(gate), {
          id: "attr-roundtrip",
          nonce: sent.nonce as string,
          toolName: req.toolName,
          sessionId: "conv-a",
          args: req.args,
        }),
      );

      gate.resolve("attr-roundtrip", {
        requestId: "attr-roundtrip",
        choice: "allow-always",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "allow-always" });
    });

    it("rejects a signature minted for a different conversation", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRequest({ id: "attr-tampered", sessionId: "conv-a" });

      const promise = gate.requestAndWait(req);
      const sent = lastSentRequest(wc);

      // Same id, nonce, tool and args — only the conversation differs. If the attribution were outside the preimage this digest would equal the one the gate issued and the allow-always below would be honored.
      const reattributed = signApprovalRequest(gateSessionKey(gate), {
        id: "attr-tampered",
        nonce: sent.nonce as string,
        toolName: req.toolName,
        sessionId: "conv-b",
        args: req.args,
      });
      expect(reattributed).not.toBe(sent.hmac);

      gate.resolve("attr-tampered", {
        requestId: "attr-tampered",
        choice: "allow-always",
        nonce: sent.nonce,
        hmac: reattributed,
      });

      await expect(promise).resolves.toMatchObject({
        choice: "deny-once",
        rememberPattern: "approval integrity check failed",
      });
    });

    it("does not let an unattributed request verify under an attributed signature", async () => {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never);
      const req = makeRequest({ id: "attr-absent" });

      const promise = gate.requestAndWait(req);
      const sent = lastSentRequest(wc);
      expect(sent.sessionId).toBeUndefined();

      // Absence is signed as an explicit null, so it is a distinct preimage from any real conversation rather than a shape a legacy signature could satisfy.
      const asAttributed = signApprovalRequest(gateSessionKey(gate), {
        id: "attr-absent",
        nonce: sent.nonce as string,
        toolName: req.toolName,
        sessionId: "conv-a",
        args: req.args,
      });
      expect(asAttributed).not.toBe(sent.hmac);

      gate.resolve("attr-absent", {
        requestId: "attr-absent",
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: asAttributed,
      });
      await expect(promise).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("attributes requested and decided audit rows to the asking conversation", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        1_000,
        auditLogger as never,
      );

      const promiseA = gate.requestAndWait(
        makeRequest({ id: "attr-audit-a", sessionId: "conv-a" }),
      );
      const sentA = lastSentRequest(wc);
      gate.resolve("attr-audit-a", {
        requestId: "attr-audit-a",
        choice: "allow-once",
        nonce: sentA.nonce,
        hmac: sentA.hmac,
      });
      await promiseA;

      const promiseB = gate.requestAndWait(
        makeRequest({ id: "attr-audit-b", sessionId: "conv-b" }),
      );
      const sentB = lastSentRequest(wc);
      gate.resolve("attr-audit-b", {
        requestId: "attr-audit-b",
        choice: "deny-once",
        nonce: sentB.nonce,
        hmac: sentB.hmac,
      });
      await promiseB;

      const rows = auditRows(auditLogger);
      const sessionFor = (marker: string) =>
        rows.filter((row) => row.text.includes(marker)).map((r) => r.sessionId);

      expect(sessionFor("[approval:requested] attr-audit-a")).toEqual(["conv-a"]);
      expect(sessionFor("[approval:decided] attr-audit-a")).toEqual(["conv-a"]);
      expect(sessionFor("[approval:requested] attr-audit-b")).toEqual(["conv-b"]);
      expect(sessionFor("[approval:decided] attr-audit-b")).toEqual(["conv-b"]);
      // Replay can now separate the two conversations, and no row is filed under the old subsystem placeholder.
      expect(rows.map((row) => row.sessionId)).not.toContain("approval-gate");
    });

    it("files an approval with no conversation under the unattributed sentinel", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        wc as never,
        undefined,
        1_000,
        auditLogger as never,
      );

      const promise = gate.requestAndWait(makeRequest({ id: "attr-none" }));
      const sent = lastSentRequest(wc);
      gate.resolve("attr-none", {
        requestId: "attr-none",
        choice: "allow-once",
        nonce: sent.nonce,
        hmac: sent.hmac,
      });
      await promise;

      const rows = auditRows(auditLogger);
      expect(
        rows.filter((row) => row.text.includes("attr-none")).map((r) => r.sessionId),
      ).toEqual([
        UNATTRIBUTED_APPROVAL_SESSION_ID,
        UNATTRIBUTED_APPROVAL_SESSION_ID,
      ]);
      expect(rows.map((row) => row.sessionId)).not.toContain("approval-gate");
    });

    it("attributes a host-rejected request that never reaches the renderer", async () => {
      const wc = makeMockWebContents();
      const auditLogger = { log: vi.fn() };
      const gate = new ApprovalGate(
        null,
        undefined,
        1_000,
        auditLogger as never,
      );

      // Missing approval transport denies before a card is parked.
      await expect(
        gate.requestAndWait(
          makeRequest({
            id: "attr-blocked",
            sessionId: "conv-blocked",
            target: { filePath: "/home/u/.ssh/id_rsa" },
          }),
        ),
      ).resolves.toMatchObject({ choice: "deny-once" });

      const blocked = auditRows(auditLogger).find((row) =>
        row.text.includes("[approval:send-failed] attr-blocked"),
      );
      expect(blocked?.sessionId).toBe("conv-blocked");
    });


  });

  // Answerer attribution `sessionId` names the conversation that was blocked; `answeredBy` names who ended the block. The assertions below are about the shape of the record: the field is present with a real value on the row that records an answer, absent everywhere else, host-derived, and closed.
  describe("approval answerer", () => {
    // Read the row's answerer, so a test asserts its value and not merely that the word appears.
    function answererOf(row: string): string | undefined {
      return /(?:^| )answeredBy=(\S+)/.exec(row)?.[1];
    }

    it("records the desk as the answerer on the decided row", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "answerer-desk" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("answerer-desk", {
        requestId: "answerer-desk",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

      const decided = auditRowTexts(auditLogger).find((row) =>
        row.includes("[approval:decided] answerer-desk"),
      );
      expect(decided).toBeDefined();
      expect(answererOf(decided as string)).toBe("desk");
    });

    it("names an answerer on the decided row and on no other row", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "answerer-scope" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("answerer-scope", {
        requestId: "answerer-scope",
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;

      const rows = auditRowTexts(auditLogger);
      // The requested row is emitted for this same approval, so "only the decided row names an answerer" constrains a non-empty set of other rows rather than asserting something about nothing.
      expect(
        rows.some((row) => row.includes("[approval:requested] answerer-scope")),
      ).toBe(true);
      expect(
        rows
          .filter((row) => answererOf(row) !== undefined)
          .map((row) => row.split(" ")[0]),
      ).toEqual(["[approval:decided]"]);
    });

    it("claims no answerer when the host resolved the request itself", async () => {
      vi.useFakeTimers();
      try {
        const { auditLogger, gate } = makeAuditingGate();

        const promise = gate.requestAndWait(
          makeRequest({ id: "answerer-timeout" }),
        );
        vi.advanceTimersByTime(1_001);
        await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

        const timeout = auditRowTexts(auditLogger).find((row) =>
          row.includes("[approval:timeout] answerer-timeout"),
        );
        expect(timeout).toBeDefined();
        // Absence is the record. Nobody answered, so naming the desk here would assert a user action that never happened.
        expect(answererOf(timeout as string)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores an answerer smuggled in the renderer's response payload", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "answerer-spoof" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("answerer-spoof", {
        requestId: "answerer-spoof",
        choice: "allow-once",
        nonce,
        hmac,
        // A hostile renderer sends whatever JSON it likes. `answeredBy` is not a field of ApprovalDecision precisely because the host never reads one — an integrity-verified response still does not get to say who sent it.
        answeredBy: "remote",
      } as ApprovalDecision & { answeredBy: string });
      await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

      const decided = auditRowTexts(auditLogger).find((row) =>
        row.includes("[approval:decided] answerer-spoof"),
      );
      expect(answererOf(decided as string)).toBe("desk");
    });

    it("closes the union: a non-member answerer is an anomaly, not the desk", () => {
      // @ts-expect-error — "remote" is not an ApprovalAnswerer, and the away
      // answerer joining the union did not make it one. That is the point of
      // this row: the union is closed against the value a relay design would
      // have needed, not merely small. The directive is the type-level half —
      // it suppresses an error today, and `check:typecheck-tests` reports it as
      // unused the moment an answerer named "remote" is added.
      const widened: ApprovalAnswerer = "remote";
      expect(approvalAnswererAuditToken(widened)).toBe("unrecognized-answerer");
      // The runtime half: the guarantee has to survive a caller that casts past the type, and an inherited property is not an answerer.
      expect(approvalAnswererAuditToken("toString" as never)).toBe(
        "unrecognized-answerer",
      );
      // Every member renders as itself. A new member that forgot its token would fail to compile in the audit table; one that mistyped it fails here.
      expect(approvalAnswererAuditToken("desk")).toBe("desk");
    });
  });

  // Remote-controller origin The marker answers "was a remote controller's turn blocked on this approval?" It is a fact the host wrote down, not one a later reader reconstructs from the reason text, and not one the renderer is asked for or told. Every assertion below is about that: the value the host set, on the rows that outlive the request, and nowhere the renderer can see.
  describe("remote-controller origin", () => {
    function makeControllerRequest(overrides: Partial<RequestInput>): RequestInput {
      const sessionId = overrides.sessionId ?? "controller-session";
      const authority = overrides.remoteControllerOrigin === "platform-bridge"
        ? makePlatformBridgeAuthority()
        : { kind: "tailnet-controller" as const, actorId: "tailnet:controller-digest" as const, pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" }, pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => true } };
      return makeRequest({ ...overrides, sessionId, remoteControllerAuthority: bindRemoteControllerToSession(authority, sessionId) });
    }

    function originOf(row: string): string | undefined {
      return /(?:^| )remoteControllerOrigin=(\S+)/.exec(row)?.[1];
    }

    function rowsFor(
      auditLogger: { log: ReturnType<typeof vi.fn> },
      id: string,
    ): string[] {
      return auditRowTexts(auditLogger).filter((row) => row.includes(id));
    }

    it("names the controller on every row a remote turn produces", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(
        makeControllerRequest({
          id: "origin-tailnet",
          remoteControllerOrigin: "tailnet-controller",
        }),
      );
      const { nonce, hmac } = lastSentNonceHmac(wc);
      await gate.resolveWithFreshIdentity("origin-tailnet", {
        requestId: "origin-tailnet",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await expect(promise).resolves.toMatchObject({ choice: "allow-once" });

      const rows = rowsFor(auditLogger, "origin-tailnet");
      expect(rows.map((row) => row.split(" ")[0])).toEqual([
        "[approval:requested]",
        "[approval:decided]",
      ]);
      // The decided row is written from the pending entry after the request object is gone, so this pins that the entry kept the marker too.
      expect(rows.map(originOf)).toEqual([
        "tailnet-controller",
        "tailnet-controller",
      ]);
    });

    it("fails clearly when a Tailnet-controller card reaches a synchronous answer path, leaving the card pending", async () => {
      const { wc, gate } = makeAuditingGate();
      const promise = gate.requestAndWait(makeControllerRequest({ id: "sync-tailnet", remoteControllerOrigin: "tailnet-controller" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      const answer = { requestId: "sync-tailnet", choice: "allow-once" as const, nonce, hmac };
      expect(() => gate.resolve("sync-tailnet", answer)).toThrow(ApprovalFreshIdentityRequiredError);
      // The contract violation is not a revocation: the card stays pending for the fresh-identity path.
      await expect(gate.resolveWithFreshIdentity("sync-tailnet", answer)).resolves.toMatchObject({ choice: "allow-once" });
      await expect(promise).resolves.toMatchObject({ choice: "allow-once" });
    });

    it("distinguishes the controllers instead of marking every remote turn alike", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(
        makeControllerRequest({
          id: "origin-bridge",
          remoteControllerOrigin: "platform-bridge",
        }),
      );
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("origin-bridge", {
        requestId: "origin-bridge",
        choice: "deny-once",
        nonce,
        hmac,
      });
      await promise;

      expect(rowsFor(auditLogger, "origin-bridge").map(originOf)).toEqual([
        "platform-bridge",
        "platform-bridge",
      ]);
    });

    it("states positively that no controller is behind an ordinary approval", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();

      const promise = gate.requestAndWait(makeRequest({ id: "origin-desk", sessionId: "controller-session" }));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("origin-desk", {
        requestId: "origin-desk",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await promise;

      // Not an absent key: a reviewer partitioning rows by origin would have to guess whether an absence meant "the desk asked" or "this row's writer never carried the marker".
      expect(rowsFor(auditLogger, "origin-desk").map(originOf)).toEqual([
        "none",
        "none",
      ]);
    });

    it("still names the controller when the host resolved the request itself", async () => {
      vi.useFakeTimers();
      try {
        const { auditLogger, gate } = makeAuditingGate();

        const promise = gate.requestAndWait(
          makeControllerRequest({
            id: "origin-timeout",
            remoteControllerOrigin: "tailnet-controller",
          }),
        );
        vi.advanceTimersByTime(1_001);
        await expect(promise).resolves.toMatchObject({ choice: "deny-once" });

        const timeout = rowsFor(auditLogger, "origin-timeout").find((row) =>
          row.startsWith("[approval:timeout]"),
        );
        expect(timeout).toBeDefined();
        // Unlike `answeredBy`, which is absent here because nobody answered, the origin is still true of the request and is exactly what a review of an unanswered remote turn is looking for.
        expect(originOf(timeout as string)).toBe("tailnet-controller");
      } finally {
        vi.useRealTimers();
      }
    });

    it("names the controller on a request the host refused before the renderer saw it", async () => {
      const { wc, auditLogger } = makeAuditingGate();
      const gate = new ApprovalGate(null, undefined, undefined, auditLogger as never);

      await expect(
        gate.requestAndWait(
          makeControllerRequest({
            id: "origin-blocked",
            remoteControllerOrigin: "platform-bridge",
            target: { filePath: "/home/u/.ssh/id_rsa" },
          }),
        ),
      ).resolves.toMatchObject({ choice: "deny-once" });

      expect(wc.send).not.toHaveBeenCalled();
      const blocked = rowsFor(auditLogger, "origin-blocked").find((row) =>
        row.startsWith("[approval:send-failed]"),
      );
      // The hard-block resolves before a nonce is minted, so this row is the only record that a bridged turn tried it at all.
      expect(originOf(blocked as string)).toBe("platform-bridge");
    });

    it("never sends the marker to the renderer", async () => {
      const { wc, gate } = makeAuditingGate();

      void gate.requestAndWait(
        makeControllerRequest({
          id: "origin-not-sent",
          remoteControllerOrigin: "tailnet-controller",
          abortSignal: new AbortController().signal,
        }),
      );

      const [, sent] = wc.send.mock.calls[0] as unknown as [
        string,
        ApprovalRequest,
      ];
      // Non-vacuous: this is the real payload, carrying the fields the renderer is meant to have.
      expect(sent.id).toBe("origin-not-sent");
      expect(sent.nonce).toEqual(expect.any(String));
      // The renderer is neither asked for the marker nor told it. There is no copy of it outside the main process to author or to alter.
      expect(sent).not.toHaveProperty("remoteControllerOrigin");
      // And the abort signal. An AbortSignal is not structured-cloneable, so leaving it on the payload throws at `webContents.send` in production — loud rather than silent, but still a crash, and the mock here clones nothing so only this assertion would catch it.
      expect(sent).not.toHaveProperty("abortSignal");
    });

    it("reports an unrecognised controller as an anomaly instead of echoing it", () => {
      // Audit rows are space-delimited `key=value`, so echoing a raw value would let it append fields of its own choosing.
      expect(
        remoteControllerOriginAuditToken(
          "tailnet-controller choice=allow-always" as never,
        ),
      ).toBe("unrecognized-remote-origin");
      // An inherited member is not a controller.
      expect(remoteControllerOriginAuditToken("toString" as never)).toBe(
        "unrecognized-remote-origin",
      );
      expect(remoteControllerOriginAuditToken(undefined)).toBe("none");
      expect(remoteControllerOriginAuditToken("platform-bridge")).toBe(
        "platform-bridge",
      );
    });

    it("is deliberately outside the request signature", () => {
      const signed = {
        id: "origin-sig",
        nonce: "b1a2c3",
        toolName: "agent_spawn",
        sessionId: undefined,
        args: { title: "test" },
      };
      const key = Buffer.from("signing-key-for-preimage-comparison");

      const withMarker: ApprovalSignatureFields = {
        ...signed,
        // @ts-expect-error — the marker is not a signature field. This directive
        // is the type-level half: if it is ever added to the preimage's field
        // set, this suppresses nothing and `check:typecheck-tests` reports the
        // unused directive until the decision is revisited on purpose.
        remoteControllerOrigin: "tailnet-controller",
      };

      // The runtime half. The marker is host-only and never leaves the main process, so it has no echoed copy for a signature to authenticate — a digest over it would compare the host's own value to itself. Carrying it must therefore change nothing about the digest.
      expect(signApprovalRequest(key, withMarker)).toBe(
        signApprovalRequest(key, signed),
      );
    });
  });

  it("keeps bound remote requests eligible for the ordinary approval choices", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const request = makeRequest({ sessionId: "away-session", remoteControllerOrigin: "platform-bridge", remoteControllerAuthority: bindRemoteControllerToSession(makePlatformBridgeAuthority(), "away-session"), toolCategory: "write", allowedChoices: ["allow-once", "allow-session", "deny-once"] });
    const pending = gate.requestAndWait(request);
    const card = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    expect(card.allowedChoices).toEqual(["allow-once", "allow-session", "deny-once"]);
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac }, wc as never);
    await expect(pending).resolves.toMatchObject({ choice: "deny-once" });
  });

  it.each(["missing", "unbound", "wrong-session"] as const)("denies a remote card with %s session authority", async kind => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const authority = makePlatformBridgeAuthority();
    const remoteControllerAuthority = kind === "missing" ? undefined : kind === "unbound" ? authority : bindRemoteControllerToSession(authority, "another-session");
    const decision = await gate.requestAndWait(makeRequest({ sessionId: "controller-card", remoteControllerOrigin: "platform-bridge", remoteControllerAuthority }));
    expect(decision.choice).toBe("deny-once");
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
    expect(wc.send).not.toHaveBeenCalled();
  });

  describe("turn abort", () => {
    // A tool ask with nothing to short-circuit it on the way in: not read-only, no away grant armed, no sensitive target. It reaches the renderer and then waits, which is the only state a stop can be observed from.
    function makeAbortableRequest(signal?: AbortSignal): RequestInput {
      return makeRequest({
        id: "abort-1",
        toolName: "fs_write",
        toolCategory: "write",
        sessionId: "conv-stopped",
        ...(signal === undefined ? {} : { abortSignal: signal }),
      });
    }

    it("unparks a request nobody answered when the turn is stopped", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();
      const turn = new AbortController();

      const parked = gate.requestAndWait(makeAbortableRequest(turn.signal));
      // The modal really was raised. Without this the rest of the test would also pass against a gate that refused the request on its way in.
      expect(wc.send).toHaveBeenCalledTimes(1);
      expect(gate.pendingCount).toBe(1);

      turn.abort(new Error("user cancelled turn"));
      const decision = await parked;

      expect(decision.choice).toBe("deny-once");
      // Host-generated, not a deny the owner authored, and not the timeout — the gate's five minutes never elapsed here.
      expect(isHostApprovalRejectedDecision(decision)).toBe(true);
      expect(isHostApprovalTimeoutDecision(decision)).toBe(false);
      expect(decision.rememberPattern).toBeUndefined();
      // The entry is gone, so a desk answer that crossed the abort in flight arrives as an unknown-request replay rather than an answer to a turn that no longer exists.
      expect(gate.pendingCount).toBe(0);

      const cancelled = auditRowTexts(auditLogger).find((row) =>
        row.startsWith("[approval:cancelled]"),
      );
      expect(cancelled).toContain("abort-1");
      expect(cancelled).toContain("reason=turn-abort");
      expect(cancelled).toContain('cause="user cancelled turn"');
    });

    it("keeps a parked request for the next renderer while its turn is not stopped", async () => {
      // A renderer reload does not stop the primary conversation's turn; the request it parked on is what `listPendingRendererRequests` hands the renderer that comes back.
      const { wc, gate } = makeAuditingGate();
      const turn = new AbortController();
      const parked = gate.requestAndWait(makeAbortableRequest(turn.signal));
      const sent = (wc.send.mock.calls[0] as unknown as [string, ApprovalRequest])[1];
      expect(gate.listPendingRendererRequests(wc as never)).toEqual([sent]);

      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("abort-1", { requestId: "abort-1", choice: "allow-once", nonce, hmac });
      expect((await parked).choice).toBe("allow-once");
      expect(gate.listPendingRendererRequests(wc as never)).toEqual([]);
    });

    it("retires a parked request with the release that stopped its turn, and says so", async () => {
      // A tile the host let go of — closed, or released by a renderer reload — has no turn left to answer into; the request is not re-offered, and the row names the release rather than a stop the user never made.
      const { wc, auditLogger, gate } = makeAuditingGate();
      const turn = new AbortController();
      const parked = gate.requestAndWait(makeAbortableRequest(turn.signal));
      expect(gate.listPendingRendererRequests(wc as never)).toHaveLength(1);

      turn.abort(new Error("renderer reload released the tile"));
      const decision = await parked;

      expect(decision.choice).toBe("deny-once");
      expect(isHostApprovalRejectedDecision(decision)).toBe(true);
      expect(gate.listPendingRendererRequests(wc as never)).toEqual([]);
      const cancelled = auditRowTexts(auditLogger).find((row) =>
        row.startsWith("[approval:cancelled]"),
      );
      expect(cancelled).toContain('cause="renderer reload released the tile"');
    });

    it("tells the renderer a request it can no longer answer is over", async () => {
      // The card for a released tile is drawn by a surface that has already unmounted, so nothing in the renderer will retire it on its own. The announcement is the only thing that can.
      const { wc, gate } = makeAuditingGate();
      const turn = new AbortController();
      const parked = gate.requestAndWait(makeAbortableRequest(turn.signal));
      expect(sentApprovalCards<ApprovalRequest>(wc).map((req) => req.id)).toEqual(["abort-1"]);
      expect(announcedSettledIds(wc)).toEqual([]);

      turn.abort(new Error("tile closed"));
      await parked;

      expect(announcedSettledIds(wc)).toEqual(["abort-1"]);
    });

    it("announces a desk answer too, so one path covers every way a request ends", async () => {
      // Announced for EVERY settlement rather than a chosen subset: the renderer has already dropped this one, and a closed list of announced causes would be a second thing to keep in step with `settle`.
      const { wc, gate } = makeAuditingGate();
      const parked = gate.requestAndWait(makeAbortableRequest());
      const { nonce, hmac } = lastSentNonceHmac(wc);

      gate.resolve("abort-1", { requestId: "abort-1", choice: "allow-once", nonce, hmac });
      expect((await parked).choice).toBe("allow-once");

      expect(announcedSettledIds(wc)).toEqual(["abort-1"]);
    });

    it("says nothing to a renderer that is already gone", async () => {
      const wc = makeMockWebContents({ isDestroyed: true });
      const gate = new ApprovalGate(wc as never, undefined, 1_000);
      const turn = new AbortController();

      const decision = await gate.requestAndWait(makeAbortableRequest(turn.signal));

      // The destroyed-renderer guard denies on the way in, so nothing is sent at all: there is no window left holding a card to take down.
      expect(decision.choice).toBe("deny-once");
      expect(wc.send).not.toHaveBeenCalled();
    });

    it("does not raise a modal for a turn that is already over", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();
      const turn = new AbortController();
      turn.abort(new Error("user cancelled turn"));

      const decision = await gate.requestAndWait(makeAbortableRequest(turn.signal));

      expect(decision.choice).toBe("deny-once");
      expect(wc.send).not.toHaveBeenCalled();
      expect(gate.pendingCount).toBe(0);
      const rows = auditRowTexts(auditLogger);
      // The cancelled row keeps its requested row. An approval that leaves no trace at all reads exactly like one that was never asked for.
      expect(rows.some((row) => row.startsWith("[approval:requested]"))).toBe(true);
      expect(rows.some((row) => row.startsWith("[approval:cancelled]"))).toBe(true);
    });

    it("leaves a request that carries no signal parked", async () => {
      const { gate } = makeAuditingGate();
      const unrelated = new AbortController();

      const parked = gate.requestAndWait(makeAbortableRequest());
      let settled = false;
      void parked.then(() => {
        settled = true;
      });

      unrelated.abort(new Error("user cancelled turn"));
      await Promise.resolve();

      // The signal is the mechanism, not some ambient "any abort ends every wait" behaviour a passing test above could otherwise be crediting.
      expect(settled).toBe(false);
      expect(gate.pendingCount).toBe(1);

      gate.disposeAll();
      await expect(parked).resolves.toMatchObject({ choice: "deny-once" });
    });

    it("detaches from the signal once the desk answers", async () => {
      const { wc, auditLogger, gate } = makeAuditingGate();
      const turn = new AbortController();
      const removeListener = vi.spyOn(turn.signal, "removeEventListener");

      const parked = gate.requestAndWait(makeAbortableRequest(turn.signal));
      const { nonce, hmac } = lastSentNonceHmac(wc);
      gate.resolve("abort-1", {
        requestId: "abort-1",
        choice: "allow-once",
        nonce,
        hmac,
      });
      await expect(parked).resolves.toMatchObject({ choice: "allow-once" });

      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));

      // A later stop of the same turn has nothing left to cancel here. One turn can ask many times, and an answered request that stayed attached would keep piling listeners onto the one signal it shares with them.
      turn.abort(new Error("user cancelled turn"));
      expect(
        auditRowTexts(auditLogger).some((row) =>
          row.startsWith("[approval:cancelled]"),
        ),
      ).toBe(false);
    });
  });
});

describe("same-card policy mutation evidence", () => {
  it.each(["session", "persistent", "global"])("binds a completed %s exact save to its authenticated native answer once", async (scope) => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const request = makeRequest({ id: `exact-save-${scope}`, sessionId: "save-session" });
    const pending = gate.requestAndWait(request);
    const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    const token = gate.beginExactApprovalSave(request.id, "40");
    gate.completeExactApprovalSave(token, "41", scope);
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
    const decision = await pending;
    expect(gate.consumeApprovalPolicyMutation({ ...decision })).toBeUndefined();
    expect(gate.consumeApprovalPolicyMutation(decision)).toEqual({ approvals: { from: "40", to: "41", scope } });
    expect(gate.consumeApprovalPolicyMutation(decision)).toBeUndefined();
  });

  it("rejects a concurrent exact-store change from the same-card proof", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const request = makeRequest({ id: "overlapping-exact-save" });
    const pending = gate.requestAndWait(request);
    const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    gate.completeExactApprovalSave(gate.beginExactApprovalSave(request.id, "40"), "42", "session");
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
    expect(gate.consumeApprovalPolicyMutation(await pending)).toBeUndefined();
  });

  it("requires a native directory answer and the exact chosen folder delta", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const request = makeRequest({ id: "folder-save", kind: "out-of-allowed-dir", outOfAllowedDir: { candidatePath: "/srv/task/file.txt", suggestedParent: "/srv/task", currentAllowed: ["/workspace"], adjacencyWarnings: [] } });
    const pending = gate.requestAndWait(request);
    const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-session", nonce: sent.nonce, hmac: sent.hmac }, wc as never);
    const decision = await pending;
    const mutation = { from: ["/workspace"], to: ["/workspace", "/srv/task"], directory: "/srv/task", scope: "session" as const };
    expect(() => gate.recordApprovedDirectoryMutation({ ...decision }, mutation)).toThrow("not authorized by this card");
    expect(() => gate.recordApprovedDirectoryMutation(decision, { ...mutation, to: [...mutation.to, "/unrelated"] })).toThrow("not authorized by this card");
    gate.recordApprovedDirectoryMutation(decision, mutation);
    expect(gate.consumeApprovalPolicyMutation(decision)).toEqual({ directories: { ...mutation, to: ["/srv/task", "/workspace"] } });
  });
});

describe("host-owned ordinary card cancellation", () => {
  it.each(["tool", "out-of-allowed-dir"] as const)("retires only the exact %s card owned by the supplied session", async (kind) => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const request = makeRequest({ id: `owned-${kind}`, sessionId: "owning-session", kind });
    const pending = gate.requestAndWait(request);
    const sent = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    expect(gate.cancelPendingRequest(request.id, "another-session", "caller-abort")).toBe(false);
    expect(gate.pendingCount).toBe(1);
    expect(gate.cancelPendingRequest(request.id, "owning-session", "caller-abort")).toBe(true);
    await expect(pending).resolves.toMatchObject({ choice: "deny-once", requestId: request.id });
    expect(gate.pendingCount).toBe(0);
    expect(gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: sent.nonce, hmac: sent.hmac }, wc as never)).toBeNull();
  });
});
