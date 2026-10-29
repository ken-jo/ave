import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
// Always-grants match the exact (tool, args, source, trustOrigin, approvalCacheKey, directory) tuple.
// Literal wildcards in cache keys or legacy rememberPattern values must never widen grants into glob rules.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import {
  __resetSessionStoreForTest,
  approvalCacheKeyIdentity,
  recordApproval,
} from "../../permissions/user-approval-store.js";
import { canonicalStringify } from "../../shared/canonical-json.js";

const TOOL_NAME = "wildcard_probe";

interface Harness {
  executor: ToolExecutor;
  executeSpy: ReturnType<typeof vi.fn>;
  requestAndWait: ReturnType<typeof vi.fn>;
  rules: () => { pattern: string; action: string }[];
}

// File-tool approvalCacheKey values use path:<resolved path>; rememberPattern comes from the approval card.
function harness(
  dir: string,
  auditLogger: AuditLogger,
  opts: {
    approvalCacheKey?: (input: unknown) => string;
    rememberPattern?: string;
  },
): Harness {
  const executeSpy = vi.fn(async () => "sent");
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: TOOL_NAME,
    description: "probe requiring approval",
    source: "plugin",
    pluginId: "test-plugin",
    category: "network",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        url: { type: "string" },
      },
    },
    ...(opts.approvalCacheKey ? { approvalCacheKey: opts.approvalCacheKey } : {}),
    execute: async () => ({ output: await executeSpy(), isError: false }),
  }));

  const permissionsFile = join(dir, "permissions.json");
  const permMgr = new PermissionManager(permissionsFile);
  permMgr.setMode("auto");
  permMgr.setInteractiveAutoApprove("low");
  // Only a non-LOW verdict reaches the approval modal that persists an always-grant.
  setReviewerForTest(permMgr, {
    classifier: { classify: vi.fn(() => ({ level: "medium" as const, reason: "needs confirmation" })) },
    cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(dir, "deferred-queue.jsonl")),
  });

  const requestAndWait = vi.fn(async (req: ApprovalRequestInput) => {
    // Persist the host-issued frozen directory identity; unscoped legacy records cannot be reused.
    const workingDirectory = req.reviewerApprovalBasis?.workingDirectory;
    expect(workingDirectory).toBeDefined();
    await recordApproval(
      req.toolName,
      canonicalStringify(req.args ?? {}),
      req.source ?? "builtin",
      {
        decision: "allow",
        scope: "persistent",
        verdictAtApproval: req.reviewerVerdict?.level ?? "low",
        nlJustification: null,
        trustOrigin: req.trustOrigin,
        approvalCacheKey: approvalCacheKeyIdentity(req.approvalCacheKey, req.approvalMemory),
        workingDirectoryIdentity: workingDirectory!.identity,
      },
    );
    return {
      requestId: req.id,
      choice: "allow-always" as const,
      ...(opts.rememberPattern === undefined ? {} : { rememberPattern: opts.rememberPattern }),
    };
  });

  return {
    executor: new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      auditLogger,
    ),
    executeSpy,
    requestAndWait,
    rules: () => {
      try {
        return JSON.parse(readFileSync(permissionsFile, "utf-8")).rules ?? [];
      } catch {
        return [];
      }
    },
  };
}

function call(executor: ToolExecutor, id: string, path: string) {
  return executor.executeAll(
    // A LOW network target isolates exact identity from the independent risk-escalation guard.
    [{ id, name: TOOL_NAME, input: { path, url: "https://api.openai.com" } }],
    { sessionId: "sess-wildcard", permissionContext: { trustOrigin: "user-keyboard" } },
  );
}

function withTempDir(
  run: (dir: string, auditLogger: AuditLogger) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-allow-always-literal-"));
    const previousAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = dir;
    __resetSessionStoreForTest();
    const auditLogger = new AuditLogger(join(dir, "audit"));
    try {
      await run(dir, auditLogger);
    } finally {
      await auditLogger.close();
      if (previousAveHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previousAveHome;
      __resetSessionStoreForTest();
      await cleanupTmpDir(dir);
    }
  };
}

describe("allow-always exact identity", () => {
  it("records and recalls the exact tuple when the cache key is literal", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {
      approvalCacheKey: () => "path:/work/Reports-2024/notes.md",
    });

    const first = await call(h.executor, "tu-literal-1", "/work/Reports-2024/notes.md");
    const second = await call(h.executor, "tu-literal-2", "/work/Reports-2024/notes.md");

    expect(first[0].is_error).toBeUndefined();
    expect(second[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.requestAndWait).toHaveBeenCalledTimes(1);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("treats a wildcard-bearing cache key as opaque exact data", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {
      approvalCacheKey: () => "path:/work/Reports*2024/notes.md",
    });

    const first = await call(h.executor, "tu-wildcard-key-1", "/work/Reports*2024/notes.md");
    const second = await call(h.executor, "tu-wildcard-key-2", "/work/Reports*2024/notes.md");

    expect(first[0].is_error).toBeUndefined();
    expect(second[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.requestAndWait).toHaveBeenCalledTimes(1);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("leaves a sibling the wildcard would have matched still requiring approval", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {
      approvalCacheKey: (input) => `path:${(input as { path: string }).path}`,
    });

    await call(h.executor, "tu-consented", "/work/Reports*2024/notes.md");
    const sibling = await call(h.executor, "tu-sibling", "/work/Reports-secret2024/notes.md");

    expect(h.requestAndWait).toHaveBeenCalledTimes(2);
    expect(sibling[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("ignores a legacy wildcard rememberPattern instead of turning it into a glob rule", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, { rememberPattern: "/work/Reports?2024" });

    const first = await call(h.executor, "tu-wildcard-remember-1", "/work/anything");
    const second = await call(h.executor, "tu-wildcard-remember-2", "/work/anything");

    expect(first[0].is_error).toBeUndefined();
    expect(second[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(2);
    expect(h.requestAndWait).toHaveBeenCalledTimes(1);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));

  it("does not widen a no-cache-key approval into a tool-wide grant", withTempDir(async (dir, auditLogger) => {
    const h = harness(dir, auditLogger, {});

    const first = await call(h.executor, "tu-toolname-1", "/work/notes.md");
    const same = await call(h.executor, "tu-toolname-2", "/work/notes.md");
    const different = await call(h.executor, "tu-toolname-3", "/work/other.md");

    expect(first[0].is_error).toBeUndefined();
    expect(same[0].is_error).toBeUndefined();
    expect(different[0].is_error).toBeUndefined();
    expect(h.executeSpy).toHaveBeenCalledTimes(3);
    expect(h.requestAndWait).toHaveBeenCalledTimes(2);
    expect(h.rules().filter((rule) => rule.action === "allow")).toEqual([]);
  }));
});
