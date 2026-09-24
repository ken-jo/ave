/**
 * The git marketplace as one service (design §6, §7, §8, §13, §15): what the
 * `ave:marketplace:*` channels do.
 *
 * Sources come from the registry and are read through the syncer's
 * snapshots; the catalog is the aggregate of the shown sources' snapshots
 * with each row's state against what is installed. An install is planned
 * first (single-use `planId`, bound to the row's snapshot commit and the
 * version's commit) and executed later by id, so what the user reviewed is
 * what installs. Each kind's installer is a port the host composition
 * provides; the service plans, stages the bytes and dispatches.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { renameDirectory } from "../../lib/transient-fs-lock-retry.js";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import type {
  CatalogEntryView,
  CatalogQuery,
  CatalogView,
  DirectMcpPreviewRequest,
  DirectMcpPreviewView,
  InstallPlanRequest,
  InstallPlanView,
  InstallProgressView,
  InstallResultView,
  McpRuntimeView,
  PackageDetailView,
  PackageKeyView,
  SourceAddRequest,
  SourcePreviewRequest,
  SourcePreviewView,
  SourceView,
  SyncProgressView,
  UninstallRequest,
  UninstallResultView,
  UpdatePlanView,
} from "../../shared/git-marketplace.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import { aggregateCatalog, versionExclusions, type CatalogRow, type VersionChoiceContext } from "../catalog/aggregate.js";
import { PACKAGE_KINDS, type IndexVersion, type PackageKind, type PluginAuthority } from "../catalog/types.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { stageContentPackage } from "../content/store.js";
import { errorMessage } from "../../shared/error-message.js";
import { MarketplaceError } from "../errors.js";
import { BareRepo } from "../git/repo.js";
import type { GitCommands, GitRemote } from "../git/run-git.js";
import type { NetworkGate } from "../net/network-gate.js";
import { normalizeSourceHost, normalizeSourceUrl, type NormalizedSourceUrl } from "../net/source-url.js";
import { candidateVersion, planPackage, type PackagePlan } from "../resolve/descriptor.js";
import { classifyInstall, type InstalledPackage } from "../resolve/identity.js";
import { assertMcpRuntimePinned, resolveMcpPackage, runtimeFromServerJson, type ResolvedMcpServer } from "../resolve/mcp.js";
import { planPluginVersion, runPluginLadder, type LadderDeps, type PluginInstallPlan } from "../resolve/plugin-ladder.js";
import { assertNotRequiredByPolicy, requiredByPolicy } from "../boot-installs/run.js";
import { readDirectPackage } from "../sources/direct-package.js";
import { isReservedSourceId, SOURCE_ID_RE, type SourceAuth } from "../sources/official.js";
import type { MarketplacePolicy } from "../sources/policy.js";
import type { ResolvedSource, SourceRegistry, SourceState } from "../sources/registry.js";
import { SnapshotBuilder, type SourceSnapshot } from "../sources/snapshot.js";
import { shouldSyncSource, type SourceSyncer } from "../sources/sync.js";
import { Tickets } from "./tickets.js";
import type { InstallerPorts, InstalledRecord, TokenStore } from "./ports.js";
import {
  authorityDelta,
  authorityView,
  installActionView,
  rowState,
  rungOutcomeViews,
  rungViews,
  runsCode,
  sourceStatus,
  versionViews,
  widensAuthority,
} from "./views.js";

type ContentPlan = PackagePlan & { kind: Exclude<PackageKind, "plugin" | "mcp"> };

type HeldPlan =
  | { kind: "plugin"; plan: PluginInstallPlan; switchSource: boolean }
  | { kind: "content"; plan: ContentPlan; switchSource: boolean }
  | { kind: "mcp"; resolved: ResolvedMcpServer; switchSource: boolean }
  | { kind: "mcp-unbound"; name: string; runtime: McpRuntimeSpec };

interface HeldPreview {
  sourceId: string;
  dir: string;
  url: NormalizedSourceUrl;
  ref: string | null;
  subdir: string | null;
  auth: SourceAuth;
  token: string | null;
  origin: "custom" | "direct";
  suggestedId: string;
}

export interface MarketplaceServiceOptions {
  registry: SourceRegistry;
  syncer: SourceSyncer;
  /** The runner every repository uses, and whether an OS credential helper answers for a host. */
  git: { commands: GitCommands; credentialHelperFor(host: string): Promise<boolean> };
  gate: NetworkGate;
  /** `~/.ave/marketplaces`. */
  root: string;
  /** Scratch directory for exports and preview clones. */
  workRoot: string;
  policy: MarketplacePolicy;
  tokens: TokenStore;
  /** Tokens typed into the add dialog, by preview source id; read by the askpass lookup. */
  previewTokens: Map<string, string>;
  versionContext: () => VersionChoiceContext;
  installers: InstallerPorts;
  ladder: Pick<LadderDeps, "fetchImpl" | "zip" | "limits">;
  mcpLimits: LadderDeps["limits"];
  english: Readonly<Record<string, string>>;
  onSyncProgress?: (progress: SyncProgressView) => void;
  onCatalogChanged?: () => void;
  onInstallProgress?: (progress: InstallProgressView) => void;
  now?: () => Date;
}

const PREVIEW_ID_PREFIX = "preview-";

function keyOf(kind: PackageKind, name: string): string {
  return `${kind}:${name}`;
}

function sourceLabel(source: ResolvedSource, snapshot: SourceSnapshot | null): string {
  return source.label ?? snapshot?.marketplace.displayName ?? source.id;
}

function mcpRuntimeView(runtime: McpRuntimeSpec): McpRuntimeView {
  if (runtime.transport === "http") {
    return {
      transport: "http",
      command: null,
      args: [],
      url: runtime.url,
      env: runtime.auth === "api-key" && runtime.apiKeyHeader ? [{ name: runtime.apiKeyHeader, secret: true, required: true }] : [],
      usesDataDir: false,
    };
  }
  const env = Object.keys(runtime.env ?? {}).map((name) => ({ name, secret: false, required: false }));
  if (runtime.apiKeyEnv) env.push({ name: runtime.apiKeyEnv, secret: true, required: true });
  const text = [runtime.command, ...(runtime.args ?? []), ...Object.values(runtime.env ?? {})].join("\n");
  return { transport: "stdio", command: runtime.command, args: [...(runtime.args ?? [])], url: null, env, usesDataDir: /\$DATA_DIR(?![A-Za-z0-9_])/u.test(text) };
}

/** A source id from a name: lowercase, `-` for anything else, never reserved. */
function idFrom(raw: string): string | null {
  const id = raw.toLowerCase().replace(/\.git$/u, "").replace(/[^a-z0-9-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^-+|-+$/gu, "");
  return SOURCE_ID_RE.test(id) && !isReservedSourceId(id) ? id : null;
}

export class MarketplaceService {
  private readonly plans: Tickets<HeldPlan>;
  private readonly previews: Tickets<HeldPreview>;
  private readonly syncing = new Set<string>();

  constructor(private readonly options: MarketplaceServiceOptions) {
    const now = () => (options.now?.() ?? new Date()).getTime();
    this.plans = new Tickets<HeldPlan>("install plan", now);
    this.previews = new Tickets<HeldPreview>("marketplace preview", now, undefined, (preview) => {
      options.previewTokens.delete(preview.sourceId);
      void rm(preview.dir, { recursive: true, force: true });
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get registry(): SourceRegistry {
    return this.options.registry;
  }

  private source(id: string): ResolvedSource {
    const source = this.registry.get(id);
    if (!source) throw new MarketplaceError("SOURCE_ID_INVALID", `no source named ${id}`);
    return source;
  }

  /**
   * A source's state and the snapshot at its pin. A state or snapshot file
   * that cannot be read is reported as the source's problem, never read as a
   * fresh source: the Sources view shows it and the catalog leaves the
   * source out until it is repaired or removed.
   */
  private async read(source: ResolvedSource): Promise<{ state: SourceState; snapshot: SourceSnapshot | null } | { problem: string }> {
    try {
      const state = await this.registry.readState(source.id);
      return { state, snapshot: await this.options.syncer.readSnapshot(source.id) };
    } catch (error) {
      return { problem: errorMessage(error) };
    }
  }

  // ─── sources ──────────────────────────────────────────────────────────────

  private async sourceView(source: ResolvedSource): Promise<SourceView> {
    const read = await this.read(source);
    const state = "problem" in read ? null : read.state;
    const snapshot = "problem" in read ? null : read.snapshot;
    const reviewable = source.origin === "custom" || source.origin === "direct";
    const tokenHost = source.auth.kind === "token" ? source.auth.host : null;
    return {
      id: source.id,
      origin: source.origin,
      label: sourceLabel(source, snapshot),
      url: source.url.url,
      ref: source.ref ?? null,
      subdir: source.subdir ?? null,
      mirrors: source.mirrors.length,
      auth: source.auth.kind,
      tokenHost,
      tokenStored: tokenHost !== null && this.options.tokens.has(tokenHost),
      pinnedCommit: state?.pinnedCommit ?? null,
      lastSyncAt: state?.lastSync?.at ?? null,
      marketplace: snapshot
        ? {
            name: snapshot.marketplace.name,
            displayName: snapshot.marketplace.displayName,
            description: snapshot.marketplace.description ?? null,
            owner: snapshot.marketplace.owner?.name ?? null,
          }
        : null,
      packageCount: snapshot?.packages.length ?? 0,
      status: "problem" in read ? { state: "broken", problem: read.problem } : sourceStatus(read.state, this.syncing.has(source.id), snapshot !== null, reviewable),
      enabled: state ? this.registry.isEnabled(source, state) : !this.registry.canDisable(source),
      canDisable: this.registry.canDisable(source),
      canRemove: reviewable,
      diagnostics: (snapshot?.diagnostics ?? []).map((item) => `${item.subject}: ${item.message}`),
    };
  }

  async listSources(): Promise<SourceView[]> {
    return Promise.all(this.registry.list().map((source) => this.sourceView(source)));
  }

  private async syncOne(id: string): Promise<void> {
    this.syncing.add(id);
    this.options.onSyncProgress?.({ sourceId: id, state: "syncing" });
    try {
      const result = await this.options.syncer.sync(id);
      this.options.onSyncProgress?.({ sourceId: id, state: result.status === "ok" ? "done" : "failed" });
    } catch (error) {
      this.options.onSyncProgress?.({ sourceId: id, state: "failed" });
      throw error;
    } finally {
      this.syncing.delete(id);
    }
  }

  /** Sync one source, or every source that is shown or has installed packages (§7.3). */
  async refresh(id?: string): Promise<SourceView[]> {
    let ids: string[];
    if (id !== undefined) {
      ids = [this.source(id).id];
    } else {
      const bound = new Set((await this.installedAll()).map((item) => item.sourceId).filter((sourceId): sourceId is string => sourceId !== null));
      ids = [];
      for (const source of this.registry.list()) {
        const read = await this.read(source);
        // A broken source is listed with its problem; syncing it would only fail again.
        if ("problem" in read) continue;
        if (shouldSyncSource(this.registry, source, read.state, bound.has(source.id))) ids.push(source.id);
      }
    }
    // Every source finishes; a failure outside a sync result (a bug, an unreadable file) is reported after.
    const settled = await Promise.allSettled(ids.map((sourceId) => this.syncOne(sourceId)));
    const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed) throw failed.reason;
    return this.listSources();
  }

  async setEnabled(id: string, enabled: boolean): Promise<SourceView> {
    await this.registry.setEnabled(id, enabled);
    this.options.onCatalogChanged?.();
    return this.sourceView(this.source(id));
  }

  async acceptRewrite(id: string, commit: string): Promise<SourceView> {
    const result = await this.options.syncer.acceptRewrite(id, commit);
    if (result.status === "failed") throw new MarketplaceError(result.code, result.message);
    return this.sourceView(this.source(id));
  }

  /** Remove a custom or direct source; its installed packages stay and are listed (§7.6). */
  async removeSource(id: string): Promise<{ orphanedPackages: PackageKeyView[] }> {
    const source = this.source(id);
    if (source.origin === "official" || source.origin === "managed") {
      throw new MarketplaceError("SOURCE_POLICY_BLOCKED", `the ${source.origin} source ${id} cannot be removed`);
    }
    const orphaned = (await this.installedAll()).filter((item) => item.sourceId === id).map((item) => ({ sourceId: id, kind: item.kind, name: item.name }));
    await this.options.syncer.removeSource(id);
    this.options.onCatalogChanged?.();
    return { orphanedPackages: orphaned };
  }

  async setToken(host: string, token: string): Promise<{ host: string }> {
    const normalized = normalizeSourceHost(host, host);
    if (token.length === 0 || /[\r\n]/u.test(token)) throw new MarketplaceError("SOURCE_AUTH_REQUIRED", "the token is empty or spans lines");
    await this.options.tokens.set(normalized, token);
    return { host: normalized };
  }

  async deleteToken(host: string): Promise<{ host: string }> {
    const normalized = normalizeSourceHost(host, host);
    await this.options.tokens.delete(normalized);
    return { host: normalized };
  }

  // ─── add (preview → confirm, §7.2) ─────────────────────────────────────

  private freeId(candidates: ReadonlyArray<string | null>): string {
    const taken = new Set(this.registry.list().map((source) => source.id));
    for (const candidate of candidates) {
      if (!candidate) continue;
      for (let suffix = 1; suffix < 100; suffix += 1) {
        const id = suffix === 1 ? candidate : `${candidate.slice(0, 60)}-${suffix}`;
        if (!taken.has(id)) return id;
      }
    }
    return `source-${randomBytes(3).toString("hex")}`;
  }

  async previewSource(request: SourcePreviewRequest): Promise<SourcePreviewView> {
    const url = normalizeSourceUrl(request.input);
    if (request.auth === "ssh" && url.scheme !== "ssh") throw new MarketplaceError("SOURCE_URL_REJECTED", "SSH sign-in needs an ssh:// or git@host:path address");
    if (request.auth !== "ssh" && url.scheme === "ssh") throw new MarketplaceError("SOURCE_URL_REJECTED", "an ssh address needs SSH sign-in");
    const auth: SourceAuth = request.auth === "token" ? { kind: "token", host: url.host } : { kind: request.auth };
    const subdir = request.subdir?.trim() ? request.subdir.trim().replace(/^\/+|\/+$/gu, "") : null;
    const ref = request.ref?.trim() ? request.ref.trim() : null;
    const sourceId = `${PREVIEW_ID_PREFIX}${randomBytes(9).toString("hex")}`;
    const { allowHttp } = await this.options.gate.checkRemote(url, { official: false });
    const token = request.auth === "token" && request.token ? request.token : null;
    if (token) this.options.previewTokens.set(sourceId, token);
    const remote: GitRemote = { url, sourceId, allowHttp, useToken: auth.kind === "token" };
    const dir = join(this.options.root, ".previews", sourceId);
    const drop = async () => {
      this.options.previewTokens.delete(sourceId);
      await rm(dir, { recursive: true, force: true });
    };
    try {
      const repo = await BareRepo.init(this.options.git.commands, join(dir, "repo.git"));
      const commit = await repo.fetchRef(remote, ref ?? undefined, "candidate");
      const credentialHelper = await this.options.git.credentialHelperFor(url.host);
      const pathName = url.path.split("/").filter(Boolean).pop() ?? "";
      if (subdir === null) {
        const source: ResolvedSource = { id: sourceId, origin: "custom", url, mirrors: [], auth, ...(ref ? { ref } : {}) };
        const built = await new SnapshotBuilder(repo, remote, source, commit).build(this.now().toISOString());
        if (built.ok) {
          const counts: Partial<Record<PackageKind, number>> = {};
          for (const pkg of built.snapshot.packages) counts[pkg.kind] = (counts[pkg.kind] ?? 0) + 1;
          const suggestedId = this.freeId([idFrom(built.snapshot.marketplace.name), idFrom(pathName)]);
          const held = this.previews.issue({ sourceId, dir, url, ref, subdir: null, auth, token, origin: "custom", suggestedId });
          return {
            type: "marketplace",
            previewId: held.id,
            expiresAt: held.expiresAt,
            url: url.url,
            ref,
            commit,
            marketplace: {
              name: built.snapshot.marketplace.name,
              displayName: built.snapshot.marketplace.displayName,
              description: built.snapshot.marketplace.description ?? null,
              owner: built.snapshot.marketplace.owner?.name ?? null,
            },
            counts,
            codeRunning: built.snapshot.packages.filter((pkg) => runsCode(pkg.kind)).length,
            diagnostics: built.snapshot.diagnostics.map((item) => `${item.subject}: ${item.message}`),
            credentialHelper,
            suggestedId,
          };
        }
        if (built.code !== "SOURCE_NOT_A_MARKETPLACE") throw new MarketplaceError(built.code, built.message);
      }
      // A single package at the root or the given folder: a direct source (§7.2 step 4, §8.1).
      const read = await readDirectPackage({ repo, remote, commit, path: subdir ?? "" });
      if (!read) throw new MarketplaceError("SOURCE_NOT_A_MARKETPLACE", `no marketplace and no package at ${subdir ?? "the repository root"}`);
      if (!read.ok) throw new MarketplaceError(read.code, read.error);
      const { descriptor, detectedFrom, versionSynthesized } = read.found;
      const suggestedId = this.freeId([idFrom(descriptor.name), idFrom(pathName)]);
      const held = this.previews.issue({ sourceId, dir, url, ref, subdir, auth, token, origin: "direct", suggestedId });
      return {
        type: "package",
        previewId: held.id,
        expiresAt: held.expiresAt,
        url: url.url,
        ref,
        subdir,
        commit,
        detectedFrom,
        kind: descriptor.kind,
        name: descriptor.name,
        displayName: descriptor.displayName ?? null,
        description: descriptor.description ?? null,
        version: descriptor.version,
        versionSynthesized,
        runsCode: runsCode(descriptor.kind),
        credentialHelper,
        suggestedId,
      };
    } catch (error) {
      await drop();
      throw error;
    }
  }

  /**
   * Write the entry, then the state, then move the preview's repository into
   * place and sync (§7.2 step 6): a repo.git without a state reads as lost.
   */
  async addSource(request: SourceAddRequest): Promise<SourceView> {
    const preview = this.previews.take(request.previewId);
    try {
      const id = request.id?.trim() || preview.suggestedId;
      await this.registry.add({
        id,
        origin: preview.origin,
        url: preview.url.url,
        ...(preview.ref ? { ref: preview.ref } : {}),
        ...(preview.subdir ? { subdir: preview.subdir } : {}),
        auth: preview.auth,
        ...(request.label?.trim() ? { label: request.label.trim() } : {}),
      });
      if (preview.token && preview.auth.kind === "token") await this.options.tokens.set(preview.auth.host, preview.token);
      await this.registry.updateState(id, (state) => state);
      try {
        await renameDirectory(join(preview.dir, "repo.git"), join(this.options.root, id, "repo.git"));
      } catch (error) {
        // The sync fetches from scratch instead.
        if (!isMissingPathError(error)) throw error;
      }
      await this.syncOne(id);
      this.options.onCatalogChanged?.();
      return this.sourceView(this.source(id));
    } finally {
      this.options.previewTokens.delete(preview.sourceId);
      await rm(preview.dir, { recursive: true, force: true });
    }
  }

  // ─── catalog ──────────────────────────────────────────────────────────────

  private async installedAll(): Promise<InstalledRecord[]> {
    const [plugins, content, mcp] = await Promise.all([
      this.options.installers.plugin.list(),
      this.options.installers.content.list(),
      this.options.installers.mcp.list(),
    ]);
    return [...plugins, ...content, ...mcp];
  }

  /** Rows of every shown source that has a snapshot, with the sources that have one. */
  private async rows(): Promise<{ rows: CatalogRow[]; snapshots: Map<string, SourceSnapshot>; shown: ResolvedSource[] }> {
    const shown: ResolvedSource[] = [];
    const snapshots = new Map<string, SourceSnapshot>();
    for (const source of this.registry.list()) {
      const read = await this.read(source);
      // A source whose files cannot be read shows as broken in Sources and lists nothing.
      if ("problem" in read || !this.registry.isEnabled(source, read.state)) continue;
      shown.push(source);
      if (read.snapshot) snapshots.set(source.id, read.snapshot);
    }
    const rows = aggregateCatalog(
      shown.filter((source) => snapshots.has(source.id)).map((source) => ({ sourceId: source.id, sourceOrigin: source.origin, snapshot: snapshots.get(source.id)! })),
      this.options.versionContext(),
    );
    return { rows, snapshots, shown };
  }

  private entry(row: CatalogRow, installed: InstalledPackage | null, rows: readonly CatalogRow[], sources: ReadonlySet<string>, label: string): CatalogEntryView {
    return {
      key: { sourceId: row.sourceId, kind: row.kind, name: row.name },
      sourceOrigin: row.sourceOrigin,
      sourceLabel: label,
      displayName: row.package.displayName ?? row.name,
      description: row.package.description ?? "",
      keywords: [...(row.package.keywords ?? [])],
      state: rowState(row, installed, rows, sources),
      required: requiredByPolicy(this.options.policy, row.kind, row.name)?.source === row.sourceId,
      runsCode: runsCode(row.kind),
    };
  }

  async catalog(query: CatalogQuery): Promise<CatalogView> {
    const { rows, snapshots, shown } = await this.rows();
    const installed = new Map((await this.installedAll()).map((item) => [keyOf(item.kind, item.name), item]));
    const existing = new Set(this.registry.list().map((source) => source.id));
    const labels = new Map(shown.map((source) => [source.id, sourceLabel(source, snapshots.get(source.id) ?? null)]));
    const text = query.query?.trim().toLowerCase() ?? "";
    const matches = (entry: CatalogEntryView) =>
      (!query.sourceId || entry.key.sourceId === query.sourceId) &&
      (!text || [entry.key.name, entry.displayName, entry.description, ...entry.keywords].some((field) => field.toLowerCase().includes(text)));

    let entries = rows.map((row) => this.entry(row, installed.get(keyOf(row.kind, row.name)) ?? null, rows, existing, labels.get(row.sourceId) ?? row.sourceId));
    if (query.installedOnly) {
      entries = entries.filter((entry) => {
        const item = installed.get(keyOf(entry.key.kind, entry.key.name));
        return item !== undefined && item.sourceId === entry.key.sourceId;
      });
      // Installed packages whose source is gone or shows no row (§7.6): listed so they can be uninstalled.
      const listed = new Set(entries.map((entry) => keyOf(entry.key.kind, entry.key.name)));
      for (const item of installed.values()) {
        if (listed.has(keyOf(item.kind, item.name))) continue;
        if (item.sourceId === null) {
          entries.push({
            key: { sourceId: null, kind: item.kind, name: item.name },
            sourceOrigin: null,
            sourceLabel: null,
            displayName: item.name,
            description: "",
            keywords: [],
            state: { state: "unbound", version: item.version },
            required: false,
            runsCode: runsCode(item.kind),
          });
          continue;
        }
        entries.push({
          key: { sourceId: item.sourceId, kind: item.kind, name: item.name },
          sourceOrigin: this.registry.get(item.sourceId)?.origin ?? "custom",
          sourceLabel: labels.get(item.sourceId) ?? item.sourceId,
          displayName: item.name,
          description: "",
          keywords: [],
          state: existing.has(item.sourceId) ? { state: "installed", version: item.version } : { state: "source-removed", version: item.version },
          required: requiredByPolicy(this.options.policy, item.kind, item.name)?.source === item.sourceId,
          runsCode: runsCode(item.kind),
        });
      }
    }
    entries = entries.filter(matches);
    const counts = Object.fromEntries(PACKAGE_KINDS.map((kind) => [kind, 0])) as Record<PackageKind, number>;
    for (const entry of entries) counts[entry.key.kind] += 1;
    const syncedAt = [...snapshots.values()].map((snapshot) => snapshot.fetchedAt).sort().pop() ?? null;
    return {
      entries: query.kind ? entries.filter((entry) => entry.key.kind === query.kind) : entries,
      counts,
      sourceCount: shown.length,
      syncedAt,
    };
  }

  private async row(key: PackageKeyView): Promise<{ row: CatalogRow; rows: CatalogRow[]; snapshot: SourceSnapshot; label: string }> {
    const { rows, snapshots, shown } = await this.rows();
    const row = rows.find((item) => item.sourceId === key.sourceId && item.kind === key.kind && item.name === key.name);
    const snapshot = snapshots.get(key.sourceId);
    const source = shown.find((item) => item.id === key.sourceId);
    if (!row || !snapshot || !source) {
      throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${key.sourceId} does not list ${key.kind} ${key.name}`);
    }
    return { row, rows, snapshot, label: sourceLabel(source, snapshot) };
  }

  private async installed(kind: PackageKind, name: string): Promise<InstalledRecord | null> {
    return (await this.installedAll()).find((item) => item.kind === kind && item.name === name) ?? null;
  }

  /** Whether the tree rung is declared: `artifact.tree`, or a plugin.json in the package directory (§6.2). */
  private async treeDeclared(sourceId: string, version: IndexVersion, packagePath: string): Promise<boolean> {
    if (version.artifact?.tree !== undefined) return true;
    const manifest = packagePath ? `${packagePath}/plugin.json` : "plugin.json";
    return this.options.syncer.withRepository(sourceId, async ({ repo }) =>
      (await repo.lsTree(version.commit, manifest, false)).some((entry) => entry.path === manifest && entry.type === "blob"),
    );
  }

  async detail(key: PackageKeyView): Promise<PackageDetailView> {
    const { row, rows, snapshot, label } = await this.row(key);
    const installed = await this.installed(key.kind, key.name);
    const existing = new Set(this.registry.list().map((source) => source.id));
    const context = this.options.versionContext();
    const shownVersion = row.choice.state === "candidate" ? row.choice.version : row.package.versions[0] ?? null;
    const installedHere = installed?.sourceId === key.sourceId ? installed.version : null;
    return {
      entry: this.entry(row, installed, rows, existing, label),
      provenance: {
        sourceLabel: label,
        repository: this.source(key.sourceId).url.url,
        path: row.package.path,
        snapshotCommit: row.snapshotCommit,
        versionCommit: shownVersion?.commit ?? null,
        publishedAt: shownVersion?.publishedAt ?? null,
      },
      compatibility: {
        minAppVersion: shownVersion?.minAppVersion ?? null,
        appVersion: context.appVersion,
        compatible: shownVersion ? appVersionSatisfiesMin(context.appVersion, shownVersion.minAppVersion) : false,
      },
      authority: shownVersion?.authority ? authorityView(shownVersion.authority) : null,
      rungs:
        row.kind === "plugin" && shownVersion?.artifact
          ? rungViews(shownVersion.artifact, row.package.path, await this.treeDeclared(key.sourceId, shownVersion, row.package.path))
          : [],
      versions: versionViews(row, snapshot.revocations, context, installedHere),
    };
  }

  // ─── plans and installs ─────────────────────────────────────────────────

  /** The version to install: the candidate, or a listed version the user chose (a rollback). */
  private chosenVersion(row: CatalogRow, snapshot: SourceSnapshot, requested: string | undefined): IndexVersion {
    if (requested === undefined) return candidateVersion(row);
    const version = row.package.versions.find((item) => item.version === requested);
    if (!version) throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${row.sourceId} does not list ${row.name} ${requested}`);
    const blocking = versionExclusions(row.sourceId, row.kind, row.name, version, snapshot.revocations, this.options.versionContext())
      // Choosing a version by hand overrides the rollout and the pre-release opt-in, nothing else.
      .filter((reason) => reason !== "rollout" && reason !== "prerelease");
    if (blocking.includes("revoked")) throw new MarketplaceError("PACKAGE_REVOKED", `${row.name} ${requested} is revoked by ${row.sourceId}`);
    if (blocking.includes("yanked")) throw new MarketplaceError("PACKAGE_YANKED", `${row.name} ${requested} is yanked`);
    if (blocking.length > 0) throw new MarketplaceError("PACKAGE_INCOMPATIBLE", `${row.name} ${requested} cannot be installed here (${blocking.join(", ")})`);
    return version;
  }

  private repositoryAccess<T>(sourceId: string, fn: (access: { repo: BareRepo; remote: GitRemote; direct: boolean }) => Promise<T>): Promise<T> {
    return this.options.syncer.withRepository(sourceId, ({ source, repo, remote }) => fn({ repo, remote, direct: source.origin === "direct" }));
  }

  async planInstall(request: InstallPlanRequest): Promise<InstallPlanView> {
    const { row, snapshot } = await this.row(request);
    const version = this.chosenVersion(row, snapshot, request.version);
    const installed = await this.installed(row.kind, row.name);
    const switchSource = request.switchSource === true;
    const required = requiredByPolicy(this.options.policy, row.kind, row.name);
    if (required && required.source !== row.sourceId && installed) {
      throw new MarketplaceError("PACKAGE_REQUIRED_BY_POLICY", `${row.kind} ${row.name} is required from ${required.source} by policy`);
    }
    const base = planPackage(row, version);
    const action = classifyInstall(base, installed, { switchSource });
    let held: HeldPlan;
    let mcp: McpRuntimeView | null = null;
    let rungs: InstallPlanView["rungs"] = [];
    if (row.kind === "plugin") {
      const plan = planPluginVersion(row, version);
      held = { kind: "plugin", plan, switchSource };
      rungs = rungViews(plan.artifact, plan.packagePath, await this.treeDeclared(row.sourceId, version, row.package.path));
    } else if (row.kind === "mcp") {
      const plan = { ...base, kind: "mcp" as const };
      // Resolved now so the review shows the command that will run.
      const resolved = await this.repositoryAccess(row.sourceId, (access) =>
        resolveMcpPackage(plan, { ...access, limits: this.options.mcpLimits, workRoot: this.options.workRoot }),
      );
      this.options.installers.mcp.admit(row.name, resolved.runtime);
      held = { kind: "mcp", resolved, switchSource };
      mcp = mcpRuntimeView(resolved.runtime);
    } else {
      held = { kind: "content", plan: base as ContentPlan, switchSource };
    }
    const ticket = this.plans.issue(held);
    return {
      planId: ticket.id,
      expiresAt: ticket.expiresAt,
      key: { sourceId: row.sourceId, kind: row.kind, name: row.name },
      displayName: row.package.displayName ?? row.name,
      version: version.version,
      snapshotCommit: row.snapshotCommit,
      versionCommit: version.commit,
      action: installActionView(action),
      runsCode: runsCode(row.kind),
      authority: version.authority ? authorityView(version.authority) : null,
      rungs,
      mcp,
    };
  }

  /** The update review (§15.6): commit range, authority delta, and rewritten history pending review. */
  async planUpdate(key: PackageKeyView): Promise<UpdatePlanView> {
    const installed = await this.installed(key.kind, key.name);
    if (!installed || installed.sourceId !== key.sourceId) {
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${key.kind} ${key.name} is not installed from ${key.sourceId}`);
    }
    const state = await this.registry.readState(key.sourceId);
    const source = this.source(key.sourceId);
    const historyRewritten =
      state.pendingRewrite && (source.origin === "custom" || source.origin === "direct")
        ? { pinned: state.pinnedCommit, candidate: state.pendingRewrite.candidate }
        : null;
    const plan = await this.planInstall(key);
    let delta: UpdatePlanView["authorityDelta"] = null;
    if (key.kind === "plugin" && plan.authority) {
      const { row } = await this.row(key);
      const listed = row.package.versions.find((item) => item.version === installed.version)?.authority;
      const previous: PluginAuthority | null = listed ?? (await this.options.installers.plugin.installedAuthority(key.name));
      delta = authorityDelta(previous ? authorityView(previous) : authorityView({ capabilities: [] }), plan.authority);
    }
    return {
      ...plan,
      from: installed.version,
      commitRange: { from: installed.originCommit, to: plan.snapshotCommit },
      authorityDelta: delta,
      historyRewritten,
      needsConfirmation: widensAuthority(delta) || historyRewritten !== null,
    };
  }

  private progress(planId: string, phase: InstallProgressView["phase"], rung: InstallProgressView["rung"] = null): void {
    this.options.onInstallProgress?.({ planId, phase, rung, bytes: null, total: null });
  }

  async executeInstall(planId: string): Promise<InstallResultView> {
    const held = this.plans.take(planId);
    this.progress(planId, "resolving");
    let result: InstallResultView;
    if (held.kind === "plugin") {
      const { plan } = held;
      const outcome = await this.options.installers.plugin.install(plan, {
        switchSource: held.switchSource,
        stage: (staged) =>
          this.options.syncer.withRepository(plan.sourceId, ({ source, repo, remote }) => {
            this.progress(planId, "downloading");
            return runPluginLadder(staged, {
              repo,
              remote,
              direct: source.origin === "direct",
              sourceUrl: source.url,
              gate: this.options.gate,
              fetchImpl: this.options.ladder.fetchImpl,
              sourceToken: this.tokenFor(source),
              tokenMissing: source.auth.kind === "token" && this.tokenFor(source) === null,
              zip: this.options.ladder.zip,
              limits: this.options.ladder.limits,
              workRoot: this.options.workRoot,
            });
          }).then((staged) => {
            this.progress(planId, "installing", staged.rung);
            return staged;
          }),
      });
      result = {
        key: { sourceId: plan.sourceId, kind: "plugin", name: plan.name },
        version: plan.version,
        action: installActionView(outcome.action),
        rungs: rungOutcomeViews(outcome.staged.rungs),
        connectionWarning: null,
      };
    } else if (held.kind === "content") {
      const { plan } = held;
      this.progress(planId, "downloading");
      const staged = await this.repositoryAccess(plan.sourceId, (access) =>
        stageContentPackage(plan, access, { workRoot: this.options.workRoot, english: this.options.english }),
      );
      this.progress(planId, "installing");
      const outcome = await this.options.installers.content.install(staged, { switchSource: held.switchSource });
      result = { key: { sourceId: plan.sourceId, kind: plan.kind, name: plan.name }, version: plan.version, action: installActionView(outcome.action), rungs: [], connectionWarning: null };
    } else if (held.kind === "mcp") {
      const { plan } = held.resolved;
      this.progress(planId, "installing");
      const outcome = await this.options.installers.mcp.install(held.resolved, { switchSource: held.switchSource });
      result = { key: { sourceId: plan.sourceId, kind: "mcp", name: plan.name }, version: plan.version, action: installActionView(outcome.action), rungs: [], connectionWarning: outcome.connectionWarning };
    } else {
      this.progress(planId, "installing");
      const { connectionWarning } = await this.options.installers.mcp.installUnbound(held.name, held.runtime);
      result = { key: { sourceId: null, kind: "mcp", name: held.name }, version: null, action: { action: "install" }, rungs: [], connectionWarning };
    }
    this.options.onCatalogChanged?.();
    return result;
  }

  /** The stored token a token-auth source's release downloads go through the REST API with (§6.2), or null. */
  private tokenFor(source: ResolvedSource): string | null {
    return source.auth.kind === "token" ? this.options.tokens.get(source.auth.host) : null;
  }

  async uninstall(request: UninstallRequest): Promise<UninstallResultView> {
    assertNotRequiredByPolicy(this.options.policy, request.kind, request.name, "uninstall");
    const installed = await this.installed(request.kind, request.name);
    if (!installed || installed.sourceId !== request.sourceId) {
      const from = request.sourceId === null ? "without a source" : `from ${request.sourceId}`;
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${request.kind} ${request.name} is not installed ${from}`);
    }
    let keptDataDir: string | null = null;
    if (request.kind === "plugin") await this.options.installers.plugin.uninstall(request.name);
    else if (request.kind === "mcp") ({ keptDataDir } = await this.options.installers.mcp.uninstall(request.name, { removeData: request.removeData === true }));
    else await this.options.installers.content.uninstall(request.kind, request.name);
    this.options.onCatalogChanged?.();
    return { key: { sourceId: request.sourceId, kind: request.kind, name: request.name }, keptDataDir };
  }

  // ─── direct MCP input (§8.1) ─────────────────────────────────────────────

  previewDirectMcp(request: DirectMcpPreviewRequest): DirectMcpPreviewView {
    let document: unknown;
    try {
      document = parseStrictJson(request.serverJson);
    } catch (error) {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", `server.json does not parse: ${(error as Error).message}`);
    }
    const record = typeof document === "object" && document !== null && !Array.isArray(document) ? (document as Record<string, unknown>) : null;
    if (!record || typeof record.name !== "string" || typeof record.version !== "string") {
      throw new MarketplaceError("CONTENT_RULE_VIOLATION", "server.json needs a name and a version");
    }
    const name = idFrom(record.name.slice(record.name.lastIndexOf("/") + 1));
    if (!name) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `server.json name ${record.name} does not end in a usable name`);
    const runtime = runtimeFromServerJson(document, request.select);
    assertMcpRuntimePinned(name, runtime);
    this.options.installers.mcp.admit(name, runtime);
    const ticket = this.plans.issue({ kind: "mcp-unbound", name, runtime });
    return {
      planId: ticket.id,
      expiresAt: ticket.expiresAt,
      name,
      version: record.version,
      runtime: mcpRuntimeView(runtime),
      options: {
        packages: Array.isArray(record.packages) ? record.packages.length : 0,
        remotes: Array.isArray(record.remotes) ? record.remotes.length : 0,
      },
    };
  }

  /** Drop every preview clone and plan (shutdown). */
  close(): void {
    this.previews.clear();
    this.plans.clear();
  }
}
