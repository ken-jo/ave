import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { t } from "../../i18n/index.js";
import { configureHostResources } from "../../main/host-resources.js";
import { rankAdmittedMxcLists } from "../../__tests__/support/mxc-policy-rows.js";

// Every directory watch the module arms, with an injectable arm failure.
const fsHook = vi.hoisted(() => ({
  fail: undefined as ((path: string) => NodeJS.ErrnoException | undefined) | undefined,
  handles: [] as { path: string; watcher: import("node:events").EventEmitter; closed: boolean }[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = (path: string, ...rest: unknown[]) => {
    const failure = fsHook.fail?.(String(path));
    if (failure !== undefined) throw failure;
    const watcher = (actual.watch as (...args: unknown[]) => import("node:fs").FSWatcher)(path, ...rest);
    const handle = { path: String(path), watcher, closed: false };
    const close = watcher.close.bind(watcher);
    watcher.close = () => { handle.closed = true; close(); };
    fsHook.handles.push(handle);
    return watcher;
  };
  return { ...actual, watch };
});
const live = () => fsHook.handles.filter(handle => !handle.closed).map(handle => handle.path);
const emfile = () => Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });

import {
  isWatchedWorkspaceConsumable, listWatchedQuarantine, placeholderLeftovers, resetWatchedRows, restoreWatchedQuarantine,
  pruneWatchedRows, sweepWatchedRows, WATCHED_ROW_VIOLATION, watchAbsentProtectedRow, watchedProtectedRows, watchMxcProtectedRows,
} from "../windows-watched-rows.js";

describe("watched protected rows", () => {
  let container: string;
  let workspace: string;
  let home: string;
  let tasks: string;

  beforeEach(() => {
    container = mkdtempSync(join(tmpdir(), "watched-rows-"));
    workspace = join(container, "workspace");
    home = join(container, "home");
    tasks = join(workspace, ".vscode", "tasks.json");
    mkdirSync(workspace);
    mkdirSync(home);
    vi.stubEnv("AVE_HOME", home);
  });

  afterEach(async () => {
    fsHook.fail = undefined;
    for (const handle of fsHook.handles.splice(0)) if (!handle.closed) (handle.watcher as import("node:fs").FSWatcher).close();
    vi.unstubAllEnvs();
    await cleanupTmpDir(container);
    resetWatchedRows();
  });

  it("records an absent row reachable from a write root without creating anything", () => {
    watchAbsentProtectedRow(tasks, [workspace]);
    expect(watchedProtectedRows()).toContain(tasks);
    expect(lstatSync(join(workspace, ".vscode"), { throwIfNoEntry: false })).toBeUndefined();
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    resetWatchedRows();
    expect(watchedProtectedRows()).not.toContain(tasks);
  });

  it("quarantines a created row with its manifest and violation, refuses host consumers until then, and restores on request", async () => {
    watchAbsentProtectedRow(tasks, [workspace]);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    const notice = await sweepWatchedRows({ commandId: "fixture-command", command: "echo planted" });
    expect(notice).toContain(WATCHED_ROW_VIOLATION);
    expect(lstatSync(join(workspace, ".vscode"), { throwIfNoEntry: false })).toBeUndefined();
    const [entry, ...rest] = listWatchedQuarantine();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ original: join(workspace, ".vscode"), row: tasks, commandId: "fixture-command", command: "echo planted" });
    if (entry === undefined) throw new Error("No quarantine entry");
    expect(readFileSync(join(entry.quarantined, "tasks.json"), "utf8")).toBe("planted");
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    await expect(restoreWatchedQuarantine(entry.slot, entry.index)).resolves.toEqual({ restored: join(workspace, ".vscode") });
    expect(readFileSync(tasks, "utf8")).toBe("planted");
    expect(listWatchedQuarantine()[0]?.restored).toEqual(expect.any(String));
    watchAbsentProtectedRow(tasks, [workspace]);
    expect(watchedProtectedRows()).not.toContain(tasks);
    await expect(restoreWatchedQuarantine(entry.slot, entry.index)).rejects.toThrow(/already restored/);
  });

  it("quarantines the protected children of a newly created carrier and preserves siblings", async () => {
    const carrier = join(workspace, ".ave");
    const protectedPaths = [join(carrier, "commands"), join(carrier, "hooks")];
    for (const path of protectedPaths) watchAbsentProtectedRow(path, [workspace], true);
    mkdirSync(carrier);
    const unrelated = join(carrier, "unrelated.txt");
    writeFileSync(unrelated, "keep");
    for (const path of protectedPaths) mkdirSync(path);

    await expect(sweepWatchedRows({ commandId: "fixture-command" })).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(readFileSync(unrelated, "utf8")).toBe("keep");
    expect(listWatchedQuarantine().map(entry => entry.original)).toEqual(protectedPaths);
    for (const path of protectedPaths) expect(lstatSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("keeps a shared carrier watch until the last container releases it", async () => {
    const hooks = join(workspace, ".ave", "hooks");
    const first = watchMxcProtectedRows([hooks], { commandId: "first" });
    const second = watchMxcProtectedRows([hooks], { commandId: "second" });

    await expect(first()).resolves.toBeUndefined();
    pruneWatchedRows([]);
    expect(watchedProtectedRows()).toContain(hooks);
    mkdirSync(hooks, { recursive: true });

    await expect(second()).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(listWatchedQuarantine()).toEqual([expect.objectContaining({ original: hooks, commandId: "second" })]);
    expect(watchedProtectedRows()).not.toContain(hooks);
  });

  it("arms a live watch on the anchor before the container starts, follows a created carrier, and closes both with the run", async () => {
    const carrier = join(workspace, ".ave");
    const hooks = join(carrier, "hooks");
    const sweep = watchMxcProtectedRows([hooks], { commandId: "armed" });
    expect(live()).toEqual([workspace]);
    mkdirSync(hooks, { recursive: true });
    await vi.waitFor(() => expect(live()).toEqual([workspace, carrier]));
    await expect(sweep()).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(live()).toEqual([]);
  });

  it.runIf(process.platform === "win32")("gives the next launch exact denies once the carrier exists, while the running launch keeps its watch until it ends", async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const root = realpathSync.native(workspace);
    const carrier = join(root, ".ave");
    const [commands, hooks] = [join(carrier, "commands"), join(carrier, "hooks")];
    const children = [commands, hooks];
    const lists = { allowWrite: [root], allowRead: [], denyRead: [], denyWrite: children, requiredWriteDenies: children, carrierChildWriteDenies: children, protectedFloor: [] };
    const running = rankAdmittedMxcLists(lists);
    expect(running.watched).toEqual(children);
    const sweep = watchMxcProtectedRows(running.watched ?? [], { commandId: "running" });
    mkdirSync(carrier);
    await vi.waitFor(() => expect(live()).toEqual([root, carrier]));
    expect(rankAdmittedMxcLists(lists)).toEqual({ readwrite: [root], readonly: [], denied: children });
    expect(live()).toEqual([root, carrier]);
    mkdirSync(hooks);
    await expect(sweep()).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(listWatchedQuarantine().map(entry => entry.original)).toEqual([hooks]);
    expect(live()).toEqual([]);
  });

  it("refuses the grant, naming the protected path, and releases every partial registration when a watch cannot be armed", () => {
    const other = join(container, "other");
    mkdirSync(other);
    const first = join(workspace, ".ave", "commands");
    const second = join(other, ".ave", "hooks");
    fsHook.fail = path => path === other ? emfile() : undefined;
    expect(() => watchMxcProtectedRows([first, second], { commandId: "unarmed" }))
      .toThrow(t("sandboxPolicy.windowsProtectedWriteRefused", { path: second }));
    expect(live()).toEqual([]);
    expect(watchedProtectedRows()).not.toEqual(expect.arrayContaining([first]));
    expect(watchedProtectedRows()).not.toEqual(expect.arrayContaining([second]));
  });

  it("refuses the grant when the carrier appeared after ranking", () => {
    const hooks = join(workspace, ".ave", "hooks");
    mkdirSync(join(workspace, ".ave"));
    expect(() => watchMxcProtectedRows([hooks], { commandId: "late-carrier" }))
      .toThrow(t("sandboxPolicy.windowsProtectedWriteRefused", { path: hooks }));
    expect(live()).toEqual([]);
    expect(watchedProtectedRows()).not.toContain(hooks);
  });

  it("refuses host consumers of the workspace until the sweep once a live watch fails", async () => {
    const hooks = join(workspace, ".ave", "hooks");
    const sweep = watchMxcProtectedRows([hooks], { commandId: "lost" });
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    fsHook.handles[0]?.watcher.emit("error", Object.assign(new Error("EPERM"), { code: "EPERM" }));
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    await sweep();
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
  });

  it("refuses to move a protected child through a replacement carrier link", async () => {
    const carrier = join(workspace, ".ave");
    const target = join(container, "external");
    const child = join(target, "hooks");
    mkdirSync(child, { recursive: true });
    watchAbsentProtectedRow(join(carrier, "hooks"), [workspace], true);
    symlinkSync(target, carrier, "junction");

    await expect(sweepWatchedRows({ commandId: "fixture-command" })).rejects.toThrow(/quarantine/i);
    expect(lstatSync(carrier).isSymbolicLink()).toBe(true);
    expect(lstatSync(child).isDirectory()).toBe(true);
    expect(listWatchedQuarantine()).toEqual([]);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
  });

  it("fails closed without deleting anything when the quarantine cannot be created", async () => {
    writeFileSync(join(home, "sandbox-quarantine"), "");
    watchAbsentProtectedRow(tasks, [workspace]);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    await expect(sweepWatchedRows({ commandId: "fixture-command" })).rejects.toThrow(JSON.stringify(join(workspace, ".vscode")));
    expect(readFileSync(tasks, "utf8")).toBe("planted");
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    expect(isWatchedWorkspaceConsumable(join(container, "elsewhere"))).toBe(true);
    rmSync(join(workspace, ".vscode"), { recursive: true });
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
  });

  it("refuses to move an entry whose recorded parent was replaced", async () => {
    watchAbsentProtectedRow(tasks, [workspace]);
    renameSync(workspace, join(container, "moved"));
    mkdirSync(join(workspace, ".vscode"), { recursive: true });
    writeFileSync(tasks, "planted");
    await expect(sweepWatchedRows({ commandId: "fixture-command" })).rejects.toThrow(/changed identity/);
    expect(readFileSync(tasks, "utf8")).toBe("planted");
    expect(listWatchedQuarantine()).toEqual([]);
  });

  it("lists only zero-byte files as placeholder leftovers", () => {
    const empty = join(workspace, "empty.json");
    const full = join(workspace, "full.json");
    writeFileSync(empty, "");
    writeFileSync(full, "{}");
    expect(placeholderLeftovers([empty, full, workspace, join(workspace, "absent")])).toEqual([empty]);
  });
});
