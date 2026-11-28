import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => ({ base: "" }));
vi.mock("../asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../asrt-sandbox.js")>(),
  aveHomeReadBoundaryRoots: () => [join(roots.base, "ave-home")],
  appOwnedSandboxPrivateRoots: () => [join(roots.base, "sandbox-private")],
}));
vi.mock("../mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-runtime-root.js")>(),
  requireMxcContainerStartRoot: () => join(roots.base, "runtime"),
}));

const { linuxHolderWatchedRoots } = await import("../mxc-linux.js");
const { posixPolicyLookups, rankPosixContainerRows } = await import("../mxc-posix.js");
const { buildPolicyModel, policyFloorRow, policyGrantRow } = await import("../policy-model.js");
const { claimMxcWatchedRows, resetWatchedRows } = await import("../windows-watched-rows.js");

describe.runIf(process.platform === "linux")("Linux holder protected names: placeholder or watch", () => {
  let user: string;
  beforeEach(() => {
    roots.base = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-holder-watch-")));
    user = join(roots.base, "project");
    for (const path of [user, join(roots.base, "ave-home", "plugin-data"), join(roots.base, "sandbox-private", "home")]) mkdirSync(path, { recursive: true });
  });
  afterEach(() => {
    resetWatchedRows();
    rmSync(roots.base, { recursive: true, force: true });
  });

  it("watches only a long-lived holder's user folders, never an Ave-owned root", () => {
    const writeRoots = [user, join(roots.base, "ave-home", "plugin-data"), join(roots.base, "sandbox-private", "home"), join(roots.base, "runtime", "x")];
    expect(linuxHolderWatchedRoots(writeRoots, true)).toEqual([user]);
    expect(linuxHolderWatchedRoots(writeRoots, false)).toEqual([]);
  });

  function rank(watchedRoots: readonly string[]) {
    const lookups = { ...posixPolicyLookups(roots.base, false), watchedRoots };
    const model = buildPolicyModel({
      floors: [policyFloorRow(join(user, ".vscode", "tasks.json"), "ro", "protected-name", true), policyFloorRow(join(user, ".git", "hooks"), "ro", "protected-name", true)],
      launchGrants: [policyGrantRow(user, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [],
    });
    return rankPosixContainerRows(model, "bubblewrap", lookups);
  }

  it("puts a watched absent name in no list and creates nothing, while a placeholder root still holds it", () => {
    const watched = rank([user]);
    const target = join(user, ".vscode", "tasks.json");
    expect([...watched.readwrite, ...watched.readonly, ...watched.denied, ...(watched.pins ?? [])]).not.toEqual(expect.arrayContaining([target]));
    expect(watched.placeholders).toEqual([]);
    expect(watched.watched).toEqual(expect.arrayContaining([expect.objectContaining({ path: target, anchor: user })]));
    expect(existsSync(join(user, ".vscode"))).toBe(false);
    const held = rank([]);
    expect(held.watched).toBeUndefined();
    expect(held.denied).toContain(target);
    expect(held.placeholders?.map(row => row.path)).toContain(target);
  });

  it("refuses the start when a watched name appeared after the ranking", () => {
    const { watched = [] } = rank([user]);
    mkdirSync(join(user, ".vscode"));
    expect(() => claimMxcWatchedRows(watched, { commandId: "test" }).start()).toThrow(join(user, ".vscode", "tasks.json"));
  });

  it("refuses the start when the anchor folder was replaced", () => {
    const { watched = [] } = rank([user]);
    // Moved aside rather than removed: a freed inode number may be reused at once (see the placeholder identity limit).
    renameSync(user, `${user}-former`);
    mkdirSync(user);
    expect(() => claimMxcWatchedRows(watched, { commandId: "test" }).start()).toThrow();
  });

  it("sweeps a name the holder created at release into quarantine and returns its receipt", async () => {
    const { watched = [] } = rank([user]);
    const claim = claimMxcWatchedRows(watched, { commandId: "test" });
    claim.start();
    mkdirSync(join(user, ".vscode"));
    writeFileSync(join(user, ".vscode", "tasks.json"), "{}");
    const receipt = await claim.release();
    expect(receipt).toEqual(expect.stringContaining(".vscode"));
    expect(existsSync(join(user, ".vscode", "tasks.json"))).toBe(false);
  });
});
