/**
 * Content package store (design §2, §5.4, §18.7.4).
 *
 * Staging reads the package directory at the version commit, holds every
 * file to the kind's rules and parses the entry files. Installing writes the
 * files to a directory of their own, `packages/<kind>/<name>/.installs/<installId>/`,
 * records the ledger entry and then activates the content; a failed
 * activation puts the previous state back. Nothing a running generation
 * uses is moved or overwritten: the replaced install's directory is removed
 * only once its activation has retired, and a boot sweep removes what a
 * quit or a failed removal left. Loading re-reads each installed package
 * from disk under the same rules and the recorded digest, so a package whose
 * files changed after install is listed as broken and never applied.
 *
 * Identity follows the plugin rules (design §15.1): `(kind, name)` is bound
 * to the source it came from, and replacing it from another source is an
 * explicit switch.
 */
import { randomUUID } from "node:crypto";
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
  /** Tree digest (design §6.4) of `files`. */
  contentSha256: string;
  content: ParsedContent;
  /** The descriptor's `minAppVersion` and `hostProtocol`; null for a local agent plugin, which has no descriptor. */
  minAppVersion: string | null;
  hostProtocol: string | null;
}

/** The consent fingerprint of staged content (§18.7.3): what installing it asks the user to accept. */
export function stagedConsent(staged: StagedContent): ConsentFingerprint {
  if (staged.content.kind === "agent-plugin") {
    return agentPluginConsent({ minAppVersion: staged.minAppVersion, hostProtocol: staged.hostProtocol, components: staged.content.components, files: staged.files });
  }
  return contentConsent(staged.plan.kind as Exclude<ContentKind, "agent-plugin">, staged.minAppVersion, staged.files);
}

/** Stage bytes selected from a local directory or archive under the same content rules. */
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
  /** Scratch directory for the export; removed before returning. */
  workRoot: string;
  /** The English catalog a language package is checked against. */
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

/**
 * Read `plan`'s package at its version's revision (a commit, or the copy a
 * folder plan captured): the descriptor must match
 * the index (MANIFEST_MISMATCH), every file must fit the kind's rules and
 * the entry files must parse (CONTENT_RULE_VIOLATION).
 */
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

/**
 * How installed content takes effect. Themes, languages and fonts are read
 * by the renderer from the loaded store; providers and messaging
 * connections are written into settings, and uninstalling a selected theme,
 * language or font returns its setting to the default.
 */
export interface ContentActivation {
  /**
   * After the ledger records the package; a throw undoes the install.
   * `previous` is the entry it replaces, null for a first install. `adopt`:
   * the first-boot migration is recording an activation the settings already
   * hold (design §16.3), which leaves those settings as they are.
   */
  activate(content: ParsedContent, entry: LedgerEntry, previous: LedgerEntry | null, adopt: boolean, dir?: string, componentConsents?: readonly ComponentConsent[]): Promise<{ retired: Promise<void> }>;
  /** Before the ledger drops the package; a throw leaves it installed. `content` is null when its files no longer parse. */
  deactivate(entry: LedgerEntry, content: ParsedContent | null, dir?: string): Promise<void>;
  /**
   * Approve components of the installed agent plugin `entry` (design
   * §18.7.5), after the store checked the review's binding: publish them
   * with these consents on the installed generation.
   */
  approveComponents(entry: LedgerEntry, content: ParsedContent & { kind: "agent-plugin" }, dir: string, consents: readonly ComponentConsent[]): Promise<void>;
}

export interface ContentStoreOptions {
  /** `~/.ave/packages`. */
  root: string;
  /** The English catalog a language package is checked against. */
  english: Readonly<Record<string, string>>;
  activation: ContentActivation;
  now?: () => Date;
}

export interface LoadedContent {
  entry: LedgerEntry;
  content: ParsedContent;
  /** The installed package directory. */
  dir: string;
}

export interface BrokenContent {
  entry: LedgerEntry;
  problem: string;
}

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

/** What only one installed package may provide at a time: a locale, or a font family name. */
function claimOf(content: ParsedContent): string | null {
  if (content.kind === "language") return `the ${content.locale} language`;
  if (content.kind === "font") return `the ${content.family} font family`;
  return null;
}

/**
 * Run each undo step of a failed install. A step that fails is logged and the
 * rest still run, so the caller rethrows the install's own error; the return
 * says whether every step held.
 */
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

  list(): LedgerEntry[] {
    return this.ledger.list();
  }

  /** The installed package for identity checks (design §15.1). */
  installed(kind: ContentKind, name: string): InstalledPackage | null {
    const entry = this.ledger.get(kind, name);
    return entry ? { kind, name, version: entry.version, sourceId: entry.origin.sourceId } : null;
  }

  /**
   * Where an installed entry's files are: its own install directory, or a
   * legacy install's `<version>/` directory.
   */
  packageDir(entry: Pick<LedgerEntry, "kind" | "name" | "version" | "origin">): string {
    if (entry.origin.payloadDir !== undefined) return join(this.options.root, ...entry.origin.payloadDir.split("/"));
    if (!SAFE_VERSION.test(entry.version)) throw new Error(`unsafe version ${entry.version}`);
    return join(this.options.root, entry.kind, entry.name, entry.version);
  }

  /**
   * Install `staged` into a directory of its own. `assertConsent` is
   * checkpoint two of an automatic update (§18.7.3): it sees the staged
   * consent fingerprint before anything is written, and a throw installs
   * nothing.
   */
  async install(
    staged: StagedContent,
    options: { switchSource?: boolean; adopt?: boolean; componentConsents?: readonly ComponentConsent[]; assertConsent?: (consent: ConsentFingerprint) => void } = {},
  ): Promise<{ action: InstallAction; entry: LedgerEntry }> {
    return this.serialize(async () => {
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

  /**
   * Remove exactly the replaced install's own directory once its activation
   * has retired, outside the store's serialization. A removal that fails, or
   * a quit before it, is the boot sweep's.
   */
  private removeWhenRetired(previous: LedgerEntry, retired: Promise<void>): void {
    const dir = this.packageDir(previous);
    void retired
      .then(async () => {
        // A same-version legacy reinstall leaves nothing to remove twice; a directory a live entry names is never removed.
        const current = this.ledger.get(previous.kind, previous.name);
        if (current && this.packageDir(current) === dir) return;
        await rm(dir, { recursive: true, force: true });
      })
      .catch((error: unknown) => log.warn({ dir, err: errorMessage(error) }, "the replaced package's files stay until the next start"));
  }

  /**
   * The boot sweep (§18.7.4): remove every `.installs/<installId>/` no
   * ledger entry names, and every `<version>/` no legacy ledger entry names.
   * Runs before anything is activated.
   */
  async sweep(): Promise<string[]> {
    return this.serialize(async () => {
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

  /**
   * A second package may not provide a locale or font family another
   * installed package provides (PACKAGE_ID_CONFLICT): removing either would
   * otherwise take the other's selection with it.
   */
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

  /**
   * Remove an installed package; null when it is not installed. A package
   * the policy's `requiredInstalls` locks, from its bound source, cannot be
   * removed (PACKAGE_REQUIRED_BY_POLICY).
   */
  async uninstall(kind: ContentKind, name: string, policy: MarketplacePolicy): Promise<LedgerEntry | null> {
    return this.serialize(async () => {
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

  /**
   * The consent baseline of an installed package (§18.7.3): the fingerprint
   * its ledger entry stored, or, for an install from before slice F, one
   * computed from its installed files with `minAppVersion` (and an agent
   * plugin's `hostProtocol`) from the catalog it was installed from, which
   * `descriptor` reads from the retained snapshot (null: not kept, so
   * unknown). Files that no longer verify give an entirely unknown one.
   */
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

  /**
   * Approve components of an `approval-pending` agent plugin (§18.7.5).
   * Inside the install serialization: the installed entry must be the
   * reviewed install `installId`, and each consent's approval digest must be
   * the one its component has in that install's files; otherwise nothing is
   * approved and the review is stale (`PLAN_EXPIRED` `package-changed`).
   */
  async approveComponents(name: string, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<void> {
    await this.serialize(async () => {
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

  /** Every installed data package, re-read from disk; a package that no longer holds is listed as broken. */
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
