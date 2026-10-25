import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BrowserActionError } from "../browser-action-guard.js";
import { BROWSER_UPLOAD_LIMITS, stageBrowserUpload, type BrowserUploadPickerRequest, type BrowserUploadSelection } from "../browser-upload.js";

let dir: string;
let previousHome: string | undefined;
let selections: BrowserUploadSelection[];
const request = (): BrowserUploadPickerRequest => ({ windowId: 1, sessionId: "conversation", tabId: "tab-1", origin: "https://a.example:443", documentId: 7, controlGeneration: 3, ref: "e1", signal: new AbortController().signal });

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ave-browser-upload-")));
  previousHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(dir, "home");
  selections = [];
});
afterEach(async () => {
  await Promise.all(selections.map((selection) => selection.release()));
  if (previousHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = previousHome;
  await fs.rm(dir, { recursive: true, force: true });
});

async function file(name = "notes.txt", bytes = "approved bytes"): Promise<string> {
  const path = join(dir, name);
  await fs.writeFile(path, bytes);
  return path;
}

async function staged(path: string, destination = request()): Promise<BrowserUploadSelection> {
  const selection = await stageBrowserUpload(destination, async () => [path], () => {});
  expect(selection).not.toBeNull();
  selections.push(selection!);
  return selection!;
}

describe("native upload selection staging", () => {
  it("keeps an independent readonly byte snapshot across edits to the original", async () => {
    const path = await file();
    const destination = request();
    const selection = await staged(path, destination);
    await fs.writeFile(path, "changed after choice");
    await selection.dispatch(destination, async (paths) => {
      expect(paths[0]).not.toBe(path);
      expect(await fs.readFile(paths[0]!, "utf8")).toBe("approved bytes");
      if (process.platform !== "win32") expect((await fs.stat(paths[0]!)).mode & 0o777).toBe(0o400);
    });
    expect(selection.result).toEqual({ status: "selected", count: 1, bytes: 14, files: [{ name: "notes.txt", bytes: 14 }] });
    expect(JSON.stringify(selection.result)).not.toContain(dir);
    await selection.release();
    expect(await fs.readFile(path, "utf8")).toBe("changed after choice");
  });

  it("delivers each file under its source basename, even when two sources share one", async () => {
    await fs.mkdir(join(dir, "a"));
    await fs.mkdir(join(dir, "b"));
    const first = await file(join("a", "notes.txt"), "first bytes");
    const second = await file(join("b", "notes.txt"), "second bytes");
    const destination = request();
    const selection = await stageBrowserUpload(destination, async () => [first, second], () => {});
    expect(selection).not.toBeNull();
    let delivered: readonly string[] = [];
    await selection!.dispatch(destination, async (paths) => {
      delivered = paths;
      expect(paths.map((path) => basename(path))).toEqual(["notes.txt", "notes.txt"]);
      expect(new Set(paths.map((path) => dirname(path))).size).toBe(2);
      expect(await fs.readFile(paths[0]!, "utf8")).toBe("first bytes");
      expect(await fs.readFile(paths[1]!, "utf8")).toBe("second bytes");
    });
    expect(selection!.result.files).toEqual([{ name: "notes.txt", bytes: 11 }, { name: "notes.txt", bytes: 12 }]);
    await selection!.release();
    for (const path of delivered) await expect(fs.stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(join(dir, "home", "browser-uploads"))).toEqual([]);
  });

  it("removes the slot directories of a selection released before dispatch", async () => {
    const selection = await staged(await file());
    const root = join(dir, "home", "browser-uploads");
    const [selectionDir] = await fs.readdir(root);
    expect(await fs.readdir(join(root, selectionDir!))).toEqual(["0"]);
    expect(await fs.readdir(join(root, selectionDir!, "0"))).toEqual(["notes.txt"]);
    await selection.release();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("binds a one-shot selection to every destination identity field", async () => {
    const path = await file();
    for (const changed of [{ windowId: 2 }, { sessionId: "other" }, { tabId: "tab-2" }, { origin: "https://b.example:443" }, { documentId: 8 }, { controlGeneration: 4 }, { ref: "e2" }]) {
      const destination = request();
      const selection = await staged(path, destination);
      await expect(selection.dispatch({ ...destination, ...changed }, async () => { throw new Error("must not dispatch"); })).rejects.toMatchObject({ code: "upload-revoked" });
      await expect(selection.dispatch(destination, async () => {})).rejects.toMatchObject({ code: "upload-revoked" });
    }
  });

  it("rejects replay after cancellation even with a replacement signal", async () => {
    const abort = new AbortController();
    const destination = { ...request(), signal: abort.signal };
    const selection = await staged(await file(), destination);
    abort.abort();
    await expect(selection.dispatch({ ...destination, signal: new AbortController().signal }, async () => {})).rejects.toMatchObject({ code: "cancelled" });
  });

  it("does no staging when selection is cancelled or its dialog was aborted", async () => {
    expect(await stageBrowserUpload(request(), async () => null, () => {})).toBeNull();
    const abort = new AbortController();
    await expect(stageBrowserUpload({ ...request(), signal: abort.signal }, async () => { abort.abort(); return [await file()]; }, () => {})).rejects.toMatchObject({ code: "cancelled" });
    await expect(fs.stat(join(dir, "home", "browser-uploads"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokes on destination change during staging and deletes only its copy", async () => {
    const path = await file();
    let checks = 0;
    await expect(stageBrowserUpload(request(), async () => [path], () => { if (++checks === 8) throw new BrowserActionError("document-changed", "destination changed"); })).rejects.toThrow("destination changed");
    expect(await fs.readFile(path, "utf8")).toBe("approved bytes");
    expect(await fs.readdir(join(dir, "home", "browser-uploads"))).toEqual([]);
  });

  it("rejects duplicate choices, links, sensitive files and disallowed file types", async () => {
    const path = await file();
    await expect(stageBrowserUpload(request(), async () => [path, path], () => {})).rejects.toMatchObject({ code: "upload-refused" });
    const link = join(dir, "linked.txt");
    await fs.symlink(path, link);
    for (const candidate of [link, await file("run.sh"), await file(".env")]) {
      await expect(stageBrowserUpload(request(), async () => [candidate], () => {})).rejects.toMatchObject({ code: "upload-refused" });
    }
  });

  it("rejects oversized files without allocating their bytes", async () => {
    const path = await file();
    await fs.truncate(path, BROWSER_UPLOAD_LIMITS.fileBytes + 1);
    await expect(stageBrowserUpload(request(), async () => [path], () => {})).rejects.toMatchObject({ code: "upload-refused" });
  });

  it("keeps bytes until explicit lifetime revocation, then invalidates the selection", async () => {
    const destination = request();
    const selection = await staged(await file(), destination);
    let path = "";
    await selection.dispatch(destination, async (paths) => { path = paths[0]!; });
    let revoke!: () => void;
    let stopped = false;
    selection.retainUntil((callback) => { revoke = callback; return () => { stopped = true; }; });
    expect(await fs.readFile(path, "utf8")).toBe("approved bytes");
    revoke();
    await selection.release();
    expect(stopped).toBe(true);
    await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(selection.dispatch(destination, async () => {})).rejects.toMatchObject({ code: "upload-revoked" });
  });
});
