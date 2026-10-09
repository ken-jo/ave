import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renameEntryExclusive } from "../rename-entry-exclusive.js";
import { configureHostResources } from "../../main/host-resources.js";

describe("exclusive same-volume rename", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "exclusive-rename-")); });
  afterEach(async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    await rm(root, { recursive: true, force: true });
  });

  it("executes the packaged helper from a relocated resource directory", async () => {
    const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      build: { extraResources: Array<{ from: string; to: string; filter?: string[] }> };
    };
    const mapping = pkg.build.extraResources.find((entry) => entry.from === "resources/rename-entry/${arch}");
    expect(mapping?.to).toBe("rename-entry/${arch}");
    const name = process.platform === "win32" ? "ave-rename-entry.exe" : "ave-rename-entry";
    expect(mapping?.filter).toContain(name);
    const resources = join(root, "packaged-resources");
    await mkdir(join(resources, "rename-entry", process.arch), { recursive: true });
    await copyFile(resolve("resources", "rename-entry", process.arch, name), join(resources, "rename-entry", process.arch, name));
    configureHostResources({ resourcePath: resources, isPackaged: true });
    const from = join(root, "source");
    const to = join(root, "target");
    await mkdir(from);
    const inode = statSync(from).ino;
    await renameEntryExclusive(from, to);
    expect(statSync(to).ino).toBe(inode);
  });

  it("refuses an existing empty directory without replacing its inode", async () => {
    const from = join(root, "source");
    const to = join(root, "target");
    await mkdir(from);
    await mkdir(to);
    const sourceInode = statSync(from).ino;
    const targetInode = statSync(to).ino;
    await expect(renameEntryExclusive(from, to)).rejects.toMatchObject({ code: "EEXIST" });
    expect(statSync(from).ino).toBe(sourceInode);
    expect(statSync(to).ino).toBe(targetInode);
    expect(await readdir(root)).toEqual(["source", "target"]);
  });

  it("refuses an existing file and retains both contents", async () => {
    const from = join(root, "source");
    const to = join(root, "target");
    await writeFile(from, "original");
    await writeFile(to, "late");
    await expect(renameEntryExclusive(from, to)).rejects.toMatchObject({ code: "EEXIST" });
    expect(statSync(from).size).toBe(8);
    expect(statSync(to).size).toBe(4);
  });

  it("moves the original directory into an absent destination", async () => {
    const from = join(root, "source");
    const to = join(root, "target");
    await mkdir(from);
    const inode = statSync(from).ino;
    await renameEntryExclusive(from, to);
    expect(statSync(to).ino).toBe(inode);
    expect(await readdir(root)).toEqual(["target"]);
  });
});
