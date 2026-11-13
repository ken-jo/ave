/** Bounded plugin-scoped task records. Recovery never replays effects or restores execution authority. */
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import { readAveHomeInput } from "../shared/ave-home-trust.js";
import { describeNonJson } from "../shared/json-representable.js";
import { DetailedTaskSchema, TASK_POLL_INTERVAL_MS, type DetailedTask } from "./task-protocol.js";
import { RPC_INTERNAL_ERROR } from "./protocol-constants.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("mcp-task-store");
export const MCP_TASK_STORE_POLICY = {
  maxTasks: 128,
  ttlMs: 24 * 60 * 60 * 1000,
  maxResultBytes: 128 * 1024,
  maxRecordBytes: 256 * 1024,
  maxLegacyBytes: 32 * 1024 * 1024,
} as const;
const TASK_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STAGING_FILE_RE = /^[a-f0-9-]{36}\.json\.[a-f0-9]{32}\.tmp$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function isTerminal(task: DetailedTask): boolean {
  return task.status !== "working" && task.status !== "input_required";
}
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface McpTaskReservation {
  promote(): Promise<DetailedTask>;
  release(): void;
}

export class McpTaskStore {
  private readonly records = new Map<string, DetailedTask>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly listeners = new Set<(task: DetailedTask) => void>();
  private readonly directoryName: string;
  private writeFailed = false;
  private reservedSlots = 0;

  constructor(pluginId: string, private readonly namespace: FeatureNamespaceHandle = openFeatureNamespace("mcp-tasks")) {
    this.directoryName = createHash("sha256").update(pluginId).digest("hex");
    this.ready = this.load();
  }

  private recordName(taskId: string): string {
    return `${this.directoryName}/${taskId}.json`;
  }

  private async read(name: string, maxBytes: number): Promise<unknown | undefined> {
    const path = join(this.namespace.dir, name);
    let info: Stats;
    try { info = await lstat(path); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Task store entry is not a plain file");
    if (info.size > maxBytes) throw new Error("Task store entry exceeds the read limit");
    const input = await readAveHomeInput(path);
    if (input.status !== "trusted") throw new Error("Task store is unavailable or untrusted");
    if (input.bytes.byteLength > maxBytes) throw new Error("Task store entry exceeds the read limit");
    return JSON.parse(input.bytes.toString("utf8")) as unknown;
  }

  private failure(task: DetailedTask, message: string): DetailedTask {
    const lastUpdatedAt = new Date().toISOString();
    return { taskId: task.taskId, createdAt: task.createdAt, lastUpdatedAt,
      ttlMs: this.terminalTtl(task, lastUpdatedAt), pollIntervalMs: TASK_POLL_INTERVAL_MS, status: "failed",
      error: { code: RPC_INTERNAL_ERROR, message } };
  }

  private terminalTtl(task: DetailedTask, lastUpdatedAt: string): number {
    return Math.max(0, Date.parse(lastUpdatedAt) - Date.parse(task.createdAt)) + MCP_TASK_STORE_POLICY.ttlMs;
  }

  private expired(task: DetailedTask): boolean {
    return isTerminal(task) && Date.parse(task.lastUpdatedAt) + MCP_TASK_STORE_POLICY.ttlMs <= Date.now();
  }

  private recover(value: unknown): DetailedTask {
    let task = DetailedTaskSchema.parse(value);
    if (!TASK_ID_RE.test(task.taskId)) throw new Error("Invalid stored task identifier");
    if (!isTerminal(task)) task = this.failure(task, "Task execution was interrupted by server restart");
    else task.ttlMs = this.terminalTtl(task, task.lastUpdatedAt);
    if ((task.status === "completed" && jsonBytes(task.result) > MCP_TASK_STORE_POLICY.maxResultBytes)
      || Buffer.byteLength(`${JSON.stringify(task, null, 2)}\n`) > MCP_TASK_STORE_POLICY.maxRecordBytes) {
      task = this.failure(task, "Task result exceeds the storage limit");
    }
    return task;
  }

  private async load(): Promise<void> {
    const dir = join(this.namespace.dir, this.directoryName);
    let directoryExists = false;
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Task store is not a plain directory");
      directoryExists = true;
    } catch (error) { if (!isMissing(error)) throw error; }
    if (directoryExists) {
      let count = 0;
      for await (const entry of await opendir(dir)) {
        if (STAGING_FILE_RE.test(entry.name)) { await unlink(join(dir, entry.name)); continue; }
        if (!entry.name.endsWith(".json") || !TASK_ID_RE.test(entry.name.slice(0, -5))) continue;
        if (++count > MCP_TASK_STORE_POLICY.maxTasks) throw new Error("Task store capacity exceeded on disk");
        const name = `${this.directoryName}/${entry.name}`;
        const raw = await this.read(name, MCP_TASK_STORE_POLICY.maxRecordBytes);
        if (raw === undefined) throw new Error("Stored task disappeared during startup");
        const task = this.recover(raw);
        if (entry.name !== `${task.taskId}.json`) throw new Error("Stored task identifier mismatch");
        if (this.expired(task)) { await unlink(join(dir, entry.name)); continue; }
        if (JSON.stringify(raw) !== JSON.stringify(task)) await this.namespace.writeJson(name, task);
        this.records.set(task.taskId, task);
      }
    }
    // One bounded migration of the former aggregate format; never retain an archive copy.
    const legacyName = `${this.directoryName}.json`;
    const legacy = await this.read(legacyName, MCP_TASK_STORE_POLICY.maxLegacyBytes);
    if (legacy === undefined) return;
    if (!Array.isArray(legacy)) throw new Error("Invalid task store");
    const candidates = new Map<string, DetailedTask>();
    for (const value of legacy) {
      const task = this.recover(value);
      if (candidates.has(task.taskId)) throw new Error("Duplicate task identifier in store");
      if (!this.expired(task)) candidates.set(task.taskId, task);
    }
    for (const task of this.records.values()) candidates.set(task.taskId, task);
    const retained = [...candidates.values()].sort((a, b) => Date.parse(a.lastUpdatedAt) - Date.parse(b.lastUpdatedAt))
      .slice(-MCP_TASK_STORE_POLICY.maxTasks);
    const ids = new Set(retained.map((task) => task.taskId));
    for (const task of this.records.values()) if (!ids.has(task.taskId)) await this.remove(task.taskId);
    for (const task of retained) {
      await this.namespace.writeJson(this.recordName(task.taskId), task);
      this.records.set(task.taskId, task);
    }
    await unlink(join(this.namespace.dir, legacyName));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.ready).then(() => {
      if (this.writeFailed) throw new Error("Task store is unavailable after a write failure");
      return operation();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async remove(taskId: string): Promise<void> {
    try { await unlink(join(this.namespace.dir, this.recordName(taskId))); }
    catch (error) { if (!isMissing(error)) throw error; }
    this.records.delete(taskId);
  }

  private async prune(): Promise<void> {
    for (const task of this.records.values()) if (this.expired(task)) await this.remove(task.taskId);
  }

  private async commit(task: DetailedTask): Promise<DetailedTask> {
    const nonJson = describeNonJson(task, "task");
    if (nonJson) throw new Error(`Task cannot be persisted: ${nonJson}`);
    let snapshot = DetailedTaskSchema.parse(JSON.parse(JSON.stringify(task)));
    if (Buffer.byteLength(`${JSON.stringify(snapshot, null, 2)}\n`) > MCP_TASK_STORE_POLICY.maxRecordBytes) {
      snapshot = this.failure(snapshot, "Task result exceeds the storage limit");
    }
    try { await this.namespace.writeJson(this.recordName(snapshot.taskId), snapshot); }
    catch (error) {
      // A failed directory sync may follow a successful rename. Do not admit uncounted files.
      this.writeFailed = true;
      throw error;
    }
    this.records.set(snapshot.taskId, snapshot);
    for (const listener of this.listeners) {
      try { listener(structuredClone(snapshot)); }
      catch { log.warn("Task notification delivery failed; durable state remains available"); }
    }
    return structuredClone(snapshot);
  }

  reserve(): Promise<McpTaskReservation> {
    return this.serialize(async () => {
      await this.prune();
      if (this.records.size + this.reservedSlots >= MCP_TASK_STORE_POLICY.maxTasks) {
        const oldest = [...this.records.values()].filter(isTerminal)
          .sort((a, b) => Date.parse(a.lastUpdatedAt) - Date.parse(b.lastUpdatedAt))[0];
        if (!oldest) throw new Error("Task store capacity reached");
        // Capacity pressure shortens the oldest terminal handle's remaining lifetime to zero.
        await this.remove(oldest.taskId);
      }
      this.reservedSlots++;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.reservedSlots--;
      };
      return {
        release,
        promote: () => this.serialize(async () => {
          if (released) throw new Error("Task capacity reservation was released");
          try {
            const now = new Date().toISOString();
            return await this.commit({ taskId: randomUUID(), status: "working", createdAt: now,
              lastUpdatedAt: now, ttlMs: null, pollIntervalMs: TASK_POLL_INTERVAL_MS });
          } finally { release(); }
        }),
      };
    });
  }

  async create(): Promise<DetailedTask> {
    const reservation = await this.reserve();
    try { return await reservation.promote(); }
    finally { reservation.release(); }
  }

  get(taskId: string): Promise<DetailedTask | undefined> {
    return this.serialize(async () => {
      await this.prune();
      const task = this.records.get(taskId);
      return task ? structuredClone(task) : undefined;
    });
  }

  complete(taskId: string, result: Record<string, unknown>): Promise<DetailedTask | undefined> {
    return this.transition(taskId, (task) => {
      const nonJson = describeNonJson(result, "task result");
      if (nonJson) throw new Error(`Task cannot be persisted: ${nonJson}`);
      return jsonBytes(result) > MCP_TASK_STORE_POLICY.maxResultBytes
        ? this.failure(task, "Task result exceeds the storage limit") : { ...task, status: "completed", result };
    });
  }

  fail(taskId: string): Promise<DetailedTask | undefined> {
    return this.transition(taskId, (task) => this.failure(task, "Task result could not be persisted"));
  }

  cancel(taskId: string): Promise<DetailedTask | undefined> {
    return this.transition(taskId, (task) => ({ ...task, status: "cancelled" }));
  }

  private transition(taskId: string, change: (task: DetailedTask) => DetailedTask): Promise<DetailedTask | undefined> {
    return this.serialize(async () => {
      await this.prune();
      const task = this.records.get(taskId);
      if (!task || isTerminal(task)) return task ? structuredClone(task) : undefined;
      const lastUpdatedAt = new Date().toISOString();
      return this.commit({ ...change(task), lastUpdatedAt, ttlMs: this.terminalTtl(task, lastUpdatedAt) });
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
