import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { enforceMutatingEffects, EffectBoundaryDeniedError } from "../../permissions/effect-enforcement.js";
import { ApprovalSurfaceRegistry } from "../../permissions/approval-surface-registry.js";
import { createRecentlyDeniedReplayResolver } from "../../permissions/reviewer/recently-denied-replay.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import * as approvals from "../../permissions/user-approval-store.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const resources = new PermissionTestResources();
const cleanup: Array<() => Promise<void>> = [];
const SESSION_ID = "75a4bf7c-9a43-486c-9266-a03a92aeb7ca";

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  approvals.__resetSessionStoreForTest();
  vi.restoreAllMocks();
  await resources.cleanup();
});

async function subject() {
  const storageRoot = resources.makeTmpDir("ave-executor-history-");
  const root = join(storageRoot, "project");
  mkdirSync(root);
  const historyFile = join(storageRoot, "recently-denied.json");
  const history = makeRecentlyDeniedStore(historyFile);
  const manager = new PermissionManager(join(storageRoot, "permissions.json"));
  manager.setMode("default");
  const classify = vi.fn(async () => ({ level: "low" as const, reason: "bounded operation" }));
  setReviewerForTest(manager, { classifier: { classify }, cache: resources.makeVerdictCache(join(storageRoot, "cache.jsonl")), recentlyDenied: history });
  const audit = new AuditLogger(join(storageRoot, "audit"));
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  const hooks = new ScriptHookManager();
  const preHook = vi.spyOn(hooks, "runPreToolUse");
  const cards: ApprovalRequest[] = [];
  const sender = { isDestroyed: () => false, send: (channel: string, card: ApprovalRequest) => {
    if (channel === "ave:approval:request") cards.push(card);
  } };
  const surfaces = new ApprovalSurfaceRegistry();
  surfaces.register(SESSION_ID, null);
  surfaces.registerUnattributed(sender as never);
  const gate = new ApprovalGate((sessionId) => surfaces.resolve(sessionId));
  const execute = vi.fn(async () => ({ output: "completed", isError: false }));
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: "send_probe", source: "builtin", description: "Sends a bounded message.", category: "network", pathFields: [],
    jsonSchema: { type: "object", properties: { password: { type: "string" }, message: { type: "string" } }, required: ["message"] }, execute }));
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, hooks, audit);
  cleanup.push(async () => { gate.disposeAll(); await audit.close(); });
  const originalAbort = new AbortController();
  const input = { message: "bounded message", password: "private-history-credential" };
  const denyHeadless = (origin: Partial<import("../executor-contract.js").ToolPermissionContext> = {}, overlayTriggerOrigin?: string) => executor.executeAll([{ id: "initial-denied-call", name: "send_probe", input }], {
    sessionId: SESSION_ID, executionCwd: root, abortSignal: originalAbort.signal, permissionContext: userPermissionContext({ headless: true, ...origin }),
    ...(overlayTriggerOrigin === undefined ? {} : { overlayTriggerOrigin }),
  });
  const approve = (card: ApprovalRequest) => gate.resolveFromDesktopRenderer(card.id, {
    requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac,
  }, sender as never);
  return { root, storageRoot, historyFile, history, manager, classify, hooks, preHook, cards, execute, input, originalAbort, denyHeadless, approve, executor, registry, gate, surfaces, sender };
}

describe("executor denial history and manual rerun", () => {
  it.each(["headless", "owner-away-skip"] as const)("keeps a caught nested %s write denial terminal despite an enclosing allow rule", async (lane) => {
    const current = await subject();
    const pluginId = "nested-effect-provider";
    const toolName = "nested_write_probe";
    const target = join(current.root, "nested.json");
    const writeEffect = vi.fn(async (relativePath: string, contents: unknown) => {
      writeFileSync(join(current.root, relativePath), String(contents));
    });
    const api = enforceMutatingEffects({ storage: { write: writeEffect } }, {
      pluginId, approvalGate: current.gate, permissionManager: current.manager,
      resolveStoragePath: (relativePath) => join(current.root, relativePath), assertActive: vi.fn(),
    });
    const caught: unknown[] = [];
    const handler = vi.fn(async () => {
      try { await api.storage.write("nested.json", current.input.password); }
      catch (error) { caught.push(error); }
      return { output: "handler caught the rejection", isError: false };
    });
    current.registry.register(createDynamicTool({ name: toolName, source: "plugin", pluginId,
      description: "Performs a bounded nested write.", category: "write", pathFields: [], jsonSchema: { type: "object" }, execute: handler,
    }));
    await current.manager.addAlwaysAllowedPersist(toolName);
    const checks = vi.spyOn(current.manager, "checkDetailed");
    if (lane === "owner-away-skip") {
      current.surfaces.register(SESSION_ID, current.sender as never);
      current.gate.setOwnerAwayAutoSkipMinutes(1);
      vi.useFakeTimers();
    }
    try {
      const pending = current.executor.executeAll([{ id: "caught-nested-write", name: toolName, input: current.input }], {
        sessionId: SESSION_ID, executionCwd: current.root,
        permissionContext: userPermissionContext(lane === "headless" ? { headless: true } : { headless: false, ownerUnattended: true }),
      });
      if (lane === "owner-away-skip") {
        await vi.waitFor(() => expect(current.cards).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(60_001);
      }
      const [result] = await pending;
      expect(handler).toHaveBeenCalledOnce();
      expect(caught).toHaveLength(1);
      expect(caught[0]).toBeInstanceOf(EffectBoundaryDeniedError);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Nobody can approve this request; do not retry.");
      expect(writeEffect).not.toHaveBeenCalled();
      expect(existsSync(target)).toBe(false);
      expect(current.classify).not.toHaveBeenCalled();
      if (lane === "headless") expect(current.cards).toHaveLength(0);
      const effectIndex = checks.mock.calls.findIndex(([name]) => name === "effect_storage_write");
      expect(effectIndex).toBeGreaterThanOrEqual(0);
      const effectDecision = checks.mock.results[effectIndex];
      if (effectDecision.type !== "return") throw new Error("Effect policy did not return a decision");
      expect(effectDecision.value.pipelineRequest?.floor).toBeUndefined();
      const [entry] = await current.history.list();
      expect(entry).toMatchObject({ toolName, source: "plugin", reason: "Nobody can approve this request; do not retry." });
      expect(entry.inputSummary).not.toContain(current.input.password);
      expect(readFileSync(current.historyFile, "utf8")).not.toContain(current.input.password);
    } finally { if (lane === "owner-away-skip") vi.useRealTimers(); }
  });

  it("records a headless terminal denial with redacted display data and no persisted replay", async () => {
    const current = await subject();
    const [result] = await current.denyHeadless();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Nobody can approve this request; do not retry.");
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.cards).toHaveLength(0);
    const [entry] = await current.history.list();
    expect(entry).toMatchObject({ toolName: "send_probe", reason: expect.any(String), rerunAvailable: true });
    expect(entry.inputSummary).not.toContain(current.input.password);
    expect(readFileSync(current.historyFile, "utf8")).not.toContain(current.input.password);
    expect(entry).not.toHaveProperty("grant");
    expect(entry).not.toHaveProperty("args");
    const restarted = makeRecentlyDeniedStore(current.historyFile);
    expect((await restarted.list())[0].rerunAvailable).toBe(false);
    expect(await restarted.rerun(entry.id)).toEqual({ ok: false, error: "rerun-unavailable" });
  });

  it("reruns admission hooks and asks a fresh card despite remembered allow and automatic review", async () => {
    const current = await subject();
    await current.denyHeadless();
    const [entry] = await current.history.list();
    await approvals.recordApproval("send_probe", approvals.canonicalStringify(current.input), "builtin", {
      scope: "session", sessionId: SESSION_ID, verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard",
      workingDirectoryIdentity: approvals.captureApprovalWorkingDirectory(current.root).identity,
    });
    current.originalAbort.abort(new Error("original turn ended"));
    current.manager.setMode("auto");
    current.surfaces.register(SESSION_ID, current.sender as never);
    const pending = current.history.rerun(entry.id);
    await vi.waitFor(() => expect(current.cards).toHaveLength(1));
    expect(current.preHook).toHaveBeenCalledTimes(2);
    expect(current.classify).not.toHaveBeenCalled();
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.cards[0].sessionId).toBe(SESSION_ID);
    expect(current.approve(current.cards[0])).toBeTruthy();
    expect(await pending).toEqual({ ok: true });
    expect(current.execute).toHaveBeenCalledOnce();
    expect(await current.history.rerun(entry.id)).toEqual({ ok: false, error: "rerun-unavailable" });
  });

  it("reconstructs a persisted reference after restart and asks the current native user", async () => {
    const current = await subject();
    const memory = new MemoryManager({ aveDir: join(current.storageRoot, "saved-memory") });
    await memory.saveSession(SESSION_ID, [{ role: "assistant", content: "", toolCalls: [{
      id: "initial-denied-call", name: "send_probe", input: current.input, source: "builtin", category: "network",
    }] }]);
    await memory.saveSessionMetadata(SESSION_ID, { projectRoot: current.root });
    await current.denyHeadless();
    const restarted = makeRecentlyDeniedStore(current.historyFile);
    restarted.setReplayResolver(createRecentlyDeniedReplayResolver({ memoryManager: memory, toolRegistry: current.registry,
      executeAll: current.executor.executeAll.bind(current.executor),
    }));
    const [entry] = await restarted.list();
    expect(entry.invocationRef).toBeDefined();
    expect(entry.rerunAvailable).toBe(true);
    current.originalAbort.abort(new Error("old process ended"));
    current.surfaces.register(SESSION_ID, current.sender as never);
    const pending = restarted.rerun(entry.id);
    await vi.waitFor(() => expect(current.cards).toHaveLength(1));
    expect(current.cards[0].sessionId).toBe(SESSION_ID);
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.preHook).toHaveBeenCalledTimes(2);
    current.approve(current.cards[0]);
    expect(await pending).toEqual({ ok: true });
    expect(current.execute).toHaveBeenCalledOnce();
    expect(readFileSync(current.historyFile, "utf8")).not.toContain(current.input.password);
  });

  it.each(["live", "persisted"] as const)("rejects a root replaced during the %s replay approval card", async (kind) => {
    const current = await subject();
    const memory = new MemoryManager({ aveDir: join(current.storageRoot, "saved-memory") });
    await memory.saveSession(SESSION_ID, [{ role: "assistant", content: "", toolCalls: [{
      id: "initial-denied-call", name: "send_probe", input: current.input, source: "builtin", category: "network",
    }] }]);
    await memory.saveSessionMetadata(SESSION_ID, { projectRoot: current.root });
    await current.denyHeadless();
    const history = kind === "live" ? current.history : makeRecentlyDeniedStore(current.historyFile);
    if (kind === "persisted") history.setReplayResolver(createRecentlyDeniedReplayResolver({ memoryManager: memory,
      toolRegistry: current.registry, executeAll: current.executor.executeAll.bind(current.executor),
    }));
    const [entry] = await history.list();
    current.surfaces.register(SESSION_ID, current.sender as never);
    const pending = history.rerun(entry.id);
    await vi.waitFor(() => expect(current.cards).toHaveLength(1));
    renameSync(current.root, join(current.storageRoot, "original-project"));
    mkdirSync(current.root);
    current.approve(current.cards[0]);
    expect(await pending).toEqual({ ok: false, error: "rerun-failed" });
    expect(current.execute).not.toHaveBeenCalled();
  });

  it.each(["live", "persisted"] as const)("preserves an other-principal turn and its one-time-only floor in a %s rerun", async (kind) => {
    const current = await subject();
    const memory = new MemoryManager({ aveDir: join(current.storageRoot, "saved-memory") });
    await memory.saveSession(SESSION_ID, [{ role: "assistant", content: "", toolCalls: [{
      id: "initial-denied-call", name: "send_probe", input: current.input, source: "builtin", category: "network",
    }] }]);
    await memory.saveSessionMetadata(SESSION_ID, { projectRoot: current.root });
    await current.denyHeadless({ trustOrigin: "agent-message", otherPrincipal: true });
    const history = kind === "live" ? current.history : makeRecentlyDeniedStore(current.historyFile);
    if (kind === "persisted") history.setReplayResolver(createRecentlyDeniedReplayResolver({ memoryManager: memory,
      toolRegistry: current.registry, executeAll: current.executor.executeAll.bind(current.executor),
    }));
    current.manager.setMode("allow");
    current.surfaces.register(SESSION_ID, current.sender as never);
    const [entry] = await history.list();
    const pending = history.rerun(entry.id);
    await vi.waitFor(() => expect(current.cards).toHaveLength(1));
    expect(current.cards[0]).toMatchObject({ sessionId: SESSION_ID, trustOrigin: "agent-message", requireExplicit: true,
      allowedChoices: ["allow-once", "deny-once"], exactRecordAllowed: false });
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.classify).not.toHaveBeenCalled();
    current.approve(current.cards[0]);
    expect(await pending).toEqual({ ok: true });
    expect(current.execute).toHaveBeenCalledOnce();
  });

  for (const overlayTriggerOrigin of ["overlay:meeting-detection", "app:status-card", "mcp-prompt:workspace", "plugin-prompt:extension:notes:summary"]) {
    it.each(["live", "persisted"] as const)(`retains ${overlayTriggerOrigin} staged provenance in a %s rerun`, async (kind) => {
      const current = await subject();
      const memory = new MemoryManager({ aveDir: join(current.storageRoot, "saved-memory") });
      await memory.saveSession(SESSION_ID, [{ role: "assistant", content: "", toolCalls: [{
        id: "initial-denied-call", name: "send_probe", input: current.input, source: "builtin", category: "network",
      }] }]);
      await memory.saveSessionMetadata(SESSION_ID, { projectRoot: current.root });
      await current.denyHeadless({}, overlayTriggerOrigin);
      const history = kind === "live" ? current.history : makeRecentlyDeniedStore(current.historyFile);
      if (kind === "persisted") history.setReplayResolver(createRecentlyDeniedReplayResolver({ memoryManager: memory,
        toolRegistry: current.registry, executeAll: current.executor.executeAll.bind(current.executor),
      }));
      current.manager.setMode("allow");
      current.surfaces.register(SESSION_ID, current.sender as never);
      const checks = vi.spyOn(current.manager, "checkDetailed");
      const [entry] = await history.list();
      expect(entry.invocationRef?.replayOrigin).toMatchObject({ overlayTriggerOrigin, otherPrincipal: true });
      expect(readFileSync(current.historyFile, "utf8")).toContain(overlayTriggerOrigin);
      const pending = history.rerun(entry.id);
      await vi.waitFor(() => expect(current.cards).toHaveLength(1));
      expect(checks.mock.calls.some(([name, , , source]) => name === "send_probe" && source === overlayTriggerOrigin)).toBe(true);
      expect(checks.mock.results.some((result) => result.type === "return" && result.value.pipelineRequest?.floor?.code === "other-principal")).toBe(true);
      expect(current.cards[0]).toMatchObject({ sessionId: SESSION_ID, requireExplicit: true,
        allowedChoices: ["allow-once", "deny-once"], exactRecordAllowed: false });
      expect(current.execute).not.toHaveBeenCalled();
      expect(current.classify).not.toHaveBeenCalled();
      current.approve(current.cards[0]);
      expect(await pending).toEqual({ ok: true });
      expect(current.execute).toHaveBeenCalledOnce();
    });
  }

  it("applies a new admission hook denial before any replay approval or tool effect", async () => {
    const current = await subject();
    await current.denyHeadless();
    const [entry] = await current.history.list();
    current.preHook.mockResolvedValueOnce({ decision: "deny", reason: "changed admission policy", results: [] });
    expect(await current.history.rerun(entry.id)).toEqual({ ok: false, error: "rerun-failed" });
    expect(current.preHook).toHaveBeenCalledTimes(2);
    expect(current.cards).toHaveLength(0);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("ignores legacy approved queue contents when the history file is missing", async () => {
    const root = resources.makeTmpDir("ave-legacy-denial-history-");
    const legacyFile = join(root, "deferred-queue.jsonl");
    const legacy = JSON.stringify({ id: "old", status: "approved", args: { command: "legacy executable input" }, grant: { kind: "directory", path: root } });
    writeFileSync(legacyFile, legacy);
    const historyFile = join(root, "recently-denied.json");
    const history = makeRecentlyDeniedStore(historyFile);
    expect(await history.list()).toEqual([]);
    expect(await history.rerun("old")).toEqual({ ok: false, error: "rerun-unavailable" });
    expect(existsSync(historyFile)).toBe(false);
    expect(readFileSync(legacyFile, "utf8")).toBe(legacy);
  });
});
