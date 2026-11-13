import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpTaskStore } from "../task-store.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";

const PLUGIN_ID = "retention-probe";
const PLUGIN_HASH = createHash("sha256").update(PLUGIN_ID).digest("hex");
const DAY_MS = 24 * 60 * 60 * 1000;
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(process.env.AVE_HOME ?? tmpdir(), "task-retention-"));
  vi.stubEnv("AVE_HOME", home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("bounded durable task retention", () => {
  it("expires oldest terminal handles at capacity and keeps the bounded newest results after restart", async () => {
    const store = new McpTaskStore(PLUGIN_ID);
    const ids: string[] = [];
    for (let index = 0; index < 130; index++) {
      const task = await store.create();
      ids.push(task.taskId);
      await store.complete(task.taskId, { content: [{ type: "text", text: String(index) }] });
    }
    expect(await store.get(ids[0])).toBeUndefined();
    expect(await store.get(ids[1])).toBeUndefined();
    expect(await store.get(ids[2])).toMatchObject({ status: "completed" });
    const retained = await store.get(ids[2]);
    expect(retained).toBeDefined();
    if (retained) expect(Date.parse(retained.createdAt) + (retained.ttlMs ?? 0)).toBe(Date.parse(retained.lastUpdatedAt) + DAY_MS);
    const restarted = new McpTaskStore(PLUGIN_ID);
    expect(await restarted.get(ids[0])).toBeUndefined();
    expect(await restarted.get(ids.at(-1) ?? "")).toMatchObject({ status: "completed", result: { content: [{ text: "129" }] } });
    const files = await readdir(join(home, "mcp-tasks", PLUGIN_HASH));
    expect(files).toHaveLength(128);
  });

  it("writes only the changed task record rather than the accumulated history", async () => {
    const namespace = openFeatureNamespace("mcp-tasks");
    const writes = vi.spyOn(namespace, "writeJson");
    const store = new McpTaskStore(PLUGIN_ID, namespace);
    const first = await store.create();
    const second = await store.create();
    writes.mockClear();
    await store.complete(first.taskId, { content: [] });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0]).toBe(`${PLUGIN_HASH}/${first.taskId}.json`);
    expect(writes.mock.calls[0][1]).toMatchObject({ taskId: first.taskId, status: "completed" });
    const secondBytes = await readFile(join(namespace.dir, PLUGIN_HASH, `${second.taskId}.json`), "utf8");
    expect(JSON.parse(secondBytes)).toMatchObject({ taskId: second.taskId, status: "working" });
  });

  it("counts UTF-8 result bytes and persists a bounded failure instead of a truncated result", async () => {
    const store = new McpTaskStore(PLUGIN_ID);
    const task = await store.create();
    const result = await store.complete(task.taskId, { content: [{ type: "text", text: "가".repeat(50_000) }] });
    expect(result).toMatchObject({ status: "failed", error: { code: -32603, message: "Task result exceeds the storage limit" } });
    expect(result).not.toHaveProperty("result");
    const bytes = await readFile(join(home, "mcp-tasks", PLUGIN_HASH, `${task.taskId}.json`));
    expect(bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(await new McpTaskStore(PLUGIN_ID).get(task.taskId)).toEqual(result);
  });

  it("preserves live tasks through a forward clock jump and retains their late result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
    const store = new McpTaskStore(PLUGIN_ID);
    const task = await store.create();
    vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    expect(await store.get(task.taskId)).toMatchObject({ status: "working" });
    const completed = await store.complete(task.taskId, { content: [{ type: "text", text: "late result" }] });
    expect(completed).toMatchObject({ status: "completed", result: { content: [{ text: "late result" }] } });
    expect(await store.get(task.taskId)).toEqual(completed);
    expect(await new McpTaskStore(PLUGIN_ID).get(task.taskId)).toEqual(completed);
  });

  it("prunes expired terminal records and preserves the recovered interruption", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
    const store = new McpTaskStore(PLUGIN_ID);
    const completed = await store.create();
    const working = await store.create();
    await store.complete(completed.taskId, { content: [] });
    vi.setSystemTime(new Date("2026-11-14T00:00:00.001Z"));
    expect(await store.get(completed.taskId)).toBeUndefined();
    expect(await new McpTaskStore(PLUGIN_ID).get(working.taskId)).toMatchObject({ status: "failed", error: { message: "Task execution was interrupted by server restart" } });
    expect(await readdir(join(home, "mcp-tasks", PLUGIN_HASH))).toEqual([`${working.taskId}.json`]);
  });

  it("refuses new tasks when every retained slot is active", async () => {
    const store = new McpTaskStore(PLUGIN_ID);
    for (let index = 0; index < 128; index++) await store.create();
    await expect(store.create()).rejects.toThrow("Task store capacity reached");
  });

  it("refuses oversized records at startup", async () => {
    const namespace = openFeatureNamespace("mcp-tasks");
    const taskId = randomUUID();
    await namespace.writeJson(`${PLUGIN_HASH}/${taskId}.json`, { padding: "x".repeat(256 * 1024) });
    await expect(new McpTaskStore(PLUGIN_ID).get(taskId)).rejects.toThrow("read limit");
  });

  it("does not accumulate uncounted records after a write reports failure following publication", async () => {
    const namespace = openFeatureNamespace("mcp-tasks");
    const write = namespace.writeJson.bind(namespace);
    vi.spyOn(namespace, "writeJson").mockImplementationOnce(async (name, value) => {
      await write(name, value);
      throw new Error("Directory sync failed after publication");
    });
    const store = new McpTaskStore(PLUGIN_ID, namespace);
    await expect(store.create()).rejects.toThrow("Directory sync failed");
    await expect(store.create()).rejects.toThrow("unavailable after a write failure");
    const files = await readdir(join(namespace.dir, PLUGIN_HASH));
    expect(files).toHaveLength(1);
    const recovered = new McpTaskStore(PLUGIN_ID);
    expect(await recovered.get(files[0].slice(0, -5))).toMatchObject({ status: "failed" });
  });

  it("loads only its record directory without interpreting sibling files", async () => {
    const namespace = openFeatureNamespace("mcp-tasks");
    const store = new McpTaskStore(PLUGIN_ID, namespace);
    const task = await store.create();
    const completed = await store.complete(task.taskId, { content: [] });
    const sibling = `${PLUGIN_HASH}.json`;
    await namespace.writeJson(sibling, { unrelated: true });
    const before = await readFile(join(namespace.dir, sibling), "utf8");
    expect(await new McpTaskStore(PLUGIN_ID).get(task.taskId)).toEqual(completed);
    expect(await readFile(join(namespace.dir, sibling), "utf8")).toBe(before);
  });
});
