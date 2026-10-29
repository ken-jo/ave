import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
/** Execution receives only the finalized approval scope; a scope shape does not issue user-owned surface authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import {
  __resetSessionStoreForTest,
  approvalCacheKeyIdentity,
  canonicalStringify,
  recordApproval,
} from "../../permissions/user-approval-store.js";
import type { ApprovalMemoryScope } from "../../shared/permissions-events.js";
import { createDynamicTool, type Tool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { authorizedApprovalMemoryScope } from "../approval-memory-context.js";
import type { ToolExecutionContext } from "../types.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { BROWSER_TOOL } from "../../shared/browser-tools.js";

describe("authorized approval scope", () => {
  let dir: string;
  let aveHomeDir: string;
  let prevAveHome: string | undefined;
  let auditLogger: AuditLogger;
  let reviewerCache: VerdictCache | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-authorized-scope-"));
    aveHomeDir = mkdtempSync(join(tmpdir(), "ave-home-authorized-scope-"));
    prevAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = aveHomeDir;
    __resetSessionStoreForTest();
    auditLogger = new AuditLogger(join(aveHomeDir, "audit"));
  });

  afterEach(async () => {
    await auditLogger.close();
    await reviewerCache?.flush();
    reviewerCache = undefined;
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    __resetSessionStoreForTest();
    await cleanupTmpDir(dir);
    await cleanupTmpDir(aveHomeDir);
  });

  /** A reviewer that grades everything MEDIUM in auto mode: an ordinary ask never reaches a
   * card. Each card that does appear is answered "remember for the session" when the host allows remembering. */
  function harness(tools: Tool[], mode: "auto" | "default" = "auto") {
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode(mode);

    reviewerCache = new VerdictCache(join(aveHomeDir, "reviewer-cache.jsonl"));
    const classify = vi.fn(() => ({ level: "medium" as const, reason: "stub medium" }));
    setReviewerForTest(manager, {
      classifier: { classify },
      cache: reviewerCache,
      recentlyDenied: makeRecentlyDeniedStore(join(aveHomeDir, "deferred.jsonl")),
    });
    const cards: ApprovalRequest[] = [];
    const recorded: string[] = [];
    const recordings: Promise<void>[] = [];
    const nativeWebContents = {
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel !== "ave:approval:request") return;
        cards.push(request);
        recordings.push((async () => {
          const snapshot = gate.getRequestSnapshot(request.id)!;
          if (snapshot.durableApprovalRecordAllowed && snapshot.persistentAllowAllowed) {
            recorded.push(request.id);
            await recordApproval(snapshot.toolName, canonicalStringify(snapshot.args), snapshot.source, {
              decision: "allow",
              scope: "session",
              sessionId: snapshot.sessionId,
              verdictAtApproval: snapshot.verdictAtApproval,
              nlJustification: null,
              trustOrigin: snapshot.trustOrigin,
              approvalCacheKey: approvalCacheKeyIdentity(snapshot.approvalCacheKey, snapshot.approvalMemory),
              workingDirectoryIdentity: snapshot.workingDirectoryIdentity,
              riskCeilingAtApproval: snapshot.riskCeilingAtApproval,
            });
          }
          gate.resolveFromDesktopRenderer(request.id, {
            requestId: request.id,
            choice: "allow-once",
            nonce: request.nonce,
            hmac: request.hmac,
          }, nativeWebContents as never);
        })());
      },
    };
    const gate = new ApprovalGate(nativeWebContents as never);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
    let seq = 0;
    const run = async (name: string, input: Record<string, unknown>) => {
      const [result] = await executor.executeAll(
        [{ id: `call-${seq += 1}`, name, input }],
        {
          sessionId: "authorized-scope",
          executionCwd: dir,
          permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
        },
      );
      await Promise.all(recordings);
      return result;
    };
    return { cards, recorded, run, classify };
  }

  function probe(options: { scoped?: boolean }) {
    const seen: ToolExecutionContext[] = [];
    const tool = createDynamicTool({
      name: BROWSER_TOOL.click,
      description: "probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { owner: { type: "string" }, n: { type: "integer" } }, required: ["owner"] },
      ...(options.scoped
        ? {
            approvalMemoryScope: (input: unknown): ApprovalMemoryScope => ({
              kind: "browser-origin",
              origin: "https://a.example:443",
              tabOpener: (input as { owner: string }).owner === "user" ? "user" : "agent",
              tabId: "tab-1",
              documentId: 1,
            }),
          }
        : {}),
      execute: async (_input, ctx) => {
        seen.push(ctx);
        return { output: "ok", isError: false };
      },
    });
    return { tool, seen };
  }

  it("hands execute the scope the call was authorized under", async () => {
    const { tool, seen } = probe({ scoped: true });
    const { run } = harness([tool]);
    await run(BROWSER_TOOL.click, { owner: "user" });
    expect(authorizedApprovalMemoryScope(seen[0])).toEqual({
      kind: "browser-origin",
      origin: "https://a.example:443",
      tabOpener: "user",
      tabId: "tab-1",
      documentId: 1,
    });
  });

  it("an exact-args tool gets no authorized scope", async () => {
    const { tool, seen } = probe({});
    const { run } = harness([tool]);
    await run(BROWSER_TOOL.click, { owner: "user" });
    expect(authorizedApprovalMemoryScope(seen[0])).toBeUndefined();
  });

  it("does not treat an arbitrary builtin's browser-shaped scope as a user-owned surface", async () => {
    const { tool, seen } = probe({ scoped: true });
    const { run, cards } = harness([tool], "default");
    const result = await run(BROWSER_TOOL.click, { owner: "user" });
    expect(result?.is_error).toBeFalsy();
    expect(cards).toHaveLength(1);
    expect(cards[0].userOwnedSurface).toBeUndefined();
    expect(cards[0].allowedChoices).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(authorizedApprovalMemoryScope(seen[0])).toMatchObject({ kind: "browser-origin", tabOpener: "user" });
  });
});
