/**
 * The folder rules on this machine's own filesystem (design §18.4.1,
 * §18.4.5): links — junctions on Windows, symbolic links elsewhere — judged by
 * their text, the volume's own case rule deciding the on-disk spelling, and a
 * network path answered with a confirmation before any call. The recording
 * fakes prove the same with every case spelled out; this file proves the real
 * `FolderFs` behaves as the fakes assume.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { marketplaceRefusal, nodeFolders, writeFolderFiles } from "../../__tests__/fixtures/folder-fs.js";
import { folderService } from "../../__tests__/fixtures/folder-service.js";
import type { FolderFs } from "../folder-fs.js";

const SKILL = "---\nname: note\ndescription: A note skill\n---\nWrite notes.\n";
const AUTHORITY = { capabilities: ["notes:read"], requires: { minAppVersion: "0.12.0", hostProtocol: "2" } };
const PLUGIN_JSON = `${JSON.stringify({ name: "alpha", version: "1.0.0", description: "alpha", extensions: { "ai.agent-connector.ave": { displayName: "alpha", entry: "dist/index.js", ...AUTHORITY } } })}\n`;
const PLUGIN_DESCRIPTOR = `${JSON.stringify({ schemaVersion: 2, kind: "plugin", name: "alpha", version: "1.0.0", minAppVersion: "0.12.0", hostProtocol: "2", payload: { authority: AUTHORITY, artifact: { release: { repo: "acme/alpha", sha256: "0".repeat(64) } } } })}\n`;
const windows = process.platform === "win32";

let scratch: string;
let calls: string[];
beforeEach(() => {
  // The long, link-free spelling, so the walk's result is predictable (macOS /var, Windows 8.3 names).
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-folder-real-")));
  calls = [];
});
afterEach(() => {
  // Links first, and only the link: a junction is removed as an empty directory, a symbolic link
  // unlinked, so no removal goes through one to its target.
  for (const link of linksMade.splice(0)) {
    if (windows) rmdirSync(link);
    else unlinkSync(link);
  }
  rmSync(scratch, { recursive: true, force: true });
});

const linksMade: string[] = [];
/** A directory link: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
function linkDirectory(path: string, target: string): void {
  symlinkSync(target, path, windows ? "junction" : "dir");
  linksMade.push(path);
}

/** The real filesystem, with every call's path recorded. */
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
    // A UNC share on Windows; an automount path on macOS and Linux.
    const input = windows ? "\\\\localhost\\share\\market" : "/net/localhost/market";
    const answer = await previewOf(input);
    expect(answer).toMatchObject({ type: "confirm", warnings: [{ warning: "network-folder", address: input }] });
    expect(calls).toEqual([]);
  });

  it("reads a link that stays in the folder, and refuses one that leaves it without touching the target", async () => {
    const market = join(scratch, "market");
    const outside = join(scratch, "outside");
    // A plugin whose dist/ is a link to its build/ output: build/ itself is not installed, so it is reached once.
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
    // The volume's own rule, measured: the other spelling exists only on a case-insensitive volume.
    if (existsSync(typed)) {
      await expect(previewOf(typed)).resolves.toMatchObject({ type: "package", path: market, resolvedFrom: typed });
    } else {
      await expect(previewOf(typed)).rejects.toMatchObject({ code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "not-found" } });
    }
  });
});
