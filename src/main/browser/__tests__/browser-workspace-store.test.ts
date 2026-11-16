import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWorkspaceStore } from "../browser-workspace-store.js";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "../../storage/feature-namespace.js";
import { BROWSER_WORKSPACE_LIMITS } from "../../../shared/browser-workspace.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function namespace() {
  const dir = await mkdtemp(join(tmpdir(), "ave-browser-store-")); directories.push(dir); vi.stubEnv("AVE_HOME", dir);
  return openFeatureNamespace("browser-workspace");
}

describe("browser workspace storage", () => {
  it("persists canonical bookmarks, bounded visit records and explicit decisions through private atomic storage", async () => {
    const ns = await namespace();
    const store = new BrowserWorkspaceStore(ns, () => 123);
    await store.setBookmark({ url: "https://site.example", title: "Site", bookmarked: true });
    await store.recordVisit("https://site.example/", "Visited", "user");
    await store.updateHistoryTitle("https://site.example/", "Loaded title");
    await store.setSitePermission({ origin: "https://site.example", permission: "camera", decision: "allow" });
    const reloaded = new BrowserWorkspaceStore(ns);
    expect(await reloaded.snapshot()).toEqual({ bookmarks: [{ url: "https://site.example/", title: "Site", at: 123 }], history: [{ url: "https://site.example/", title: "Loaded title", at: 123, by: "user" }], sitePermissions: [{ origin: "https://site.example", permission: "camera", decision: "allow" }], storageStatus: "ready" });
    if (process.platform !== "win32") { expect((await stat(ns.dir)).mode & 0o777).toBe(0o700); expect((await stat(join(ns.dir, "workspace.json"))).mode & 0o777).toBe(0o600); }
    await reloaded.clearHistory();
    await reloaded.setBookmark({ url: "https://site.example/", title: "", bookmarked: false });
    await reloaded.setSitePermission({ origin: "https://site.example", permission: "camera", decision: "ask" });
    expect((await reloaded.snapshot()).sitePermissions).toEqual([]);
    expect((await reloaded.snapshot()).bookmarks).toEqual([]);
    expect((await reloaded.snapshot()).history).toEqual([]);
  });
  it("preserves corrupt saved bytes, denies grants, and refuses to overwrite the evidence", async () => {
    const ns = await namespace();
    await ns.writeJson("workspace.json", { version: 1, bookmarks: [], history: [], sitePermissions: [{ origin: "https://site.example", permission: "camera", decision: "grant" }] });
    const path = join(ns.dir, "workspace.json");
    const before = await readFile(path, "utf8");
    const store = new BrowserWorkspaceStore(ns);
    expect((await store.snapshot()).storageStatus).toBe("corrupt");
    expect(store.peekDecision("https://site.example", "camera")).toBe("block");
    await expect(store.clearHistory()).rejects.toThrow("storage-unavailable");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("keeps newest unique records within a fixed bound and does not publish a failed write", async () => {
    const ns = await namespace();
    const writeJson = vi.fn(async () => undefined);
    const handle: FeatureNamespaceHandle = { ...ns, writeJson };
    const store = new BrowserWorkspaceStore(handle, () => 1);
    for (let i = 0; i <= BROWSER_WORKSPACE_LIMITS.bookmarks; i++) await store.setBookmark({ url: `https://site.example/${i}`, title: String(i), bookmarked: true });
    const before = await store.snapshot();
    expect(before.bookmarks).toHaveLength(BROWSER_WORKSPACE_LIMITS.bookmarks);
    expect(before.bookmarks[0]?.url).toBe(`https://site.example/${BROWSER_WORKSPACE_LIMITS.bookmarks}`);
    writeJson.mockRejectedValueOnce(new Error("disk-failed"));
    await expect(store.setBookmark({ url: "https://other.example/", title: "Other", bookmarked: true })).rejects.toThrow("disk-failed");
    expect(await store.snapshot()).toEqual(before);
  });
  it("serializes concurrent mutations without losing a prior entry", async () => {
    const store = new BrowserWorkspaceStore(await namespace());
    await Promise.all(["a", "b", "c"].map((name) => store.setBookmark({ url: `https://${name}.example/`, title: name, bookmarked: true })));
    expect((await store.snapshot()).bookmarks.map((entry) => entry.title)).toEqual(["c", "b", "a"]);
  });
  it("reloads valid bounded collections whose serialized URLs exceed two megabytes", async () => {
    const ns = await namespace();
    const history = Array.from({ length: 300 }, (_, index) => ({ url: `https://site.example/${index}?q=${"a".repeat(8000)}`, title: "Site", at: index }));
    await ns.writeJson("workspace.json", { version: 1, bookmarks: [], history, sitePermissions: [] });
    const snapshot = await new BrowserWorkspaceStore(ns).snapshot();
    expect(snapshot.storageStatus).toBe("ready"); expect(snapshot.history).toHaveLength(300);
  });
  it("normalizes actual storage I/O errors while preserving unexpected internal failures", async () => {
    const ns = await namespace();
    const writeJson = vi.fn(async () => undefined);
    const store = new BrowserWorkspaceStore({ ...ns, writeJson });
    writeJson.mockRejectedValueOnce(Object.assign(new Error("private storage path"), { code: "ENOSPC" }));
    await expect(store.clearHistory()).rejects.toThrow("storage-unavailable");
    writeJson.mockRejectedValueOnce(new TypeError("Invalid namespace callback"));
    await expect(store.clearHistory()).rejects.toThrow("Invalid namespace callback");
  });
  it("reads a file written before visits recorded who made them as the user's history, and writes the new shape on the next change", async () => {
    const ns = await namespace();
    await ns.writeJson("workspace.json", { version: 1, bookmarks: [{ url: "https://saved.example/", title: "Saved", at: 5 }], history: [{ url: "https://old.example/", title: "Old", at: 7 }], sitePermissions: [] });
    const store = new BrowserWorkspaceStore(ns, () => 9);
    expect(await store.snapshot()).toEqual({ bookmarks: [{ url: "https://saved.example/", title: "Saved", at: 5 }], history: [{ url: "https://old.example/", title: "Old", at: 7, by: "user" }], sitePermissions: [], storageStatus: "ready" });
    await store.recordVisit("https://new.example/", "New", "agent");
    const written = JSON.parse(await readFile(join(ns.dir, "workspace.json"), "utf8"));
    expect(written).toEqual({ version: 2, bookmarks: [{ url: "https://saved.example/", title: "Saved", at: 5 }], sitePermissions: [],
      history: [{ url: "https://new.example/", title: "New", at: 9, by: "agent" }, { url: "https://old.example/", title: "Old", at: 7, by: "user" }] });
    expect((await new BrowserWorkspaceStore(ns).snapshot()).history).toHaveLength(2);
  });
  it("refuses a file whose version and entry shape disagree instead of guessing who visited", async () => {
    for (const file of [
      { version: 2, bookmarks: [], history: [{ url: "https://old.example/", title: "Old", at: 7 }], sitePermissions: [] },
      { version: 1, bookmarks: [], history: [{ url: "https://old.example/", title: "Old", at: 7, by: "agent" }], sitePermissions: [] },
      { version: 2, bookmarks: [], history: [{ url: "https://old.example/", title: "Old", at: 7, by: "page" }], sitePermissions: [] },
      { version: 3, bookmarks: [], history: [], sitePermissions: [] },
    ]) {
      const ns = await namespace();
      await ns.writeJson("workspace.json", file);
      expect((await new BrowserWorkspaceStore(ns).snapshot()).storageStatus).toBe("corrupt");
    }
  });
  it("refuses a file whose saved time is not a time a date can hold, in either version", async () => {
    for (const at of [1e20, 8.64e15 + 1, 1.5, -1]) {
      for (const file of [
        { version: 1, bookmarks: [], history: [{ url: "https://old.example/", title: "Old", at }], sitePermissions: [] },
        { version: 2, bookmarks: [], history: [{ url: "https://old.example/", title: "Old", at, by: "user" }], sitePermissions: [] },
        { version: 2, bookmarks: [{ url: "https://old.example/", title: "Old", at }], history: [], sitePermissions: [] },
      ]) {
        const ns = await namespace();
        await ns.writeJson("workspace.json", file);
        expect((await new BrowserWorkspaceStore(ns).snapshot()).storageStatus).toBe("corrupt");
      }
    }
    const ns = await namespace();
    await ns.writeJson("workspace.json", { version: 2, bookmarks: [], history: [{ url: "https://old.example/", title: "Old", at: 8.64e15, by: "user" }], sitePermissions: [] });
    expect((await new BrowserWorkspaceStore(ns).snapshot()).storageStatus).toBe("ready");
  });
  it("keeps the user's and the agent's visit to one address as two entries and removes exactly the one named", async () => {
    const store = new BrowserWorkspaceStore(await namespace(), () => 3);
    await store.recordVisit("https://site.example/", "Site", "user");
    await store.recordVisit("https://site.example/", "Site", "agent");
    await store.recordVisit("https://site.example/", "Site again", "user");
    expect((await store.snapshot()).history).toEqual([{ url: "https://site.example/", title: "Site again", at: 3, by: "user" }, { url: "https://site.example/", title: "Site", at: 3, by: "agent" }]);
    await store.deleteHistory({ url: "https://site.example/", by: "agent" });
    expect((await store.snapshot()).history.map((entry) => entry.by)).toEqual(["user"]);
    await expect(store.deleteHistory({ url: "javascript:alert(1)", by: "user" })).rejects.toThrow("bad-request");
  });
});
