import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "./fixtures/tasks-2026-07-28.schema.json" with { type: "json" };
import { McpTaskStore } from "../task-store.js";
import { awaitMcpTask, MCP_TASKS_EXTENSION } from "../task-protocol.js";
import { PluginMcpServer, type PluginToolOutcome } from "../plugin-mcp-server.js";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { LoopbackTransport } from "../loopback-transport.js";
import { StdioServerLoop } from "../experimental/stdio-server-loop.js";
import { frameMessage, StdioFrameDecoder } from "../stdio-framing.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { PluginManifest } from "../../plugins/types.js";

const MANIFEST: PluginManifest = {
  id: "task-probe", name: "Task probe", version: "1.0.0", entry: "dist/index.js", description: "Task probe",
  tools: [{ name: "compute", description: "Compute", inputSchema: { type: "object", properties: {} } }],
};
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": { extensions: { [MCP_TASKS_EXTENSION]: {} } } };
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function isolate(): Promise<string> {
  const base = process.env.AVE_HOME ?? tmpdir();
  const home = await mkdtemp(join(base, "tasks-test-"));
  homes.push(home);
  vi.stubEnv("AVE_HOME", home);
  return home;
}
function request(server: PluginMcpServer, method: string, params: Record<string, unknown> = {}) {
  return server.handle({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } });
}
function deferred() {
  let resolve!: (value: PluginToolOutcome) => void;
  const promise = new Promise<PluginToolOutcome>((done) => { resolve = done; });
  return { promise, resolve };
}
const OUTCOME = { content: [{ type: "text", text: "finished" }], _meta: { "ai.agent-connector.ave/rawResult": { value: 42 } } };

// Independent release validation constraints; only description annotations are removed.
// Source blob: 1d0ec255bbcc5744264be53bba0e09e7eb8a5615. No runtime parser feeds this fixture.
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);
function conforms(definition: string, value: unknown): void {
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

describe("durable task protocol", () => {
  it("pins the release validation snapshot and rejects invalid terminal envelopes", async () => {
    const bytes = await readFile(new URL("./fixtures/tasks-2026-07-28.schema.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("9f3de4d0a022a3b1d20db86ff2219641f6632d3529e6fbcd580c958dc9dd6526");
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/GetTaskResult` });
    const task = { taskId: "x", status: "completed", createdAt: "2026-07-28T00:00:00Z", lastUpdatedAt: "2026-07-28T00:00:00Z", ttlMs: null };
    expect(validate({ ...task, resultType: "complete" })).toBe(false);
    expect(validate({ ...task, resultType: "task", result: {} })).toBe(false);
  });

  it("persists before returning a handle and publishes a conforming terminal result", async () => {
    await isolate();
    const work = deferred();
    const store = new McpTaskStore(MANIFEST.id);
    const server = new PluginMcpServer(MANIFEST, () => work.promise, undefined, store);
    const created = (await request(server, "tools/call", { name: "compute" })).result as Record<string, unknown>;
    conforms("CreateTaskResult", created);
    expect(created).toMatchObject({ resultType: "task", status: "working" });
    const files = await import("node:fs/promises").then((fs) => fs.readdir(openFeatureNamespace("mcp-tasks").dir));
    const recordPath = join(openFeatureNamespace("mcp-tasks").dir, files[0], `${created.taskId}.json`);
    const saved = JSON.parse(await readFile(recordPath, "utf8"));
    expect(saved.taskId).toBe(created.taskId);
    if (process.platform !== "win32") {
      expect((await stat(openFeatureNamespace("mcp-tasks").dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(openFeatureNamespace("mcp-tasks").dir, files[0]))).mode & 0o777).toBe(0o700);
      expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    }
    conforms("GetTaskResult", (await request(server, "tasks/get", { taskId: created.taskId })).result);
    work.resolve(OUTCOME);
    await expect.poll(async () => (await store.get(String(created.taskId)))?.status).toBe("completed");
    const completed = (await request(server, "tasks/get", { taskId: created.taskId })).result;
    conforms("GetTaskResult", completed);
    expect(completed).toMatchObject({ resultType: "complete", status: "completed", result: { ...OUTCOME, resultType: "complete" } });
  });

  it("cancels durably, preserves the terminal state against a late completion, and acknowledges repeats", async () => {
    await isolate();
    const work = deferred();
    const store = new McpTaskStore(MANIFEST.id);
    const server = new PluginMcpServer(MANIFEST, () => work.promise, undefined, store);
    const task = (await request(server, "tools/call", { name: "compute" })).result as { taskId: string };
    const cancelled = await request(server, "tasks/cancel", { taskId: task.taskId });
    conforms("CancelTaskResult", cancelled.result);
    expect(cancelled.result).toMatchObject({ resultType: "complete" });
    await store.complete(task.taskId, { resultType: "complete", ...OUTCOME });
    work.resolve(OUTCOME);
    expect(await store.get(task.taskId)).toMatchObject({ status: "cancelled" });
    expect(await new McpTaskStore(MANIFEST.id).get(task.taskId)).toMatchObject({ status: "cancelled" });
    conforms("CancelTaskResult", (await request(server, "tasks/cancel", { taskId: task.taskId })).result);
  });

  it("survives independent process exits with results intact and interrupted work failed without replay", async () => {
    const home = await isolate();
    const run = (action: string, id?: string) => JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", join(ROOT, "test/fixtures/mcp-tasks-store-process.mjs"), action, ...(id ? [id] : [])],
      { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AVE_HOME: home, TMPDIR: home, TMP: home, TEMP: home }, encoding: "utf8" }).trim());
    const completed = run("complete");
    expect(run("read", completed.taskId)).toEqual(completed);
    const working = run("working");
    const recovered = run("read", working.taskId);
    expect(recovered).toMatchObject({ taskId: working.taskId, status: "failed", error: { code: -32603 } });
    conforms("DetailedTask", recovered);
    expect(run("read", working.taskId)).toEqual(recovered);
  });

  it("requires per-request capability and hides tasks from a different plugin", async () => {
    await isolate();
    const store = new McpTaskStore(MANIFEST.id);
    const task = await store.create();
    const server = new PluginMcpServer(MANIFEST, async () => OUTCOME, undefined, store);
    for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
      expect((await server.handle({ jsonrpc: "2.0", id: 1, method, params: { taskId: task.taskId } })).error?.code).toBe(-32021);
      expect((await request(server, method, { taskId: "unknown" })).error?.code).toBe(-32602);
    }
    const other = new PluginMcpServer({ ...MANIFEST, id: "other-plugin" }, async () => OUTCOME);
    expect((await request(other, "tasks/get", { taskId: task.taskId })).error?.code).toBe(-32602);
    expect((await server.handle({ jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: { notifications: { taskIds: [task.taskId] } } })).error?.code).toBe(-32021);
    conforms("UpdateTaskResult", (await request(server, "tasks/update", { taskId: task.taskId, inputResponses: { unknown: { action: "cancel" } } })).result);
    expect((await request(server, "server/discover")).result).toMatchObject({ capabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } });
    expect((await request(server, "tools/call", { name: "compute" })).result).toMatchObject({ resultType: "complete", content: OUTCOME.content });
  });

  it("never promotes a slow call for a client that did not declare task support", async () => {
    await isolate();
    const work = deferred();
    const server = new PluginMcpServer(MANIFEST, () => work.promise);
    vi.useFakeTimers();
    let settled = false;
    const call = server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "compute" } }).then((response) => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mcpTaskPromotionMs);
    expect(settled).toBe(false);
    work.resolve(OUTCOME);
    expect((await call).result).toMatchObject({ resultType: "complete", content: OUTCOME.content });
  });

  it("refuses malformed persisted state without overwriting it", async () => {
    await isolate();
    const namespace = openFeatureNamespace("mcp-tasks");
    const filename = `${createHash("sha256").update(MANIFEST.id).digest("hex")}.json`;
    await namespace.writeJson(filename, [{ taskId: "broken" }]);
    const bytes = await readFile(join(namespace.dir, filename), "utf8");
    await expect(new McpTaskStore(MANIFEST.id).get("broken")).rejects.toThrow();
    expect(await readFile(join(namespace.dir, filename), "utf8")).toBe(bytes);
  });

  it("does not publish a handle when durable creation fails", async () => {
    const home = await isolate();
    await writeFile(join(home, "mcp-tasks"), "occupied");
    const work = deferred();
    const server = new PluginMcpServer(MANIFEST, () => work.promise);
    const response = await request(server, "tools/call", { name: "compute" });
    expect(response.error?.code).toBe(-32603);
    expect(response.result).toBeUndefined();
    work.resolve(OUTCOME);
  });

  it("refuses a full task store before starting the delegate", async () => {
    await isolate();
    const store = new McpTaskStore(MANIFEST.id);
    for (let index = 0; index < 128; index++) await store.create();
    const work = deferred();
    const delegate = vi.fn(() => work.promise);
    const server = new PluginMcpServer(MANIFEST, delegate, undefined, store);
    try {
      const response = await request(server, "tools/call", { name: "compute" });
      expect(response.error?.code).toBe(-32603);
      expect(delegate).not.toHaveBeenCalled();
    } finally { work.resolve(OUTCOME); }
  });

  it("reserves capacity atomically for calls that have not reached promotion yet", async () => {
    await isolate();
    const store = new McpTaskStore(MANIFEST.id);
    const work = deferred();
    const delegate = vi.fn(() => work.promise);
    const server = new PluginMcpServer(MANIFEST, delegate, undefined, store);
    const accepted = Array.from({ length: 128 }, () => request(server, "tools/call", { name: "compute" }));
    await expect.poll(() => delegate.mock.calls.length).toBe(128);
    const overflow = request(server, "tools/call", { name: "compute" });
    try {
      expect((await overflow).error?.code).toBe(-32603);
      expect(delegate).toHaveBeenCalledTimes(128);
    } finally {
      work.resolve(OUTCOME);
      const responses = await Promise.all([...accepted, overflow]);
      for (const response of responses) {
        const taskId = (response.result as { taskId?: string } | undefined)?.taskId;
        if (taskId) await expect.poll(async () => (await store.get(taskId))?.status).toBe("completed");
      }
    }
    expect((await request(server, "tools/call", { name: "compute" })).result).toMatchObject({ resultType: "complete" });
  });

  it("delivers subscribed full task notifications through newline-framed streams", async () => {
    await isolate();
    const store = new McpTaskStore(MANIFEST.id);
    const task = await store.create();
    const server = new PluginMcpServer(MANIFEST, async () => OUTCOME, undefined, store);
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new StdioFrameDecoder(1024 * 1024);
    const messages: unknown[] = [];
    output.on("data", (chunk) => messages.push(...decoder.push(chunk)));
    new StdioServerLoop(input, output, server, 1024 * 1024).start();
    input.write(frameMessage({ jsonrpc: "2.0", id: "subscription", method: "subscriptions/listen",
      params: { notifications: { taskIds: [task.taskId] }, _meta: META } }));
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatchObject({ method: "notifications/subscriptions/acknowledged", params: { notifications: { taskIds: [task.taskId] } } });
    await store.complete(task.taskId, { resultType: "complete", ...OUTCOME });
    await expect.poll(() => messages.length).toBe(2);
    conforms("TaskStatusNotification", messages[1]);
    expect(messages[1]).toMatchObject({ method: "notifications/tasks", params: { status: "completed", result: { ...OUTCOME }, _meta: { "io.modelcontextprotocol/subscriptionId": "subscription" } } });
    input.destroy(); output.destroy(); server.closeSubscriptions();
  });

  it("keeps the plugin host call pending until the durable nested result is ready", async () => {
    await isolate();
    const work = deferred();
    const store = new McpTaskStore(MANIFEST.id);
    const server = new PluginMcpServer(MANIFEST, () => work.promise, undefined, store);
    const transport = new LoopbackTransport(server);
    const host = new PluginMcpHost(MANIFEST.id, transport, {}, "generation");
    const tools = await host.prepareTools();
    const done = new Promise<void>((resolve) => store.subscribe((task) => { if (task.status === "working") resolve(); }));
    const call = tools[0].execute({}, { cwd: ROOT, extraAllowedDirectories: [], metadata: {} });
    await done;
    work.resolve(OUTCOME);
    expect(await call).toMatchObject({ output: "finished", metadata: { rawResult: { value: 42 } } });
    await host.dispose();
  });

  it("fails a subscription whose acknowledgement cannot fit without leaving a live listener", async () => {
    await isolate();
    const store = new McpTaskStore(MANIFEST.id);
    const task = await store.create();
    const subscribe = vi.spyOn(store, "subscribe");
    const server = new PluginMcpServer(MANIFEST, async () => OUTCOME, undefined, store);
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new StdioFrameDecoder(1024 * 1024);
    const messages: Array<{ id?: unknown; error?: { code: number } }> = [];
    output.on("data", (chunk) => messages.push(...decoder.push(chunk)));
    new StdioServerLoop(input, output, server, 1024 * 1024, 1).start();
    input.write(frameMessage({ jsonrpc: "2.0", id: "blocked", method: "subscriptions/listen",
      params: { notifications: { taskIds: [task.taskId] }, _meta: META } }));
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatchObject({ id: "blocked", error: { code: -32603 } });
    expect(subscribe).not.toHaveBeenCalled();
    input.destroy(); output.destroy();
  });

  it("uses the task cancellation method on a polling deadline and rejects guessed result envelopes", async () => {
    await isolate();
    const store = new McpTaskStore(MANIFEST.id);
    const task = await store.create();
    const server = new PluginMcpServer(MANIFEST, async () => OUTCOME, undefined, store);
    vi.useFakeTimers();
    const methods: string[] = [];
    const call = awaitMcpTask({ ...task, resultType: "task" }, async (method, params) => {
      methods.push(method);
      return (await request(server, method, params)).result;
    }, TOOL_TIMEOUT_POLICY.mcpTaskPromotionMs);
    const rejected = expect(call).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mcpTaskPromotionMs);
    await rejected;
    expect(methods).toContain("tasks/cancel");
    expect(await store.get(task.taskId)).toMatchObject({ status: "cancelled" });
    vi.useRealTimers();
    await expect(awaitMcpTask({ ...task, resultType: "task" }, async () => ({ ...task, resultType: "task" }), TOOL_TIMEOUT_POLICY.mcpTaskPromotionMs)).rejects.toThrow(/Invalid tasks\/get/);
  });
});
