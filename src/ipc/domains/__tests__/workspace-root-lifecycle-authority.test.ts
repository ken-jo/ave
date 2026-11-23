import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

// Workspace root changes must reach child loops through the single published lifecycle authority.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { arrivalBeforeCompletion } from "../../../__tests__/support/arrival-before-completion.js";
import { deferred } from "../../../__tests__/support/deferred.js";
import { bindRemoteControllerToSession } from "../../../shared/chat-origin.js";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

import { registerWorkspaceHandlers } from "../workspace.js";
import { ConversationLoop } from "../../../engine/conversation-loop.js";
import { makeConversationLoopDeps } from "../../../engine/__tests__/conversation-loop-test-helpers.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { ApprovalGate, type ApprovalDecision } from "../../../permissions/approval-gate.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createDynamicTool } from "../../../tools/base.js";
import { readPermissionSettings } from "../../../permissions/permission-settings-store.js";
import { setWorkspaceRootLifecycle } from "../../../permissions/workspace-root-lifecycle.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../../../permissions/sensitive-paths.js";
import { makeMockWebContents } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { ensureAveHomePrivate } from "../../../shared/ave-home.js";
import { setFixtureOwner } from "../../../__tests__/support/fixture-owner.js";

const prunePathGrantsUnderRoot = vi.fn(async () => []);
const workspaceDeps = {
  auditLogger: { log: vi.fn() },
  pluginRuntime: { retireSandboxGrantsOutsideCeiling: vi.fn(async () => []) },
  getMainWindow: () => null,
  memoryManager: {
    sessions: {
      allowProjectRoot: vi.fn(),
      detachSessionsFromProject: vi.fn(async () => 0),
    },
  },
  conversationLoop: {
    deps: {},
    permissionManager: { prunePathGrantsUnderRoot },
    revokeWorkspaceRoot: () => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }),
  },
  routinesStore: {
    revokeWorkspaceRoot: async () => ({ routinesUpdated: 0, directoriesRemoved: 0 }),
  },
} as never;

function makeSubAgentShapedLoop(gate: ApprovalGate, executeSpy: (input: unknown) => Promise<string>) {
  const registry = new ToolRegistry();
  // Use a write tool to reach directory approval; reads do not share that confinement boundary.
  registry.register(createDynamicTool({
    name: "write_file",
    description: "Writes a file.",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    isReadOnly: () => false,
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => {
      const value = await executeSpy(rawInput);
      return { output: String(value), isError: false };
    },
  }));
  return new ConversationLoop(makeConversationLoopDeps({
    toolRegistry: registry,
    permissionManager: new PermissionManager(join(homeRoot, "permissions.json")),
    approvalGate: gate,
    auditLogger: audit,
  }));
}

async function firstApprovalPayload<T>(wc: ReturnType<typeof makeMockWebContents>): Promise<T> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const payload = wc.send.mock.calls[0]?.[1];
    if (payload) return payload as T;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("approval request was not sent");
}

let homeRoot: string;
let home: string;
let grantRoot: string;
let audit: AuditLogger;

beforeEach(async () => {
  homeRoot = mkdtempSync(join(tmpdir(), "ave-wsroot-authority-home-"));
  setFixtureOwner(homeRoot);
  home = join(homeRoot, ".ave");
  expect(ensureAveHomePrivate(home)).not.toMatchObject({ enforcement: "none" });
  vi.stubEnv("AVE_HOME", home);
  grantRoot = mkdtempSync(join(tmpdir(), "ave-wsroot-authority-grant-"));
  writeFileSync(join(grantRoot, "notes.md"), "content\n");
  audit = new AuditLogger(join(homeRoot, "audit"));
  await audit.setupPermissionAuditChain("aa".repeat(32));
  prunePathGrantsUnderRoot.mockReset().mockResolvedValue([]);
  registerWorkspaceHandlers(workspaceDeps);
});

afterEach(async () => {
  setWorkspaceRootLifecycle(undefined);
  vi.unstubAllEnvs();
  await audit.close();
  await cleanupTmpDir(homeRoot);
  await cleanupTmpDir(grantRoot);
});

function startDirectoryApproval(remote = true) {
  const sessionId = "directory-approval";
  let current = true;
  const refreshController = vi.fn(async () => current);
  const remoteControllerAuthority = remote ? bindRemoteControllerToSession({
    kind: "tailnet-controller",
    actorId: "tailnet:controller-digest",
    pairedShare: { pairingId: "pairing", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
    pairedShareGuard: { isCurrent: () => current, refreshCurrent: refreshController },
  }, sessionId) : undefined;
  const wc = makeMockWebContents();
  const gate = new ApprovalGate(wc as never);
  const execute = vi.fn(async () => "ok");
  const onTurnDirectoryGrant = vi.fn();
  const loop = makeSubAgentShapedLoop(gate, execute);
  const abort = new AbortController();
  const result = loop.toolExecutor.executeAll(
    [{ id: "directory-write", name: "write_file", input: { path: join(grantRoot, "notes.md") } }],
    {
      sessionId, executionCwd: homeRoot, abortSignal: abort.signal,
      permissionContext: {
        trustOrigin: remote ? "tailnet-surface" : "user-keyboard",
        remoteControllerAuthority, onTurnDirectoryGrant,
      },
    },
  );
  const answer = async (choice: ApprovalDecision["choice"]) => {
    const { id, nonce, hmac } = await firstApprovalPayload<{ id: string; nonce: string; hmac: string }>(wc);
    const accepted = await gate.resolveFromDesktopRendererWithFreshIdentity(id, {
      requestId: id, choice, nonce, hmac, ...(choice === "allow-always" ? { rememberPattern: grantRoot } : {}),
    }, wc as never);
    expect(accepted?.choice).toBe(choice);
    expect(accepted?.nonce).toBe(nonce);
  };
  return { answer, result, execute, gate, abort, onTurnDirectoryGrant, refreshController, revoke: () => { current = false; } };
}

function persistedRoots() {
  return readPermissionSettings().permissions.additionalDirectories.map(dir => caseFoldForMatch(canonicalizePathForMatch(dir)));
}

function holdGrantAudit(lifetime: "always" | "degraded-to-turn") {
  const arrived = deferred<void>();
  const release = deferred<void>();
  const append = audit.appendPermissionAuditEntry.bind(audit);
  const entries = vi.spyOn(audit, "appendPermissionAuditEntry").mockImplementation(async entry => {
    if ("grantLifetime" in entry && entry.grantLifetime === lifetime) {
      arrived.resolve();
      await release.promise;
    }
    return append(entry);
  });
  return { arrived, release, entries };
}

function expectRemoteDenial(entries: ReturnType<typeof holdGrantAudit>["entries"], reason: string) {
  const denials = entries.mock.calls.map(([entry]) => entry).filter(entry => entry.decision === "deny");
  expect(denials).toEqual([expect.objectContaining({
    decision: "deny", trustOrigin: "tailnet-surface", tool: "write_file",
    denyReasons: [expect.objectContaining({ reason })],
  })]);
}

describe("workspace-root lifecycle authority", () => {
  it.each(["revoke", "abort"] as const)("refuses a durable directory grant after %s during its audit", async interruption => {
    const { arrived, release, entries } = holdGrantAudit("always");
    const call = startDirectoryApproval();
    const waiting = arrivalBeforeCompletion(arrived.promise, call.result);
    try {
      await call.answer("allow-always");
      await waiting;
      if (interruption === "revoke") call.revoke();
      else call.abort.abort();
    } finally {
      release.resolve();
    }
    expect((await call.result)[0].is_error).toBe(true);
    expect(persistedRoots()).toEqual([]);
    expect(call.execute).not.toHaveBeenCalled();
    expectRemoteDenial(entries, interruption === "revoke" ? "remote-controller-revoked" : "user aborted turn");
  });

  it("refuses a durable directory grant revoked during cleanup under the workspace-root lock", async () => {
    const arrived = deferred<void>();
    const release = deferred<void>();
    prunePathGrantsUnderRoot.mockImplementationOnce(async () => {
      arrived.resolve();
      await release.promise;
      return [];
    });
    const entries = vi.spyOn(audit, "appendPermissionAuditEntry");
    const call = startDirectoryApproval();
    const waiting = arrivalBeforeCompletion(arrived.promise, call.result);
    try {
      await call.answer("allow-always");
      await waiting;
      call.revoke();
    } finally {
      release.resolve();
    }
    expect((await call.result)[0].is_error).toBe(true);
    expect(persistedRoots()).toEqual([]);
    expect(call.execute).not.toHaveBeenCalled();
    expectRemoteDenial(entries, "remote-controller-revoked");
  });

  it("keeps a desk denial accepted before controller revocation", async () => {
    const entries = vi.spyOn(audit, "appendPermissionAuditEntry");
    const call = startDirectoryApproval();
    const arrived = deferred<void>();
    const release = deferred<void>();
    const request = call.gate.requestAndWait.bind(call.gate);
    vi.spyOn(call.gate, "requestAndWait").mockImplementationOnce(async input => {
      const decision = await request(input);
      arrived.resolve();
      await release.promise;
      return decision;
    });
    const waiting = arrivalBeforeCompletion(arrived.promise, call.result);
    try {
      await call.answer("deny-once");
      await waiting;
      call.revoke();
    } finally {
      release.resolve();
    }
    expect((await call.result)[0].is_error).toBe(true);
    expect(persistedRoots()).toEqual([]);
    expect(call.execute).not.toHaveBeenCalled();
    expectRemoteDenial(entries, "This write requires approval.");
  });

  it("refuses the root if the fresh owner observation at the settings write fails", async () => {
    const entries = vi.spyOn(audit, "appendPermissionAuditEntry");
    const call = startDirectoryApproval();
    prunePathGrantsUnderRoot.mockImplementationOnce(async () => {
      call.refreshController.mockResolvedValueOnce(false);
      return [];
    });
    await call.answer("allow-always");
    expect((await call.result)[0].is_error).toBe(true);
    expect(persistedRoots()).toEqual([]);
    expect(call.execute).not.toHaveBeenCalled();
    expectRemoteDenial(entries, "remote-controller-revoked");
  });

  it("refuses to propagate a session grant to the turn after revocation during the fallback audit", async () => {
    const { arrived, release, entries } = holdGrantAudit("degraded-to-turn");
    const call = startDirectoryApproval();
    const waiting = arrivalBeforeCompletion(arrived.promise, call.result);
    try {
      await call.answer("allow-session");
      await waiting;
      call.revoke();
    } finally {
      release.resolve();
    }
    expect((await call.result)[0].is_error).toBe(true);
    expect(call.onTurnDirectoryGrant).not.toHaveBeenCalled();
    expect(persistedRoots()).toEqual([]);
    expect(call.execute).not.toHaveBeenCalled();
    expectRemoteDenial(entries, "remote-controller-revoked");
  });

  it.each([false, true])("persists an Allow Always directory grant while authorized (remote=%s)", async (remote) => {
    expect(handlers.size).toBeGreaterThan(0);
    const call = startDirectoryApproval(remote);
    await call.answer("allow-always");
    const results = await call.result;
    expect(results[0].content).not.toContain("workspace lifecycle unavailable");
    expect(results[0].is_error).toBeUndefined();
    expect(call.execute).toHaveBeenCalledOnce();
    expect(persistedRoots()).toContain(caseFoldForMatch(canonicalizePathForMatch(grantRoot)));
  });
});
