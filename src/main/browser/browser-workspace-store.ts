import { promises as fs } from "node:fs";
import { join } from "node:path";
import { openFeatureNamespace, type FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { BROWSER_WORKSPACE_LIMITS, parseBrowserWorkspaceRequest, parseBrowserWorkspaceState, type BrowserBookmarkRequest, type BrowserLibraryEntry, type BrowserSiteDecision, type BrowserSitePermission, type BrowserSiteRule } from "../../shared/browser-workspace.js";

interface PersistedWorkspace {
  readonly version: 1;
  readonly bookmarks: readonly BrowserLibraryEntry[];
  readonly history: readonly BrowserLibraryEntry[];
  readonly sitePermissions: readonly BrowserSiteRule[];
}
const EMPTY: PersistedWorkspace = { version: 1, bookmarks: [], history: [], sitePermissions: [] };
const MAX_STORAGE_BYTES = 24_000_000;
const STORAGE_IO_ERRORS: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "ENOTDIR", "EISDIR", "EFBIG", "EMFILE", "ENFILE", "ENAMETOOLONG", "EBADF", "ENODEV", "ELOOP", "ESTALE", "EBUSY", "EINVAL", "EDQUOT", "ENOENT"]);
function storageError(error: unknown): never {
  if (error instanceof Error && STORAGE_IO_ERRORS.has(String((error as NodeJS.ErrnoException).code))) throw new Error("storage-unavailable", { cause: error });
  throw error;
}

export class BrowserWorkspaceStore {
  private value: PersistedWorkspace = EMPTY;
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private status: "ready" | "corrupt" = "ready";
  constructor(private readonly namespace: FeatureNamespaceHandle = openFeatureNamespace("browser-workspace"), private readonly now: () => number = Date.now) {}

  private load(): Promise<void> {
    return this.loading ??= (async () => {
      let raw: string;
      try {
        const path = join(this.namespace.dir, "workspace.json");
        const stat = await fs.stat(path);
        if (stat.size > MAX_STORAGE_BYTES) { this.status = "corrupt"; return; }
        raw = await fs.readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        storageError(error);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { this.status = "corrupt"; return; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { this.status = "corrupt"; return; }
      const record = parsed as Record<string, unknown>;
      if (record.version !== 1 || Object.keys(record).length !== 4 || !parseBrowserWorkspaceState({ revision: 0, bookmarks: record.bookmarks, history: record.history, sitePermissions: record.sitePermissions, downloads: [], tabs: [], storageStatus: "ready", capabilities: { fullscreen: false } })) { this.status = "corrupt"; return; }
      this.value = record as unknown as PersistedWorkspace;
    })();
  }

  async snapshot(): Promise<Omit<PersistedWorkspace, "version"> & { storageStatus: "ready" | "corrupt" }> {
    await this.load();
    await this.writes;
    return structuredClone({ bookmarks: this.value.bookmarks, history: this.value.history, sitePermissions: this.value.sitePermissions, storageStatus: this.status });
  }

  private async update(change: (value: PersistedWorkspace) => PersistedWorkspace): Promise<void> {
    await this.load();
    if (this.status === "corrupt") throw new Error("storage-unavailable");
    const pending = this.writes.then(async () => {
      const next = change(this.value);
      if (next === this.value) return;
      try { await this.namespace.writeJson("workspace.json", next); } catch (error) { storageError(error); }
      this.value = next;
    });
    this.writes = pending.catch(() => undefined);
    await pending;
  }

  async setBookmark(request: BrowserBookmarkRequest): Promise<void> {
    const parsed = parseBrowserWorkspaceRequest("setBookmark", request);
    if (!parsed) throw new Error("bad-request");
    await this.update((value) => ({ ...value, bookmarks: [
      ...(parsed.bookmarked ? [{ url: parsed.url, title: parsed.title, at: this.now() }] : []),
      ...value.bookmarks.filter((entry) => entry.url !== parsed.url),
    ].slice(0, BROWSER_WORKSPACE_LIMITS.bookmarks) }));
  }

  async recordVisit(url: string, title: string): Promise<void> {
    const parsed = parseBrowserWorkspaceRequest("setBookmark", { url, title: title.slice(0, BROWSER_WORKSPACE_LIMITS.titleLength), bookmarked: true });
    if (!parsed) return;
    await this.update((value) => ({ ...value, history: [{ url: parsed.url, title: parsed.title, at: this.now() }, ...value.history.filter((entry) => entry.url !== parsed.url)].slice(0, BROWSER_WORKSPACE_LIMITS.history) }));
  }
  async updateHistoryTitle(url: string, title: string): Promise<void> {
    const parsed = parseBrowserWorkspaceRequest("setBookmark", { url, title: title.slice(0, BROWSER_WORKSPACE_LIMITS.titleLength), bookmarked: true });
    if (!parsed) return;
    await this.update((value) => value.history.some((entry) => entry.url === parsed.url && entry.title !== parsed.title)
      ? { ...value, history: value.history.map((entry) => entry.url === parsed.url ? { ...entry, title: parsed.title } : entry) }
      : value);
  }
  clearHistory(): Promise<void> { return this.update((value) => ({ ...value, history: [] })); }
  async setSitePermission(rule: BrowserSiteRule): Promise<void> {
    const parsed = parseBrowserWorkspaceRequest("setSitePermission", { ...rule, tabId: "site-rule", documentGeneration: 1 });
    if (!parsed) throw new Error("bad-request");
    await this.update((value) => ({ ...value, sitePermissions: [
      ...(rule.decision === "ask" ? [] : [rule]),
      ...value.sitePermissions.filter((entry) => entry.origin !== rule.origin || entry.permission !== rule.permission),
    ].slice(0, BROWSER_WORKSPACE_LIMITS.sitePermissions) }));
  }
  async decision(origin: string, permission: BrowserSitePermission): Promise<BrowserSiteDecision> {
    const value = await this.snapshot();
    return value.sitePermissions.find((rule) => rule.origin === origin && rule.permission === permission)?.decision ?? "ask";
  }
  peekDecision(origin: string, permission: BrowserSitePermission): BrowserSiteDecision {
    if (this.status !== "ready") return "block";
    return this.value.sitePermissions.find((rule) => rule.origin === origin && rule.permission === permission)?.decision ?? "ask";
  }
}
