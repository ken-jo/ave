import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { PLUGIN_SHELL_FRAME_URL } from "../../../__tests__/test-helpers.js";
import { makeAppIpcFrameInvoker } from "./test-helpers.js";

const {
  handlers,
  showOpenDialogMock,
  showItemInFolderMock,
  addAllowedDirectoryPersistMock,
  removeAllowedDirectoryPersistMock,
  beginWorkspaceRootRemovalPersistMock,
  completeWorkspaceRootRemovalPersistMock,
  additionalDirectories,
  pendingWorkspaceRootRemovals,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialogMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  addAllowedDirectoryPersistMock: vi.fn(async () => [] as string[]),
  removeAllowedDirectoryPersistMock: vi.fn(async (dir: string) => {
    additionalDirectories.value = additionalDirectories.value.filter((d) => d !== dir);
    return additionalDirectories.value;
  }),
  beginWorkspaceRootRemovalPersistMock: vi.fn(),
  completeWorkspaceRootRemovalPersistMock: vi.fn(),
  additionalDirectories: { value: [] as string[] },
  pendingWorkspaceRootRemovals: { value: [] as Array<{
    operationId: string;
    storedPath: string;
    runtimePath: string;
    requestedAt: string;
    source: string;
  }> },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: showOpenDialogMock },
  shell: { showItemInFolder: showItemInFolderMock },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: {
      additionalDirectories: additionalDirectories.value,
      pendingWorkspaceRootRemovals: pendingWorkspaceRootRemovals.value,
    },
  }),
  addAllowedDirectoryPersist: addAllowedDirectoryPersistMock,
  removeAllowedDirectoryPersist: removeAllowedDirectoryPersistMock,
  beginWorkspaceRootRemovalPersist: beginWorkspaceRootRemovalPersistMock,
  completeWorkspaceRootRemovalPersist: completeWorkspaceRootRemovalPersistMock,
}));

import { registerPreviewHandlers } from "../preview.js";
import { registerWorkspaceHandlers } from "../workspace.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { getWorkspaceRootLifecycle } from "../../../permissions/workspace-root-lifecycle.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../../../permissions/sensitive-paths.js";
import { ReadFileTool } from "../../../tools/file-tools.js";
import * as previewInput from "../../../tools/preview-document-input.js";

function withSandboxRuntime(value: unknown): never {
  return {
    ...(value as object),
    pluginRuntime: { retireSandboxGrantsOutsideCeiling: vi.fn(async () => []) },
  } as never;
}

const deps = {
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

const invoke = makeAppIpcFrameInvoker(handlers);

const OK_FRAME = "file:///app/index.html";
const EVIL_FRAME = "https://evil.example.com/x";
const PLUGIN_SHELL_FRAME = PLUGIN_SHELL_FRAME_URL;
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ave-ws-preview-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "architecture.md"), "# Architecture\n\nreal content\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01]));
  additionalDirectories.value = [root];
  registerPreviewHandlers(deps);
  registerWorkspaceHandlers(deps);
});
afterAll(async () => {
  await cleanupTmpDir(root);
});
beforeEach(() => {
  showOpenDialogMock.mockReset();
  showItemInFolderMock.mockReset();
  addAllowedDirectoryPersistMock.mockClear();
  removeAllowedDirectoryPersistMock.mockClear();
  beginWorkspaceRootRemovalPersistMock.mockReset();
  completeWorkspaceRootRemovalPersistMock.mockReset();
  additionalDirectories.value = [root];
  pendingWorkspaceRootRemovals.value = [];
  let operationSequence = 0;
  const key = (value: string) => caseFoldForMatch(canonicalizePathForMatch(value));
  beginWorkspaceRootRemovalPersistMock.mockImplementation(async (
    target: string,
    source: string,
  ) => {
    const existing = pendingWorkspaceRootRemovals.value.find(
      (intent) => key(intent.runtimePath) === key(target),
    );
    const storedPath = additionalDirectories.value.find(
      (candidate) => key(candidate) === key(target),
    );
    if (!storedPath) {
      return existing
        ? { intent: existing, activeDirectories: additionalDirectories.value, created: false }
        : null;
    }
    operationSequence += 1;
    const intent = existing ?? {
      operationId: `00000000-0000-4000-8000-${String(operationSequence).padStart(12, "0")}`,
      storedPath,
      runtimePath: target,
      requestedAt: new Date(0).toISOString(),
      source,
    };
    additionalDirectories.value = additionalDirectories.value.filter(
      (candidate) => key(candidate) !== key(target),
    );
    if (!existing) pendingWorkspaceRootRemovals.value.push(intent);
    return { intent, activeDirectories: additionalDirectories.value, created: !existing };
  });
  completeWorkspaceRootRemovalPersistMock.mockImplementation(async (operationId: string) => {
    const before = pendingWorkspaceRootRemovals.value.length;
    pendingWorkspaceRootRemovals.value = pendingWorkspaceRootRemovals.value.filter(
      (intent) => intent.operationId !== operationId,
    );
    return pendingWorkspaceRootRemovals.value.length !== before;
  });
});

describe("preview:read-file handler", () => {
  it("previews signature-verified images through the normal allowed-root read", async () => {
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6idAAAAAASUVORK5CYII=", "base64");
    const path = join(root, "source-image.dat");
    writeFileSync(path, image);
    expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, path)).toMatchObject({
      ok: true, path, bytes: image.length, image: { mimeType: "image/png", dataUrl: `data:image/png;base64,${image.toString("base64")}` },
    });
  });
  it("rechecks image scope after asynchronous reading before disclosing bytes", async () => {
    const path = join(root, "revoked-image.png");
    writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6idAAAAAASUVORK5CYII=", "base64"));
    const read = previewInput.readPreviewDocumentInput;
    const spy = vi.spyOn(previewInput, "readPreviewDocumentInput").mockImplementationOnce(async (...args) => {
      const bytes = await read(...args);
      additionalDirectories.value = [];
      return bytes;
    });
    try {
      expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, path)).toMatchObject({ ok: false, error: "path-not-allowed" });
    } finally { spy.mockRestore(); }
  });
  it("caps image bytes before returning a preview", async () => {
    const path = join(root, "large-image.png");
    const bytes = Buffer.alloc(2_000_001);
    bytes.set(Buffer.from("iVBORw0KGgo=", "base64"));
    writeFileSync(path, bytes);
    expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, path)).toMatchObject({ ok: false, error: "too-large" });
  });
  it("keeps image line references text-only and does not trust an image extension", async () => {
    const imagePath = join(root, "range-image.png");
    writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6idAAAAAASUVORK5CYII=", "base64"));
    expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, imagePath, { offset: 0, limit: 1 }))
      .toMatchObject({ ok: false, error: "binary-file" });
    const textPath = join(root, "not-image.png");
    writeFileSync(textPath, "plain source text");
    const text = await invoke(CHANNELS.preview.readFile, OK_FRAME, textPath) as Record<string, unknown>;
    expect(text).toMatchObject({ ok: true, content: "plain source text" });
    expect(text.image).toBeUndefined();
  });
  it("keeps image data behind sender and live allowed-root checks", async () => {
    const path = join(root, "scope-image.png");
    writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6idAAAAAASUVORK5CYII=", "base64"));
    expect(await invoke(CHANNELS.preview.readFile, EVIL_FRAME, path)).toMatchObject({ ok: false, error: "unauthorized" });
    additionalDirectories.value = [];
    expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, path)).toMatchObject({ ok: false, error: "path-not-allowed" });
  });

  it("reads the selected relative file window under an already allowed workspace root", async () => {
    const file = join(root, "range.txt");
    writeFileSync(file, Array.from({ length: 750 }, (_, index) => `source ${index + 1}`).join("\n"));
    const result = await invoke(CHANNELS.preview.readFile, OK_FRAME, "range.txt", { workspaceRoot: root, offset: 699, limit: 2 });
    expect(result).toMatchObject({ ok: true, content: "source 700\nsource 701", lineCount: 2, truncated: true });
  });
  it("does not let a workspace hint authorize an outside read", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-reference-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "unapproved contents");
      expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, "secret.txt", { workspaceRoot: outside, offset: 0, limit: 1 }))
        .toMatchObject({ ok: false, error: "path-not-allowed" });
    } finally { await cleanupTmpDir(outside); }
  });
  it("refuses malformed range options before reading", async () => {
    expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "docs", "architecture.md"), { offset: -1, limit: 2 }))
      .toMatchObject({ ok: false, error: "read-failed" });
    expect(await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "docs", "architecture.md"), { offset: 0, limit: 0 }))
      .toMatchObject({ ok: false, error: "read-failed" });
  });
  it.each([
    ["crlf", "alpha\r\nbeta\r\n", "alpha\r\nbeta"],
    ["mixed", "alpha\rbeta\r\ngamma\n", "alpha\rbeta\r\ngamma"],
  ])("shows the same lines as the %s file reader", async (label, source, content) => {
    const path = join(root, `${label}.txt`);
    writeFileSync(path, source);
    const preview = await invoke(CHANNELS.preview.readFile, OK_FRAME, path) as {
      ok: boolean;
      content?: string;
    };
    const read = await new ReadFileTool().execute({ path }, {
      cwd: root, extraAllowedDirectories: [], metadata: {},
    });
    expect(read.isError).toBe(false);
    expect(preview).toMatchObject({ ok: true, content });
    const readLines = read.output.split("\n").slice(1).map((line) => line.replace(/^ *\d+\t/, ""));
    expect(readLines).toEqual(content.split(/\r\n|\r|\n/));
  });

  it("reads a file inside an allowed project root", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
      content?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.content).toContain("real content");
  });

  it("rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, EVIL_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("rejects a glob pattern as not-a-file", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, "**/*architecture*.md")) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "not-a-file" });
  });

  it("hard-blocks a Layer 0 sensitive path", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(homedir(), ".ssh", "id_rsa"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "sensitive-path" });
  });

  it("rejects a path outside every allowed root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-ws-outside-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    additionalDirectories.value = []; // only cwd + ~/.ave remain in scope
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(outside, "secret.txt"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    await cleanupTmpDir(outside);
  });

  it("refuses a binary file", async () => {
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "bin.dat"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "binary-file" });
  });

  it("refuses a file over the text size cap (too-large, fail-closed)", async () => {
    // Reject oversized previews before buffering, using the read tool's shared byte cap.
    const big = join(root, "huge.txt");
    writeFileSync(big, "a".repeat(2_000_001));
    try {
      const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, big)) as {
        ok: boolean;
        error?: string;
        bytes?: number;
      };
      expect(res).toMatchObject({ ok: false, error: "too-large" });
      expect(res.bytes).toBeGreaterThan(2_000_000);
    } finally {
      rmSync(big, { force: true });
    }
  });

  it("rejects a symlink whose real target escapes the allowed root", async () => {
    // Resolve symlinks before authorization so an in-root link cannot expose an out-of-scope target.
    const outside = mkdtempSync(join(tmpdir(), "ave-ws-symlink-outside-"));
    writeFileSync(join(outside, "secret.txt"), "escaped secret");
    const link = join(root, "escape-link");
    symlinkSync(outside, link, dirLinkType);
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(link, "secret.txt"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    await cleanupTmpDir(link);
    await cleanupTmpDir(outside);
  });

  it("writes an audit entry for a successful preview read", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    log.mockClear();
    const res = (await invoke(CHANNELS.preview.readFile, OK_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining(CHANNELS.preview.readFile),
      }),
    );
  });
});

describe("workspace handlers", () => {
  it("listRoots returns the default root plus persisted additions", async () => {
    const res = (await invoke(CHANNELS.workspace.listRoots, OK_FRAME)) as {
      ok: boolean;
      defaultRoot?: string;
      roots?: Array<{ path: string; isDefault: boolean }>;
    };
    expect(res.ok).toBe(true);
    expect(res.defaultRoot).toBe(process.cwd());
    expect(res.roots?.[0]).toMatchObject({ path: process.cwd(), isDefault: true });
    expect(res.roots?.some((r) => !r.isDefault)).toBe(true);
  });


  it("listRoots prunes a confirmed missing project folder at runtime", async () => {
    const missingRoot = join(
      tmpdir(),
      `ave-missing-root-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    rmSync(missingRoot, { recursive: true, force: true });
    additionalDirectories.value = [missingRoot];

    const res = (await invoke(CHANNELS.workspace.listRoots, OK_FRAME)) as {
      ok: boolean;
      roots?: Array<{ path: string; isDefault: boolean }>;
    };

    expect(res.ok).toBe(true);
    expect(beginWorkspaceRootRemovalPersistMock).toHaveBeenCalledWith(
      missingRoot,
      "list-roots",
      undefined,
    );
    expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalledTimes(1);
    expect(res.roots?.some((entry) => entry.path === missingRoot)).toBe(false);
  });

  it("listRoots keeps a missing root inactive and pending when grant cleanup fails", async () => {
    const missingRoot = join(
      tmpdir(),
      `ave-missing-root-fail-closed-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    rmSync(missingRoot, { recursive: true, force: true });
    additionalDirectories.value = [missingRoot];
    const log = vi.fn();
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const detachSessionsFromProject = vi.fn(async () => 0);
    const lifecycleDeps = {
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: {
          prunePathGrantsUnderRoot: vi.fn(async () => {
            throw Object.assign(new Error("must-not-leak-list-path"), { code: "EIO" });
          }),
        },
        revokeWorkspaceRoot,
      },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({
          routinesUpdated: 0,
          directoriesRemoved: 0,
        })),
      },
    } as never;
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));

    try {
      const res = (await invoke(CHANNELS.workspace.listRoots, OK_FRAME)) as {
        ok: boolean;
        roots?: Array<{ path: string; isDefault: boolean }>;
        cleanupPending?: number;
      };
      expect(res.ok).toBe(true);
      expect(res.cleanupPending).toBe(1);
      expect(res.roots?.some((entry) => entry.path === missingRoot)).toBe(false);
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(revokeWorkspaceRoot).toHaveBeenCalled();
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      const warningPayloads = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string; output?: string })
        .filter((entry) => entry.type === "warn")
        .map((entry) => `${entry.input ?? ""}\n${entry.output ?? ""}`);
      expect(warningPayloads.some((payload) => payload.includes("cleanup-pending"))).toBe(true);
      expect(warningPayloads.join("\n")).not.toContain("must-not-leak-list-path");
      expect(warningPayloads.join("\n")).not.toContain(missingRoot);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("listDir lists entries inside an allowed root (dirs first)", async () => {
    const res = (await invoke(CHANNELS.workspace.listDir, OK_FRAME, root)) as {
      ok: boolean;
      entries?: Array<{ name: string; type: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.entries?.[0]).toMatchObject({ name: "docs", type: "directory" });
    expect(res.entries?.some((e) => e.name === "bin.dat" && e.type === "file")).toBe(true);
  });

  it("listDir rejects a path outside the allowed roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-ws-outside-list-"));
    additionalDirectories.value = [];
    const res = (await invoke(CHANNELS.workspace.listDir, OK_FRAME, outside)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    await cleanupTmpDir(outside);
  });

  it("pickRoot persists the chosen directory to additionalDirectories", async () => {
    const picked = mkdtempSync(join(tmpdir(), "ave-ws-picked-"));
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [picked] });
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
      ok: boolean;
      added?: string;
    };
    expect(res).toMatchObject({ ok: true, added: canonicalizePathForMatch(picked) });
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(picked));
    await cleanupTmpDir(picked);
  });

  it("central allow lifecycle rejects files and missing folders for picker/slash/Settings parity", async () => {
    const filePath = join(root, "not-a-workspace-root.txt");
    const missingPath = join(root, "missing-workspace-root");
    writeFileSync(filePath, "not a directory");
    const lifecycle = getWorkspaceRootLifecycle();

    try {
      expect(lifecycle).toBeDefined();
      await expect(
        lifecycle!.allowDirectory(filePath, "permission-slash"),
      ).rejects.toThrow("workspace-root-not-directory");
      await expect(
        lifecycle!.allowDirectory(missingPath, "permission-slash"),
      ).rejects.toThrow("workspace-root-not-found");
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  it("treats picking an already-registered root as a no-op without pruning grants or routine scopes", async () => {
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: { permissionManager: { prunePathGrantsUnderRoot: prunePathGrants } },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));

    try {
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
        ok: boolean;
        added?: string;
      };
      expect(res).toMatchObject({ ok: true, added: canonicalizePathForMatch(root) });
      expect(prunePathGrants).not.toHaveBeenCalled();
      expect(pruneRoutineScopes).not.toHaveBeenCalled();
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([root]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("pre-cleans stale grants and routine scopes before persisting a genuine add", async () => {
    const picked = mkdtempSync(join(tmpdir(), "ave-ws-readd-"));
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
      },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [picked] });
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));

    try {
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
        ok: boolean;
        added?: string;
      };
      const canonical = canonicalizePathForMatch(picked);
      expect(res).toMatchObject({ ok: true, added: canonical });
      expect(prunePathGrants).toHaveBeenCalledWith(canonical, {
        preserveRoots: [],
      });
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonical, {
        preserveRoots: [],
      });
      expect(prunePathGrants.mock.invocationCallOrder[0]).toBeLessThan(
        addAllowedDirectoryPersistMock.mock.invocationCallOrder[0]!,
      );
      expect(pruneRoutineScopes.mock.invocationCallOrder[0]).toBeLessThan(
        addAllowedDirectoryPersistMock.mock.invocationCallOrder[0]!,
      );
    } finally {
      registerWorkspaceHandlers(deps);
      await cleanupTmpDir(picked);
    }
  });

  it("pre-cleans a parent re-add without pruning a registered child project", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "ave-ws-readd-parent-"));
    const childRoot = join(parentRoot, "child");
    mkdirSync(childRoot);
    additionalDirectories.value = [childRoot];
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
      },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never);
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [parentRoot] });

    try {
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
        ok: boolean;
        added?: string;
      };
      const canonicalParent = canonicalizePathForMatch(parentRoot);
      const canonicalChild = canonicalizePathForMatch(childRoot);
      const pruneOptions = { preserveRoots: [canonicalChild] };
      expect(res).toMatchObject({ ok: true, added: canonicalParent });
      expect(prunePathGrants).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalParent);
    } finally {
      registerWorkspaceHandlers(deps);
      await cleanupTmpDir(parentRoot);
    }
  });

  it("pickRoot returns canceled without persisting when the dialog is dismissed", async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ok: boolean; canceled?: boolean };
    expect(res).toMatchObject({ ok: true, canceled: true });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("pickRoot does NOT persist an adjacency-warned path until it is acknowledged (token flow)", async () => {
    // Git-adjacent roots require one-time token confirmation before entering the read scope.
    const base = mkdtempSync(join(tmpdir(), "ave-ws-warn-"));
    const warnDir = join(base, ".git");
    mkdirSync(warnDir);
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [warnDir] });

    const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as {
      ok: boolean;
      requiresAcknowledgement?: boolean;
      pendingPath?: string;
      ackToken?: string;
      warnings?: string[];
      added?: string;
    };
    expect(first.ok).toBe(true);
    expect(first.requiresAcknowledgement).toBe(true);
    expect(first.pendingPath).toBe(warnDir);
    expect(typeof first.ackToken).toBe("string");
    expect((first.ackToken ?? "").length).toBeGreaterThan(0);
    expect((first.warnings ?? []).length).toBeGreaterThan(0);
    expect(first.added).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

    showOpenDialogMock.mockClear();
    const second = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: first.ackToken })) as {
      ok: boolean;
      added?: string;
    };
    expect(second).toMatchObject({ ok: true, added: canonicalizePathForMatch(warnDir) });
    expect(showOpenDialogMock).not.toHaveBeenCalled();
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(warnDir));

    await cleanupTmpDir(base);
  });

  it("pickRoot REFUSES an ack token that was never issued by a dialog pick (forged/unknown)", async () => {
    // Only a pending main-owned token can confirm a root; renderer paths cannot forge approval.
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, {
      ackToken: "forged-token-never-minted",
    })) as { ok: boolean; error?: string; added?: string };
    expect(res).toMatchObject({ ok: false, error: "ack-unknown" });
    expect(res.added).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    expect(showOpenDialogMock).not.toHaveBeenCalled();
  });

  it("pickRoot is a ONE-TIME token — a replayed token is refused after first use", async () => {
    const base = mkdtempSync(join(tmpdir(), "ave-ws-replay-"));
    const warnDir = join(base, ".git");
    mkdirSync(warnDir);
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [warnDir] });

    const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ackToken?: string };
    const token = first.ackToken;
    const ok = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      added?: string;
    };
    expect(ok).toMatchObject({ ok: true, added: canonicalizePathForMatch(warnDir) });

    addAllowedDirectoryPersistMock.mockClear();
    const replay = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      error?: string;
    };
    expect(replay).toMatchObject({ ok: false, error: "ack-unknown" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

    await cleanupTmpDir(base);
  });

  it("pickRoot REFUSES an expired ack token (TTL elapsed)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = mkdtempSync(join(tmpdir(), "ave-ws-expire-"));
      const warnDir = join(base, ".git");
      mkdirSync(warnDir);
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [warnDir] });

      const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ackToken?: string };
      const token = first.ackToken;

      vi.setSystemTime(Date.now() + 61_000);
      addAllowedDirectoryPersistMock.mockClear();
      const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
        ok: boolean;
        error?: string;
        added?: string;
      };
      expect(res).toMatchObject({ ok: false, error: "ack-expired" });
      expect(res.added).toBeUndefined();
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

      await cleanupTmpDir(base);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pickRoot audits the allow-list widening on a successful persist", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    log.mockClear();
    const picked = mkdtempSync(join(tmpdir(), "ave-ws-audit-"));
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [picked] });
    const res = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME)) as { ok: boolean; added?: string };
    expect(res).toMatchObject({ ok: true, added: canonicalizePathForMatch(picked) });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining(CHANNELS.workspace.pickRoot),
      }),
    );
    await cleanupTmpDir(picked);
  });

  it("listDir omits Layer 0 sensitive entries inside an allowed root", async () => {
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const res = (await invoke(CHANNELS.workspace.listDir, OK_FRAME, root)) as {
      ok: boolean;
      entries?: Array<{ name: string }>;
    };
    expect(res.ok).toBe(true);
    expect(res.entries?.some((e) => e.name === ".env")).toBe(false);
    rmSync(join(root, ".env"), { force: true });
  });

  it("removeRoot removes an additional root and audits the shrink", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    log.mockClear();
    const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
      ok: boolean;
      removed?: string;
      roots?: Array<{ path: string; isDefault: boolean }>;
    };
    expect(res).toMatchObject({ ok: true, removed: root });
    expect(beginWorkspaceRootRemovalPersistMock).toHaveBeenCalledWith(
      canonicalizePathForMatch(root),
      CHANNELS.workspace.removeRoot,
      undefined,
    );
    expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalledTimes(1);
    expect(res.roots?.some((r) => r.path === root)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining(CHANNELS.workspace.removeRoot),
      }),
    );
  });

  it("removes a parent project while preserving a separately registered child root", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "ave-ws-nested-parent-"));
    const childRoot = join(parentRoot, "child");
    mkdirSync(childRoot);
    const canonicalParent = canonicalizePathForMatch(parentRoot);
    const canonicalChild = canonicalizePathForMatch(childRoot);
    additionalDirectories.value = [parentRoot, childRoot];
    const prunePathGrants = vi.fn(async () => []);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const routineRevokeWorkspaceRoot = vi.fn(() => ({
      activeLoopsVisited: 0,
      liveScopesRevoked: 0,
    }));
    const detachSessionsFromProject = vi.fn(async () => 1);
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevokeWorkspaceRoot },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never);

    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, parentRoot)) as {
        ok: boolean;
        roots?: Array<{ path: string; isDefault: boolean }>;
      };
      const pruneOptions = { preserveRoots: [canonicalChild] };
      const liveOptions = {
        globalScopeWasAuthorized: true,
        preserveRoots: [canonicalChild],
      };
      expect(res.ok).toBe(true);
      expect(additionalDirectories.value).toEqual([childRoot]);
      expect(res.roots?.some((entry) => entry.path === canonicalChild)).toBe(true);
      expect(prunePathGrants).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonicalParent, pruneOptions);
      expect(revokeWorkspaceRoot).toHaveBeenCalledWith(canonicalParent, liveOptions);
      expect(routineRevokeWorkspaceRoot).toHaveBeenCalledWith(canonicalParent, liveOptions);
      expect(detachSessionsFromProject).toHaveBeenCalledWith(canonicalParent);
      expect(detachSessionsFromProject).not.toHaveBeenCalledWith(canonicalChild);
    } finally {
      registerWorkspaceHandlers(deps);
      await cleanupTmpDir(parentRoot);
    }
  });


  it("cuts over, revokes live scope, prunes durable scope, detaches sessions, then completes", async () => {
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 1,
      turnDirectoriesRemoved: 1,
      projectRebound: true,
    }));
    const routineRevokeWorkspaceRoot = vi.fn(() => ({
      activeLoopsVisited: 1,
      liveScopesRevoked: 3,
    }));
    const subAgentRevokeWorkspaceRoot = vi.fn(() => ({
      activeChildrenVisited: 2,
      liveScopesRevoked: 4,
    }));
    const subAgentDetachSessionsFromProject = vi.fn(async () => 1);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 1,
      directoriesRemoved: 2,
    }));
    const detachSessionsFromProject = vi.fn(async () => 2);
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: {
        allowProjectRoot: vi.fn(),
        detachSessionsFromProject,
      },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
        revokeWorkspaceRoot,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevokeWorkspaceRoot },
      getSubAgentRunner: () => ({
        detachSessionsFromProject: subAgentDetachSessionsFromProject,
        revokeWorkspaceRoot: subAgentRevokeWorkspaceRoot,
      }),
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
      };
      expect(res.ok).toBe(true);
      const canonical = canonicalizePathForMatch(root);
      const liveOptions = {
        globalScopeWasAuthorized: true,
        preserveRoots: [],
      };
      expect(revokeWorkspaceRoot).toHaveBeenCalledWith(canonical, liveOptions);
      expect(routineRevokeWorkspaceRoot).toHaveBeenCalledWith(canonical, liveOptions);
      expect(subAgentRevokeWorkspaceRoot).toHaveBeenCalledWith(canonical, liveOptions);
      expect(pruneRoutineScopes).toHaveBeenCalledWith(canonical, {
        preserveRoots: [],
      });
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(detachSessionsFromProject).toHaveBeenCalledWith(canonicalizePathForMatch(root));
      expect(beginWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]).toBeLessThan(
        revokeWorkspaceRoot.mock.invocationCallOrder[0]!,
      );
      expect(revokeWorkspaceRoot.mock.invocationCallOrder[0]).toBeLessThan(
        pruneRoutineScopes.mock.invocationCallOrder[0]!,
      );
      expect(pruneRoutineScopes.mock.invocationCallOrder[0]).toBeLessThan(
        detachSessionsFromProject.mock.invocationCallOrder[0]!,
      );
      expect(subAgentDetachSessionsFromProject.mock.invocationCallOrder[0]).toBeLessThan(
        completeWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]!,
      );
      expect(detachSessionsFromProject.mock.invocationCallOrder[0]).toBeLessThan(
        completeWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]!,
      );
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("attempts every live owner, keeps revoke failures pending, and completes on retry", async () => {
    const mainRevoke = vi.fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("main owner revoke failed"), { code: "EIO" });
      })
      .mockReturnValue({
        sessionDirectoriesRemoved: 1,
        turnDirectoriesRemoved: 0,
        projectRebound: false,
      });
    const sideRevoke = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 1,
      projectRebound: false,
    }));
    const routineRevoke = vi.fn(() => ({
      activeLoopsVisited: 1,
      liveScopesRevoked: 1,
    }));
    const subAgentRevoke = vi.fn(() => ({
      activeChildrenVisited: 1,
      liveScopesRevoked: 1,
    }));
    const primaryDetach = vi.fn(async () => 1);
    const sideDetach = vi.fn(async () => 1);
    const subAgentDetach = vi.fn(async () => 1);
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const prunePathGrants = vi.fn(async () => []);
    const subAgentRunner = {
      detachSessionsFromProject: subAgentDetach,
      revokeWorkspaceRoot: subAgentRevoke,
    };
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject: primaryDetach },
      conversationLoop: {
        deps: {},
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot: mainRevoke,
      },
      sideChatConversationLoop: {
        deps: { memoryManager: { detachSessionsFromProject: sideDetach } },
        revokeWorkspaceRoot: sideRevoke,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevoke },
      getSubAgentRunner: () => subAgentRunner,
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));

    try {
      const first = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };

      expect(first).toMatchObject({ ok: true, cleanupPending: true });
      expect(mainRevoke).toHaveBeenCalledTimes(1);
      expect(sideRevoke).toHaveBeenCalledTimes(1);
      expect(routineRevoke).toHaveBeenCalledTimes(1);
      expect(subAgentRevoke).toHaveBeenCalledTimes(1);
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(prunePathGrants).toHaveBeenCalledTimes(1);
      expect(primaryDetach).toHaveBeenCalledTimes(1);
      expect(sideDetach).toHaveBeenCalledTimes(1);
      expect(subAgentDetach).toHaveBeenCalledTimes(1);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(completeWorkspaceRootRemovalPersistMock).not.toHaveBeenCalled();

      const second = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };

      expect(second).toMatchObject({ ok: true });
      expect(second.cleanupPending).toBeUndefined();
      expect(mainRevoke).toHaveBeenCalledTimes(2);
      expect(sideRevoke).toHaveBeenCalledTimes(2);
      expect(routineRevoke).toHaveBeenCalledTimes(2);
      expect(subAgentRevoke).toHaveBeenCalledTimes(2);
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(2);
      expect(prunePathGrants).toHaveBeenCalledTimes(2);
      expect(primaryDetach).toHaveBeenCalledTimes(2);
      expect(sideDetach).toHaveBeenCalledTimes(2);
      expect(subAgentDetach).toHaveBeenCalledTimes(2);
      expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalledTimes(1);
      expect(pendingWorkspaceRootRemovals.value).toEqual([]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it.each([
    ["undefined", undefined],
    ["NaN direct count", { liveScopesRevoked: Number.NaN }],
    ["incomplete directory counts", { sessionDirectoriesRemoved: 1 }],
  ])("keeps malformed %s live revoke results pending after attempting every phase", async (_label, result) => {
    const log = vi.fn();
    const mainRevoke = vi.fn(() => result);
    const sideRevoke = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const routineRevoke = vi.fn(() => ({
      activeLoopsVisited: 0,
      liveScopesRevoked: 0,
    }));
    const subAgentRevoke = vi.fn(() => ({
      activeChildrenVisited: 0,
      liveScopesRevoked: 0,
    }));
    const pruneRoutineScopes = vi.fn(async () => ({
      routinesUpdated: 0,
      directoriesRemoved: 0,
    }));
    const prunePathGrants = vi.fn(async () => []);
    const detachSessionsFromProject = vi.fn(async () => 0);
    registerWorkspaceHandlers({
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        deps: {},
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot: mainRevoke,
      },
      sideChatConversationLoop: {
        deps: {},
        revokeWorkspaceRoot: sideRevoke,
      },
      routineEngine: { revokeWorkspaceRoot: routineRevoke },
      getSubAgentRunner: () => ({
        detachSessionsFromProject: vi.fn(async () => 0),
        revokeWorkspaceRoot: subAgentRevoke,
      }),
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never);

    try {
      const response = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };

      expect(response).toMatchObject({ ok: true, cleanupPending: true });
      expect(mainRevoke).toHaveBeenCalledTimes(1);
      expect(sideRevoke).toHaveBeenCalledTimes(1);
      expect(routineRevoke).toHaveBeenCalledTimes(1);
      expect(subAgentRevoke).toHaveBeenCalledTimes(1);
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(prunePathGrants).toHaveBeenCalledTimes(1);
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      expect(completeWorkspaceRootRemovalPersistMock).not.toHaveBeenCalled();
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      const warning = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string })
        .find((entry) =>
          entry.type === "warn" &&
          entry.input?.includes("WORKSPACE_ROOT_LIVE_SCOPE_REVOKE_INVALID_RESULT")
        );
      expect(warning).toBeDefined();
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("serializes same-root removal side effects before a concurrent re-add", async () => {
    let signalPruneStarted!: () => void;
    let releasePruneGate!: () => void;
    let released = false;
    const pruneStarted = new Promise<void>((resolve) => {
      signalPruneStarted = resolve;
    });
    const pruneGate = new Promise<void>((resolve) => {
      releasePruneGate = resolve;
    });
    const releasePrune = () => {
      if (released) return;
      released = true;
      releasePruneGate();
    };
    let pruneCalls = 0;
    const pruneRoutineScopes = vi.fn(async () => {
      pruneCalls += 1;
      if (pruneCalls === 1) signalPruneStarted();
      await pruneGate;
      return { routinesUpdated: 0, directoriesRemoved: 0 };
    });
    const lifecycleDeps = {
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject: vi.fn(async () => 0) },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
      },
      routinesStore: { revokeWorkspaceRoot: pruneRoutineScopes },
    } as never;
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));

    try {
      const removePromise = invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root) as Promise<{
        ok: boolean;
        removed?: string;
      }>;
      await pruneStarted;

      const pickPromise = invoke(CHANNELS.workspace.pickRoot, OK_FRAME) as Promise<{
        ok: boolean;
        added?: string;
      }>;
      await vi.waitFor(() => expect(showOpenDialogMock).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();

      releasePrune();
      const [removed, picked] = await Promise.all([removePromise, pickPromise]);

      expect(removed).toMatchObject({ ok: true, removed: root });
      expect(picked).toMatchObject({ ok: true, added: canonicalizePathForMatch(root) });
      expect(beginWorkspaceRootRemovalPersistMock).toHaveBeenCalled();
      expect(completeWorkspaceRootRemovalPersistMock).toHaveBeenCalled();
      expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(root));
      expect(completeWorkspaceRootRemovalPersistMock.mock.invocationCallOrder[0]).toBeLessThan(
        addAllowedDirectoryPersistMock.mock.invocationCallOrder[0]!,
      );
    } finally {
      releasePrune();
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps removal inactive and pending when durable routine scope prune fails", async () => {
    const log = vi.fn();
    const pruneError = Object.assign(new Error("must-not-leak-path"), { code: "EACCES" });
    const prunePathGrants = vi.fn(async () => []);
    const detachSessionsFromProject = vi.fn(async () => 0);
    const pruneRoutineScopes = vi.fn(async () => {
      throw pruneError;
    });
    const lifecycleDeps = {
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: prunePathGrants },
        revokeWorkspaceRoot: vi.fn(() => ({
          sessionDirectoriesRemoved: 0,
          turnDirectoriesRemoved: 0,
          projectRebound: false,
        })),
      },
      routinesStore: {
        revokeWorkspaceRoot: pruneRoutineScopes,
      },
    } as never;
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({
        ok: true,
        cleanupPending: true,
      });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(completeWorkspaceRootRemovalPersistMock).not.toHaveBeenCalled();
      expect(pruneRoutineScopes).toHaveBeenCalledTimes(1);
      expect(prunePathGrants).toHaveBeenCalledTimes(1);
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      const warning = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string })
        .find((entry) => entry.type === "warn" && entry.input?.includes("prune-routine-scopes"));
      expect(warning).toBeDefined();
      expect(JSON.parse(warning!.input!)).toMatchObject({
        lifecyclePhase: "prune-routine-scopes",
        errorCode: "EACCES",
      });
      expect(warning!.input).not.toContain("must-not-leak-path");
      expect(JSON.stringify(res)).not.toContain("must-not-leak-path");
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });
  it("revokes live scope and leaves cleanup pending when path-grant pruning fails", async () => {
    const log = vi.fn();
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const detachSessionsFromProject = vi.fn(async () => 0);
    const pruneError = Object.assign(new Error("must-not-leak-grant-path"), {
      code: "EIO",
    });
    const lifecycleDeps = {
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject },
      conversationLoop: {
        permissionManager: {
          prunePathGrantsUnderRoot: vi.fn(async () => {
            throw pruneError;
          }),
        },
        revokeWorkspaceRoot,
      },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({
          routinesUpdated: 0,
          directoriesRemoved: 0,
        })),
      },
    } as never;
    registerWorkspaceHandlers(withSandboxRuntime(lifecycleDeps));

    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({
        ok: true,
        cleanupPending: true,
      });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(revokeWorkspaceRoot).toHaveBeenCalled();
      expect(detachSessionsFromProject).toHaveBeenCalledTimes(1);
      const warning = log.mock.calls
        .map(([entry]) => entry as { type?: string; input?: string })
        .find((entry) => entry.type === "warn" && entry.input?.includes("prune-path-grants"));
      expect(warning).toBeDefined();
      expect(JSON.parse(warning!.input!)).toMatchObject({
        lifecyclePhase: "prune-path-grants",
        errorCode: "EIO",
      });
      expect(warning!.input).not.toContain("must-not-leak-grant-path");
      expect(JSON.stringify(res)).not.toContain("must-not-leak-grant-path");
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps guards and pending intent when session metadata detach fails", async () => {
    const allowProjectRoot = vi.fn();
    const detachSessionsFromProject = vi.fn(async () => {
      throw Object.assign(new Error("must-not-leak-metadata-path"), { code: "EIO" });
    });
    const revokeWorkspaceRoot = vi.fn(() => ({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    }));
    const log = vi.fn();
    registerWorkspaceHandlers({
      auditLogger: { log },
      getMainWindow: () => null,
      memoryManager: { allowProjectRoot, detachSessionsFromProject },
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
        revokeWorkspaceRoot,
      },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({
          routinesUpdated: 0,
          directoriesRemoved: 0,
        })),
      },
    } as never);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({ ok: true, cleanupPending: true });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
      expect(pendingWorkspaceRootRemovals.value).toHaveLength(1);
      expect(revokeWorkspaceRoot).toHaveBeenCalled();
      expect(allowProjectRoot).not.toHaveBeenCalled();
      expect(JSON.stringify(res)).not.toContain("must-not-leak-metadata-path");
      expect(JSON.stringify(log.mock.calls)).not.toContain("must-not-leak-metadata-path");
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });


  it("removeRoot REFUSES the default root (cwd) — it is not a removable addition", async () => {
    const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, process.cwd())) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "cannot-remove-default" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("removeRoot REFUSES a path that is not in the allow-list (no arbitrary removal)", async () => {
    const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, join(tmpdir(), "never-added-xyz"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "not-an-additional-root" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("removeRoot rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.workspace.removeRoot, EVIL_FRAME, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("#1493 removeRoot prunes path grants under the root and reports the count", async () => {
    // The prune path returns grant tuples for redacted audit; IPC still exposes only the count.
    const prunedTuples = [
      { pattern: "write_file:path:/ws/a.md", toolName: "write_file", tier: "write" as const, path: "/ws/a.md" },
      { pattern: "edit_file:path:/ws/b.ts", toolName: "edit_file", tier: "write" as const, path: "/ws/b.ts" },
      { pattern: "delete_file:path:/ws/c.log", toolName: "delete_file", tier: "read" as const, path: "/ws/c.log" },
    ];
    const prune = vi.fn(async () => prunedTuples);
    const auditLog = vi.fn();
    const depsWithPm = {
      auditLogger: { log: auditLog },
      getMainWindow: () => null,
      memoryManager: { detachSessionsFromProject: vi.fn(async () => 0) },
      conversationLoop: { permissionManager: { prunePathGrantsUnderRoot: prune } },
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({ routinesUpdated: 0, directoriesRemoved: 0 })),
      },
    } as never;
    registerWorkspaceHandlers(depsWithPm);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        prunedGrants?: number;
      };
      expect(res).toMatchObject({ ok: true, prunedGrants: 3 });
      expect(prune).toHaveBeenCalledWith(canonicalizePathForMatch(root), {
        preserveRoots: [],
      });
      const infoEntry = auditLog.mock.calls
        .map((c) => c[0] as { type: string; input: string })
        .find((entry) => entry.type === "info" && entry.input.includes(CHANNELS.workspace.removeRoot));
      expect(infoEntry).toBeTruthy();
      const parsed = JSON.parse(infoEntry!.input) as {
        prunedGrants: number;
        prunedPatterns?: Array<{ tool: string; tier: string; path: string }>;
      };
      expect(parsed.prunedGrants).toBe(3);
      expect(parsed.prunedPatterns).toHaveLength(3);
      expect(parsed.prunedPatterns![0]).toMatchObject({ tool: "write_file", tier: "write" });
      expect(JSON.stringify(res)).not.toContain("write_file:path:");
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps removal pending when the permission manager is unavailable", async () => {
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      routinesStore: {
        revokeWorkspaceRoot: vi.fn(async () => ({ routinesUpdated: 0, directoriesRemoved: 0 })),
      },
    } as never);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({ ok: true, cleanupPending: true });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("keeps removal pending when the routines store is unavailable", async () => {
    registerWorkspaceHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      conversationLoop: {
        permissionManager: { prunePathGrantsUnderRoot: vi.fn(async () => []) },
      },
    } as never);
    try {
      const res = (await invoke(CHANNELS.workspace.removeRoot, OK_FRAME, root)) as {
        ok: boolean;
        cleanupPending?: boolean;
      };
      expect(res).toMatchObject({ ok: true, cleanupPending: true });
      expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
      expect(additionalDirectories.value).toEqual([]);
    } finally {
      registerWorkspaceHandlers(deps);
    }
  });

  it("reveal shows a scope-checked file's location and never the raw renderer path", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(root, "docs", "architecture.md"))) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect(showItemInFolderMock).toHaveBeenCalledTimes(1);
    const [arg] = showItemInFolderMock.mock.calls[0] as [string];
    expect(arg.endsWith(join("docs", "architecture.md"))).toBe(true);
  });

  it("reveal reveals a directory too (guard allows dirs)", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(root, "docs"))) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(showItemInFolderMock).toHaveBeenCalledTimes(1);
  });

  it("reveal rejects a path outside the allowed roots (never touches the shell)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-ws-reveal-outside-"));
    writeFileSync(join(outside, "secret.txt"), "nope");
    additionalDirectories.value = [];
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(outside, "secret.txt"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
    await cleanupTmpDir(outside);
  });

  it("reveal hard-blocks a Layer 0 sensitive path", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, OK_FRAME, join(homedir(), ".ssh", "id_rsa"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "sensitive-path" });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it("reveal rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, EVIL_FRAME, join(root, "docs"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });
});

describe("workspace:drop-prepare handler (#1458 drag-drop add-root)", () => {
  it("rejects an unauthorized sender frame (fail-closed)", async () => {
    const res = (await invoke(CHANNELS.workspace.dropPrepare, EVIL_FRAME, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string / empty path (invalid-path)", async () => {
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, "")) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "invalid-path" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("mints a MAIN-OWNED ack token for a valid dropped folder and NEVER persists directly", async () => {
    // Dropped paths always require acknowledgment because no native dialog vouched for them.
    const dropped = mkdtempSync(join(tmpdir(), "ave-ws-drop-"));
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as {
      ok: boolean;
      pendingPath?: string;
      ackToken?: string;
      added?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.pendingPath).toBe(dropped);
    expect(typeof res.ackToken).toBe("string");
    expect((res.ackToken ?? "").length).toBeGreaterThan(0);
    expect((res as { added?: string }).added).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    await cleanupTmpDir(dropped);
  });

  it("HARD-DENIES a Layer 0 sensitive dropped path and mints NO token", async () => {
    // Reject sensitive dropped paths before minting a token, using a stable localized error code.
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, join(homedir(), ".ssh"))) as {
      ok: boolean;
      error?: string;
      ackToken?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "sensitive-path" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("REFUSES the filesystem root (hard deny, no token)", async () => {
    const fsRoot = process.platform === "win32" ? "C:\\" : "/";
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, fsRoot)) as {
      ok: boolean;
      error?: string;
      ackToken?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "path-not-allowed" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("rejects a dropped FILE (not-a-dir — the renderer never guesses a parent)", async () => {
    const base = mkdtempSync(join(tmpdir(), "ave-ws-dropfile-"));
    const file = join(base, "note.txt");
    writeFileSync(file, "hi");
    const res = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, file)) as {
      ok: boolean;
      error?: string;
      ackToken?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "not-a-dir" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    await cleanupTmpDir(base);
  });

  it("rejects a non-existent dropped path (not-found)", async () => {
    const res = (await invoke(
      CHANNELS.workspace.dropPrepare,
      OK_FRAME,
      join(tmpdir(), "ave-ws-does-not-exist-xyz"),
    )) as { ok: boolean; error?: string; ackToken?: string };
    expect(res).toMatchObject({ ok: false, error: "not-found" });
    expect(res.ackToken).toBeUndefined();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("drop → dropPrepare → pickRoot(token) persists the folder and audits gesture=drop", async () => {
    const log = (deps as unknown as { auditLogger: { log: ReturnType<typeof vi.fn> } }).auditLogger.log;
    const dropped = mkdtempSync(join(tmpdir(), "ave-ws-drop-flow-"));
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as {
      ok: boolean;
      ackToken?: string;
    };
    expect(prep.ok).toBe(true);
    log.mockClear();
    addAllowedDirectoryPersistMock.mockClear();
    const done = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: prep.ackToken })) as {
      ok: boolean;
      added?: string;
    };
    expect(done).toMatchObject({ ok: true, added: canonicalizePathForMatch(dropped) });
    expect(addAllowedDirectoryPersistMock).toHaveBeenCalledWith(canonicalizePathForMatch(dropped));
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        input: expect.stringContaining('"gesture":"drop"'),
      }),
    );
    await cleanupTmpDir(dropped);
  });

  it("a drop ack token is ONE-TIME — a replay is refused after first use", async () => {
    const dropped = mkdtempSync(join(tmpdir(), "ave-ws-drop-replay-"));
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as { ackToken?: string };
    const token = prep.ackToken;
    const first = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      added?: string;
    };
    expect(first).toMatchObject({ ok: true, added: canonicalizePathForMatch(dropped) });
    addAllowedDirectoryPersistMock.mockClear();
    const replay = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: token })) as {
      ok: boolean;
      error?: string;
    };
    expect(replay).toMatchObject({ ok: false, error: "ack-unknown" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    await cleanupTmpDir(dropped);
  });

  it("re-checks is-a-directory at the ack pass — a dir swapped for a file after prepare is refused (TOCTOU)", async () => {
    // Re-stat at acknowledgment; a directory may have become a file since preparation.
    const base = mkdtempSync(join(tmpdir(), "ave-ws-drop-toctou-"));
    const target = join(base, "target");
    mkdirSync(target);
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, target)) as {
      ok: boolean;
      ackToken?: string;
    };
    expect(prep.ok).toBe(true);
    expect(typeof prep.ackToken).toBe("string");
    rmSync(target, { recursive: true, force: true });
    writeFileSync(target, "now a file");
    addAllowedDirectoryPersistMock.mockClear();
    const done = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: prep.ackToken })) as {
      ok: boolean;
      error?: string;
    };
    expect(done).toMatchObject({ ok: false, error: "not-a-dir" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
    await cleanupTmpDir(base);
  });

  it("re-checks existence at the ack pass — a path deleted after prepare is refused (not-found)", async () => {
    const dropped = mkdtempSync(join(tmpdir(), "ave-ws-drop-vanish-"));
    const prep = (await invoke(CHANNELS.workspace.dropPrepare, OK_FRAME, dropped)) as {
      ok: boolean;
      ackToken?: string;
    };
    expect(prep.ok).toBe(true);
    rmSync(dropped, { recursive: true, force: true });
    addAllowedDirectoryPersistMock.mockClear();
    const done = (await invoke(CHANNELS.workspace.pickRoot, OK_FRAME, { ackToken: prep.ackToken })) as {
      ok: boolean;
      error?: string;
    };
    expect(done).toMatchObject({ ok: false, error: "not-found" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });
});

// Root mutation and shell access require the host-renderer guard, not the base file-frame check.
describe("workspace channels refuse a plugin-ui-shell frame", () => {
  it("pickRoot refuses", async () => {
    const res = (await invoke(CHANNELS.workspace.pickRoot, PLUGIN_SHELL_FRAME)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(showOpenDialogMock).not.toHaveBeenCalled();
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("removeRoot refuses", async () => {
    const res = (await invoke(CHANNELS.workspace.removeRoot, PLUGIN_SHELL_FRAME, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("dropPrepare refuses", async () => {
    const res = (await invoke(CHANNELS.workspace.dropPrepare, PLUGIN_SHELL_FRAME, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(addAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });

  it("reveal refuses", async () => {
    const res = (await invoke(CHANNELS.workspace.reveal, PLUGIN_SHELL_FRAME, join(root, "docs"))) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it("a frameless event is refused too (sender frame destroyed mid-invoke)", async () => {
    const fn = handlers.get(CHANNELS.workspace.removeRoot);
    if (!fn) throw new Error("no handler for workspace:remove-root");
    const res = (await fn({ senderFrame: null } as never, root)) as {
      ok: boolean;
      error?: string;
    };
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
    expect(removeAllowedDirectoryPersistMock).not.toHaveBeenCalled();
  });
});
