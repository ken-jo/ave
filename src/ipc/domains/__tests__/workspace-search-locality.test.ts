import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cwd: "",
  query: undefined as undefined | { mock: { calls: unknown[][] } },
  atWalk: [] as string[],
}));

vi.unmock("../../../shared/windows-drive-locality.js");
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(channel, handler) },
  dialog: {},
  shell: {},
}));
vi.mock("../../gated.js", () => ({ validateHostRendererSender: () => true, auditUnauthorized: vi.fn() }));
vi.mock("../../../main/default-workspace-root.js", () => ({ getDefaultWorkspaceRoot: () => fixture.cwd }));
vi.mock("../../../permissions/permission-settings-store.js", async (original) => ({
  ...await original<typeof import("../../../permissions/permission-settings-store.js")>(),
  readPermissionSettings: () => ({ permissions: { additionalDirectories: [], pendingWorkspaceRootRemovals: [] } }),
}));
vi.mock("../workspace-file-search.js", async (original) => ({
  ...await original<typeof import("../workspace-file-search.js")>(),
  searchWorkspaceFiles: vi.fn(async () => {
    fixture.atWalk = (fixture.query?.mock.calls ?? []).map(([drive]) => String(drive).toUpperCase());
    return { truncated: false, matches: [] };
  }),
}));

import { CHANNELS } from "../../../contract/app-contract.js";
import { configureHostResources } from "../../../main/host-resources.js";
import { setWindowsDriveQueryForTest } from "../../../shared/windows-drive-locality.js";
import { registerWorkspaceHandlers } from "../workspace.js";

describe.runIf(process.platform === "win32")("workspace folder search judged once before the walk", () => {
  const query = vi.fn((_drive: string): string | null => String.raw`\Device\HarddiskVolume1`);

  beforeAll(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    fixture.cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-search-locality-")));
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
});
