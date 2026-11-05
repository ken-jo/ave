import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { WorkItemListResult, WorkItemResolved, WorkItemRunResult, WorkPlanDecision } from "../../shared/work-board-types.js";
import type { WorkBoardEngine } from "../../core/work-board-engine.js";
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

/** Run the item to its stored plan, then make the user's work approval decision on exactly that stored plan and settle the run the
 * decision continues. A reject settles at once as denied; a refused decision throws, since the stored plan is the one being decided. */
export async function runThroughDecision(
  engine: WorkBoardEngine,
  store: WorkBoardStore,
  itemId: number,
  decision: WorkPlanDecision,
  opts: { surface?: WebContents | null; note?: string; agentName?: string } = {},
): Promise<WorkItemRunResult> {
  const planned = await engine.runItem(itemId, {
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    ...(opts.surface !== undefined ? { approvalSurface: opts.surface } : {}),
  });
  if (planned.status !== "awaiting_approval") return planned;
  return decideStoredPlan(engine, store, itemId, decision, opts);
}

/** Decide the plan the store holds for the item now, as the board's decision panel does, and settle what the decision continues. */
export async function decideStoredPlan(
  engine: WorkBoardEngine,
  store: WorkBoardStore,
  itemId: number,
  decision: WorkPlanDecision,
  opts: { surface?: WebContents | null; note?: string } = {},
): Promise<WorkItemRunResult> {
  const got = await store.get(itemId);
  if (got.status !== "found" || !got.item.planApproval || !got.item.runId) throw new Error(`item ${itemId} has no stored plan to decide`);
  const outcome = await engine.decidePlan(
    itemId,
    { runId: got.item.runId, planHash: got.item.planApproval.planHash, decision, ...(opts.note !== undefined ? { note: opts.note } : {}) },
    opts.surface !== undefined ? { approvalSurface: opts.surface } : {},
  );
  if (!outcome.result.ok) throw new Error(`plan decision refused: ${outcome.result.reason}`);
  if (!outcome.continuation) return { status: "denied", ...(got.item.plan ? { plan: got.item.plan } : {}), reason: "rejected" };
  return outcome.continuation;
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
