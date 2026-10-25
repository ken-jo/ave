/** Installs use unique directories and roll back failed activation without moving live files.
 * Loading verifies installed bytes; replaced directories survive until their activation retires. */
import { randomUUID } from "node:crypto";
import { withInstalledStateMutation } from "../../main/installed-state-mutation.js";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMarketplaceLogger } from "../log.js";
import { errorMessage } from "../../shared/error-message.js";
import { assertNotRequiredByPolicy } from "../boot-installs/run.js";
import { MARKETPLACE_DESCRIPTOR_FILE, type PackageDescriptor } from "../catalog/types.js";
import type { ComponentConsent, ReviewedComponentConsent } from "../../shared/git-marketplace.js";
import { MarketplaceError } from "../errors.js";
import { readDescriptorAtVersion, type PackagePlan, type RepositoryAccess } from "../resolve/descriptor.js";
import { classifyInstall, type InstallAction, type InstalledPackage } from "../resolve/identity.js";
import { treeDigest } from "../resolve/plugin-ladder.js";
import { deriveAgentPluginComponents } from "./agent-plugin-components.js";
import type { MarketplacePolicy } from "../sources/policy.js";
import { isDataContentKind, parseContent, type ContentFile, type DataContentKind, type ParsedContent } from "./kinds.js";
import { ContentLedger, installPayloadDir, type LedgerEntry } from "./ledger.js";
import { agentPluginConsent, contentConsent, unknownConsent, type ConsentFingerprint } from "../updates/consent.js";
import { agentPluginComponentDigests } from "../../plugins/contribution-approval-digest.js";
import { CONTENT_KINDS, CONTENT_RULES, DESCRIPTOR_ALLOWANCE_BYTES, checkContentFiles, isContentKind, type ContentKind } from "./rules.js";

const log = createMarketplaceLogger("marketplace-content-store");

interface DataContentPlan extends PackagePlan {
  kind: DataContentKind;
}

interface LocalContentPlan {
  kind: "agent-plugin";
  name: string;
  version: string;
  sourceId: null;
  sourceOrigin: null;
  snapshotCommit: null;
  packagePath: string;
}

export interface StagedContent {
  plan: DataContentPlan | LocalContentPlan;
  files: ContentFile[];
  contentSha256: string;
  content: ParsedContent;
  /** Null for local agent plugins without a descriptor. */
  minAppVersion: string | null;
  hostProtocol: string | null;
}

export function stagedConsent(staged: StagedContent): ConsentFingerprint {
  if (staged.content.kind === "agent-plugin") {
    return agentPluginConsent({ minAppVersion: staged.minAppVersion, hostProtocol: staged.hostProtocol, components: staged.content.components, files: staged.files });
  }
  return contentConsent(staged.plan.kind as Exclude<ContentKind, "agent-plugin">, staged.minAppVersion, staged.files);
}

export function stageLocalAgentPlugin(files: readonly ContentFile[]): StagedContent {
  checkContentFiles("agent-plugin", files);
  const manifest = files.find((file) => file.path === "plugin.json");
  if (!manifest) throw new MarketplaceError("CONTENT_RULE_VIOLATION", "plugin.json is missing");
  const parsed = JSON.parse(manifest.data.toString("utf8")) as { name: string; version: string };
  const components = deriveAgentPluginComponents(files, { name: parsed.name, version: parsed.version });
  const content: ParsedContent = { kind: "agent-plugin", components, files: files.map((file) => ({ path: file.path, data: Buffer.from(file.data) })) };
  return {
    plan: { kind: "agent-plugin", name: parsed.name, version: parsed.version, sourceId: null,
      sourceOrigin: null, snapshotCommit: null, packagePath: "" },
    files: files.map((file) => ({ path: file.path, data: Buffer.from(file.data) })),
    contentSha256: digestOf(files), content, minAppVersion: null, hostProtocol: null,
  };
}

export interface StageOptions {
  workRoot: string;
  english: Readonly<Record<string, string>>;
}

function asDataPlan(plan: PackagePlan): DataContentPlan {
  if (!isContentKind(plan.kind) || !isDataContentKind(plan.kind)) {
    throw new Error(`${plan.kind} ${plan.name} is not a content package`);
  }
  return plan as DataContentPlan;
}

function digestOf(files: readonly ContentFile[]): string {
  return treeDigest(files.map((file) => ({ ...file, executable: file.executable === true })));
}

/** Descriptor identity, file rules and entry parsing must all pass before staging succeeds. */
export async function stageContentPackage(plan: PackagePlan, access: RepositoryAccess, options: StageOptions): Promise<StagedContent> {
  const dataPlan = asDataPlan(plan);
  const descriptor: PackageDescriptor = await readDescriptorAtVersion(dataPlan, access);
  const rule = CONTENT_RULES[dataPlan.kind];
  await mkdir(options.workRoot, { recursive: true });
  const dest = await mkdtemp(join(options.workRoot, "content-"));
  try {
    const exported = await access.treeAt(dataPlan.versionCommit).exportPath(
      dataPlan.packagePath,
      dest,
      { maxFiles: rule.maxFiles + 1, maxBytes: rule.maxBytes + DESCRIPTOR_ALLOWANCE_BYTES },
    );
    const files: ContentFile[] = [];
    for (const file of exported) {
      if (file.path === MARKETPLACE_DESCRIPTOR_FILE) continue;
      files.push({ path: file.path, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
    }
    checkContentFiles(dataPlan.kind, files);
    const content = parseContent(dataPlan.kind, files, {
      name: dataPlan.name,
      version: descriptor.version,
      minAppVersion: descriptor.minAppVersion,
      payload: descriptor.payload,
      english: options.english,
      sourceOrigin: dataPlan.sourceOrigin,
      unknownMessageKeys: "ignore",
    });
    return { plan: dataPlan, files, contentSha256: digestOf(files), content, minAppVersion: descriptor.minAppVersion, hostProtocol: descriptor.hostProtocol ?? null };
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
}

/** Uninstalling a selected visual package resets its setting; other kinds update connection settings. */
export interface ContentActivation {
  /** Activation failure rolls back the recorded install; adoption preserves existing settings. */
  activate(content: ParsedContent, entry: LedgerEntry, previous: LedgerEntry | null, adopt: boolean, dir?: string, componentConsents?: readonly ComponentConsent[]): Promise<{ retired: Promise<void> }>;
  /** Before the ledger drops the package; a throw leaves it installed. `content` is null when its files no longer parse. */
  deactivate(entry: LedgerEntry, content: ParsedContent | null, dir?: string): Promise<void>;
  /** Publish approvals only after the store validates their binding to the installed generation. */
  approveComponents(entry: LedgerEntry, content: ParsedContent & { kind: "agent-plugin" }, dir: string, consents: readonly ComponentConsent[]): Promise<void>;
}

export interface ContentStoreOptions {
  root: string;
  english: Readonly<Record<string, string>>;
  activation: ContentActivation;
  now?: () => Date;
}

export interface LoadedContent {
  entry: LedgerEntry;
  content: ParsedContent;
  dir: string;
}

export interface BrokenContent {
  entry: LedgerEntry;
  problem: string;
}

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

function claimOf(content: ParsedContent): string | null {
  if (content.kind === "language") return `the ${content.locale} language`;
  if (content.kind === "font") return `the ${content.family} font family`;
  return null;
}

/** Run every rollback step despite failures, then rethrow the original install error. */
async function undo(steps: ReadonlyArray<readonly [string, () => Promise<unknown>]>): Promise<boolean> {
  let held = true;
  for (const [what, step] of steps) {
    try {
      await step();
    } catch (error) {
      held = false;
      log.error({ err: errorMessage(error) }, `content install rollback could not ${what}`);
    }
  }
  return held;
}

async function readInstalledFiles(dir: string): Promise<ContentFile[]> {
  const files: ContentFile[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, path);
      else if (entry.isFile()) files.push({ path, data: await readFile(full), executable: ((await lstat(full)).mode & 0o111) !== 0 });
      else throw new Error(`${path} is not a regular file`);
    }
  };
  await walk(dir, "");
  return files;
}

export class ContentStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: ContentStoreOptions,
    private readonly ledger: ContentLedger,
  ) {}

  /** Reads the ledger only; nothing is created until the first install. */
  static async open(options: ContentStoreOptions): Promise<ContentStore> {
    return new ContentStore(options, await ContentLedger.open(join(options.root, "ledger.json")));
  }

  /** One install or uninstall at a time; reads see the last finished write. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    return withInstalledStateMutation(() => this.serialize(work));
  }

  list(): LedgerEntry[] {
    return this.ledger.list();
  }

  installed(kind: ContentKind, name: string): InstalledPackage | null {
    const entry = this.ledger.get(kind, name);
    return entry ? { kind, name, version: entry.version, sourceId: entry.origin.sourceId } : null;
  }

  /** Legacy installs use version directories; current installs have unique install directories. */
  packageDir(entry: Pick<LedgerEntry, "kind" | "name" | "version" | "origin">): string {
    if (entry.origin.payloadDir !== undefined) return join(this.options.root, ...entry.origin.payloadDir.split("/"));
    if (!SAFE_VERSION.test(entry.version)) throw new Error(`unsafe version ${entry.version}`);
    return join(this.options.root, entry.kind, entry.name, entry.version);
  }

  /** Check staged consent before writes; a refusal installs nothing. */
  async install(
    staged: StagedContent,
    options: { switchSource?: boolean; adopt?: boolean; componentConsents?: readonly ComponentConsent[]; assertConsent?: (consent: ConsentFingerprint) => void } = {},
  ): Promise<{ action: InstallAction; entry: LedgerEntry }> {
    return this.mutate(async () => {
      const { plan } = staged;
      const previous = this.ledger.get(plan.kind, plan.name) ?? null;
      const action = classifyInstall(plan, this.installed(plan.kind, plan.name), options);
      const consent = stagedConsent(staged);
      options.assertConsent?.(consent);
      await this.assertClaimFree(staged);
      const installId = randomUUID();
      const entry: LedgerEntry = {
        kind: plan.kind,
        name: plan.name,
        version: plan.version,
        origin: {
          sourceId: plan.sourceId,
          sourceOrigin: plan.sourceOrigin,
          commit: plan.snapshotCommit,
          packagePath: plan.packagePath,
          version: plan.version,
          contentSha256: staged.contentSha256,
          installedAt: (this.options.now?.() ?? new Date()).toISOString(),
          installId,
          payloadDir: installPayloadDir(plan.kind, plan.name, installId),
          consent,
        },
      };
      // A directory no install has used: nothing that runs is moved or overwritten.
      const dir = this.packageDir(entry);
      try {
        for (const file of staged.files) {
          const target = join(dir, ...file.path.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.data, { mode: file.executable === true ? 0o700 : 0o600 });
        }
        await this.ledger.put(entry);
        let activated: { retired: Promise<void> };
        try {
          activated = await this.options.activation.activate(staged.content, entry, previous, options.adopt === true, dir, options.componentConsents);
        } catch (error) {
          await undo([["restore the ledger entry", () => (previous ? this.ledger.put(previous) : this.ledger.remove(entry.kind, entry.name))]]);
          throw error;
        }
        if (previous) this.removeWhenRetired(previous, activated.retired);
        return { action, entry };
      } catch (error) {
        await undo([["remove the new files", () => rm(dir, { recursive: true, force: true })]]);
        throw error;
      }
    });
  }

  /** Remove replaced files only after retirement, outside serialization; boot sweeps abandoned directories. */
  private removeWhenRetired(previous: LedgerEntry, retired: Promise<void>): void {
    const dir = this.packageDir(previous);
    void retired
      .then(() => withInstalledStateMutation(async () => {
        // A same-version legacy reinstall leaves nothing to remove twice; a directory a live entry names is never removed.
        const current = this.ledger.get(previous.kind, previous.name);
        if (current && this.packageDir(current) === dir) return;
        await rm(dir, { recursive: true, force: true });
      }))
      .catch((error: unknown) => log.warn({ dir, err: errorMessage(error) }, "the replaced package's files stay until the next start"));
  }

  /** Before activation, remove install directories not named by the ledger. */
  async sweep(): Promise<string[]> {
    return this.mutate(async () => {
      const removed: string[] = [];
      const named = new Set(this.ledger.list().map((entry) => this.packageDir(entry)));
      const entries = async (dir: string) => readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const kind of await entries(this.options.root)) {
        if (!kind.isDirectory() || !(CONTENT_KINDS as readonly string[]).includes(kind.name)) continue;
        for (const name of await entries(join(this.options.root, kind.name))) {
          if (!name.isDirectory()) continue;
          const packageRoot = join(this.options.root, kind.name, name.name);
          for (const child of await entries(packageRoot)) {
            if (!child.isDirectory()) continue;
            const candidates = child.name === ".installs"
              ? (await entries(join(packageRoot, ".installs"))).filter((item) => item.isDirectory()).map((item) => join(packageRoot, ".installs", item.name))
              : SAFE_VERSION.test(child.name) ? [join(packageRoot, child.name)] : [];
            for (const candidate of candidates) {
              if (named.has(candidate)) continue;
              await rm(candidate, { recursive: true, force: true });
              removed.push(candidate);
            }
          }
        }
      }
      return removed;
    });
  }

  /** Locale and font-family providers must be unique so removing one cannot clear another selection. */
  private async assertClaimFree(staged: StagedContent): Promise<void> {
    const claim = claimOf(staged.content);
    if (!claim) return;
    for (const other of this.ledger.list()) {
      if (other.kind !== staged.plan.kind || other.name === staged.plan.name) continue;
      const loaded = await this.loadOne(other);
      if ("content" in loaded && claimOf(loaded.content) === claim) {
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${other.name} already provides ${claim}`);
      }
    }
  }

  /** Policy-locked source bindings cannot be removed; absent packages return null. */
  async uninstall(kind: ContentKind, name: string, policy: MarketplacePolicy): Promise<LedgerEntry | null> {
    return this.mutate(async () => {
      const entry = this.ledger.get(kind, name);
      if (!entry) return null;
      assertNotRequiredByPolicy(policy, kind, name, entry.origin.sourceId, "uninstall");
      const loaded = await this.loadOne(entry);
      await this.options.activation.deactivate(entry, "content" in loaded ? loaded.content : null, this.packageDir(entry));
      await this.ledger.remove(kind, name);
      await rm(join(this.options.root, kind, name), { recursive: true, force: true });
      return entry;
    });
  }

  /** Reconstruct missing consent from verified installed files and retained descriptor fields.
     * Unverifiable files make the entire baseline unknown. */
  async installedConsent(
    kind: ContentKind,
    name: string,
    descriptor: (entry: LedgerEntry) => Promise<{ minAppVersion: string | null; hostProtocol: string | null } | null>,
  ): Promise<ConsentFingerprint | null> {
    const entry = this.ledger.get(kind, name);
    if (!entry) return null;
    if (entry.origin.consent) return entry.origin.consent;
    const loaded = await this.serialize(() => this.loadOne(entry));
    if (!("content" in loaded)) return unknownConsent(kind);
    const files = await readInstalledFiles(loaded.dir);
    const fields = await descriptor(entry);
    if (loaded.content.kind === "agent-plugin") {
      const consent = agentPluginConsent({ minAppVersion: fields?.minAppVersion ?? null, hostProtocol: fields?.hostProtocol ?? null, components: loaded.content.components, files });
      // A hostProtocol the snapshot cannot vouch for is unknown, not "none".
      return fields ? consent : { ...consent, unknown: [...new Set([...consent.unknown, "hostProtocol"])].sort() };
    }
    return contentConsent(kind as Exclude<ContentKind, "agent-plugin">, fields?.minAppVersion ?? null, files);
  }

  /** Approvals must match the installed id and component digests under serialization or expire unchanged. */
  async approveComponents(name: string, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<void> {
    await this.mutate(async () => {
      const entry = this.ledger.get("agent-plugin", name);
      const stale = () => new MarketplaceError("PLAN_EXPIRED", `agent plugin ${name} changed since it was reviewed`, { detail: { reason: "package-changed" } });
      if (!entry || entry.origin.installId !== installId) throw stale();
      const loaded = await this.loadOne(entry);
      if (!("content" in loaded) || loaded.content.kind !== "agent-plugin") throw stale();
      const digests = agentPluginComponentDigests(loaded.content.components, await readInstalledFiles(loaded.dir));
      for (const consent of consents) {
        const actual = "kind" in consent ? digests.hooks[consent.index] : Object.hasOwn(digests.mcpServers, consent.name) ? digests.mcpServers[consent.name] : undefined;
        if (actual === undefined || actual !== consent.approvalDigest) throw stale();
      }
      const plain = consents.map((consent): ComponentConsent => ("kind" in consent
        ? { kind: "hook", index: consent.index, digest: consent.digest }
        : { name: consent.name, digest: consent.digest }));
      await this.options.activation.approveComponents(entry, loaded.content, loaded.dir, plain);
    });
  }

  async load(): Promise<{ loaded: LoadedContent[]; broken: BrokenContent[] }> {
    // Queued behind installs, so a load never reads a package directory mid-rename.
    return this.serialize(async () => {
      const loaded: LoadedContent[] = [];
      const broken: BrokenContent[] = [];
      for (const entry of this.ledger.list()) {
        const result = await this.loadOne(entry);
        if ("content" in result) loaded.push(result);
        else broken.push(result);
      }
      return { loaded, broken };
    });
  }

  private async loadOne(entry: LedgerEntry): Promise<LoadedContent | BrokenContent> {
    if (!isDataContentKind(entry.kind)) return { entry, problem: `${entry.kind} packages are not applied by this build` };
    try {
      const dir = this.packageDir(entry);
      const files = await readInstalledFiles(dir);
      checkContentFiles(entry.kind, files);
      if (digestOf(files) !== entry.origin.contentSha256) throw new Error("the installed files changed after install");
      // The descriptor is not installed; the digest ties these bytes to the ones checked against it at install.
      const content = parseContent(entry.kind, files, {
        name: entry.name,
        version: entry.version,
        payload: null,
        english: this.options.english,
        sourceOrigin: entry.origin.sourceOrigin === null ? "direct" : entry.origin.sourceOrigin,
        unknownMessageKeys: "ignore",
      });
      return { entry, content, dir };
    } catch (error) {
      return { entry, problem: errorMessage(error) };
    }
  }
}
