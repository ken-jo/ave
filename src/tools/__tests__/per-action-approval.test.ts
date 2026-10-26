import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
/** Per-action asks always require one-shot human approval with no memory reuse or recording.
 * Pass the authorized target scope to execution so moving targets can recheck it. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
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

describe("per-action approval and the authorized scope", () => {
  let dir: string;
  let aveHomeDir: string;
  let prevAveHome: string | undefined;
  let auditLogger: AuditLogger;
  let reviewerCache: VerdictCache | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-per-action-"));
    aveHomeDir = mkdtempSync(join(tmpdir(), "ave-home-per-action-"));
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

  /** A reviewer that grades everything MEDIUM with interactive auto-approve on: an ordinary ask never reaches a
   * card. Each card that does appear is answered "remember for the session" when the host allows remembering. */
  function harness(tools: Tool[], autoApprove: "off" | "medium" = "medium") {
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("auto");
    manager.setInteractiveAutoApprove(autoApprove);
    reviewerCache = new VerdictCache(join(aveHomeDir, "reviewer-cache.jsonl"));
    const classify = vi.fn(() => ({ level: "medium" as const, reason: "stub medium" }));
    setReviewerForTest(manager, {
      classifier: { classify },
      cache: reviewerCache,
      deferredQueue: new DeferredQueue(join(aveHomeDir, "deferred.jsonl")),
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
          sessionId: "per-action",
          executionCwd: dir,
          permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
        },
      );
      await Promise.all(recordings);
      return result;
    };
    return { cards, recorded, run, classify };
  }

  function probe(options: { perAction: (input: { owner: string }) => boolean; scoped?: boolean }) {
    const seen: ToolExecutionContext[] = [];
    const tool = createDynamicTool({
      name: BROWSER_TOOL.click,
      description: "probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { owner: { type: "string" }, n: { type: "integer" } }, required: ["owner"] },
      requiresPerActionApproval: (input) => options.perAction(input as { owner: string }),
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

  it("a per-action input bypasses the auto reviewer and asks one-shot every time", async () => {
    const { tool, seen } = probe({ perAction: (input) => input.owner === "user", scoped: true });
    const { cards, recorded, run } = harness([tool]);

    // The ordinary input is answered by the MEDIUM-threshold reviewer without a card.
    await run(BROWSER_TOOL.click, { owner: "agent" });
    expect(cards).toHaveLength(0);

    await run(BROWSER_TOOL.click, { owner: "user", n: 1 });
    await run(BROWSER_TOOL.click, { owner: "user", n: 1 });
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
      expect(card.persistentAllowAllowed).toBe(false);
    }
    expect(recorded).toEqual([]);
    expect(seen).toHaveLength(3);
  });

  it("a remembered session approval for the agent scope never answers a per-action call", async () => {
    // Nothing is auto-answered: every ask reaches a card.
    const { tool, seen } = probe({ perAction: (input) => input.owner === "user", scoped: true });
    const { cards, recorded, run } = harness([tool], "off");

    await run(BROWSER_TOOL.click, { owner: "agent", n: 1 });
    expect(cards).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    // The agent scope is now remembered for the session.
    await run(BROWSER_TOOL.click, { owner: "agent", n: 2 });
    expect(cards).toHaveLength(1);

    await run(BROWSER_TOOL.click, { owner: "user", n: 1 });
    await run(BROWSER_TOOL.click, { owner: "user", n: 1 });
    expect(cards).toHaveLength(3);
    expect(recorded).toHaveLength(1);
    expect(seen).toHaveLength(4);
  });

  it("hands execute the scope the call was authorized under", async () => {
    const { tool, seen } = probe({ perAction: () => true, scoped: true });
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
    const { tool, seen } = probe({ perAction: () => true });
    const { run } = harness([tool]);
    await run(BROWSER_TOOL.click, { owner: "user" });
    expect(authorizedApprovalMemoryScope(seen[0])).toBeUndefined();
  });

  it("an external tool cannot declare requiresPerActionApproval", () => {
    const registry = new ToolRegistry();
    const external = createDynamicTool({
      name: "plugin_probe",
      description: "probe",
      source: "plugin",
      pluginId: "probe",
      category: "write",
      jsonSchema: { type: "object" },
      requiresPerActionApproval: () => false,
      execute: async () => ({ output: "ok", isError: false }),
    });
    expect(() => registry.register(external)).toThrow(/requiresPerActionApproval/);
  });
});
