import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requiredValue } from "../../__tests__/support/required-value.js";
import { reviewerJudgeOutcomeForTest } from "../../__tests__/support/reviewer-judge.js";
import { decidePermission, type PermissionDecisionRequest } from "../decision-pipeline.js";
import { PermissionManager, type ReviewerDispatchResult } from "../permission-manager.js";
import { endRunSession, registerRunSession } from "../run-grants.js";
import type { ToolEffectEvidence } from "../tool-effect-evidence.js";
import { endUnattendedStage, onUnattendedDenied, registerUnattendedStage, unattendedLaneHooks, type UnattendedStageEntry } from "../unattended-lane-registry.js";
import { decideUnattended, type UnattendedDenyCode, UNATTENDED_DENY_MESSAGE } from "../unattended-lane.js";

const workspaceRoot = resolve("stage-workspace");
const output = resolve(workspaceRoot, "output", "report.txt");
const input = resolve(workspaceRoot, "input.txt");
const external = resolve("external", "reference.txt");
const entry: UnattendedStageEntry = {
  runKey: "run", stageId: "stage", workspaceRoot, isolation: { proven: true },
  envelope: {
    tools: ["read_file", "write_file", "bash", "connect"], writePaths: ["output/**"], readRoots: [resolve("external")],
    network: [{ host: "example.com", port: 443 }], commands: ["render"],
    mcpReadOnlyTools: ["sources_read"], mcpGenerationTools: [{ name: "media_render", effect: "generate", dataSent: true }],
    pluginGenerationTools: [{ name: "assets_fetch", effect: "fetch", dataSent: false }],
    outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
  },
};
const read: PermissionDecisionRequest = {
  mode: "allow", headless: false, unattended: entry,
  tool: { name: "read_file", kind: "read", source: "builtin" },
  paths: [{ canonical: input, lexical: input, effect: "read" }],
  unattendedEffect: "safe",
};
const write: PermissionDecisionRequest = {
  ...read, tool: { name: "write_file", kind: "file-write", source: "builtin" },
  paths: [{ canonical: output, lexical: output, effect: "write" }],
  fileWrite: { checkpointAvailable: true, insideProject: true },
};
const shell: PermissionDecisionRequest = {
  ...read, tool: { name: "bash", kind: "shell", source: "builtin" },
  unattendedCommand: ["render report"], shell: { sandboxed: true, readOnlyProven: false, unproven: false, destructive: false },
};
const mcp: PermissionDecisionRequest = {
  ...read, tool: { name: "media_render", kind: "mcp", source: "mcp" }, paths: [],
};
const network: PermissionDecisionRequest = {
  ...read, tool: { name: "connect", kind: "network", source: "builtin" }, paths: [],
  unattendedNetwork: { host: "example.com", port: 443, sandboxed: true },
};

describe("unattended permission decisions", () => {
  const denies = {
    "forbidden-unattended": { floor: { code: "protected-path", reason: "protected" } },
    "isolation-unproven": { unattended: { ...entry, isolation: { proven: false } } },
    "rule-ask": { rules: { ask: "*" } },
    "exfiltration-guardrail": { exfiltration: { reason: "exfiltration" } },
    "outside-envelope": { paths: [{ canonical: resolve("outside"), lexical: input, effect: "read" }] },
    "reviewer-denied": { ...mcp, reviewer: { status: "success", level: "high" } },
  } satisfies Record<UnattendedDenyCode, Partial<PermissionDecisionRequest>>;

  it.each(Object.entries(denies))("denies %s in the evaluator and pipeline", (code, patch) => {
    const request = { ...read, ...patch };
    const expected = { outcome: "deny", reasonCode: code, reason: UNATTENDED_DENY_MESSAGE };
    expect(decideUnattended(request)).toEqual(expected);
    expect(decidePermission(request)).toEqual(expected);
  });

  it("checks admission, deny rules and unsupported kinds before the lane", () => {
    expect(decidePermission({ ...read, admissionDenial: { code: "admission", reason: "denied" }, rules: { deny: "*" } }).reasonCode).toBe("admission");
    expect(decidePermission({ ...read, rules: { deny: "*", allow: "*" } }).reasonCode).toBe("rule-deny");
    expect(decidePermission({ ...read, tool: { ...read.tool, kind: "meta" } }).reasonCode).toBe("unsupported-tool-kind");
  });

  it.each([
    { manualRerun: true }, { secretRead: true }, { agentBrowser: true },
    { userOwnedSurface: { kind: "browser", choice: "allow" } },
    { ...shell, shell: { ...requiredValue(shell.shell), sandboxed: false } },
    { ...shell, shell: { ...requiredValue(shell.shell), escalated: true } },
  ] satisfies Partial<PermissionDecisionRequest>[])("refuses forbidden surfaces and routes %#", patch => {
    expect(decidePermission({ ...read, ...patch }).reasonCode).toBe("forbidden-unattended");
  });

  it.each([
    { ...read, tool: { ...read.tool, name: "other" } },
    { ...mcp, tool: { ...mcp.tool, name: "other" } },
    { ...mcp, tool: { ...mcp.tool, name: "other", source: "plugin" } },
    { ...read, unattended: { ...entry, envelope: { ...entry.envelope, readRoots: ["../external"] } },
      paths: [{ lexical: external, canonical: external, effect: "read" }] },
    { ...write, fileWrite: { ...requiredValue(write.fileWrite), checkpointAvailable: false } },
    { ...write, paths: [{ canonical: input, lexical: input, effect: "write" }] },
    { ...shell, unattendedCommand: ["render report", "other"] },
    { ...network, unattendedNetwork: { ...requiredValue(network.unattendedNetwork), port: 80 } },
    { ...network, unattendedNetwork: { ...requiredValue(network.unattendedNetwork), sandboxed: false } },
  ] satisfies PermissionDecisionRequest[])("refuses an effect outside the envelope %#", request => {
    expect(decidePermission({ ...request, reviewer: { status: "success", level: "low" } }).reasonCode).toBe("outside-envelope");
  });

  it("allows bounded reads, checkpointed writes, sandbox commands and sandbox connections", () => {
    expect(decidePermission(read).outcome).toBe("allow");
    expect(decidePermission({ ...read, paths: [{ lexical: external, canonical: external, effect: "read" }] }).outcome).toBe("allow");
    expect(decidePermission(write)).toMatchObject({ outcome: "allow", requiresCodeCheckpoint: true });
    expect(decidePermission(shell).outcome).toBe("sandbox-auto");
    expect(decidePermission(network).outcome).toBe("allow");
  });

  it.each(["outward", "unknown"] as const)("denies a declared tool whose evidence changes after spawn to %s", unattendedEffect => {
    expect(decidePermission({ ...mcp, reviewer: { status: "success", level: "low" } }).outcome).toBe("allow");
    expect(decidePermission({ ...mcp, unattendedEffect, reviewer: { status: "success", level: "low" } }).reasonCode).toBe("outside-envelope");
  });

  it.each([
    { ...shell, shell: { ...requiredValue(shell.shell), unproven: true } },
    { ...shell, shell: { ...requiredValue(shell.shell), destructive: true } },
    mcp,
    { ...mcp, tool: { ...mcp.tool, name: "sources_read" } },
    { ...mcp, tool: { ...mcp.tool, name: "assets_fetch", source: "plugin" } },
  ] satisfies PermissionDecisionRequest[])("requires positive reviewer evidence %#", request => {
    expect(decidePermission(request)).toMatchObject({ outcome: "deny", reviewRequired: true });
    for (const level of ["low", "medium"] as const) {
      expect(decidePermission({ ...request, reviewer: { level, status: "success" } }).outcome).toBe("allow");
    }
    for (const reviewer of [{ status: "success", level: "high" }, { status: "error" }, { status: "abort" }, { status: "success", level: "low", breakerOpen: true }] as const) {
      expect(decidePermission({ ...request, reviewer }).reasonCode).toBe("reviewer-denied");
    }
  });

  it("gives every mode the same outcome and does not consult allow authority", () => {
    const getGrant = vi.fn(() => "*");
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      expect(decidePermission({
        ...write, mode, rules: { get allow() { return getGrant(); }, get remembered() { return getGrant(); }, get floorSession() { return getGrant(); } },
      }).outcome).toBe("allow");
    }
    expect(getGrant).not.toHaveBeenCalled();
  });

  it("never asks across generated combinations of permission signals", () => {
    for (let bits = 0; bits < 256; bits++) {
      const request = {
        ...((bits & 1) ? mcp : read),
        headless: Boolean(bits & 2), manualRerun: Boolean(bits & 4), secretRead: Boolean(bits & 8),
        ...(bits & 16 ? denies["exfiltration-guardrail"] : {}),
        ...(bits & 32 ? denies["rule-ask"] : {}),
        ...(bits & 64 ? denies["forbidden-unattended"] : {}),
        ...(bits & 128 ? { reviewer: { status: "success", level: "low" } as const } : {}),
      };
      expect(["allow", "sandbox-auto", "deny"]).toContain(decidePermission(request).outcome);
    }
  });

  it("ignores ambient grants and mode, applies deny rules, and rechecks live metadata", () => {
    const sessionId = "envelope-session";
    const manager = new PermissionManager();
    let effect: ToolEffectEvidence = "safe";
    manager.setUnattendedToolEffectResolver({ effectOf: () => effect });
    const listener = vi.fn();
    const off = onUnattendedDenied(listener);
    const sessionRules = vi.spyOn(manager as unknown as { sessionRulesInScope: () => never[] }, "sessionRulesInScope");
    const ambientEpoch = vi.spyOn(manager, "getPolicyEpoch");
    registerRunSession(entry.runKey, sessionId, { stageId: entry.stageId, stageName: "Stage", lane: "attended" });
    registerUnattendedStage(sessionId, entry);
    const check = (name = "read_file") => manager.checkDetailed(name, "builtin", "read", undefined, {
      sessionId, unattendedCallInput: { password: "private-value" },
    });
    try {
      manager.setRules([{ action: "allow", pattern: "*" }]);
      expect(check("unknown_read").reasonCode).toBe("outside-envelope");
      const issued = check();
      expect(issued.decision).toBe("allow");
      manager.setMode("allow");
      manager.addRunRule(sessionId, "Bash(printf ready)");
      expect(manager.recheckPermission(issued).decision).toBe("allow");
      expect(sessionRules).not.toHaveBeenCalled();
      expect(ambientEpoch).not.toHaveBeenCalled();

      manager.setRules([{ action: "deny", pattern: "*" }]);
      expect(check().reasonCode).toBe("rule-deny");
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId, code: "rule-deny" }));
      manager.setRules([]);
      for (const untrustedEffect of ["outward", "unknown"] as const) {
        effect = "safe";
        const reviewed = check();
        effect = untrustedEffect;
        expect(manager.recheckPermission(reviewed).reasonCode).toBe("outside-envelope");
        expect(listener).toHaveBeenLastCalledWith({
          sessionId, code: "outside-envelope",
          call: { toolName: "read_file", source: "builtin", inputSummary: expect.not.stringContaining("private-value") },
        });
      }
      effect = "safe";
      const beforeEnd = check();
      endUnattendedStage(sessionId);
      expect(manager.recheckPermission(beforeEnd).reasonCode).toBe("unattended-session-ended");
    } finally {
      off();
      endUnattendedStage(sessionId);
      endRunSession(sessionId);
    }
  });

  it("seals a headless review and denies when live evidence changes while it is pending", () => {
    const sessionId = "envelope-review";
    const manager = new PermissionManager();
    let effect: ToolEffectEvidence = "safe";
    manager.setUnattendedToolEffectResolver({ effectOf: () => effect });
    registerUnattendedStage(sessionId, entry);
    const review: ReviewerDispatchResult = {
      verdict: { level: "medium", reason: "Reviewed generation" }, outcome: "fresh", cacheReason: "miss-not-found",
      judge: reviewerJudgeOutcomeForTest("allow", "Reviewed generation"),
    };
    const check = () => manager.checkDetailed("media_render", "mcp", "network", undefined, { sessionId });
    try {
      const pending = check();
      expect(pending).toMatchObject({ decision: "deny", reviewer: { route: "headless" } });
      manager.setMode("allow");
      const reviewed = manager.resolveReviewedPermission(pending, review);
      expect(reviewed.decision).toBe("allow");
      expect(manager.recheckPermission(reviewed).decision).toBe("allow");
      const second = check();
      effect = "outward";
      expect(manager.resolveReviewedPermission(second, review).reasonCode).toBe("outside-envelope");
    } finally {
      endUnattendedStage(sessionId);
    }
  });

  it("fails closed for a linked stage until it has isolation proof", () => {
    const sessionId = "linked-stage";
    const manager = new PermissionManager();
    const check = () => manager.checkDetailed("read_file", "builtin", "read", undefined, { sessionId });
    unattendedLaneHooks.sessionLinked({
      sessionId, runKey: entry.runKey, stageId: entry.stageId, envelope: entry.envelope, workspaceRoot,
    });
    try {
      expect(check().reasonCode).toBe("isolation-unproven");
    } finally {
      unattendedLaneHooks.sessionEnded(sessionId);
    }
    expect(check().decision).toBe("allow");
  });
});
