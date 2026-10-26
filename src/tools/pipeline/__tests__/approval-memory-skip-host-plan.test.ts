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
      layer: 5,
    });
    // No live capability was published in this test. An accidental recompute would report `none`; the audit proves the same invocation plan was used.
    expect(emitSandboxAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: expect.objectContaining({
        kind: "asrt",
        confidence: "verified",
      }),
    }));
  });
});
