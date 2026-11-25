import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  isWatchedWorkspaceConsumable, listWatchedQuarantine, placeholderLeftovers, resetWatchedRows, restoreWatchedQuarantine,
  sweepWatchedRows, WATCHED_ROW_VIOLATION, watchAbsentProtectedRow, watchedProtectedRows,
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
