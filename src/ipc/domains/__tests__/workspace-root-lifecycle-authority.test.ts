import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

// Workspace root changes must reach child loops through the single published lifecycle authority.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";

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
import { ApprovalGate } from "../../../permissions/approval-gate.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createDynamicTool } from "../../../tools/base.js";
import { readPermissionSettings } from "../../../permissions/permission-settings-store.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../../../permissions/sensitive-paths.js";
import { makeMockWebContents } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { ensureAveHomePrivate } from "../../../shared/ave-home.js";
import { setFixtureOwner } from "../../../__tests__/support/fixture-owner.js";

const workspaceDeps = {
  auditLogger: { log: vi.fn() },
  pluginRuntime: { retireSandboxGrantsOutsideCeiling: vi.fn(async () => []) },
  getMainWindow: () => null,
  memoryManager: {
    allowProjectRoot: vi.fn(),
    detachSessionsFromProject: vi.fn(async () => 0),
  },
  conversationLoop: {
    deps: {},
    permissionManager: { prunePathGrantsUnderRoot: async () => [] },
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
    approvalGate: gate,
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
let previousHome: string | undefined;

beforeAll(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  previousHome = process.env.AVE_HOME;
  homeRoot = mkdtempSync(join(tmpdir(), "ave-wsroot-authority-home-"));
  setFixtureOwner(homeRoot);
  home = join(homeRoot, ".ave");
  expect(ensureAveHomePrivate(home)).not.toMatchObject({ enforcement: "none" });
  process.env.AVE_HOME = home;
  grantRoot = mkdtempSync(join(tmpdir(), "ave-wsroot-authority-grant-"));
  writeFileSync(join(grantRoot, "notes.md"), "content\n");
  registerWorkspaceHandlers(workspaceDeps);
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  await cleanupTmpDir(homeRoot);
  await cleanupTmpDir(grantRoot);
});

describe("workspace-root lifecycle authority", () => {
  it("registerWorkspaceHandlers reaches a sub-agent-shaped loop: allow-always persists the root", async () => {
    expect(handlers.size).toBeGreaterThan(0);
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const executeSpy = vi.fn(async () => "ok");
    const loop = makeSubAgentShapedLoop(gate, executeSpy);

    const callPromise = loop.toolExecutor.executeAll(
      [{
        id: "tu-subagent-allow-always",
        name: "write_file",
        input: { path: join(grantRoot, "notes.md") },
      }],
      {
        sessionId: "sess-subagent-allow-always",
        permissionContext: { trustOrigin: "user-keyboard" },
      },
    );

    const sent = await firstApprovalPayload<{
      id: string;
      nonce: string;
      hmac: string;
      outOfAllowedDir?: { suggestedParent?: string };
    }>(wc);
    gate.resolve(sent.id, {
      requestId: sent.id,
      choice: "allow-always",
      rememberPattern: sent.outOfAllowedDir?.suggestedParent,
      nonce: sent.nonce,
      hmac: sent.hmac,
    });

    const results = await callPromise;

    expect(results[0].content).not.toContain("workspace lifecycle unavailable");
    expect(results[0].is_error).toBeUndefined();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const persisted = readPermissionSettings().permissions.additionalDirectories
      .map((dir) => caseFoldForMatch(canonicalizePathForMatch(dir)));
    expect(persisted).toContain(caseFoldForMatch(canonicalizePathForMatch(grantRoot)));
  });
});
