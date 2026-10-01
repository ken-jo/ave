/**
 * The folder reader's rules (design §18.4.5), with the recording volume:
 * links are judged by their text before any call touches their target, a
 * swap still in place after a read fails it, and names are NFC.
 */
import { describe, expect, it } from "vitest";
import { FakeVolume, marketplaceRefusal as failure, TEST_FOLDER_LIMITS } from "../../__tests__/fixtures/folder-fs.js";
import { resolveFolderRoot } from "../../net/source-input.js";
import { FolderTree } from "../folder-tree.js";

const AT = "2026-10-02T00:00:00.000Z";

async function treeOf(volume: FakeVolume, path: string): Promise<FolderTree> {
  const root = await resolveFolderRoot(path, volume.platform, volume);
  return new FolderTree({ fs: volume, platform: volume.platform, root, readAt: AT, limits: TEST_FOLDER_LIMITS });
}

const text = (files: Array<{ path: string; data: Buffer }>) => Object.fromEntries(files.map((file) => [file.path, file.data.toString("utf8")]));

describe("links inside a folder (§18.4.5)", () => {
  it("installs an inside link as a regular file holding its target's bytes", async () => {
    const volume = new FakeVolume("linux")
      .file("/m/skills/note/SKILL.md", "real skill\n")
      .file("/m/shared/notes.md", "shared notes\n")
      .link("/m/skills/note/notes.md", "../../shared/notes.md");
    const tree = await treeOf(volume, "/m");
    const pkg = await tree.packageAt("skills/note", "skill");
    expect(text(pkg.files)).toEqual({ "SKILL.md": "real skill\n", "notes.md": "shared notes\n" });
    // The link's own path is never opened: the target's canonical path is.
    expect(volume.paths("open")).not.toContain("/m/skills/note/notes.md");
    expect(volume.paths("open")).toContain("/m/shared/notes.md");
  });

  it("refuses a link outside the folder as link-outside-folder without any call on its target", async () => {
    const volume = new FakeVolume("linux")
      .file("/m/skills/note/SKILL.md", "skill\n")
      .file("/home/example/.ssh/id_ed25519", "PRIVATE KEY\n")
      .link("/m/skills/note/key.md", "/home/example/.ssh/id_ed25519");
    const tree = await treeOf(volume, "/m");
    const error = await failure(tree.packageAt("skills/note", "skill"));
    expect(error).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "link-outside-folder", path: "skills/note/key.md", target: "/home/example/.ssh/id_ed25519" } });
    expect(volume.calls.some((call) => call.path.startsWith("/home/example"))).toBe(false);
  });

  it("stops a chain root/a → root/b → \\\\attacker\\share at b's text, with no call on any \\\\attacker path (Windows)", async () => {
    const volume = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3" } })
      .file("C:\\m\\skills\\note\\SKILL.md", "skill\n")
      .link("C:\\m\\skills\\note\\a.md", "..\\..\\b")
      .link("C:\\m\\b", "\\\\attacker\\share\\loot");
    const tree = await treeOf(volume, "C:\\m");
    const error = await failure(tree.packageAt("skills/note", "skill"));
    expect(error).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "link-to-network", path: "b", target: "\\\\attacker\\share\\loot" } });
    expect(volume.calls.some((call) => call.path.toLowerCase().includes("attacker"))).toBe(false);
  });

  it("refuses a junction to a share in an ancestor of a package as link-to-network, with no call on the share", async () => {
    const volume = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3" } })
      .file("C:\\m\\marketplace.2.json", "{}")
      .link("C:\\m\\skills", "\\\\attacker\\share\\skills");
    const tree = await treeOf(volume, "C:\\m");
    const error = await failure(tree.packageAt("skills/note", "skill"));
    expect(error).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "link-to-network", path: "skills" } });
    expect(volume.calls.some((call) => call.path.toLowerCase().includes("attacker"))).toBe(false);
  });

  it("refuses a link to a mapped network drive by the drive's mapping, and a loop", async () => {
    const volume = new FakeVolume("win32", { drives: { "C:": "\\Device\\HarddiskVolume3", "Z:": "\\Device\\Mup\\;LanmanRedirector\\files\\s" } })
      .file("C:\\m\\skills\\note\\SKILL.md", "skill\n")
      .link("C:\\m\\skills\\note\\z.md", "Z:\\loot.md");
    const tree = await treeOf(volume, "C:\\m");
    expect(await failure(tree.packageAt("skills/note", "skill"))).toMatchObject({ detail: { reason: "link-to-network" } });
    // Only the drive letter's mapping was asked; nothing on the drive was touched.
    expect(volume.calls.filter((call) => call.path.startsWith("Z:")).map((call) => call.op)).toEqual(["queryDosDevice"]);

    const loop = new FakeVolume("linux").file("/m/skills/note/SKILL.md", "s").link("/m/skills/note/x", "y").link("/m/skills/note/y", "x");
    const looped = await treeOf(loop, "/m");
    expect(await failure(looped.packageAt("skills/note", "skill"))).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "limit" } });
  });
});

describe("swaps during a read (§18.4.5)", () => {
  it("fails an fstat identity mismatch as changed-during-read", async () => {
    const volume = new FakeVolume("linux").file("/m/marketplace.2.json", "{}");
    const tree = await treeOf(volume, "/m");
    const original = volume.fstat.bind(volume);
    volume.fstat = async (handle) => ({ ...(await original(handle)), ino: 999_999n });
    expect(await failure(tree.readFile("marketplace.2.json", 1024))).toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "changed-during-read" } });
  });

  it("catches an ancestor swap still in place after the read, and no byte of the outside file reaches the package", async () => {
    const volume = new FakeVolume("linux")
      .file("/m/skills/note/SKILL.md", "inside skill\n")
      .file("/outside/note/SKILL.md", "OUTSIDE SECRET\n");
    const tree = await treeOf(volume, "/m");
    let swapped = false;
    volume.hook = (call) => {
      // After skills/note was enumerated, before its file is reached: skills/note becomes a link to the outside directory.
      if (!swapped && call.op === "lstat" && call.path === "/m/skills/note/SKILL.md") {
        swapped = true;
        volume.remove("/m/skills/note").link("/m/skills/note", "/outside/note");
      }
    };
    const error = await failure(tree.packageAt("skills/note", "skill"));
    expect(error).toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "changed-during-read" } });
    expect(swapped).toBe(true);
    // The outside file was opened through the swapped ancestor, then discarded by the parent-chain recheck.
    expect(volume.paths("open")).toContain("/m/skills/note/SKILL.md");
    expect(JSON.stringify(error)).not.toContain("OUTSIDE SECRET");
  });

  it("records the residual: the same swap restored before the recheck lets the read complete (§18.4.5, stated, not defended)", async () => {
    const volume = new FakeVolume("linux")
      .file("/m/skills/note/SKILL.md", "inside skill\n")
      .file("/outside/note/SKILL.md", "OUTSIDE\n");
    const tree = await treeOf(volume, "/m");
    let phase: "before" | "swapped" | "restored" = "before";
    volume.hook = (call) => {
      if (phase === "before" && call.op === "lstat" && call.path === "/m/skills/note/SKILL.md") {
        phase = "swapped";
        volume.remove("/m/skills/note").link("/m/skills/note", "/outside/note");
      } else if (phase === "swapped" && call.op === "close") {
        // A concurrent writer restores the directory between the read and the recheck.
        phase = "restored";
        volume.remove("/m/skills/note").alias("/m/skills/note", "/m/.restore");
      }
    };
    // The original directory node, kept so the restore puts back the same identity.
    volume.alias("/m/.restore", "/m/skills/note");
    const pkg = await tree.packageAt("skills/note", "skill");
    expect(phase).toBe("restored");
    // The documented residual: a concurrent local writer in the chosen folder can redirect one read.
    expect(text(pkg.files)["SKILL.md"]).toBe("OUTSIDE\n");
  });
});

describe("names and skipped entries (§18.4.5)", () => {
  it("skips .git/, .DS_Store, ._*, Thumbs.db and desktop.ini without reading them", async () => {
    const volume = new FakeVolume("darwin")
      .file("/m/skills/note/SKILL.md", "skill\n")
      .file("/m/skills/note/.git/config", "[core]\nfsmonitor = evil\n")
      .file("/m/skills/note/.DS_Store", "x")
      .file("/m/skills/note/._SKILL.md", "x")
      .file("/m/skills/note/Thumbs.db", "x")
      .file("/m/skills/note/desktop.ini", "x");
    const tree = await treeOf(volume, "/m");
    const pkg = await tree.packageAt("skills/note", "skill");
    expect(pkg.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(volume.calls.some((call) => /\.git|DS_Store|\._|Thumbs|desktop\.ini/u.test(call.path))).toBe(false);
  });

  it("digests an NFD name as NFC, and refuses two names equal after NFC", async () => {
    const nfd = "Cafe\u0301.md";
    const nfc = "Caf\u00e9.md";
    const decomposed = new FakeVolume("linux").file("/m/skills/note/SKILL.md", "s").file(`/m/skills/note/${nfd}`, "menu");
    const composed = new FakeVolume("linux").file("/m/skills/note/SKILL.md", "s").file(`/m/skills/note/${nfc}`, "menu");
    const a = await (await treeOf(decomposed, "/m")).packageAt("skills/note", "skill");
    const b = await (await treeOf(composed, "/m")).packageAt("skills/note", "skill");
    expect(a.files.map((file) => file.path)).toContain(nfc);
    expect(a.treeSha256).toBe(b.treeSha256);

    const both = new FakeVolume("linux").file("/m/skills/note/SKILL.md", "s").file(`/m/skills/note/${nfd}`, "1").file(`/m/skills/note/${nfc}`, "2");
    expect(await failure((await treeOf(both, "/m")).packageAt("skills/note", "skill"))).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "case-collision" } });
  });

  it("refuses a device, socket or FIFO as special-file, and lists a plugin's other top-level entries as not installed", async () => {
    const special = new FakeVolume("linux").file("/m/skills/note/SKILL.md", "s").special("/m/skills/note/fifo");
    expect(await failure((await treeOf(special, "/m")).packageAt("skills/note", "skill"))).toMatchObject({ detail: { reason: "special-file", path: "skills/note/fifo" } });

    const plugin = new FakeVolume("linux")
      .file("/m/plugins/alpha/plugin.json", "{}")
      .file("/m/plugins/alpha/dist/index.js", "x", { executable: true })
      .file("/m/plugins/alpha/src/index.ts", "x")
      .file("/m/plugins/alpha/package.json", "{}")
      .file("/m/plugins/alpha/node_modules/a/index.js", "x");
    const pkg = await (await treeOf(plugin, "/m")).packageAt("plugins/alpha", "plugin");
    expect(pkg.files.map((file) => [file.path, file.executable])).toEqual([["dist/index.js", true], ["plugin.json", false]]);
    expect(pkg.notInstalled).toEqual(["node_modules/", "package.json", "src/"]);
    // What is not installed is never read.
    expect(plugin.paths("open").some((path) => path.includes("/src/") || path.includes("node_modules"))).toBe(false);
  });
});
