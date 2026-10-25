// Root removal must revoke plugin grants as well as chat, side-chat, and routine scopes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const {
  handlers,
  additionalDirectories,
  pendingWorkspaceRootRemovals,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  additionalDirectories: { value: [] as string[] },
  pendingWorkspaceRootRemovals: { value: [] as unknown[] },
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

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: {
      additionalDirectories: additionalDirectories.value,
      pendingWorkspaceRootRemovals: pendingWorkspaceRootRemovals.value,
    },
  }),
  addAllowedDirectoryPersist: vi.fn(async () => additionalDirectories.value),
  removeAllowedDirectoryPersist: vi.fn(async (dir: string) => {
    additionalDirectories.value = additionalDirectories.value.filter((d) => d !== dir);
    return additionalDirectories.value;
  }),
  beginWorkspaceRootRemovalPersist: vi.fn(async (target: string) => ({
    intent: {
      operationId: "op-1",
      storedPath: target,
      runtimePath: target,
      requestedAt: new Date().toISOString(),
      source: "test",
    },
    activeDirectories: additionalDirectories.value,
    created: true,
  })),
  completeWorkspaceRootRemovalPersist: vi.fn(async () => {
    additionalDirectories.value = [];
    return additionalDirectories.value;
  }),
}));

import { registerWorkspaceHandlers } from "../workspace.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import {
  createPluginSurfacePermissionScope,
  setActivePluginSurfacePermissionScope,
} from "../../../boot/plugin-surface-permissions.js";

const retireSandboxGrantsOutsideCeiling = vi.fn(async () => [] as string[]);
const deps = {
  auditLogger: { log: vi.fn() },
  pluginRuntime: { retireSandboxGrantsOutsideCeiling },
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

const OK_FRAME = "file:///app/index.html";

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return Promise.resolve(fn({ senderFrame: { url: OK_FRAME } } as never, ...args));
}

let root: string;
let granted: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ave-plugin-scope-revoke-"));
  granted = join(root, "reports");
  mkdirSync(granted, { recursive: true });
  registerWorkspaceHandlers(deps);
});

afterAll(async () => {
  setActivePluginSurfacePermissionScope(undefined);
  await cleanupTmpDir(root);
});

beforeEach(() => {
  additionalDirectories.value = [root];
  pendingWorkspaceRootRemovals.value = [];
  retireSandboxGrantsOutsideCeiling.mockReset().mockResolvedValue([]);
});

describe("workspace-root removal sweeps the plugin surface scope", () => {
  it("waits for sandbox retirement before acknowledging root removal", async () => {
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    retireSandboxGrantsOutsideCeiling.mockImplementationOnce(async () => {
      await stopped;
      return ["sandbox-candidate"];
    });
    let acknowledged = false;
    const removal = invoke(CHANNELS.workspace.removeRoot, root).then((result) => {
      acknowledged = true;
      return result as { ok: boolean };
    });
    await vi.waitFor(() => expect(retireSandboxGrantsOutsideCeiling).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    release();
    expect((await removal).ok).toBe(true);
  });

  it("drops a plugin's session grant under the removed root", async () => {
    const scope = createPluginSurfacePermissionScope({
      readPersistedDirectories: () => additionalDirectories.value,
    });
    setActivePluginSurfacePermissionScope(scope);

    const pluginContext = { origin: "ui" as const, ownerPluginId: "local-indexer" };
    scope
      .createPermissionContext(pluginContext, { headless: false, trustOrigin: "plugin-emitted" })
      .onSessionDirectoryGrant?.(granted);

    expect(
      scope
        .createPermissionContext(pluginContext, { headless: false, trustOrigin: "plugin-emitted" })
        .getAdditionalDirectories?.(),
    ).toContain(granted);

    const res = (await invoke(CHANNELS.workspace.removeRoot, root)) as { ok: boolean };
    expect(res.ok).toBe(true);

    expect(
      scope
        .createPermissionContext(pluginContext, { headless: false, trustOrigin: "plugin-emitted" })
        .getAdditionalDirectories?.(),
    ).not.toContain(granted);
  });

  it("keeps a grant under an independently registered descendant root", async () => {
    const preserved = join(root, "kept");
    mkdirSync(preserved, { recursive: true });
    additionalDirectories.value = [root, preserved];
    const scope = createPluginSurfacePermissionScope({
      readPersistedDirectories: () => additionalDirectories.value,
    });
    setActivePluginSurfacePermissionScope(scope);

    const pluginContext = { origin: "ui" as const, ownerPluginId: "meeting" };
    const context = scope.createPermissionContext(pluginContext, {
      headless: false,
      trustOrigin: "plugin-emitted",
    });
    context.onSessionDirectoryGrant?.(granted);
    context.onSessionDirectoryGrant?.(join(preserved, "notes"));

    await invoke(CHANNELS.workspace.removeRoot, root);

    const remaining = scope
      .createPermissionContext(pluginContext, { headless: false, trustOrigin: "plugin-emitted" })
      .getAdditionalDirectories?.() ?? [];
    expect(remaining).not.toContain(granted);
    expect(remaining).toContain(join(preserved, "notes"));
  });
});
