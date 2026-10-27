/** Verify recording-fixture assumptions against real links, case rules and network-consent fences. */
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { marketplaceRefusal, nodeFolders, writeFolderFiles } from "../../__tests__/fixtures/folder-fs.js";
import { folderService } from "../../__tests__/fixtures/folder-service.js";
import { resolveFolderRoot } from "../../net/source-input.js";
import type { FolderFs } from "../folder-fs.js";
import { FolderTree } from "../folder-tree.js";

const SKILL = "---\nname: note\ndescription: A note skill\n---\nWrite notes.\n";
const AUTHORITY = { capabilities: ["notes:read"], requires: { minAppVersion: "0.12.0", hostProtocol: "4" } };
const PLUGIN_JSON = `${JSON.stringify({ name: "alpha", version: "1.0.0", description: "alpha", extensions: { "ai.agent-connector.ave": { displayName: "alpha", entry: "dist/index.js", ...AUTHORITY } } })}\n`;
const PLUGIN_DESCRIPTOR = `${JSON.stringify({ schemaVersion: 2, kind: "plugin", name: "alpha", version: "1.0.0", minAppVersion: "0.12.0", hostProtocol: "4", payload: { authority: AUTHORITY, artifact: { release: { repo: "acme/alpha", sha256: "0".repeat(64) } } } })}\n`;
const windows = process.platform === "win32";

let scratch: string;
let calls: string[];
beforeEach(() => {
  // Use canonical long paths to avoid platform aliases changing the expected walk.
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-folder-real-")));
  calls = [];
});
afterEach(() => {
  // Remove links before their targets without traversing them; Windows junctions need directory removal.
  for (const link of linksMade.splice(0)) {
    if (windows) rmdirSync(link);
    else unlinkSync(link);
  }
  rmSync(scratch, { recursive: true, force: true });
});

const linksMade: string[] = [];
/** Windows junctions avoid symbolic-link privilege requirements. */
function linkDirectory(path: string, target: string): void {
  symlinkSync(target, path, windows ? "junction" : "dir");
  linksMade.push(path);
}

function recorded(): { fs: FolderFs; platform: NodeJS.Platform; limits: ReturnType<typeof nodeFolders>["limits"] } {
  const real = nodeFolders();
  const fs: FolderFs = {
    lstat: (path) => (calls.push(path), real.fs.lstat(path)),
    readlink: (path) => (calls.push(path), real.fs.readlink(path)),
    readdir: (path) => (calls.push(path), real.fs.readdir(path)),
    open: (path) => (calls.push(path), real.fs.open(path)),
    fstat: (handle) => real.fs.fstat(handle),
    read: (handle, maxBytes) => real.fs.read(handle, maxBytes),
    close: (handle) => real.fs.close(handle),
    queryDosDevice: (drive) => (calls.push(drive), real.fs.queryDosDevice(drive)),
  };
  return { fs, platform: real.platform, limits: real.limits };
}

async function previewOf(input: string) {
  mkdirSync(join(scratch, "state"), { recursive: true });
  const harness = await folderService({ root: join(scratch, "state"), folders: recorded() });
  try {
    return await harness.service.previewSource({ input, auth: "none" });
  } finally {
    harness.service.close();
  }
}

describe(`folders on this machine (${process.platform})`, () => {
  it("answers a network path with network-folder before any filesystem call", async () => {
    const input = windows ? "\\\\localhost\\share\\market" : "/net/localhost/market";
    const answer = await previewOf(input);
    expect(answer).toMatchObject({ type: "confirm", warnings: [{ warning: "network-folder", address: input }] });
    expect(calls).toEqual([]);
  });

  it("reads a link that stays in the folder, and refuses one that leaves it without touching the target", async () => {
    const market = join(scratch, "market");
    const outside = join(scratch, "outside");
    writeFolderFiles(market, { "ave-package.json": PLUGIN_DESCRIPTOR, "plugin.json": PLUGIN_JSON, "build/index.js": "export default {};\n" });
    writeFolderFiles(outside, { "secret.md": "OUTSIDE\n" });
    linkDirectory(join(market, "dist"), join(market, "build"));
    await expect(previewOf(market)).resolves.toMatchObject({ type: "package", kind: "plugin", name: "alpha", path: market });
    expect(calls).toContain(join(market, "build", "index.js"));

    linkDirectory(join(market, "leak"), outside);
    calls = [];
    const error = await marketplaceRefusal(previewOf(market));
    expect(error).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "link-outside-folder", path: "leak" } });
    expect(calls.some((path) => path.startsWith(outside))).toBe(false);
  });

  it("fails a link to a directory the walk also reaches by itself, as a loop (§18.4.5 rule 4)", async () => {
    const market = join(scratch, "market");
    writeFolderFiles(market, { "SKILL.md": SKILL, "shared/notes.md": "notes\n" });
    linkDirectory(join(market, "notes"), join(market, "shared"));
    await expect(previewOf(market)).rejects.toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "limit" } });
  });

  it("takes the on-disk spelling where the volume ignores case, and finds nothing where it does not", async () => {
    const market = join(scratch, "Market");
    writeFolderFiles(market, { "SKILL.md": SKILL });
    const typed = join(scratch, "MARKET");
    // Probe the volume case rule rather than assume it from the platform.
    if (existsSync(typed)) {
      await expect(previewOf(typed)).resolves.toMatchObject({ type: "package", path: market, resolvedFrom: typed });
    } else {
      await expect(previewOf(typed)).rejects.toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "not-found" } });
    }
  });

  it("refuses a link into .git as link-to-skipped, with no call on anything beneath it", async () => {
    const market = join(scratch, "market");
    writeFolderFiles(market, { "SKILL.md": SKILL, ".git/config": "PRIVATE CONFIG\n" });
    linkDirectory(join(market, "docs"), join(market, ".git"));
    const error = await marketplaceRefusal(previewOf(market));
    expect(error).toMatchObject({ code: "CONTENT_RULE_VIOLATION", detail: { reason: "link-to-skipped", path: "docs", target: ".git" } });
    expect(calls.filter((path) => path.startsWith(`${join(market, ".git")}${sep}`))).toEqual([]);
    expect(JSON.stringify(error)).not.toContain("PRIVATE CONFIG");
  });

  it("reads a hard link as the regular file it is: it names a file, never a directory or another volume (§18.4.5)", async () => {
    const market = join(scratch, "market");
    writeFolderFiles(market, { "SKILL.md": SKILL });
    writeFolderFiles(scratch, { "elsewhere.md": "SHARED BYTES\n" });
    linkSync(join(scratch, "elsewhere.md"), join(market, "notes.md"));
    const { fs, platform, limits } = recorded();
    const root = await resolveFolderRoot(market, platform, fs, false);
    const tree = new FolderTree({ fs, platform, root, readAt: new Date().toISOString(), limits, networkConsented: false });
    const files = (await tree.packageAt("", "skill")).files.map((file) => [file.path, file.data.toString("utf8")]);
    expect(Object.fromEntries(files)).toEqual({ "SKILL.md": SKILL, "notes.md": "SHARED BYTES\n" });
  });
});
