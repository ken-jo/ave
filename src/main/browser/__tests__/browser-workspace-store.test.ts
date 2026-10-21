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
    await store.recordVisit("https://site.example/", "Visited");
    await store.updateHistoryTitle("https://site.example/", "Loaded title");
    await store.setSitePermission({ origin: "https://site.example", permission: "camera", decision: "allow" });
    const reloaded = new BrowserWorkspaceStore(ns);
    expect(await reloaded.snapshot()).toEqual({ bookmarks: [{ url: "https://site.example/", title: "Site", at: 123 }], history: [{ url: "https://site.example/", title: "Loaded title", at: 123 }], sitePermissions: [{ origin: "https://site.example", permission: "camera", decision: "allow" }], storageStatus: "ready" });
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
});
