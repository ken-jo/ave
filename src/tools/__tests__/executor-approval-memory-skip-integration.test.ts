/**
 * End-to-end integration coverage for the foreground modal-skip via
 * explicit-approval memory (Store B).
 *
 * Unlike the sibling unit suite (executor-approval-memory-skip.test.ts) these
 * tests do NOT stub `PermissionManager.checkDetailed` and do NOT mock the
 * user-approval store or the audit sink. They drive a REAL PermissionManager
 * plus the REAL user-approval store (isolated via AVE_HOME) so the layer
 * contract is pinned end-to-end:
 *
 *   (a) a deny rule wins over a prior approval — Store B is never consulted
 *       (Layer 1 hard gate).
 *   (b) an overlay-trigger mutating ask + a prior approval still shows the
 *       modal — Store B is never consulted (Layer 2 hard gate). The global
 *       strict-mode variant is asserted the same way.
 *   (c) a persistent-scope approval recorded through the real store skips the
 *       modal on the next identical invocation (Layer 6 normal ask).
 *   (d) an approval recorded under one (trustOrigin, approvalCacheKey) does
 *       NOT match a lookup with a different key dimension — the modal is shown
 *       (the cache key dimensions are load-bearing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import {
  approvalCacheKeyIdentity,
  recordApproval,
  __resetSessionStoreForTest,
  captureApprovalWorkingDirectory,
  setApprovalConversationRootResolver,
} from "../../permissions/user-approval-store.js";
import { resolveRootSessionId } from "../session-window-scope.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";
import { approvalCacheKeyFor } from "../pipeline/display-mask.js";
import { WriteFileTool } from "../file-tools.js";
import { createDynamicTool } from "../base.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";

describe("ToolExecutor — Store B memory skip end-to-end (real PermissionManager + real store)", () => {
  let dir: string;
  let aveHomeDir: string;
  let prevAveHome: string | undefined;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-memory-skip-e2e-"));
    aveHomeDir = mkdtempSync(join(tmpdir(), "ave-home-e2e-"));
    prevAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = aveHomeDir;
    __resetSessionStoreForTest();
    // OWN the audit logger rather than letting `ToolExecutor` construct one.
    //
    // `auditLogger` is the SEVENTH constructor parameter and these tests pass five, so
    // without this every executor built its own `new AuditLogger()` rooted at
    // `join(aveHome(), "audit")` — i.e. inside `aveHomeDir`. `AuditLogger.log()` returns
    // `void` and only enqueues (`audit-logger.ts:567` → `enqueuePlainWrite`), the tail is
    // awaited by nothing but `flush()`, and the permission path logs on EVERY invocation
    // including denials. That is the writer that actually raced `rmSync(aveHomeDir)`.
    auditLogger = new AuditLogger(join(aveHomeDir, "audit"));
  });

  afterEach(async () => {
    // Flush the audit writer FIRST — it is the only thing here that outlives its caller.
    //
    // An earlier version of this teardown drained the approval store instead and claimed
    // `recordApproval` "resolves when the write is QUEUED". That is FALSE, and a reviewer
    // demonstrated it: `mutatePersistentApprovals` RETURNS the promise covering
    // `readApprovalsFile → mutator → atomicWrite` (`user-approval-store.ts:214-224`) and
    // `recordApproval` awaits it, so an awaited `recordApproval` has already landed. All
    // five calls in this file are awaited, so the approval queue was never the racer and the
    // drain was a no-op.
    //
    // WHY THAT NO-OP COINCIDED WITH CI GOING GREEN IS NOT ESTABLISHED. A previous version of
    // this comment asserted the drain bought time by inserting an `await` — a timing yield
    // letting the audit writer finish. A reviewer disproved it and the experiment reproduces
    // here: firing an unawaited `appendFile`, then awaiting a settled promise, then ten
    // microtask ticks, leaves the write NOT landed; only a `setTimeout(0)` macrotask lets it
    // land. The drain awaited an already-settled queue, which is microtasks only, so it cannot
    // have given a threadpool write time to complete. The race is timing-dependent and that
    // particular run's outcome is unexplained. Saying otherwise teaches "add an `await` before
    // `rmSync`", which is the class of no-op fix the drain removal exists to discourage.
    await auditLogger.close();
    // Safe only because the flush above has completed: with nothing in flight, reverting
    // `AVE_HOME` cannot redirect a pending write at the real home.
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    __resetSessionStoreForTest();
    await cleanupTmpDir(dir);
    await cleanupTmpDir(aveHomeDir);
  });

  it("(a) deny rule wins over a prior approval — Layer 1, Store B never consulted", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setRules([{ pattern: "write_probe", action: "deny" }]);

    // A matching prior approval exists — it must be ignored under a deny.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `aveHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-deny", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-deny",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
    // Deny short-circuits at Layer 1 — the modal is never reached.
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("(b) overlay-trigger mutating ask + prior approval → modal shown — Layer 2 hard gate", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `aveHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-overlay", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-overlay",
        executionCwd: dir,
        // Overlay trigger forces a Layer 2 ask for mutating tools.
        overlayTriggerOrigin: "overlay:meeting-detection",
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ durableApprovalRecordAllowed: false }));
    // Layer 2 hard gate is never memory-skipped — modal shown, tool denied.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("(b') global strict mode + prior approval → modal shown — Layer 2 hard gate", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.setMode("strict");

    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `aveHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-strict", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-strict",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("(c) persistent-scope approval recorded via the real store skips the modal on re-call", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    // Default mode + builtin write → Layer 6 normal ask (no reviewer route),
    // which is the lane eligible for the Store B skip.
    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    // Record a PERSISTENT approval for the exact tuple the executor will look up.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "persistent", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `aveHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      [{ id: "tu-persist", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-persist",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Memory hit — modal skipped, tool executed.
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBeUndefined();
  });

  it.each([
    { sessionId: "approved-conversation", permitted: true },
    { sessionId: "another-conversation", permitted: false },
    { sessionId: undefined, permitted: false },
  ])("conversation approval permits only its owning session: $sessionId", async ({ sessionId, permitted }) => {
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const manager = new PermissionManager(join(dir, "permissions.json"));
    const input = { path: join(dir, "conversation.txt") };
    await recordApproval("write_probe", canonicalStringify(input), "builtin", {
      scope: "session",
      sessionId: "approved-conversation",
      verdictAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity,
    });
    const requestAndWait = vi.fn(async (request: { id: string }) => ({
      requestId: request.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry, undefined, manager, undefined,
      { requestAndWait } as never, undefined, auditLogger,
    );
    const result = await executor.executeAll(
      [{ id: "conversation-write", name: "write_probe", input }],
      {
        ...(sessionId === undefined ? {} : { sessionId }),
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );
    expect(execute).toHaveBeenCalledTimes(permitted ? 1 : 0);
    expect(requestAndWait).toHaveBeenCalledTimes(permitted ? 0 : 1);
    expect(Boolean(result[0].is_error)).toBe(!permitted);
  });

  // Rule: a session allow belongs to the root conversation. Every agent in
  // that tree (the conversation and the sub-agents spawned from it, at any
  // depth) shares it; separate root conversations never do.
  it.each([
    { name: "a parent allow covers its sub-agent", recordedBy: "root-a", calledBy: "child-a1", permitted: true },
    { name: "a nested sub-agent allow covers the root conversation", recordedBy: "grandchild-a1", calledBy: "root-a", permitted: true },
    { name: "a sub-agent allow covers its sibling within the same root", recordedBy: "child-a1", calledBy: "child-a2", permitted: true },
    { name: "a sub-agent allow never reaches another root conversation", recordedBy: "child-a1", calledBy: "child-b1", permitted: false },
    { name: "another root's allow never reaches this conversation", recordedBy: "root-b", calledBy: "root-a", permitted: false },
  ])("session approvals are keyed by root conversation: $name", async ({ recordedBy, calledBy, permitted }) => {
    const origins: Record<string, string> = {
      "child-a1": "root-a", "child-a2": "root-a", "grandchild-a1": "child-a1", "child-b1": "root-b",
    };
    setApprovalConversationRootResolver((sessionId) => resolveRootSessionId(sessionId, (id) => origins[id]));
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const manager = new PermissionManager(join(dir, "permissions.json"));
    const input = { path: join(dir, "subagent.txt") };
    await recordApproval("write_probe", canonicalStringify(input), "builtin", {
      scope: "session",
      sessionId: recordedBy,
      verdictAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity,
    });
    const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "deny-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, auditLogger);
    const result = await executor.executeAll(
      [{ id: "subagent-write", name: "write_probe", input }],
      { sessionId: calledBy, executionCwd: dir, permissionContext: userPermissionContext({ additionalDirectories: [dir] }) },
    );
    expect(execute).toHaveBeenCalledTimes(permitted ? 1 : 0);
    expect(requestAndWait).toHaveBeenCalledTimes(permitted ? 0 : 1);
    expect(Boolean(result[0].is_error)).toBe(!permitted);
  });

  it("refuses to key a session approval through a cyclic sub-agent origin chain", async () => {
    setApprovalConversationRootResolver((sessionId) =>
      resolveRootSessionId(sessionId, (id) => ({ loop1: "loop2", loop2: "loop1" } as Record<string, string>)[id]));
    await expect(recordApproval("write_probe", canonicalStringify({ path: join(dir, "x.txt") }), "builtin", {
      scope: "session",
      sessionId: "loop1",
      verdictAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity,
    })).rejects.toThrow(/cyclic or deeper/);
  });

  it("(d) approval under a different (trustOrigin, approvalCacheKey) does NOT match — modal shown", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    // Recorded under approvalCacheKey "key-A". The invocation below carries no
    // approvalCacheKey and trustOrigin "user-keyboard", so the derived key
    // differs → lookup misses → modal shown.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      {
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        trustOrigin: "user-keyboard",
        approvalCacheKey: approvalCacheKeyIdentity("key-A", { kind: "args" }),
      },
    );

    const requestAndWait = vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real
      // `aveHome()`; see the note in `beforeEach`.
      auditLogger,
    );

    const result = await executor.executeAll(
      // No approvalCacheKey on this invocation → key mismatch vs the stored entry.
      [{ id: "tu-keymiss", name: "write_probe", input: { path: join(dir, "file.txt") } }],
      {
        sessionId: "sess-keymiss",
        executionCwd: dir,
        permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
      },
    );

    // Key dimensions are load-bearing — a mismatch is a miss → modal shown.
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(result[0].is_error).toBe(true);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it.each(["printf hello", "inspect_local_fixture"])("reuses unassessed %s in the same directory and asks for a different directory or input", async (command) => {
    const otherDir = join(dir, "other-project");
    mkdirSync(otherDir);
    const execute = vi.fn(async () => ({ output: "hello", isError: false }));
    const tool = createDynamicTool({
      name: "shell_probe", description: "shell probe", source: "builtin", category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute,
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("low");
    const cards: ApprovalRequest[] = [];
    const recordings: Promise<void>[] = [];
    const gate = new ApprovalGate({
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel !== "ave:approval:request") return;
        cards.push(request);
        recordings.push((async () => {
          const snapshot = gate.getRequestSnapshot(request.id)!;
          expect(snapshot.persistentAllowAllowed).toBe(true);
          expect(snapshot.verdictAtApproval).toBe("high");
          await recordApproval(snapshot.toolName, canonicalStringify(snapshot.args), snapshot.source, {
            scope: "persistent", verdictAtApproval: snapshot.verdictAtApproval, nlJustification: null,
            trustOrigin: snapshot.trustOrigin,
            approvalCacheKey: approvalCacheKeyIdentity(snapshot.approvalCacheKey, snapshot.approvalMemory),
            workingDirectoryIdentity: snapshot.workingDirectoryIdentity, riskCeilingAtApproval: snapshot.riskCeilingAtApproval,
          });
          gate.resolveFromDesktopRenderer(request.id, {
            requestId: request.id, choice: "allow-always", nonce: request.nonce, hmac: request.hmac,
          });
        })());
      },
    } as never);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
    const run = (id: string, cwd: string, nextCommand = command) => executor.executeAll(
      [{ id, name: tool.name, input: { command: nextCommand } }],
      { sessionId: "unavailable-reviewer", executionCwd: cwd, permissionContext: userPermissionContext({ additionalDirectories: [dir] }) },
    );
    expect((await run("first", dir))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    __resetSessionStoreForTest();
    expect((await run("repeat", dir))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    expect((await run("other-project", otherDir))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(2);
    expect((await run("changed-input", dir, "printf changed"))[0].is_error).toBeUndefined();
    expect(cards).toHaveLength(3);
    await Promise.all(recordings);
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it("preserves a path-specific policy deny without widening the tool key", async () => {
    const tool = new WriteFileTool();
    const input = { path: join(dir, "blocked.txt"), content: "must not write" };
    const key = approvalCacheKeyFor(tool, input, dir)!;
    expect(key).toBe("write_file:path:" + input.path);
    const registry = new ToolRegistry();
    registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setRules([{ pattern: key, action: "deny" }]);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, auditLogger);
    const result = await executor.executeAll([{ id: "exact-policy-deny", name: tool.name, input }], {
      executionCwd: dir, permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
    });
    expect(result[0].is_error).toBe(true);
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it.each(["riskCeilingAtApproval", "verdictAtApproval"])("rejects malformed persisted %s before foreground reuse", async (field) => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));
    const manager = new PermissionManager(join(dir, "permissions.json"));
    const disclose = vi.fn();
    manager.setBroadcastUserApprovalHit(disclose);
    const input = { path: join(dir, "file.txt") };
    await recordApproval("write_probe", canonicalStringify(input), "builtin", {
      scope: "persistent", verdictAtApproval: "high", riskCeilingAtApproval: "low", nlJustification: null,
      trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity,
    });
    const storePath = join(aveHomeDir, "permissions", "user-approvals.json");
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    (Object.values(stored.approvals)[0] as Record<string, unknown>)[field] = "invalid";
    await writeFile(storePath, JSON.stringify(stored));
    __resetSessionStoreForTest();
    const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "deny-once" as const }));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, auditLogger);
    const result = await executor.executeAll([{ id: "malformed", name: "write_probe", input }], {
      executionCwd: dir, permissionContext: userPermissionContext({ additionalDirectories: [dir] }),
    });
    expect(result[0].is_error).toBe(true);
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(disclose).not.toHaveBeenCalled();
  });

});
