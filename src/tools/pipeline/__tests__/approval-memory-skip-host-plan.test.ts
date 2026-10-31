import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { emitSandboxAuditMock } = vi.hoisted(() => ({
  emitSandboxAuditMock: vi.fn(async () => {}),
}));

vi.mock("../../../audit/sandbox-audit-sink.js", async () => {
  const actual: typeof import("../../../audit/sandbox-audit-sink.js") =
    await vi.importActual("../../../audit/sandbox-audit-sink.js");
  return { ...actual, emitSandboxAudit: emitSandboxAuditMock };
});

import { tryUserApprovalMemorySkip } from "../approval-memory-skip.js";
import { buildHostShellExecutionPlan } from "../../../permissions/host-shell-execution-plan.js";
import {
  __resetActiveSandboxCapabilityForTest,
} from "../../../permissions/sandbox-capability.js";
import {
  __resetSessionStoreForTest,
  approvalCacheKeyIdentity,
  canonicalStringify,
  captureApprovalWorkingDirectory,
  recordApproval,
} from "../../../permissions/user-approval-store.js";

describe("foreground approval memory — sealed host shell plan", () => {
  beforeEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSessionStoreForTest();
    emitSandboxAuditMock.mockClear();
  });

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSessionStoreForTest();
  });

  it("uses the executor-sealed full-ASRT capability rather than a late live lookup", async () => {
    const finalInput = { command: "echo sealed-memory-plan" };
    const approvalCacheKey = "bash:sealed-host-plan";
    await recordApproval(
      "bash",
      canonicalStringify(finalInput),
      "builtin",
      {
        scope: "session",
        sessionId: "11111111-1111-4111-8111-111111111111",
        verdictAtApproval: "low",
        nlJustification: null,
        trustOrigin: "user-keyboard",
        approvalCacheKey: approvalCacheKeyIdentity(approvalCacheKey, { kind: "args" }),
        workingDirectoryIdentity: captureApprovalWorkingDirectory(process.cwd()).identity,
      },
    );
    const sealedPlan = buildHostShellExecutionPlan({
      platform: "darwin",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "sealed full ASRT",
        confines: { filesystem: true, process: true, network: true },
      },
    });

    const result = await tryUserApprovalMemorySkip(
      "bash",
      "builtin",
      "shell",
      [],
      finalInput,
      process.cwd(),
      [],
      [],
      { trustOrigin: "user-keyboard", approvalMemory: { kind: "args" } as const },
      approvalCacheKey,
      {},
      randomUUID(),
      undefined,
      undefined,
      undefined,
      sealedPlan,
      undefined,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(result).toMatchObject({
      decision: "allow",
    });
    // No live capability was published in this test. An accidental recompute would report `none`; the audit proves the same invocation plan was used.
    expect(emitSandboxAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: expect.objectContaining({
        kind: "asrt",
        confidence: "verified",
      }),
    }));
  });

  it("never lets a remembered approval stand in for a command typed into the user's host terminal", async () => {
    const finalInput = { command: "npm test", waitSeconds: 0 };
    const scope = {
      kind: "terminal-command" as const, lane: "manual" as const, commandSha256: "0".repeat(64), tabId: "terminal:0000c0de-1",
      terminalSessionId: "host", sessionId: "11111111-1111-4111-8111-111111111111", shell: "zsh" as const, cwd: process.cwd(),
      physicalCwd: process.cwd(), cwdDevice: "1", cwdInode: "2", turnId: "turn-1", controlGeneration: 0, cwdForMatch: process.cwd(),
    };
    const approvalMemory = { kind: "key" as const, key: "terminal_run:host", scope };
    const approvalCacheKey = "terminal_run:host-command";
    // Even a matching record (which no host card can create) is never consulted.
    await recordApproval("terminal_run", canonicalStringify(finalInput), "builtin", {
      scope: "session",
      sessionId: scope.sessionId,
      verdictAtApproval: "high",
      nlJustification: null,
      trustOrigin: "user-keyboard",
      approvalCacheKey: approvalCacheKeyIdentity(approvalCacheKey, approvalMemory),
      workingDirectoryIdentity: captureApprovalWorkingDirectory(process.cwd()).identity,
    });
    const result = await tryUserApprovalMemorySkip(
      "terminal_run", "builtin", "shell", [], finalInput, process.cwd(), [], [],
      { trustOrigin: "user-keyboard", approvalMemory }, approvalCacheKey, {}, randomUUID(),
      undefined, undefined, undefined, undefined, undefined, scope.sessionId,
    );
    expect(result).toBeNull();
  });
});
