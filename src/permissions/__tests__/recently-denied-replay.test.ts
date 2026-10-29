import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { checkReplayRootBinding } from "../reviewer/replay-root-binding.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import type { RecentlyDeniedEntry } from "../../shared/recently-denied.js";
import { createRecentlyDeniedReplayResolver, makeRecentlyDeniedInvocationRef } from "../reviewer/recently-denied-replay.js";
import { PermissionTestResources } from "./test-resources.js";

const SESSION_ID = "c8f40ac1-4139-45c2-b470-809c5c1e1272";
const CALL_ID = "tool-call-original";
const resources = new PermissionTestResources();
afterEach(async () => { vi.restoreAllMocks(); await resources.cleanup(); });

async function subject() {
  const root = resources.makeTmpDir("ave-persisted-replay-");
  const project = join(root, "project");
  mkdirSync(project);
  const memory = new MemoryManager({ aveDir: root });
  const input = { message: "bounded message", password: "not-in-denial-file" };
  const tool = createDynamicTool({ name: "send_probe", source: "builtin", category: "network", description: "Sends a bounded message.", pathFields: [],
    jsonSchema: { type: "object", properties: { message: { type: "string" }, password: { type: "string" } }, required: ["message"] },
    execute: async () => ({ output: "done", isError: false }),
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  const call = { id: CALL_ID, name: tool.name, input, source: tool.source, category: tool.category };
  const messages = [{ role: "assistant", content: "", toolCalls: [call] }];
  await memory.saveSession(SESSION_ID, messages);
  await memory.saveSessionMetadata(SESSION_ID, { projectRoot: project });
  const executeAll = vi.fn(async () => [{ tool_use_id: "fresh", content: "done", is_error: false, durationMs: 0 }]);
  const resolver = createRecentlyDeniedReplayResolver({ memoryManager: memory, toolRegistry: registry, executeAll });
  const invocationRef = makeRecentlyDeniedInvocationRef(input, { cwd: project, toolUseId: CALL_ID });
  expect(invocationRef).toBeDefined();
  const entry: RecentlyDeniedEntry = {
    id: "730b7e85-ffbd-47c3-97bd-97af131701d4", ts: "2026-10-30T00:00:00.000Z", sessionId: SESSION_ID,
    toolName: tool.name, source: tool.source, category: tool.category,
    inputSummary: "redacted summary", reason: "Nobody can approve this request; do not retry.", rerunAvailable: true, invocationRef,
  };
  return { root, project, memory, input, tool, call, messages, registry, executeAll, resolver, entry, invocationRef };
}

describe("persisted denial invocation references", () => {
  it("reconstructs only the original call on explicit click after store restart without raw arguments in history", async () => {
    const current = await subject();
    const file = join(current.root, "recently-denied.json");
    const initial = makeRecentlyDeniedStore(file);
    const id = await initial.append(current.entry);
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain(current.input.password);
    expect(persisted).not.toContain(current.project);
    const restarted = makeRecentlyDeniedStore(file);
    restarted.setReplayResolver(current.resolver);
    expect((await restarted.list())[0].rerunAvailable).toBe(true);
    expect(current.executeAll).not.toHaveBeenCalled();
    expect(await restarted.rerun(id)).toEqual({ ok: true });
    const [calls, options] = current.executeAll.mock.calls[0] as unknown as [Array<{ id: string; name: string; input: unknown }>, Record<string, unknown>];
    expect(calls[0]).toMatchObject({ name: "send_probe", input: current.input });
    expect(calls[0].id).not.toBe(CALL_ID);
    expect(options).toEqual({ executionCwd: current.project, replayRootBinding: expect.any(Object), permissionContext: { trustOrigin: "user-keyboard", manualRerun: true, headless: false } });
    expect(checkReplayRootBinding(options.replayRootBinding)).toEqual({ valid: true });
    expect(JSON.stringify(options.replayRootBinding)).toBe("{}");
    expect(options).not.toHaveProperty("sessionId");
    expect(options).not.toHaveProperty("abortSignal");
  });

  it.each(["missing-session", "duplicate-call", "changed-input", "changed-name", "changed-source", "invalid-input", "missing-root", "changed-root"])("refuses %s without entering the executor", async (kind) => {
    const current = await subject();
    if (kind === "missing-session") vi.spyOn(current.memory, "loadSession").mockReturnValue(null);
    if (kind === "duplicate-call") await current.memory.saveSession(SESSION_ID, [...current.messages, ...current.messages]);
    if (kind === "changed-input") await current.memory.saveSession(SESSION_ID, [{ ...current.messages[0], toolCalls: [{ ...current.call, input: { message: "changed" } }] }]);
    if (kind === "changed-name") await current.memory.saveSession(SESSION_ID, [{ ...current.messages[0], toolCalls: [{ ...current.call, name: "another_tool" }] }]);
    if (kind === "changed-source") await current.memory.saveSession(SESSION_ID, [{ ...current.messages[0], toolCalls: [{ ...current.call, source: "plugin" }] }]);
    if (kind === "invalid-input") await current.memory.saveSession(SESSION_ID, [{ ...current.messages[0], toolCalls: [{ ...current.call, invalidInput: { raw: "bad" } }] }]);
    if (kind === "missing-root") await current.memory.saveSessionMetadata(SESSION_ID, {});
    if (kind === "changed-root") { const other = join(current.root, "other"); mkdirSync(other); await current.memory.saveSessionMetadata(SESSION_ID, { projectRoot: other }); }
    expect(await current.resolver(current.entry)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(current.executeAll).not.toHaveBeenCalled();
  });

  it("refuses a replaced directory even when its path and metadata stay the same", async () => {
    const current = await subject();
    renameSync(current.project, join(current.root, "original-project"));
    mkdirSync(current.project);
    expect(await current.resolver(current.entry)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(current.executeAll).not.toHaveBeenCalled();
  });

  it("marks an unresolved persisted pointer unavailable without reading raw input during listing", async () => {
    const current = await subject();
    const store = makeRecentlyDeniedStore(join(current.root, "history.json"));
    const id = await store.append(current.entry);
    const load = vi.spyOn(current.memory, "loadSession").mockReturnValue(null);
    store.setReplayResolver(current.resolver);
    expect((await store.list())[0].rerunAvailable).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(await store.rerun(id)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect((await store.list())[0].rerunAvailable).toBe(false);
    expect(load).toHaveBeenCalledOnce();
  });

  it("requires an exact current registry owner and valid current schema", async () => {
    const current = await subject();
    vi.spyOn(current.registry, "findByName").mockReturnValue({ ...current.tool, pluginId: "another-plugin" });
    expect(await current.resolver(current.entry)).toEqual({ ok: false, error: "rerun-unavailable" });
    vi.mocked(current.registry.findByName).mockReturnValue({ ...current.tool, toJsonSchema: () => ({ type: "object", required: ["newRequiredField"] }) });
    expect(await current.resolver(current.entry)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(current.executeAll).not.toHaveBeenCalled();
  });

  it.each(["plugin", "mcp"] as const)("preserves exact %s ownership through the persisted pointer", async (source) => {
    const current = await subject();
    const origin = source === "plugin" ? { pluginId: "message-provider" } : { mcpServerId: "message-server" };
    const ownedTool = { ...current.tool, source, ...origin };
    vi.spyOn(current.registry, "findByName").mockReturnValue(ownedTool);
    await current.memory.saveSession(SESSION_ID, [{ ...current.messages[0], toolCalls: [{ ...current.call, source, ...origin }] }]);
    const invocationRef = makeRecentlyDeniedInvocationRef(current.input, { cwd: current.project, toolUseId: CALL_ID, ...origin });
    const entry = { ...current.entry, source, invocationRef };
    expect(await current.resolver(entry)).toEqual({ ok: true });
    current.executeAll.mockClear();
    vi.mocked(current.registry.findByName).mockReturnValue({ ...ownedTool, ...(source === "plugin" ? { pluginId: "another-provider" } : { mcpServerId: "another-server" }) });
    expect(await current.resolver(entry)).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(current.executeAll).not.toHaveBeenCalled();
  });

  it("does not execute a display-only row, malformed pointer or missing legacy transcript", async () => {
    const current = await subject();
    writeFileSync(join(current.root, "deferred-queue.jsonl"), JSON.stringify({ status: "approved", args: current.input }));
    expect(await current.resolver({ ...current.entry, invocationRef: undefined })).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(await current.resolver({ ...current.entry, invocationRef: { ...current.invocationRef!, inputDigest: "malformed" } })).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(await current.resolver({ ...current.entry, sessionId: "../../outside" })).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(current.executeAll).not.toHaveBeenCalled();
  });

  it("rejects non-JSON or non-directory fingerprints and reflects a failed fresh execution", async () => {
    const current = await subject();
    expect(makeRecentlyDeniedInvocationRef({ value: Infinity }, { cwd: current.project, toolUseId: CALL_ID })).toBeUndefined();
    expect(makeRecentlyDeniedInvocationRef(current.input, { cwd: "relative", toolUseId: CALL_ID })).toBeUndefined();
    let nested: Record<string, unknown> = { leaf: "value" };
    for (let index = 0; index < 70; index += 1) nested = { nested };
    expect(makeRecentlyDeniedInvocationRef(nested, { cwd: current.project, toolUseId: CALL_ID })).toBeUndefined();
    current.executeAll.mockResolvedValue([{ tool_use_id: "fresh", content: "denied", is_error: true, durationMs: 0 }]);
    expect(await current.resolver(current.entry)).toEqual({ ok: false, error: "rerun-failed" });
  });
});
