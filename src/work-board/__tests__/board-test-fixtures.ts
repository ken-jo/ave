import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalChoice, ApprovalDecision, ApprovalGate } from "../../permissions/approval-gate.js";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { WorkItemListResult, WorkItemResolved } from "../../shared/work-board-types.js";
import type { TranscriptStorage } from "../run-transcript.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import type { ToolCategory } from "../../shared/permission-review-status.js";

export function okListReader(
  items: WorkItemResolved[],
): { list(): Promise<WorkItemListResult> } {
  return { list: async () => ({ status: "ok", items }) };
}

/** Use in-memory transcript storage to assert persisted JSONL without touching a feature namespace. */
export function memTranscriptStorage(): TranscriptStorage & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readText: async (rel) => files[rel] ?? "",
    write: async (rel, data) => {
      files[rel] = data;
    },
    exists: async (rel) => rel in files,
    mkdir: async () => {},
  };
}

export function projectMemoryPath(files: Record<string, string>): string | undefined {
  return Object.keys(files).find((key) => key.startsWith("memories/projects/") && key.endsWith("/MEMORY.md"));
}

export function projectReportPath(files: Record<string, string>, kind: "daily" | "weekly"): string | undefined {
  return Object.keys(files).find((key) => key.startsWith("reports/projects/") && key.includes(`/${kind}/`));
}

/** Return cleanup to the caller, which must invoke it in finally around the real-board run. */
export function tempBoardStore(): {
  store: WorkBoardStore;
  cleanup: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "ave-work-board-"));
  return {
    store: new WorkBoardStore(join(dir, "board.json")),
    cleanup: () => cleanupTmpDir(dir),
  };
}

export function scriptedApprovalGate(choice: ApprovalChoice): {
  gate: ApprovalGate;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  const gate = {
    async requestAndWait(request: unknown): Promise<ApprovalDecision> {
      requests.push(request);
      return { requestId: "scripted-gate-request", choice };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}

/** Use the real registry with every permission category and a plugin read tool so scope derivation cannot drift from execution. */
export function boardParentToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const tool = (name: string, category: ToolCategory, pluginId?: string) =>
    createDynamicTool({
      name,
      description: name,
      source: pluginId ? "plugin" : "builtin",
      category,
      ...(category === "meta" ? { decisionOverride: "ask" as const } : {}),
      ...(pluginId ? { pluginId } : {}),
      jsonSchema: { type: "object" },
      execute: async () => ({ output: "", isError: false }),
    });
  registry.registerBatch([
    tool("read_file", "read"),
    tool("grep_files", "read"),
    tool("write_file", "write"),
    tool("run_shell", "shell"),
    tool("web_fetch", "network"),
    tool("agent_spawn", "meta"),
    tool("sample_lookup", "read", "sample-plugin"),
  ]);
  return registry;
}
