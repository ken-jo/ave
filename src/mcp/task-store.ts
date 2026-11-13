/** Durable plugin-scoped task records. Recovery never replays a tool or restores execution authority. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import { readAveHomeInput } from "../shared/ave-home-trust.js";
import { describeNonJson } from "../shared/json-representable.js";
import { DetailedTaskSchema, TASK_POLL_INTERVAL_MS, type DetailedTask } from "./task-protocol.js";
import { RPC_INTERNAL_ERROR } from "./protocol-constants.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("mcp-task-store");

export class McpTaskStore {
  private readonly records = new Map<string, DetailedTask>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly listeners = new Set<(task: DetailedTask) => void>();
  private readonly fileName: string;

  constructor(pluginId: string, private readonly namespace: FeatureNamespaceHandle = openFeatureNamespace("mcp-tasks")) {
    this.fileName = `${createHash("sha256").update(pluginId).digest("hex")}.json`;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const input = await readAveHomeInput(join(this.namespace.dir, this.fileName));
    if (input.status === "absent") return;
    if (input.status !== "trusted") throw new Error("Task store is untrusted");
    const parsed: unknown = JSON.parse(input.bytes.toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("Invalid task store");
    let recovered = false;
    for (const value of parsed) {
      let task = DetailedTaskSchema.parse(value);
      if (this.records.has(task.taskId)) throw new Error("Duplicate task identifier in store");
      if (task.status === "working" || task.status === "input_required") {
        task = { ...task, status: "failed", lastUpdatedAt: new Date().toISOString(),
          error: { code: RPC_INTERNAL_ERROR, message: "Task execution was interrupted by server restart" } };
        recovered = true;
      }
      this.records.set(task.taskId, task);
    }
    if (recovered) await this.namespace.writeJson(this.fileName, [...this.records.values()]);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.ready).then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  private async commit(task: DetailedTask): Promise<DetailedTask> {
    const nonJson = describeNonJson(task, "task");
    if (nonJson) throw new Error(`Task cannot be persisted: ${nonJson}`);
    const snapshot = DetailedTaskSchema.parse(JSON.parse(JSON.stringify(task)));
    const records = new Map(this.records).set(snapshot.taskId, snapshot);
    await this.namespace.writeJson(this.fileName, [...records.values()]);
    this.records.set(snapshot.taskId, snapshot);
    for (const listener of this.listeners) {
      try { listener(structuredClone(snapshot)); }
      catch { log.warn("Task notification delivery failed; durable state remains available"); }
    }
    return structuredClone(snapshot);
  }

  create(): Promise<DetailedTask> {
    return this.serialize(() => {
      const now = new Date().toISOString();
      return this.commit({ taskId: randomUUID(), status: "working", createdAt: now,
        lastUpdatedAt: now, ttlMs: null, pollIntervalMs: TASK_POLL_INTERVAL_MS });
    });
  }

  get(taskId: string): Promise<DetailedTask | undefined> {
    return this.serialize(async () => {
      const task = this.records.get(taskId);
      return task ? structuredClone(task) : undefined;
    });
  }

  complete(taskId: string, result: Record<string, unknown>): Promise<DetailedTask | undefined> {
    return this.transition(taskId, (task) => ({ ...task, status: "completed", result }));
  }

  fail(taskId: string): Promise<DetailedTask | undefined> {
    return this.transition(taskId, (task) => ({ ...task, status: "failed",
      error: { code: RPC_INTERNAL_ERROR, message: "Task result could not be persisted" } }));
  }

  cancel(taskId: string): Promise<DetailedTask | undefined> {
    return this.transition(taskId, (task) => ({ ...task, status: "cancelled" }));
  }

  private transition(taskId: string, change: (task: DetailedTask) => DetailedTask): Promise<DetailedTask | undefined> {
    return this.serialize(async () => {
      const task = this.records.get(taskId);
      if (!task || (task.status !== "working" && task.status !== "input_required")) return task ? structuredClone(task) : undefined;
      return this.commit({ ...change(task), lastUpdatedAt: new Date().toISOString() });
    });
  }

  subscribe(listener: (task: DetailedTask) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// Concurrent generations share one writer and live state; a new process performs restart recovery once.
const stores = new Map<string, McpTaskStore>();
export function pluginTaskStore(pluginId: string): McpTaskStore {
  const namespace = openFeatureNamespace("mcp-tasks");
  const key = `${namespace.dir}\0${pluginId}`;
  let store = stores.get(key);
  if (!store) {
    store = new McpTaskStore(pluginId, namespace);
    stores.set(key, store);
  }
  return store;
}
