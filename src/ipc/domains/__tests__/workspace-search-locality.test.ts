import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cwd: "",
  defaultRoot: "",
  collectRealFiles: false,
  query: undefined as undefined | { mock: { calls: unknown[][] } },
  atWalk: [] as string[],
  atCollect: [] as string[],
}));

vi.unmock("../../../shared/windows-drive-locality.js");
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(channel, handler) },
  dialog: {},
  shell: {},
}));
vi.mock("../../gated.js", () => ({ validateHostRendererSender: () => true, auditUnauthorized: vi.fn() }));
vi.mock("../../../main/default-workspace-root.js", async (original) => {
  const actual = await original<typeof import("../../../main/default-workspace-root.js")>();
  return {
    ...actual,
    getDefaultWorkspaceRoot: () => {
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixture.defaultRoot);
      try { return actual.getDefaultWorkspaceRoot(); }
      finally { cwd.mockRestore(); }
    },
  };
});
vi.mock("../../../permissions/permission-settings-store.js", async (original) => ({
  ...await original<typeof import("../../../permissions/permission-settings-store.js")>(),
  readPermissionSettings: () => ({ permissions: { additionalDirectories: [], pendingWorkspaceRootRemovals: [] } }),
}));
vi.mock("../workspace-file-search.js", async (original) => {
  const actual = await original<typeof import("../workspace-file-search.js")>();
  return {
    ...actual,
    searchWorkspaceFiles: vi.fn((...args: Parameters<typeof actual.searchWorkspaceFiles>) => {
      fixture.atWalk = (fixture.query?.mock.calls ?? []).map(([drive]) => String(drive).toUpperCase());
      return actual.searchWorkspaceFiles(...args);
    }),
  };
});
vi.mock("../../../tools/file-tools.js", async (original) => {
  const actual = await original<typeof import("../../../tools/file-tools.js")>();
  return {
    ...actual,
    collectFiles: vi.fn(async (...args: Parameters<typeof actual.collectFiles>) => {
      fixture.atCollect = (fixture.query?.mock.calls ?? []).map(([drive]) => String(drive).toUpperCase());
      if (fixture.collectRealFiles) return actual.collectFiles(...args);
      return { ok: true, value: { files: [], truncated: false } };
    }),
  };
});

import { CHANNELS } from "../../../contract/app-contract.js";
import { configureHostResources } from "../../../main/host-resources.js";
import { setWindowsDriveQueryForTest } from "../../../shared/windows-drive-locality.js";
import { registerWorkspaceHandlers } from "../workspace.js";

describe.runIf(process.platform === "win32")("workspace folder search judged once before the walk", () => {
  const query = vi.fn((_drive: string): string | null => String.raw`\Device\HarddiskVolume1`);

  beforeAll(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    fixture.cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-search-locality-")));
    fixture.defaultRoot = fixture.cwd;
    mkdirSync(join(fixture.cwd, "src"));
    fixture.query = query;
    setWindowsDriveQueryForTest(query);
    registerWorkspaceHandlers({ auditLogger: { log: vi.fn() } } as never);
  });

  afterAll(async () => {
    setWindowsDriveQueryForTest();
    await cleanupTmpDir(fixture.cwd);
  });

  it("observes each drive once for the scope, the folder and its root", async () => {
    query.mockClear();
    const handler = fixture.handlers.get(CHANNELS.workspace.searchFiles);
    expect(await handler?.({ sender: { id: 1 } }, "notes", { folder: join(fixture.cwd, "src") })).toEqual({ ok: true, truncated: false, matches: [] });
    expect(fixture.atWalk.length).toBeGreaterThan(0);
    expect(fixture.atWalk).toEqual([...new Set(fixture.atWalk)]);
  });

  it("carries the checked native folder and root to collection without another drive query", async () => {
    query.mockClear();
    const handler = fixture.handlers.get(CHANNELS.workspace.searchFiles);
    expect(await handler?.({ sender: { id: 1 } }, "notes", { folder: join(fixture.cwd, "src") })).toEqual({ ok: true, truncated: false, matches: [] });
    expect(fixture.atCollect.length).toBeGreaterThan(0);
    expect(fixture.atCollect).toEqual([...new Set(fixture.atCollect)]);
  });

  it("carries every admitted native root to collection without another drive query", async () => {
    query.mockClear();
    const handler = fixture.handlers.get(CHANNELS.workspace.searchFiles);
    expect(await handler?.({ sender: { id: 1 } }, "notes")).toEqual({ ok: true, truncated: false, matches: [] });
    expect(fixture.atCollect.length).toBeGreaterThan(0);
    expect(fixture.atCollect).toEqual(fixture.atWalk);
    expect(fixture.atCollect).toEqual([...new Set(fixture.atCollect)]);
  });

  it("returns the stored spelling of the default workspace and its files", async () => {
    const storedRoot = join(fixture.cwd, "StoredRoot");
    mkdirSync(storedRoot);
    const path = join(storedRoot, "Notes.txt");
    writeFileSync(path, "abc");
    fixture.defaultRoot = join(fixture.cwd, "storedroot");
    fixture.collectRealFiles = true;
    query.mockClear();
    try {
      const handler = fixture.handlers.get(CHANNELS.workspace.searchFiles);
      expect(await handler?.({ sender: { id: 1 } }, "notes")).toEqual({
        ok: true, truncated: false, matches: [{ path, root: storedRoot, relativePath: "Notes.txt", bytes: 3 }],
      });
      expect(fixture.atCollect).toHaveLength(1);
      expect(fixture.atCollect).toEqual(fixture.atWalk);
    } finally {
      fixture.defaultRoot = fixture.cwd;
      fixture.collectRealFiles = false;
    }
  });
});
