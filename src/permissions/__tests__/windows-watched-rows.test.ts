import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { t } from "../../i18n/index.js";
import { configureHostResources } from "../../main/host-resources.js";
import { rankAdmittedMxcLists } from "../../__tests__/support/mxc-policy-rows.js";
import { isHostWorkspaceConsumable } from "../../shared/host-workspace-gate.js";

// The identity helper: the real one on request, else the same folder identity read through the file system.
const pin = vi.hoisted(() => ({ real: false, fail: undefined as ((path: string) => Error | undefined) | undefined }));
vi.mock("../../shared/windows-path-facts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/windows-path-facts.js")>();
  const { lstatSync: look } = await import("node:fs");
  return { ...actual, pinWindowsPaths: (paths: readonly string[]) => pin.real ? actual.pinWindowsPaths(paths) : paths.map((path) => {
    const failure = pin.fail?.(path);
    if (failure !== undefined) throw failure;
    const entry = look(path, { bigint: true });
    return { volumeSerial: entry.dev.toString(16), fileId: entry.ino.toString(16) };
  }) };
});

import type { MxcWatchedRow } from "../mxc-windows.js";
import {
  claimMxcWatchedRows, deferWatchedReceipt, hasWatchedWork, isWatchedWorkspaceConsumable, listWatchedQuarantine, placeholderLeftovers, resetWatchedRows,
  restoreWatchedQuarantine, pruneWatchedRows, sweepWatchedRows, WATCHED_ROW_VIOLATION, watchAbsentProtectedRow, watchedProtectedRows,
} from "../windows-watched-rows.js";

// What the ranker records for an absent name beneath an existing folder.
function ranked(path: string, anchor: string): MxcWatchedRow {
  const entry = lstatSync(anchor, { bigint: true });
  return { path, anchor, volumeSerial: entry.dev.toString(16), fileId: entry.ino.toString(16) };
}

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
    pin.real = false;
    pin.fail = undefined;
    // Drain a check a host consumer started and the receipts no result took.
    await sweepWatchedRows({ commandId: "teardown" }).catch(() => undefined);
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

  it("refuses a host consumer while a watched name exists, quarantines it, and hands the receipt to the next command result", async () => {
    watchAbsentProtectedRow(tasks, [workspace]);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    // The gate every host consumer asks is this check.
    expect(isHostWorkspaceConsumable(workspace)).toBe(false);
    expect(isHostWorkspaceConsumable(join(container, "elsewhere"))).toBe(true);
    await vi.waitFor(() => expect(isWatchedWorkspaceConsumable(workspace)).toBe(true));
    expect(listWatchedQuarantine()).toEqual([expect.objectContaining({ original: join(workspace, ".vscode"), row: tasks, commandId: "host-consumer" })]);
    await expect(sweepWatchedRows({ commandId: "next-command" })).resolves.toContain(WATCHED_ROW_VIOLATION);
    await expect(sweepWatchedRows({ commandId: "later-command" })).resolves.toBeUndefined();
  });

  it("registers nothing until the launch starts, and an unstarted claim neither fences nor sweeps", async () => {
    const hooks = join(workspace, ".ave", "hooks");
    const claim = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "unstarted" });
    expect(watchedProtectedRows()).not.toContain(hooks);
    // The host, not a contained process, creates the name before any start.
    mkdirSync(hooks, { recursive: true });
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    await expect(claim.release()).resolves.toBeUndefined();
    expect(lstatSync(hooks).isDirectory()).toBe(true);
    expect(listWatchedQuarantine()).toEqual([]);
    expect(() => claim.start()).toThrow(t("sandboxPolicy.windowsProtectedWriteRefused", { path: hooks }));
    expect(watchedProtectedRows()).not.toContain(hooks);
  });

  it("keeps a shared name claimed until the last launch releases it", async () => {
    const hooks = join(workspace, ".ave", "hooks");
    const first = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "first" });
    const second = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "second" });
    first.start();
    second.start();

    await expect(first.release()).resolves.toBeUndefined();
    pruneWatchedRows([]);
    expect(watchedProtectedRows()).toContain(hooks);
    mkdirSync(hooks, { recursive: true });

    await expect(second.release()).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(listWatchedQuarantine()).toEqual([expect.objectContaining({ original: hooks, commandId: "second" })]);
    expect(watchedProtectedRows()).not.toContain(hooks);
  });

  it("quarantines a started launch's created name at release without any live watch, and leaves its siblings", async () => {
    const carrier = join(workspace, ".ave");
    const hooks = join(carrier, "hooks");
    const claim = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "started" });
    claim.start();
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(carrier, "ordinary.txt"), "keep");
    await expect(claim.release()).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(readFileSync(join(carrier, "ordinary.txt"), "utf8")).toBe("keep");
    expect(listWatchedQuarantine().map(entry => entry.original)).toEqual([hooks]);
    expect(lstatSync(hooks, { throwIfNoEntry: false })).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("gives the next launch exact denies once the parent exists, while the running launch keeps its claim until it ends", async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    pin.real = true;
    const root = realpathSync.native(workspace);
    const carrier = join(root, ".ave");
    const [commands, hooks] = [join(carrier, "commands"), join(carrier, "hooks")];
    const children = [commands, hooks];
    const lists = { allowWrite: [root], allowRead: [], denyRead: [], denyWrite: children, requiredWriteDenies: children, protectedFloor: [] };
    const running = rankAdmittedMxcLists(lists);
    expect(running.watched?.map(row => row.path)).toEqual(children);
    const claim = claimMxcWatchedRows(running.watched ?? [], { commandId: "running" });
    claim.start();
    mkdirSync(carrier);
    expect(rankAdmittedMxcLists(lists)).toEqual({ readwrite: [root], readonly: [], denied: children });
    // A launch ranked before the parent appeared is refused at its start instead of running on the stale ranking.
    expect(() => claimMxcWatchedRows(running.watched ?? [], { commandId: "stale" }).start())
      .toThrow(t("sandboxPolicy.windowsProtectedWriteRefused", { path: commands }));
    mkdirSync(hooks);
    await expect(claim.release()).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(listWatchedQuarantine().map(entry => entry.original)).toEqual([hooks]);
  });

  it("starts with every row or none: a refused row leaves no registration behind", () => {
    const other = join(container, "other");
    mkdirSync(other);
    const first = join(workspace, ".ave", "commands");
    const second = join(other, ".ave", "hooks");
    const refused = t("sandboxPolicy.windowsProtectedWriteRefused", { path: second });
    const unregistered = () => {
      expect(watchedProtectedRows()).not.toEqual(expect.arrayContaining([first]));
      expect(watchedProtectedRows()).not.toEqual(expect.arrayContaining([second]));
      expect(hasWatchedWork()).toBe(false);
    };
    // The identity check cannot be made.
    pin.fail = path => path === other ? new Error("helper unavailable") : undefined;
    const claim = claimMxcWatchedRows([ranked(first, workspace), ranked(second, other)], { commandId: "unchecked" });
    expect(() => claim.start()).toThrow(refused);
    unregistered();
    pin.fail = undefined;
    // The second row's folder is not the object the ranker admitted.
    const stale = { ...ranked(second, other), fileId: ranked(first, workspace).fileId };
    expect(() => claimMxcWatchedRows([ranked(first, workspace), stale], { commandId: "other-object" }).start()).toThrow(refused);
    unregistered();
    // The second row's name exists.
    mkdirSync(second, { recursive: true });
    expect(() => claimMxcWatchedRows([ranked(first, workspace), ranked(second, other)], { commandId: "late-name" }).start()).toThrow(refused);
    unregistered();
  });

  it("refuses the start when the parent appeared, or the folder was replaced, after ranking", () => {
    const hooks = join(workspace, ".ave", "hooks");
    const row = ranked(hooks, workspace);
    const refused = t("sandboxPolicy.windowsProtectedWriteRefused", { path: hooks });
    mkdirSync(join(workspace, ".ave"));
    expect(() => claimMxcWatchedRows([row], { commandId: "late-parent" }).start()).toThrow(refused);
    rmSync(join(workspace, ".ave"), { recursive: true });
    renameSync(workspace, join(container, "moved"));
    mkdirSync(workspace);
    expect(() => claimMxcWatchedRows([row], { commandId: "replaced-folder" }).start()).toThrow(refused);
    expect(watchedProtectedRows()).not.toContain(hooks);
  });

  it("refuses host consumers while a started launch's folder cannot be verified", async () => {
    const hooks = join(workspace, ".ave", "hooks");
    const claim = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "unverifiable" });
    claim.start();
    renameSync(workspace, join(container, "moved"));
    mkdirSync(workspace);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    await expect(claim.release()).rejects.toThrow(/changed identity/);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
  });

  it("keeps the remaining launch's claim when the user restores a quarantined name", async () => {
    const hooks = join(workspace, ".ave", "hooks");
    const first = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "first" });
    const second = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "second" });
    first.start();
    second.start();
    mkdirSync(hooks, { recursive: true });
    await expect(first.release()).resolves.toContain(WATCHED_ROW_VIOLATION);
    const [entry] = listWatchedQuarantine();
    if (entry === undefined) throw new Error("No quarantine entry");
    await expect(restoreWatchedQuarantine(entry.slot, entry.index)).resolves.toEqual({ restored: hooks });
    // The second launch is still live: its claim stays, host consumers stay refused, and no other check moves the restored entry.
    expect(watchedProtectedRows()).toContain(hooks);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    await expect(sweepWatchedRows({ commandId: "another-command" })).resolves.toBeUndefined();
    expect(lstatSync(hooks).isDirectory()).toBe(true);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    // Its release checks the name again, and its result carries both receipts.
    const notice = await second.release();
    expect(notice?.split(WATCHED_ROW_VIOLATION)).toHaveLength(3);
    expect(lstatSync(hooks, { throwIfNoEntry: false })).toBeUndefined();
    expect(listWatchedQuarantine().filter(item => item.restored === undefined)).toEqual([expect.objectContaining({ original: hooks, commandId: "second" })]);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    expect(watchedProtectedRows()).not.toContain(hooks);
  });

  it("carries a receipt no command result took on the next command result", async () => {
    expect(hasWatchedWork()).toBe(false);
    deferWatchedReceipt("receipt from a released holder");
    expect(hasWatchedWork()).toBe(true);
    await expect(sweepWatchedRows({ commandId: "next-command" })).resolves.toBe("receipt from a released holder");
    expect(hasWatchedWork()).toBe(false);
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
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
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
