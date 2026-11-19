import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const root = String.raw`D:\Projects\MiXeD`;
  const cwd = String.raw`C:\Workspace`;
  const nativePath = (path: string): string => {
    const key = path.replace(/\\/gu, "/").toLowerCase();
    for (const native of [root, cwd]) {
      const base = native.replace(/\\/gu, "/").toLowerCase();
      if (key === base) return native;
      if (key.startsWith(`${base}/`)) {
        const suffix = path.slice(base.length).replace(/\//gu, "\\");
        return native + suffix;
      }
    }
    return path.replace(/\//gu, "\\").replace(/^[a-z]:/u, drive => drive.toUpperCase());
  };
  return {
    root,
    cwd,
    nativePath,
    additionalDirectories: [] as string[],
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    collectFiles: vi.fn(async (path: string) => ({
      ok: true,
      value: { files: path.toLowerCase().startsWith("d:")
        ? [{ path: `${nativePath(path)}\\notes.md`, relativePath: "notes.md", size: 1 }]
        : [], truncated: false },
    })),
    assertReadableFilePath: vi.fn((path: string): { ok: true; resolved: string } | { ok: false; error: "sensitive-path" } => ({ ok: true, resolved: nativePath(path) })),
  };
});

vi.mock("node:path", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedDrivePath(await original()));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const native = (path: string, ...args: unknown[]) => /^[a-z]:[\\/]/iu.test(path)
    ? fixture.nativePath(path)
    : Reflect.apply(actual.realpathSync.native, undefined, [path, ...args]);
  const realpathSync = (...args: Parameters<typeof actual.realpathSync>) => Reflect.apply(actual.realpathSync, undefined, args);
  return { ...actual, realpathSync: Object.assign(realpathSync, { native }) };
});
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(channel, handler) },
  dialog: {},
  shell: {},
}));
vi.mock("../../gated.js", () => ({ validateHostRendererSender: () => true, auditUnauthorized: vi.fn() }));
vi.mock("../../../main/default-workspace-root.js", () => ({ getDefaultWorkspaceRoot: () => fixture.cwd }));
vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({ permissions: { additionalDirectories: fixture.additionalDirectories, pendingWorkspaceRootRemovals: [] } }),
  addAllowedDirectoryPersist: vi.fn(),
  PermissionSettingsUnreadableError: class PermissionSettingsUnreadableError extends Error {},
}));
vi.mock("../../../permissions/allowed-directories.js", async original => ({
  ...await original<typeof import("../../../permissions/allowed-directories.js")>(),
  buildRuntimeAllowedDirectories: (paths: string[]) => paths,
  sanitizeRuntimeAllowedDirectories: (paths: string[]) => paths.map(path => path.replace(/\\/gu, "/").replace(/^[A-Z]:/u, drive => drive.toLowerCase())),
}));
vi.mock("../../../permissions/workspace-root-reconciler.js", async original => ({
  ...await original<typeof import("../../../permissions/workspace-root-reconciler.js")>(),
  reconcileWorkspaceRoots: vi.fn(async () => ({ pending: [] })),
}));
vi.mock("../../../tools/file-tools.js", () => ({ collectFiles: fixture.collectFiles }));
vi.mock("../../../tools/file-read-core.js", async original => ({
  ...await original<typeof import("../../../tools/file-read-core.js")>(),
  assertReadableFilePath: fixture.assertReadableFilePath,
}));

import { CHANNELS } from "../../../contract/app-contract.js";
import { registerWorkspaceHandlers } from "../workspace.js";
import { clearWorkspaceFileSearchCache, searchWorkspaceFiles } from "../workspace-file-search.js";
import { canonicalizePathForMatch, caseFoldForMatch, resolvePathForPolicy } from "../../../permissions/sensitive-paths.js";

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
if (ORIGINAL_PLATFORM === undefined) throw new Error("Process platform descriptor is missing");
const FOLDED_ROOT = "d:/Projects/MiXeD";
const SIBLING_ROOTS = [
  ["normalization", String.raw`D:\Projects\Café`, String.raw`D:\Projects\Café`],
  ["case", String.raw`D:\Projects\Case`, String.raw`D:\Projects\case`],
] as const;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...ORIGINAL_PLATFORM, value: "win32" });
  fixture.additionalDirectories = [fixture.root];
  fixture.collectFiles.mockClear();
  fixture.assertReadableFilePath.mockClear();
  clearWorkspaceFileSearchCache();
  registerWorkspaceHandlers({ auditLogger: { log: vi.fn() } } as never);
});

afterEach(() => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
});

async function invoke(channel: string, ...args: unknown[]) {
  const handler = fixture.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for: ${channel}`);
  return handler({}, ...args);
}

describe("workspace roots with native drive spelling", () => {
  it("returns native registered roots and deduplicates the default root by its matching identity", async () => {
    fixture.additionalDirectories = [fixture.root, "c:/WORKSPACE"];
    expect(await invoke(CHANNELS.workspace.listRoots)).toEqual({
      ok: true,
      defaultRoot: fixture.cwd,
      roots: [{ path: fixture.cwd, isDefault: true }, { path: fixture.root, isDefault: false }],
    });
  });

  it("matches a differently spelled folder while returning its native registered root", async () => {
    const result = await invoke(CHANNELS.workspace.searchFiles, "notes", { folder: "d:/projects/mixed/src" });
    expect(result).toEqual({ ok: true, truncated: false, matches: [{
      path: `${fixture.root}\\src\\notes.md`, relativePath: "notes.md", root: fixture.root, bytes: 1,
    }] });
    expect(fixture.collectFiles).toHaveBeenCalledWith(`${fixture.root}\\src`, 20_000);
  });

  it("walks native roots and returns them from an unscoped search", async () => {
    expect(await invoke(CHANNELS.workspace.searchFiles, "notes")).toEqual({ ok: true, truncated: false, matches: [{
      path: `${fixture.root}\\notes.md`, relativePath: "notes.md", root: fixture.root, bytes: 1,
    }] });
    expect(fixture.collectFiles.mock.calls.map(([path]) => path)).toEqual([fixture.cwd, fixture.root]);
  });
});

describe("workspace search path identities", () => {
  it("resolves a matching-form root before the native walk and response", async () => {
    const result = await searchWorkspaceFiles({ query: "notes", roots: [FOLDED_ROOT], cwd: fixture.cwd, extraAllowed: [fixture.root] });
    expect(fixture.collectFiles).toHaveBeenCalledWith(fixture.root, 20_000);
    expect(result.matches).toEqual([{ path: `${fixture.root}\\notes.md`, relativePath: "notes.md", root: fixture.root, bytes: 1 }]);
  });

  it("keeps the folder search response root native", async () => {
    const result = await searchWorkspaceFiles({
      query: "notes", roots: [FOLDED_ROOT], cwd: fixture.cwd, extraAllowed: [fixture.root],
      folder: { path: `${fixture.root}\\src`, root: FOLDED_ROOT },
    });
    expect(result.matches[0]?.root).toBe(fixture.root);
  });

  it("shares a listing between equivalent root spellings", async () => {
    const args = { query: "notes", cwd: fixture.cwd, extraAllowed: [fixture.root] };
    const alias = "D:\\PROJECTS\\MIXED";
    expect(resolvePathForPolicy(FOLDED_ROOT)).toBe(fixture.root);
    expect(resolvePathForPolicy(alias)).toBe(fixture.root);
    await Promise.all([
      searchWorkspaceFiles({ ...args, roots: [FOLDED_ROOT] }),
      searchWorkspaceFiles({ ...args, roots: [alias] }),
    ]);
    expect(fixture.collectFiles).toHaveBeenCalledTimes(1);
    expect(fixture.collectFiles).toHaveBeenCalledWith(fixture.root, 20_000);
  });

  it("deduplicates returned file identities across different native spellings", async () => {
    fixture.collectFiles
      .mockResolvedValueOnce({ ok: true, value: { files: [{ path: `${fixture.root}\\notes.md`, relativePath: "notes.md", size: 1 }], truncated: false } })
      .mockResolvedValueOnce({ ok: true, value: { files: [{ path: "d:/projects/mixed/notes.md", relativePath: "notes.md", size: 1 }], truncated: false } });
    const result = await searchWorkspaceFiles({ query: "notes", roots: [fixture.root, fixture.cwd], cwd: fixture.cwd, extraAllowed: [fixture.root] });
    expect(result.matches).toEqual([{ path: `${fixture.root}\\notes.md`, relativePath: "notes.md", root: fixture.root, bytes: 1 }]);
    expect(fixture.assertReadableFilePath).toHaveBeenCalledTimes(1);
  });

  it("still checks a candidate when an equivalent spelling was refused", async () => {
    fixture.collectFiles
      .mockResolvedValueOnce({ ok: true, value: { files: [{ path: "d:/projects/mixed/notes.md", relativePath: "notes.md", size: 1 }], truncated: false } })
      .mockResolvedValueOnce({ ok: true, value: { files: [{ path: `${fixture.root}\\notes.md`, relativePath: "MiXeD/notes.md", size: 1 }], truncated: false } });
    fixture.assertReadableFilePath.mockReturnValueOnce({ ok: false, error: "sensitive-path" });
    const result = await searchWorkspaceFiles({ query: "notes", roots: [fixture.root, "D:\\Projects"], cwd: fixture.cwd, extraAllowed: [fixture.root] });
    expect(result.matches).toEqual([{ path: `${fixture.root}\\notes.md`, relativePath: "MiXeD/notes.md", root: "D:\\Projects", bytes: 1 }]);
    expect(fixture.assertReadableFilePath).toHaveBeenCalledTimes(2);
  });
});

describe("workspace search physical identities", () => {
  it.each(SIBLING_ROOTS)("keeps cached listings separate for %s siblings", async (_kind, left, right) => {
    expect(resolvePathForPolicy(left)).toBe(left);
    expect(resolvePathForPolicy(right)).toBe(right);
    expect(left).not.toBe(right);
    expect(caseFoldForMatch(canonicalizePathForMatch(left))).toBe(caseFoldForMatch(canonicalizePathForMatch(right)));
    const args = { query: "notes", cwd: fixture.cwd, extraAllowed: [left, right] };
    const first = await searchWorkspaceFiles({ ...args, roots: [left] });
    const second = await searchWorkspaceFiles({ ...args, roots: [right] });
    expect(first.matches).toEqual([{ path: `${left}\\notes.md`, relativePath: "notes.md", root: left, bytes: 1 }]);
    expect(second.matches).toEqual([{ path: `${right}\\notes.md`, relativePath: "notes.md", root: right, bytes: 1 }]);
    expect(fixture.collectFiles.mock.calls.map(([path]) => path)).toEqual([left, right]);
  });

  it.each(SIBLING_ROOTS)("keeps in-flight listings separate for %s siblings", async (_kind, left, right) => {
    const args = { query: "notes", cwd: fixture.cwd, extraAllowed: [left, right] };
    const [first, second] = await Promise.all([
      searchWorkspaceFiles({ ...args, roots: [left] }),
      searchWorkspaceFiles({ ...args, roots: [right] }),
    ]);
    expect(first.matches).toEqual([{ path: `${left}\\notes.md`, relativePath: "notes.md", root: left, bytes: 1 }]);
    expect(second.matches).toEqual([{ path: `${right}\\notes.md`, relativePath: "notes.md", root: right, bytes: 1 }]);
    expect(fixture.collectFiles.mock.calls.map(([path]) => path)).toEqual([left, right]);
  });

  it.each(SIBLING_ROOTS)("keeps results from distinct %s siblings", async (_kind, left, right) => {
    const parent = String.raw`D:\Projects`;
    const file = (root: string) => ({ path: `${root}\\notes.md`, relativePath: `${root.slice(parent.length + 1)}/notes.md`, size: 1 });
    fixture.collectFiles.mockResolvedValueOnce({ ok: true, value: { files: [file(left), file(right)], truncated: false } });
    const result = await searchWorkspaceFiles({ query: "notes", roots: [parent], cwd: fixture.cwd, extraAllowed: [parent] });
    expect(result.matches.map(({ path }) => path).sort()).toEqual([`${left}\\notes.md`, `${right}\\notes.md`].sort());
    expect(result.matches.map(({ root }) => root)).toEqual([parent, parent]);
    expect(fixture.assertReadableFilePath).toHaveBeenCalledTimes(2);
  });
});
