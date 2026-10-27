import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import type { LLMProvider } from "../../../engine/llm/types.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { readPermissionSettings } from "../../../permissions/permission-settings-store.js";
import { judgeSettings, scriptedStage } from "../../../permissions/judge/__tests__/judge-request-fixture.js";
import { wireJudgeAgent } from "../judge-wiring.js";
import { wireReviewerAgent } from "../reviewer-wiring.js";

let directory: string;
let audit: AuditLogger | undefined;

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  directory = mkdtempSync(join(tmpdir(), "reviewer-model-audit-"));
});
afterEach(async () => {
  await audit?.close();
  audit = undefined;
  await cleanupTmpDir(directory);
});

describe("implicit reviewer model audit", () => {
  for (const observer of [false, true]) {
    it.each(["llm", "rule"] as const)(`records %s identity in the authoritative ${observer ? "shadow baseline" : "ordinary review"}`, async (mode) => {
      const manager = new PermissionManager(join(directory, "permissions.json"));
      manager.setMode("auto");
      const defaults = readPermissionSettings(join(directory, "absent-settings.json")).permissions.reviewer;
      const provider: LLMProvider = {
        vendor: "openai",
        async *streamTurn() {
          yield { type: "text_delta", text: '{"level":"low","reason":"reviewed action"}' };
          yield { type: "message_complete", stopReason: "end_turn" };
        },
      };
      const reviewer = wireReviewerAgent({
        permissionManager: manager,
        readSettings: () => ({ ...defaults, mode, interactive: { autoApprove: "medium" } }),
        readActiveLlm: () => ({ provider: "openai", model: "selected-reviewer-model" }),
        selectedModel: { label: "openai/selected-reviewer-model", available: true },
        streamProviderFor: () => provider,
        networkFetch: async () => new Response("{}"),
        verdictCachePath: join(directory, "verdicts.jsonl"),
        deferredQueuePath: join(directory, "deferred.jsonl"),
      });
      expect(reviewer.runtimeMode).toBe(mode);
      audit = new AuditLogger(join(directory, "audit"));
      await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
      wireJudgeAgent({
        permissionManager: manager,
        reviewer,
        settings: judgeSettings({
          chain: observer ? [scriptedStage("observer")] : [],
          mode: observer ? "shadow" : "active",
        }),
        providerForModel: () => null,
        networkFetch: async () => new Response('{"decision":"deny","rationale":"shadow observation"}'),
        audit,
        resolveRootSessionId: (id) => id,
      });
      const result = await manager.dispatchReviewer("bash", {
        sessionId: "reviewer-model-session",
        invocationId: "reviewer-model-invocation",
        source: "builtin", category: "shell", pathFields: [],
        finalInput: { command: "echo reviewed" }, executionCwd: directory,
        allowedDirectories: [directory], sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
      }, undefined, { defer: "none" });
      expect(result).toMatchObject({ outcome: "fresh", verdict: { level: "low" }, judge: { decision: "allow", applied: true } });
      const records = readFileSync(audit.getPermissionAuditLogFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0].judgeRecord).toMatchObject({
        mode: "active", applied: true, decision: "allow",
        stages: [{ provider: "builtin-llm", model: mode === "llm" ? "openai/selected-reviewer-model" : null }],
      });
    });
  }
});
