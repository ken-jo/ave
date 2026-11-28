import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => ({ base: "" }));
// A host where a folder made again takes back the removed one's inode number (ext4 does this at once): lstat of
// `path` reports `reused`'s device and inode with the new folder's own, later, birth time.
const inodeReuse = vi.hoisted(() => ({ path: undefined as string | undefined, reused: undefined as { dev: bigint; ino: bigint } | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: ((path: string, options?: unknown) => {
      const entry = fs.lstatSync(path, options as never);
      const reused = inodeReuse.reused;
      if (path !== inodeReuse.path || reused === undefined || entry === undefined || typeof entry.ino !== "bigint") return entry;
      return Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, { dev: reused.dev, ino: reused.ino });
    }) as typeof fs.lstatSync,
  };
});
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
const { t } = await import("../../i18n/index.js");
const { posixPolicyLookups, rankPosixContainerRows } = await import("../mxc-posix.js");
const { buildPolicyModel, policyFloorRow, policyGrantRow } = await import("../policy-model.js");
const { claimMxcWatchedRows, isWatchedWorkspaceConsumable, resetWatchedRows } = await import("../windows-watched-rows.js");
const { holdMxcLinuxPlaceholders, installMxcLinuxWatchedPlaceholderOccupant } = await import("../mxc-linux-placeholders.js");
const { currentMxcRuntimeHost } = await import("../mxc-runtime-root.js");

describe.runIf(process.platform === "linux")("Linux holder protected names: placeholder or watch", () => {
  let user: string;
  beforeEach(() => {
    roots.base = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-holder-watch-")));
    user = join(roots.base, "project");
    // What Linux boot installs: a live run's placeholder at a watched name counts as absent.
    installMxcLinuxWatchedPlaceholderOccupant();
    for (const path of [user, join(roots.base, "ave-home", "plugin-data"), join(roots.base, "sandbox-private", "home"), join(roots.base, "runtime")]) {
      mkdirSync(path, { recursive: true });
    }
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

  const model = () => buildPolicyModel({
    floors: [policyFloorRow(join(user, ".vscode", "tasks.json"), "ro", "protected-name", true), policyFloorRow(join(user, ".git", "hooks"), "ro", "protected-name", true)],
    launchGrants: [policyGrantRow(user, "rw", "launch-grant", true)], userGrants: [], extensionManifests: [],
  });
  function rank(watchedRoots: readonly string[]) {
    return rankPosixContainerRows(model(), "bubblewrap", { ...posixPolicyLookups(roots.base, false), watchedRoots });
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

  it("refuses the start when the anchor folder was made again at a reused inode number, by its birth time", () => {
    const { watched = [] } = rank([user]);
    const original = lstatSync(user, { bigint: true });
    if (original.birthtimeNs === 0n) throw new Error("this filesystem reports no birth time; the reuse case cannot be told apart here");
    expect(watched.every(row => row.birth === String(original.birthtimeNs))).toBe(true);
    rmSync(user, { recursive: true });
    mkdirSync(user);
    // Forced, not left to the allocator: the new folder reports the removed one's device and inode.
    inodeReuse.path = user;
    inodeReuse.reused = { dev: original.dev, ino: original.ino };
    try {
      const again = lstatSync(user, { bigint: true });
      expect([again.dev, again.ino]).toEqual([original.dev, original.ino]);
      expect(again.birthtimeNs).not.toBe(original.birthtimeNs);
      expect(() => claimMxcWatchedRows(watched, { commandId: "test" }).start()).toThrow();
    } finally {
      inodeReuse.path = undefined;
      inodeReuse.reused = undefined;
    }
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

  it("masks a shell's live placeholder at a watched name, starts, and watches the name once the shell removes it", async () => {
    const host = currentMxcRuntimeHost();
    const target = join(user, ".vscode", "tasks.json");
    const shell = await holdMxcLinuxPlaceholders(posixPolicyLookups(roots.base, false), (lookups) => rankPosixContainerRows(model(), "bubblewrap", lookups), host);
    expect(existsSync(target)).toBe(true);
    const holder = await holdMxcLinuxPlaceholders({ ...posixPolicyLookups(roots.base, false), watchedRoots: [user] },
      (lookups) => rankPosixContainerRows(model(), "bubblewrap", lookups), host);
    // Masked for the holder, and anchored on the user's own folder rather than the shell's.
    expect(holder.grants.denied).toContain(target);
    expect(holder.grants.placeholders).toEqual([]);
    const watched = holder.grants.watched ?? [];
    expect(watched).toEqual(expect.arrayContaining([expect.objectContaining({ path: target, anchor: user })]));
    const claim = claimMxcWatchedRows(watched, { commandId: "test" });
    claim.start();
    // The shell's placeholder is Ave's: host consumers pass and nothing is moved.
    expect(isWatchedWorkspaceConsumable(user)).toBe(true);
    expect(existsSync(target)).toBe(true);
    await holder.releaseForeignClaims();
    await shell.release();
    expect(existsSync(join(user, ".vscode"))).toBe(false);
    // Now the holder could create it: it is watched like any absent name.
    mkdirSync(join(user, ".vscode"));
    writeFileSync(target, "{}");
    expect(isWatchedWorkspaceConsumable(user)).toBe(false);
    expect(await claim.release()).toEqual(expect.stringContaining(".vscode"));
    expect(existsSync(target)).toBe(false);
    await holder.release();
  });

  it("refuses a Linux start with the Linux wording", () => {
    const { watched = [] } = rank([user]);
    mkdirSync(join(user, ".vscode"));
    const target = join(user, ".vscode", "tasks.json");
    expect(() => claimMxcWatchedRows(watched, { commandId: "test" }).start()).toThrow(t("sandboxPolicy.linuxProtectedWriteRefused", { path: target }));
  });

});
