import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdDir, nodeIdOf, OwnedFsError, openSource, realWithin } from "../owned-fs.js";

let base: string;
let outside: string;

/** A directory link that needs no privilege: a junction on Windows. */
const linkDir = (target: string, path: string): void => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
const reasonOf = (act: () => unknown): string => {
  try { act(); } catch (error) { return error instanceof OwnedFsError ? error.reason : `other: ${(error as Error).message}`; }
  return "none";
};
const rejection = async (act: Promise<unknown>): Promise<string> => act.then(() => "none", (error: unknown) => error instanceof OwnedFsError ? error.reason : `other: ${(error as Error).message}`);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ofs-"));
  outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "victim.txt"), "outside\n");
  mkdirSync(join(base, "home", "run"), { recursive: true });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("owned folders", () => {
  it("make refuses a link where the new folder would be", () => {
    const run = holdDir(join(base, "home")).ensure("run");
    linkDir(outside, join(run.path, "s1"));
    expect(reasonOf(() => run.make("s1"))).toBe("exists");
    expect(reasonOf(() => run.ensure("s1"))).toBe("not-plain");
    expect(reasonOf(() => run.make("a/b"))).toBe("not-plain");
    expect(readdirSync(outside)).toEqual(["victim.txt"]);
  });

  it("on Windows a name that ends in a dot or a space is no entry: the system would read it as another name, or as the folder itself", async () => {
    const run = holdDir(join(base, "home")).ensure("run");
    run.ensure("s1");
    const windows = process.platform === "win32";
    for (const name of ["...", "s1.", "s1 ", " "]) {
      expect(reasonOf(() => run.existing(name)), name).toBe(windows ? "not-plain" : "none");
      expect(reasonOf(() => run.entryId(name)), name).toBe(windows ? "not-plain" : "none");
      expect(await rejection(run.remove(name)), name).toBe(windows ? "not-plain" : "none");
    }
    expect(readdirSync(run.path)).toEqual(["s1"]);
    expect(existsSync(run.path)).toBe(true);
  });

  it("a level swapped after the chain was held stops every later make", () => {
    const run = holdDir(join(base, "home")).ensure("run");
    const stage = run.make("s1");
    renameSync(run.path, join(base, "home", "away"));
    linkDir(outside, run.path);
    mkdirSync(join(outside, "s1"));
    expect(reasonOf(() => run.make("s2"))).toBe("moved");
    expect(reasonOf(() => stage.make("src"))).toBe("moved");
    expect(reasonOf(() => stage.createFile("a.txt"))).toBe("moved");
    expect(reasonOf(() => run.writeFileAtomic("_run.json", "{}"))).toBe("moved");
    expect(readdirSync(outside).sort()).toEqual(["s1", "victim.txt"]);
    expect(readdirSync(join(outside, "s1"))).toEqual([]);
  });

  it("a level swapped after the chain was held tells nothing of its entries: what took its place neither has one nor lacks one", () => {
    const run = holdDir(join(base, "home")).ensure("run");
    const stage = run.make("s1");
    writeFileSync(join(run.path, "note.txt"), "");
    expect([run.entryId("s1"), run.entryId("s2"), run.isFile("note.txt"), run.isFile("s1"), run.isFile("s2")]).toEqual([stage.id, undefined, true, false, false]);
    renameSync(run.path, join(base, "home", "away"));
    mkdirSync(run.path);
    // The folder with the run's name holds neither; the one that was held holds both.
    expect(reasonOf(() => run.entryId("s1"))).toBe("moved");
    expect(reasonOf(() => run.isFile("note.txt"))).toBe("moved");
    expect(reasonOf(() => stage.entryId("src"))).toBe("moved");
  });

  it("ensurePath stops at a junction component", () => {
    const run = holdDir(join(base, "home")).ensure("run");
    linkDir(outside, join(run.path, "a"));
    expect(reasonOf(() => run.ensurePath(["a", "b"]))).toBe("not-plain");
    expect(existsSync(join(outside, "b"))).toBe(false);
    expect(run.ensurePath(["x", "y"]).path).toBe(join(run.path, "x", "y"));
    expect(run.walk(["x", "y"])?.id).toBe(nodeIdOf(join(run.path, "x", "y")));
    expect(run.walk(["x", "none", "z"])).toBeUndefined();
  });

  it("createFile with replace unlinks a hard link or link, never its target", () => {
    const run = holdDir(join(base, "home")).ensure("run");
    linkSync(join(outside, "victim.txt"), join(run.path, "a.txt"));
    linkDir(outside, join(run.path, "b.txt"));
    expect(reasonOf(() => run.createFile("a.txt"))).toBe("exists");
    for (const name of ["a.txt", "b.txt"]) {
      const { fd, id } = run.createFile(name, { replace: true });
      writeFileSync(fd, "ours\n");
      closeSync(fd);
      expect(run.entryId(name)).toBe(id);
      expect(lstatSync(join(run.path, name)).nlink).toBe(1);
    }
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("outside\n");
    expect(readdirSync(outside)).toEqual(["victim.txt"]);
    mkdirSync(join(run.path, "dir"));
    expect(reasonOf(() => run.createFile("dir", { replace: true }))).toBe("not-plain");
  });

  it("writeFileAtomic ignores a planted tmp link, and readFile takes no file with a second name", () => {
    const run = holdDir(join(base, "home")).ensure("run");
    linkSync(join(outside, "victim.txt"), join(run.path, "_run.json.tmp"));
    run.writeFileAtomic("_run.json", "{\"v\":2}");
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("outside\n");
    expect(run.readFile("_run.json")?.toString("utf8")).toBe("{\"v\":2}");
    expect(run.list()).toEqual(["_run.json"]);
    expect(run.readFile("none")).toBeUndefined();
    linkSync(join(outside, "victim.txt"), join(run.path, "second"));
    expect(reasonOf(() => run.readFile("second"))).toBe("not-plain");
  });

  it("remove never follows a junction and removes read-only files", async () => {
    const run = holdDir(join(base, "home")).ensure("run");
    const stage = run.make("s1");
    mkdirSync(join(stage.path, "src", "deep"), { recursive: true });
    writeFileSync(join(stage.path, "src", "deep", "locked.txt"), "x");
    chmodSync(join(stage.path, "src", "deep", "locked.txt"), 0o444);
    linkDir(outside, join(stage.path, "src", "link"));
    linkSync(join(outside, "victim.txt"), join(stage.path, "src", "second.txt"));
    await run.remove("s1", stage.id);
    expect(existsSync(stage.path)).toBe(false);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("outside\n");
    linkDir(outside, join(run.path, "_ignore-x"));
    await run.remove("_ignore-x");
    await run.remove("none");
    expect(run.list()).toEqual([]);
    expect(readdirSync(outside)).toEqual(["victim.txt"]);
    expect(run.removeSelfIfEmpty()).toBe(true);
    expect(existsSync(run.path)).toBe(false);
  });

  it("remove leaves a read-only file's other name read-only", async () => {
    const run = holdDir(join(base, "home")).ensure("run");
    const stage = run.make("s1");
    const victim = join(outside, "victim.txt");
    chmodSync(victim, 0o444);
    linkSync(victim, join(stage.path, "second.txt"));
    try {
      await run.remove("s1", stage.id).catch(() => undefined);
      expect(statSync(victim).mode & 0o200).toBe(0);
    } finally {
      chmodSync(victim, 0o644);
    }
  });

  it("remove refuses an entry whose id changed", async () => {
    const run = holdDir(join(base, "home")).ensure("run");
    const stage = run.make("s1");
    renameSync(stage.path, join(base, "away"));
    mkdirSync(stage.path);
    writeFileSync(join(stage.path, "kept.txt"), "kept");
    expect(await rejection(run.remove("s1", stage.id))).toBe("changed");
    expect(reasonOf(() => run.child("s1", stage.id))).toBe("changed");
    expect(readdirSync(stage.path)).toEqual(["kept.txt"]);
    writeFileSync(join(run.path, "full"), "x");
    expect(run.removeSelfIfEmpty()).toBe(false);
  });

  it("openSource refuses a link, a linked parent and a root whose id changed", async () => {
    const root = join(base, "home", "run");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "a\n");
    const source = { path: root, id: nodeIdOf(root) as string };
    const handle = await openSource(source, ["src", "a.ts"]);
    expect((await handle.readFile()).toString("utf8")).toBe("a\n");
    await handle.close();
    linkDir(outside, join(root, "linked"));
    expect(await rejection(openSource(source, ["linked", "victim.txt"]))).toBe("not-plain");
    expect(await rejection(openSource(source, ["src"]))).toBe("not-plain");
    expect(await rejection(openSource(source, ["..", "outside", "victim.txt"]))).toBe("not-plain");
    renameSync(root, join(base, "away"));
    linkDir(outside, root);
    expect(await rejection(openSource(source, ["victim.txt"]))).toBe("not-plain");
    expect(await rejection(openSource({ path: outside, id: source.id }, ["victim.txt"]))).toBe("changed");
  });

  it("holds only a real directory, the recorded one when an id is given, and tells what lies within what", () => {
    linkDir(outside, join(base, "linked"));
    expect(reasonOf(() => holdDir(join(base, "linked")))).toBe("not-plain");
    expect(reasonOf(() => holdDir(join(base, "none")))).toBe("not-plain");
    expect(reasonOf(() => holdDir(outside, "1:1"))).toBe("changed");
    expect(holdDir(outside, nodeIdOf(outside)).path).toBe(outside);
    expect(realWithin(base, join(base, "linked"))).toBe(true);
    expect(realWithin(outside, join(base, "linked"))).toBe(true);
    expect(realWithin(join(base, "home"), join(base, "linked"))).toBe(false);
  });
});
