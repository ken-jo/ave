import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { getLocale, loadLocaleMessages, setLocale, t, type Locale } from "../../i18n/index.js";
import * as restoreRename from "../../lib/transient-fs-lock-retry.js";
import { withLocalityDecision } from "../../shared/local-path-io.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { configureHostResources } from "../../main/host-resources.js";
import { rankAdmittedMxcLists } from "../../__tests__/support/mxc-policy-rows.js";
import { isHostWorkspaceConsumable } from "../../shared/host-workspace-gate.js";

vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("../../lib/transient-fs-lock-retry.js", async original => {
  const actual = await original<typeof restoreRename>();
  return { ...actual, renameFileOnceSync: vi.fn(actual.renameFileOnceSync) };
});

// The identity helper: the real one on request, else the same folder identity read through the file system.
const pin = vi.hoisted(() => ({ real: false, fail: undefined as ((path: string) => Error | undefined) | undefined }));
vi.mock("../../shared/windows-path-facts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/windows-path-facts.js")>();
  const { lstatSync: look } = await import("node:fs");
  const { dirname } = await import("node:path");
  return { ...actual, pinWindowsPaths: (paths: readonly string[]) => pin.real ? actual.pinWindowsPaths(paths) : paths.map((path) => {
    const failure = pin.fail?.(path);
    if (failure !== undefined) throw failure;
    const entry = look(path, { bigint: true, throwIfNoEntry: false });
    if (entry !== undefined) return { volumeSerial: entry.dev.toString(16), fileId: entry.ino.toString(16) };
    let anchor = dirname(path);
    let parent = look(anchor, { bigint: true, throwIfNoEntry: false });
    while (parent === undefined && dirname(anchor) !== anchor) {
      anchor = dirname(anchor);
      parent = look(anchor, { bigint: true, throwIfNoEntry: false });
    }
    if (parent === undefined) throw new Error("Fixture watch has no existing ancestor");
    return { exists: false, attributes: 0, reparseTag: 0, ancestors: [{
      exists: true, canonical: anchor, directory: parent.isDirectory(), attributes: 0, reparseTag: 0,
      volumeSerialNumber: parent.dev.toString(), fileIndex: parent.ino.toString(),
    }] };
  }) };
});

import type { MxcWatchedRow } from "../mxc-windows.js";
import {
  claimMxcWatchedRows, deferWatchedReceipt, hasWatchedWork, isWatchedWorkspaceConsumable, listWatchedQuarantine, placeholderLeftovers, releaseWatchClaim,
  prepareAbsentProtectedWatch, resetWatchedRows, restoreWatchedQuarantine, pruneWatchedRows, sweepWatchedRows, WATCHED_ROW_VIOLATION, watchAbsentProtectedRow, watchedProtectedRows,
} from "../windows-watched-rows.js";

// What the ranker records for an absent name beneath an existing folder.
function ranked(path: string, anchor: string): MxcWatchedRow {
  const entry = lstatSync(anchor, { bigint: true });
  return { path, anchor, volumeSerial: entry.dev.toString(16), fileId: entry.ino.toString(16) };
}

const RECEIPT_LOCALES = ["en", "ko"] as const;
const RECEIPT_WORDING = {
  en: {
    found: "Ave found an entry at a protected path",
    restore: "move it from the shown quarantine path back to its original path",
    failed: "but could not move it to quarantine",
    unverified: "Ave could not verify the identity of the protected location",
    recover: "move any unexpected entry away from its protected path",
  },
  ko: {
    found: /Ave 가 보호 경로.*에서 항목을 발견/u,
    restore: "표시된 격리 경로에서 원래 경로로 옮겨 복원",
    failed: "격리 위치로 옮기지 못했습니다",
    unverified: "Ave 가 보호 경로의 위치가 기존과 같은지 확인하지 못했습니다",
    recover: "예상하지 못한 항목이 있다면 보호 경로 밖으로 옮기세요",
  },
} as const;

describe("watched protected rows", () => {
  let container: string;
  let workspace: string;
  let home: string;
  let previousLocale: Locale;
  let tasks: string;

  beforeEach(() => {
    vi.mocked(restoreRename.renameFileOnceSync).mockReset();
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    previousLocale = getLocale();
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
    setLocale(previousLocale);
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

  it("publishes a prepared optional row and root only when committed", () => {
    const proposed = join(workspace, "proposed");
    mkdirSync(proposed);
    const existing = join(proposed, "existing-watch");
    const added = join(proposed, "new-watch");
    watchAbsentProtectedRow(existing, [workspace]);

    const [publishRoot, publishRow] = withLocalityDecision(() => [
      prepareAbsentProtectedWatch(existing, [proposed], false),
      prepareAbsentProtectedWatch(added, [proposed], false),
    ]);
    expect(watchedProtectedRows()).toEqual([existing]);
    expect(publishRoot).toBeTypeOf("function");
    expect(publishRow).toBeTypeOf("function");
    publishRoot?.();
    publishRow?.();
    pruneWatchedRows([proposed]);
    expect(watchedProtectedRows()).toEqual([existing, added]);
  });

  it.runIf(process.platform === "win32")("leaves optional rows and roots unchanged after a later drive query fails", () => {
    const proposed = join(workspace, "proposed");
    mkdirSync(proposed);
    const existing = join(proposed, "existing-watch");
    const added = join(proposed, "new-watch");
    const failedDrive = workspace.startsWith("Z:") ? "Y:" : "Z:";
    const failure = new Error("Watch drive query failed");
    watchAbsentProtectedRow(existing, [workspace]);

    setWindowsDriveQueryForTest(drive => {
      if (drive === failedDrive) throw failure;
      return String.raw`\Device\HarddiskVolume1`;
    });
    try {
      expect(() => withLocalityDecision(() => [
        prepareAbsentProtectedWatch(existing, [proposed], false),
        prepareAbsentProtectedWatch(added, [proposed], false),
        prepareAbsentProtectedWatch(join(`${failedDrive}\\`, "blocked", "watch"), [proposed], false),
      ])).toThrow(failure);
    } finally {
      setWindowsDriveQueryForTest();
    }

    expect(watchedProtectedRows()).toEqual([existing]);
    pruneWatchedRows([proposed]);
    expect(watchedProtectedRows()).toEqual([]);
  });

  it.each(RECEIPT_LOCALES)("uses %s receipt wording for a quarantined entry with a manifest and restore locations", async locale => {
    await loadLocaleMessages(locale);
    setLocale(locale);
    watchAbsentProtectedRow(tasks, [workspace]);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    const notice = await sweepWatchedRows({ commandId: "fixture-command", command: "echo planted" });
    expect(notice).toContain(WATCHED_ROW_VIOLATION);
    expect(notice).toMatch(RECEIPT_WORDING[locale].found);
    expect(notice).toContain(RECEIPT_WORDING[locale].restore);
    expect(lstatSync(join(workspace, ".vscode"), { throwIfNoEntry: false })).toBeUndefined();
    const [entry, ...rest] = listWatchedQuarantine();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ original: join(workspace, ".vscode"), row: tasks, commandId: "fixture-command", command: "echo planted" });
    if (entry === undefined) throw new Error("No quarantine entry");
    expect(notice).toContain(`${JSON.stringify(entry.original)} -> ${JSON.stringify(entry.quarantined)}`);
    expect(readFileSync(join(entry.quarantined, "tasks.json"), "utf8")).toBe("planted");
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
    await expect(restoreWatchedQuarantine(entry.slot, entry.index)).resolves.toEqual({ restored: join(workspace, ".vscode") });
    expect(readFileSync(tasks, "utf8")).toBe("planted");
    expect(listWatchedQuarantine()[0]?.restored).toEqual(expect.any(String));
    watchAbsentProtectedRow(tasks, [workspace]);
    expect(watchedProtectedRows()).not.toContain(tasks);
    await expect(restoreWatchedQuarantine(entry.slot, entry.index)).rejects.toThrow(/already restored/);
  });

  async function quarantineTasks(commandId: string) {
    watchAbsentProtectedRow(tasks, [workspace]);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    await sweepWatchedRows({ commandId });
    const [entry] = listWatchedQuarantine();
    if (entry === undefined) throw new Error("No quarantine entry");
    return entry;
  }

  it.runIf(process.platform === "win32")("completes a Windows restore without an asynchronous rename", async () => {
    const entry = await quarantineTasks("sync-restore");
    const rename = vi.spyOn(restoreRename, "renameFileOnce");
    try {
      await expect(restoreWatchedQuarantine(entry.slot, entry.index)).resolves.toEqual({ restored: entry.original });
      expect(rename).not.toHaveBeenCalled();
      expect(readFileSync(tasks, "utf8")).toBe("planted");
      expect(listWatchedQuarantine()[0]?.restored).toEqual(expect.any(String));
    } finally {
      rename.mockRestore();
    }
  });

  it.runIf(process.platform === "win32")("reports an identity change at the restore's effect boundary", async () => {
    const entry = await quarantineTasks("changed-parent-at-rename");
    const watchedBefore = watchedProtectedRows();
    const rename = vi.mocked(restoreRename.renameFileOnceSync).mockImplementationOnce((source, destination) => {
      renameSync(workspace, join(container, "previous-workspace"));
      mkdirSync(workspace);
      renameSync(source, destination);
    });
    try {
      await expect(restoreWatchedQuarantine(entry.slot, entry.index)).rejects.toThrow("Quarantine restore destination folder changed identity");
      expect(rename).toHaveBeenCalledOnce();
      expect(readFileSync(tasks, "utf8")).toBe("planted");
      expect(listWatchedQuarantine()[0]?.restored).toBeUndefined();
      expect(watchedProtectedRows()).toEqual(watchedBefore);
    } finally {
      rename.mockClear();
    }
  });

  it.skipIf(process.platform === "win32")("restores by pathname off Windows exactly as before", async () => {
    const entry = await quarantineTasks("pathname-restore");
    resetWatchedRows();
    renameSync(workspace, join(container, "previous-workspace"));
    mkdirSync(workspace);
    const rename = vi.spyOn(restoreRename, "renameFileOnce");
    try {
      await expect(restoreWatchedQuarantine(entry.slot, entry.index)).resolves.toEqual({ restored: entry.original });
      expect(rename).toHaveBeenCalledExactlyOnceWith(entry.quarantined, entry.original);
      expect(readFileSync(tasks, "utf8")).toBe("planted");
      expect(listWatchedQuarantine()[0]?.restored).toEqual(expect.any(String));
    } finally {
      rename.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("preserves copied quarantine receipt fields when listing on POSIX", async () => {
    const entry = await quarantineTasks("copied-receipt");
    const manifest = join(dirname(entry.quarantined), "watched-manifest.json");
    const record = JSON.parse(readFileSync(manifest, "utf8"));
    const restoreIdentity = { source: "copied-source", parent: "copied-parent" };
    record.entries[0].restoreIdentity = restoreIdentity;
    writeFileSync(manifest, JSON.stringify(record));
    expect(listWatchedQuarantine()[0]).toMatchObject({ restoreIdentity });
  });

  it.runIf(process.platform === "win32")("stops restore at a failed source-drive query before probing the destination", async () => {
    watchAbsentProtectedRow(tasks, [workspace]);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    await sweepWatchedRows({ commandId: "source-drive" });
    const [entry] = listWatchedQuarantine();
    if (entry === undefined) throw new Error("No quarantine entry");
    const failedDrive = workspace.startsWith("Z:") ? "Y:" : "Z:";
    const manifest = join(dirname(entry.quarantined), "watched-manifest.json");
    const record = JSON.parse(readFileSync(manifest, "utf8"));
    record.entries[0].quarantined = join(`${failedDrive}\\`, entry.slot, basename(entry.quarantined));
    writeFileSync(manifest, JSON.stringify(record));
    const failure = new Error("Quarantine source drive query failed");
    const rename = vi.mocked(restoreRename.renameFileOnceSync).mockImplementationOnce(() => { throw new Error("Unexpected restore rename"); });
    const query = vi.fn((drive: string) => {
      if (drive === failedDrive) throw failure;
      return "\\Device\\HarddiskVolume1";
    });
    setWindowsDriveQueryForTest(query);
    try {
      await expect(restoreWatchedQuarantine(entry.slot, entry.index)).rejects.toThrow(failure);
      expect(query.mock.calls.map(([drive]) => drive)).toEqual([entry.quarantined.slice(0, 2).toUpperCase(), failedDrive]);
      expect(rename).not.toHaveBeenCalled();
      expect(readFileSync(join(entry.quarantined, "tasks.json"), "utf8")).toBe("planted");
      expect(listWatchedQuarantine()[0]?.restored).toBeUndefined();
    } finally {
      setWindowsDriveQueryForTest();
      rename.mockReset();
    }
  });

  it.runIf(process.platform === "win32")("refuses to restore into a replaced destination parent", async () => {
    watchAbsentProtectedRow(tasks, [workspace]);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    await sweepWatchedRows({ commandId: "destination-parent" });
    const [entry] = listWatchedQuarantine();
    if (entry === undefined) throw new Error("No quarantine entry");
    // A persisted receipt must still enforce its recorded parent after the watches are gone.
    resetWatchedRows();
    renameSync(workspace, join(container, "previous-workspace"));
    mkdirSync(workspace);
    await expect(restoreWatchedQuarantine(entry.slot, entry.index)).rejects.toThrow("Quarantine restore destination folder changed identity");
    expect(lstatSync(entry.original, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(entry.quarantined, "tasks.json"), "utf8")).toBe("planted");
    expect(listWatchedQuarantine()[0]?.restored).toBeUndefined();
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

  it.each(RECEIPT_LOCALES)("uses %s receipt wording when a started launch's folder cannot be verified and the entry is absent", async locale => {
    await loadLocaleMessages(locale);
    setLocale(locale);
    const hooks = join(workspace, ".ave", "hooks");
    const claim = claimMxcWatchedRows([ranked(hooks, workspace)], { commandId: "unverifiable" });
    claim.start();
    renameSync(workspace, join(container, "moved"));
    mkdirSync(workspace);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    expect(lstatSync(hooks, { throwIfNoEntry: false })).toBeUndefined();
    const released = claim.release();
    await expect(released).rejects.toThrow(/changed identity/);
    await expect(released).rejects.toThrow(RECEIPT_WORDING[locale].unverified);
    await expect(released).rejects.toThrow(RECEIPT_WORDING[locale].recover);
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

  it.runIf(process.platform === "win32")("retains an undelivered receipt when the sweep cannot judge locality", async () => {
    watchAbsentProtectedRow(tasks, [workspace]);
    deferWatchedReceipt("receipt from a released holder");
    const failure = new Error("Watched drive query failed");
    setWindowsDriveQueryForTest(() => { throw failure; });
    try {
      await expect(sweepWatchedRows({ commandId: "failed-sweep" })).rejects.toBe(failure);
    } finally {
      setWindowsDriveQueryForTest();
    }
    resetWatchedRows();
    expect(hasWatchedWork()).toBe(true);
    await expect(sweepWatchedRows({ commandId: "next-sweep" })).resolves.toBe("receipt from a released holder");
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

  it.each(RECEIPT_LOCALES)("uses %s receipt wording when a found entry cannot be quarantined", async locale => {
    await loadLocaleMessages(locale);
    setLocale(locale);
    writeFileSync(join(home, "sandbox-quarantine"), "");
    watchAbsentProtectedRow(tasks, [workspace]);
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(tasks, "planted");
    const sweep = sweepWatchedRows({ commandId: "fixture-command" });
    await expect(sweep).rejects.toThrow(JSON.stringify(join(workspace, ".vscode")));
    await expect(sweep).rejects.toThrow(RECEIPT_WORDING[locale].found);
    await expect(sweep).rejects.toThrow(RECEIPT_WORDING[locale].failed);
    await expect(sweep).rejects.toThrow(RECEIPT_WORDING[locale].recover);
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

  it("checks the folder each grant pinned, so a later grant's carrier cannot be swapped under an older watch", async () => {
    const carrier = join(workspace, ".ave");
    const hooks = join(carrier, "hooks");
    watchAbsentProtectedRow(hooks, [workspace], true, Symbol("earlier"));
    mkdirSync(carrier);
    watchAbsentProtectedRow(hooks, [workspace], true, Symbol("later"));
    renameSync(carrier, join(container, "measured-carrier"));
    mkdirSync(hooks, { recursive: true });
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    await expect(sweepWatchedRows({ commandId: "fixture-command" })).rejects.toThrow(/changed identity/);
    expect(lstatSync(hooks).isDirectory()).toBe(true);
    expect(listWatchedQuarantine()).toEqual([]);
  });

  it("refuses to re-arm a grant's watch after its pinned folder changed", () => {
    const carrier = join(workspace, ".ave");
    const hooks = join(carrier, "hooks");
    const grant = Symbol("grant");
    mkdirSync(carrier);
    watchAbsentProtectedRow(hooks, [workspace], true, grant);
    renameSync(carrier, join(container, "measured-carrier"));
    mkdirSync(carrier);
    expect(() => watchAbsentProtectedRow(hooks, [workspace], true, grant)).toThrow(hooks);
  });

  it("keeps a failed check fail-closed after the grant that pinned the folder ends", async () => {
    const carrier = join(workspace, ".ave");
    const hooks = join(carrier, "hooks");
    const later = Symbol("later");
    watchAbsentProtectedRow(hooks, [workspace], true, Symbol("earlier"));
    mkdirSync(carrier);
    watchAbsentProtectedRow(hooks, [workspace], true, later);
    renameSync(carrier, join(container, "measured-carrier"));
    mkdirSync(hooks, { recursive: true });
    await expect(sweepWatchedRows({ commandId: "fixture-command" })).rejects.toThrow(/changed identity/);
    releaseWatchClaim(later);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);

    const failure = await sweepWatchedRows({ commandId: "next-command" }).catch((error: unknown) => error);
    expect(lstatSync(hooks, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(listWatchedQuarantine()).toEqual([]);
    expect(failure).toMatchObject({ message: expect.stringContaining("changed identity") });
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);

    renameSync(hooks, join(container, "removed-hooks"));
    await expect(sweepWatchedRows({ commandId: "after-removal" })).resolves.toBeUndefined();
    mkdirSync(hooks);
    await expect(sweepWatchedRows({ commandId: "new-entry" })).resolves.toContain(WATCHED_ROW_VIOLATION);
  });

  it("keeps watching a restored name an ACL grant still reaches and refuses host consumers until the next sweep", async () => {
    const hooks = join(workspace, ".ave", "hooks");
    watchAbsentProtectedRow(hooks, [workspace], true);
    mkdirSync(hooks, { recursive: true });
    await expect(sweepWatchedRows({ commandId: "first" })).resolves.toContain(WATCHED_ROW_VIOLATION);
    const [entry] = listWatchedQuarantine();
    if (entry === undefined) throw new Error("No quarantine entry");
    await expect(restoreWatchedQuarantine(entry.slot, entry.index)).resolves.toEqual({ restored: hooks });
    expect(watchedProtectedRows()).toContain(hooks);
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(false);
    await expect(sweepWatchedRows({ commandId: "next" })).resolves.toContain(WATCHED_ROW_VIOLATION);
    expect(lstatSync(hooks, { throwIfNoEntry: false })).toBeUndefined();
    expect(isWatchedWorkspaceConsumable(workspace)).toBe(true);
  });

  it("lists only zero-byte files as placeholder leftovers", () => {
    const empty = join(workspace, "empty.json");
    const full = join(workspace, "full.json");
    writeFileSync(empty, "");
    writeFileSync(full, "{}");
    expect(placeholderLeftovers([empty, full, workspace, join(workspace, "absent")])).toEqual([empty]);
  });
});
