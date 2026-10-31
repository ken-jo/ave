import { randomUUID } from "node:crypto";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
// Regression test for the fail-closed gate against legacy user-approval entries with `verdictAtApproval: null`. Earlier the user-approval entry shape did not have a `verdictAtApproval` field. A naive `?? "medium"` coerce on read would have turned every such legacy entry into a medium-risk memory hit — fail-permissive for inputs whose original verdict was HIGH. The fail-closed gate rejects the memory hit and forces a fresh approval flow when `verdictAtApproval == null`. This file is the regression guard for that gate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";

// vi.mock must be at top level (hoisted). We feed the mock from a per-test setter so each case can shape the lookup result.
let mockLookupResult: unknown = null;
let useActualApprovalStore = false;
const { emitSandboxAuditMock } = vi.hoisted(() => ({
  emitSandboxAuditMock: vi.fn(async () => {}),
}));

vi.mock("../user-approval-store.js", async () => {
  const actual: typeof import("../user-approval-store.js") = await vi.importActual(
    "../user-approval-store.js",
  );
  return {
    ...actual,
    lookupApproval: vi.fn(async (...args: Parameters<typeof actual.lookupApproval>) =>
      useActualApprovalStore ? actual.lookupApproval(...args) : mockLookupResult),
  };
});

vi.mock("../../audit/sandbox-audit-sink.js", async () => {
  const actual: typeof import("../../audit/sandbox-audit-sink.js") =
    await vi.importActual("../../audit/sandbox-audit-sink.js");
  return {
    ...actual,
    emitSandboxAudit: emitSandboxAuditMock,
  };
});

import { PermissionManager } from "../permission-manager.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import {
  LlmRiskClassifier,
  RuleBasedRiskClassifier,
  type RiskClassifier,
} from "../reviewer/risk-classifier.js";
import { PermissionTestResources } from "./test-resources.js";
import {
  __resetSessionStoreForTest,
  approvalCacheKeyIdentity,
  captureApprovalWorkingDirectory,
  canonicalStringify,
  recordApproval,
} from "../user-approval-store.js";

const resources = new PermissionTestResources();

const tmpFile = resources.tmpFileFactory("ave-pm-legacy-null-");

afterEach(async () => {
  await resources.cleanup();
});

describe("PermissionManager — scoped approval memory with a separate risk ceiling", () => {
  let pm: PermissionManager;
  let cwd: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.AVE_HOME;
    process.env.AVE_HOME = resources.makeTmpDir("ave-pm-scoped-approval-state-");
    cwd = resources.makeTmpDir("ave-pm-scoped-approval-project-");
    useActualApprovalStore = true;
    __resetSessionStoreForTest();
    emitSandboxAuditMock.mockClear();
    ({ pm } = makeManager());

  });

  afterEach(() => {
    useActualApprovalStore = false;
    __resetSessionStoreForTest();
    if (previousHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousHome;
  });

  it.each(["low", "medium"] as const)(
    "uses the persisted %s ceiling while preserving the displayed HIGH and fresh risk escalation", async (ceiling) => {
      const broadcast = vi.fn();
      pm.setBroadcastUserApprovalHit(broadcast);
      const finalInput = {
        path: join(cwd, "note.md"),
      };
      const approvalCacheKey = `write_file:path:${finalInput.path}`;
      await recordApproval("write_file", canonicalStringify(finalInput), "builtin", {
        scope: "persistent",
        verdictAtApproval: "high",
        riskCeilingAtApproval: ceiling,
        nlJustification: null,
        trustOrigin: "user-keyboard",
        approvalCacheKey: approvalCacheKeyIdentity(approvalCacheKey, { kind: "args" })!,
        workingDirectoryIdentity: captureApprovalWorkingDirectory(cwd).identity,
      });
      // Force the reviewer to read the persisted record rather than its cache.
      __resetSessionStoreForTest();
      const input = {
        sessionId: "permission-manager-legacy-null-verdict-session",
        source: "builtin" as const,
        category: "write" as const,
        pathFields: ["path"],
        finalInput,
        executionCwd: cwd,
        allowedDirectories: [caseFoldForMatch(canonicalizePathForMatch(cwd))],
        sensitivePathsAdjacent: [],
        trustOrigin: "user-keyboard" as const,
        approvalCacheKey, approvalMemory: { kind: "args" } as const,
      };

      const remembered = await pm.dispatchReviewer("write_file", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });
      expect(remembered).toMatchObject({ outcome: "approval-memory", verdict: { level: ceiling } });
      expect(remembered.judge).toMatchObject({ judged: true, decision: "allow" });
      expect(broadcast).toHaveBeenLastCalledWith({
        toolName: "write_file", scope: "persistent", verdictAtApproval: "high",
      });
      expect((emitSandboxAuditMock.mock.calls as unknown as [unknown][]).at(-1)?.[0]).toMatchObject({
        reviewer: {
          ruleVerdict: "low",
          finalVerdict: ceiling,
          llmVerdict: null,
          userApprovalUsed: { memoryHit: true, verdictAtApproval: "high" },
        },
      });

      // The exact tuple still matches, but the current scope no longer admits this target. The deterministic HIGH must survive memory composition.
      const escalated = await pm.dispatchReviewer("write_file", {
        invocationId: randomUUID(),
        ...input, allowedDirectories: [],
      }, undefined, { lane: "foreground-auto" });
      expect(escalated).toMatchObject({ outcome: "approval-memory", verdict: { level: "high" } });
      expect(escalated.judge).toMatchObject({ judged: true, decision: "ask" });
      expect(broadcast).toHaveBeenLastCalledWith({
        toolName: "write_file", scope: "persistent", verdictAtApproval: "high",
      });
      expect((emitSandboxAuditMock.mock.calls as unknown as [unknown][]).at(-1)?.[0]).toMatchObject({
        reviewer: {
          ruleVerdict: "high",
          finalVerdict: "high",
          llmVerdict: null,
          userApprovalUsed: { memoryHit: true, verdictAtApproval: "high" },
        },
      });

      const otherCwd = resources.makeTmpDir("ave-pm-scoped-approval-other-");
      const otherProject = await pm.dispatchReviewer("write_file", {
        invocationId: randomUUID(),
        ...input, executionCwd: otherCwd,
      }, undefined, { lane: "foreground-auto" });
      expect(otherProject.outcome).not.toBe("approval-memory");
      expect(broadcast).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["riskCeilingAtApproval", "bogus"],
    ["riskCeilingAtApproval", null],
    ["riskCeilingAtApproval", 7],
    ["riskCeilingAtApproval", { level: "low" }],
    ["verdictAtApproval", "bogus"],
    ["verdictAtApproval", null],
    ["verdictAtApproval", 7],
    ["verdictAtApproval", { level: "high" }],
  ] as const)("does not reuse or disclose a persisted malformed %s=%j", async (field, value) => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);
    const finalInput = { path: join(cwd, "note.md") };
    const approvalCacheKey = `write_file:path:${finalInput.path}`;
    await recordApproval("write_file", canonicalStringify(finalInput), "builtin", {
      scope: "persistent",
      verdictAtApproval: "high",
      riskCeilingAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
      approvalCacheKey: approvalCacheKeyIdentity(approvalCacheKey, { kind: "args" })!,
      workingDirectoryIdentity: captureApprovalWorkingDirectory(cwd).identity,
    });
    const storePath = join(process.env.AVE_HOME!, "permissions", "user-approvals.json");
    const stored = JSON.parse(await readFile(storePath, "utf8")) as {
      approvals: Record<string, Record<string, unknown>>;
    };
    Object.values(stored.approvals)[0]![field] = value;
    await writeFile(storePath, JSON.stringify(stored));
    __resetSessionStoreForTest();

    const result = await pm.dispatchReviewer("write_file", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput,
      executionCwd: cwd,
      allowedDirectories: [caseFoldForMatch(canonicalizePathForMatch(cwd))],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard",
      approvalCacheKey, approvalMemory: { kind: "args" } as const,
    }, undefined, { lane: "foreground-auto" });

    expect(result.outcome).not.toBe("approval-memory");
    expect(broadcast).not.toHaveBeenCalled();
    expect((emitSandboxAuditMock.mock.calls as unknown as [unknown][]).at(-1)?.[0]).toMatchObject({
      reviewer: { userApprovalUsed: null },
    });
  });

  it("reuses an exact remembered decision after a medium risk assessment", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);
    const finalInput = { operation: "inspect" };
    const approvalCacheKey = "plugin_probe:inspect";
    const input = {
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "plugin" as const,
      category: "write" as const,
      pathFields: [],
      finalInput,
      executionCwd: cwd,
      allowedDirectories: [caseFoldForMatch(canonicalizePathForMatch(cwd))],
      sensitivePathsAdjacent: [],
      trustOrigin: "plugin-emitted" as const,
      approvalCacheKey, approvalMemory: { kind: "args" } as const,
      ownerPluginSandboxRoot: cwd,
      pluginId: "plugin_probe",
    };
    const fresh = await pm.dispatchReviewer("plugin_probe", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });
    expect(fresh.verdict).toMatchObject({ level: "medium", requiresExplicitApproval: true });
    expect(fresh.judge).toMatchObject({ judged: true, decision: "allow" });
    expect(broadcast).not.toHaveBeenCalled();

    await recordApproval("plugin_probe", canonicalStringify(finalInput), "plugin", {
      scope: "persistent",
      verdictAtApproval: "high",
      riskCeilingAtApproval: "medium",
      nlJustification: null,
      trustOrigin: "plugin-emitted",
      approvalCacheKey: approvalCacheKeyIdentity(approvalCacheKey, { kind: "args" })!,
      workingDirectoryIdentity: captureApprovalWorkingDirectory(cwd).identity,
    });
    __resetSessionStoreForTest();
    const result = await pm.dispatchReviewer("plugin_probe", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });

    expect(result).toMatchObject({
      outcome: "approval-memory",
      verdict: { level: "medium" },
    });
    expect(result.verdict.requiresExplicitApproval).toBeUndefined();
    expect(result.judge).toMatchObject({ judged: true, decision: "allow" });
    expect(broadcast).toHaveBeenCalledWith({
      toolName: "plugin_probe", scope: "persistent", verdictAtApproval: "high",
    });
  });
});

function makeManager(): {
  pm: PermissionManager;
  classifier: RiskClassifier;
} {
  const pm = new PermissionManager(tmpFile("permissions.json"));
  pm.setMode("auto");
  const classifier = new RuleBasedRiskClassifier();
  const cache = resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl"));
  const queue = makeRecentlyDeniedStore(tmpFile("recently-denied.jsonl"));
  setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
  return { pm, classifier };
}

describe("PermissionManager — fail-closed gate against legacy null-verdict entries", () => {
  let pm: PermissionManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ({ pm } = makeManager());
    mockLookupResult = null;
    emitSandboxAuditMock.mockClear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("rejects a memory hit whose verdictAtApproval is null (legacy entry) — does not call broadcastUserApprovalHit", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);

    // Legacy entry — verdictAtApproval is null (the field was absent at the time of recording, so the store returns null for pre-existing entries).
    mockLookupResult = {
      toolName: "fs_write",
      scope: "persistent",
      verdictAtApproval: null,
      nlJustification: null,
      revokedAt: null,
    };

    await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: ["/Users/example/work"],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    // Stable structured marker (2nd arg) — survives i18n / wording changes (cluster review S-Med-1 + C-Med-4).
    const warnCalls = warnSpy.mock.calls;
    const legacyCall = warnCalls.find((args: unknown[]) => {
      const marker = args[1];
      return (
        marker != null &&
        typeof marker === "object" &&
        (marker as { event?: unknown }).event === "legacy-null-verdict"
      );
    });
    expect(legacyCall).toBeDefined();
    const marker = legacyCall![1] as {
      event: string;
      toolName: string;
      scope: string;
    };
    expect(marker.toolName).toBe("fs_write");
    expect(marker.scope).toBe("persistent");
  });

  it("does broadcast when verdictAtApproval is a real value (sanity — gate only rejects null)", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);

    mockLookupResult = {
      toolName: "fs_write",
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: ["/Users/example/work"],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0]?.[0];
    expect(payload.toolName).toBe("fs_write");
    expect(payload.scope).toBe("persistent");
    expect(payload.verdictAtApproval).toBe("low");
    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | { reviewer: { llmVerdict: string | null; userApprovalUsed: { memoryHit: boolean } | null } }
      | undefined;
    expect(auditEntry?.reviewer.llmVerdict).toBeNull();
    expect(auditEntry?.reviewer.userApprovalUsed?.memoryHit).toBe(true);
    const warnedLegacy = warnSpy.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("legacy entry without verdictAtApproval"),
    );
    expect(warnedLegacy).toBe(false);
  });

  it("no broadcast and no legacy warning when there is no memory hit at all", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);

    mockLookupResult = null;

    await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: ["/Users/example/work"],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });

    expect(broadcast).not.toHaveBeenCalled();
    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | { reviewer: { llmVerdict: string | null; userApprovalUsed: unknown } }
      | undefined;
    expect(auditEntry?.reviewer.llmVerdict).toBeNull();
    expect(auditEntry?.reviewer.userApprovalUsed).toBeNull();
    const warnedLegacy = warnSpy.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("legacy entry without verdictAtApproval"),
    );
    expect(warnedLegacy).toBe(false);
  });

  it("audit separates raw rule verdict, raw LLM verdict, and final composed verdict", async () => {
    const pm = new PermissionManager(tmpFile("permissions.json"));
    pm.setMode("auto");
  pm.setMode("auto");
    const classifier = new LlmRiskClassifier(
      {
        // The LLM ESCALATES: a rule-HIGH probe would be composition-pinned and never reach the provider, so verdict separation is shown on a non-HIGH rule verdict with a disagreeing (higher) LLM verdict.
        complete: vi.fn(async () => ({
          text: '{"level":"high","reason":"llm escalates"}',
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        })),
      },
      "gpt-4o-mini",
    );
    const cache = resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl"));
    const queue = makeRecentlyDeniedStore(tmpFile("recently-denied.jsonl"));
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });

    await pm.dispatchReviewer("write_file", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/audit-probe.md" },
      // Canonicalized like the executor lane does — the classifier's containment compare is over canonical case-folded strings.
      allowedDirectories: [caseFoldForMatch(canonicalizePathForMatch("/Users/example/work"))],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
    });

    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | {
          reviewer: {
            ruleVerdict: string;
            llmVerdict: string | null;
            finalVerdict: string;
          };
        }
      | undefined;
    expect(auditEntry?.reviewer.ruleVerdict).not.toBe("high");
    expect(auditEntry?.reviewer.llmVerdict).toBe("high");
    expect(auditEntry?.reviewer.finalVerdict).toBe("high");
  });

  it("reviewer audit masks finalInput and preserves the trust tuple", async () => {
    await pm.dispatchReviewer("plugin_send", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "plugin",
      category: "network",
      pathFields: [],
      finalInput: {
        email: "alice@example.com",
        apiKey: "sk-abcdefghijklmnopqrst",
      },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "plugin-emitted" as const,
      approvalCacheKey: "plugin_send:scope-a", approvalMemory: { kind: "args" } as const,
    });

    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | {
          tool: {
            args: string;
            source: string;
            trustOrigin?: string;
            approvalCacheKey?: string;
          };
        }
      | undefined;
    expect(auditEntry?.tool.args).not.toContain("alice@example.com");
    expect(auditEntry?.tool.args).not.toContain("sk-abcdefghijklmnopqrst");
    expect(auditEntry?.tool.args).toContain("***@example.com");
    expect(auditEntry?.tool.args).toContain("[REDACTED:TOKEN]");
    expect(auditEntry?.tool.source).toBe("plugin");
    expect(auditEntry?.tool.trustOrigin).toBe("plugin-emitted");
    expect(auditEntry?.tool.approvalCacheKey).toBe("plugin_send:scope-a");
  });

  it("reviewer audit persists the Host-owned governed projection", async () => {
    await pm.dispatchReviewer("plugin_checkin_read", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-legacy-null-verdict-session",
      source: "plugin",
      category: "read",
      pathFields: [],
      finalInput: {
        operation: "status",
        opaqueSecret: "must-never-reach-audit",
      },
      auditInput: { operation: "status" },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "plugin-emitted" as const,
    });

    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | { tool: { args: string } }
      | undefined;
    expect(auditEntry?.tool.args).toBe('{"operation":"status"}');
    expect(auditEntry?.tool.args).not.toContain("must-never-reach-audit");
  });
});
