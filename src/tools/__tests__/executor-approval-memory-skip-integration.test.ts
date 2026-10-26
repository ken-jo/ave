/** Exercise real approval, permission, store, and audit boundaries with an isolated home.
 * Deny and forced-modal rules outrank remembered approval; persistent matching tuples skip ordinary asks, while identity changes re-prompt. */
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
import { wireJudgeForTest } from "../../__tests__/support/reviewer-judge.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import {
  approvalCacheKeyIdentity,
  recordApproval,
  __resetSessionStoreForTest,
  captureApprovalWorkingDirectory,
  setApprovalConversationRootResolver,
} from "../../permissions/user-approval-store.js";
import { createRootSessionResolver } from "../../permissions/root-session-resolver.js";
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
    // Own the audit logger so teardown can flush queued writes before removing its temporary home.
    auditLogger = new AuditLogger(join(aveHomeDir, "audit"));
  });

  afterEach(async () => {
    // Flush the audit writer before deleting the home; approval writes are already awaited.
    // Awaiting settled promises or microtasks does not complete pending filesystem writes.
    await auditLogger.close();
    // Safe only because the flush above has completed: with nothing in flight, reverting `AVE_HOME` cannot redirect a pending write at the real home.
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

    // A matching prior approval exists; it must be ignored under a deny.
    await recordApproval(
      "write_probe",
      canonicalStringify({ path: join(dir, "file.txt") }),
      "builtin",
      { scope: "session", sessionId: "sess-deny", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
    );

    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      { requestAndWait } as never,
      undefined,
      // 7th parameter. Without it the executor builds its own logger under the real `aveHome()`; see the note in `beforeEach`.
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
    // Deny short-circuits at Layer 1; the modal is never reached.
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
      { scope: "session", sessionId: "sess-overlay", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
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
      // 7th parameter. Without it the executor builds its own logger under the real `aveHome()`; see the note in `beforeEach`.
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
    // Layer 2 hard gate is never memory-skipped; modal shown, tool denied.
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
      { scope: "session", sessionId: "sess-strict", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity },
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
      // 7th parameter. Without it the executor builds its own logger under the real `aveHome()`; see the note in `beforeEach`.
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

    // Default mode + builtin write → Layer 6 normal ask (no reviewer route), which is the lane eligible for the Store B skip.
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
      // 7th parameter. Without it the executor builds its own logger under the real `aveHome()`; see the note in `beforeEach`.
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

    // Memory hit; modal skipped, tool executed.
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

  // Rule: a session allow belongs to the root conversation. Every agent in that tree (the conversation
  // and the sub-agents spawned from it, at any depth) shares it; separate root conversations never do.
  const ROOT_A = "11111111-1111-4111-8111-111111111111";
  const ROOT_B = "22222222-2222-4222-8222-222222222222";
  const CHILD_A1 = "sub-aa-33333333-3333-4333-8333-333333333333";
  const CHILD_A2 = "sub-ab-44444444-4444-4444-8444-444444444444";
  const GRANDCHILD_A1 = "sub-ac-55555555-5555-4555-8555-555555555555";
  const CHILD_B1 = "sub-ba-66666666-6666-4666-8666-666666666666";
  const SUBAGENT_ORIGINS: Record<string, string> = {
    [CHILD_A1]: ROOT_A, [CHILD_A2]: ROOT_A, [GRANDCHILD_A1]: CHILD_A1, [CHILD_B1]: ROOT_B,
  };
  it.each([
    { name: "a parent allow covers its sub-agent", recordedBy: ROOT_A, calledBy: CHILD_A1, permitted: true },
    { name: "a nested sub-agent allow covers the root conversation", recordedBy: GRANDCHILD_A1, calledBy: ROOT_A, permitted: true },
    { name: "a sub-agent allow covers its sibling within the same root", recordedBy: CHILD_A1, calledBy: CHILD_A2, permitted: true },
    { name: "a sub-agent allow never reaches another root conversation", recordedBy: CHILD_A1, calledBy: CHILD_B1, permitted: false },
    { name: "another root's allow never reaches this conversation", recordedBy: ROOT_B, calledBy: ROOT_A, permitted: false },
  ])("session approvals are keyed by root conversation: $name", async ({ recordedBy, calledBy, permitted }) => {
    setApprovalConversationRootResolver(createRootSessionResolver((id) => SUBAGENT_ORIGINS[id]));
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
    const loop: Record<string, string> = { [CHILD_A1]: CHILD_A2, [CHILD_A2]: CHILD_A1 };
    setApprovalConversationRootResolver(createRootSessionResolver((id) => loop[id]));
    await expect(recordApproval("write_probe", canonicalStringify({ path: join(dir, "x.txt") }), "builtin", {
      scope: "session",
      sessionId: CHILD_A1,
      verdictAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
      workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity,
    })).rejects.toThrow(/cycle/);
  });

  it("(d) approval under a different (trustOrigin, approvalCacheKey) does NOT match — modal shown", async () => {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));

    const permMgr = new PermissionManager(join(dir, "permissions.json"));

    // Recorded under approvalCacheKey "key-A". The invocation below carries no approvalCacheKey
    // and trustOrigin "user-keyboard", so the derived key differs → lookup misses → modal shown.
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
      // 7th parameter. Without it the executor builds its own logger under the real `aveHome()`; see the note in `beforeEach`.
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

    // Key dimensions are load-bearing; a mismatch is a miss → modal shown.
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
    wireJudgeForTest(manager);
    manager.setInteractiveAutoApprove("low");
    const cards: ApprovalRequest[] = [];
    const recordings: Promise<void>[] = [];
    const nativeWebContents = {
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
          }, nativeWebContents as never);
        })());
      },
    };
    const gate = new ApprovalGate(nativeWebContents as never);
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
