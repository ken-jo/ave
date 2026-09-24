/**
 * Content package store (design §2, §5.4; blueprint 3.1).
 *
 * Staging reads the package directory at the version commit, holds every
 * file to the kind's rules and parses the entry files. Installing writes the
 * files to `packages/<kind>/<name>/<version>/`, records the ledger entry and
 * then activates the content; a failed activation puts the previous state
 * back. Loading re-reads each installed package from disk under the same
 * rules and the recorded digest, so a package whose files changed after
 * install is listed as broken and never applied.
 *
 * Identity follows the plugin rules (design §15.1): `(kind, name)` is bound
 * to the source it came from, and replacing it from another source is an
 * explicit switch.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renameDirectory } from "../../lib/transient-fs-lock-retry.js";
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";
import { assertNotRequiredByPolicy } from "../boot-installs/run.js";
import type { PackageDescriptor } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";
import { DESCRIPTOR_NAME, readDescriptorAtVersion, type PackagePlan, type RepositoryAccess } from "../resolve/descriptor.js";
import { classifyInstall, type InstallAction, type InstalledPackage } from "../resolve/identity.js";
import { treeDigest } from "../resolve/plugin-ladder.js";
import type { MarketplacePolicy } from "../sources/policy.js";
import { isDataContentKind, parseContent, type ContentFile, type DataContentKind, type ParsedContent } from "./kinds.js";
import { ContentLedger, type LedgerEntry } from "./ledger.js";
import { CONTENT_RULES, DESCRIPTOR_ALLOWANCE_BYTES, checkContentFiles, isContentKind, type ContentKind } from "./rules.js";

const log = createLogger("marketplace-content-store");

interface DataContentPlan extends PackagePlan {
  kind: DataContentKind;
}

export interface StagedContent {
  plan: DataContentPlan;
  files: ContentFile[];
  /** Tree digest (design §6.4) of `files`. */
  contentSha256: string;
  content: ParsedContent;
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
  return treeDigest(files.map((file) => ({ ...file, executable: false })));
}

/**
 * Read `plan`'s package at its version commit: the descriptor must match
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
    const exported = await access.repo.exportPath(
      access.remote,
      dataPlan.versionCommit,
      dataPlan.packagePath,
      dest,
      { maxFiles: rule.maxFiles + 1, maxBytes: rule.maxBytes + DESCRIPTOR_ALLOWANCE_BYTES },
      access.signal,
    );
    const files: ContentFile[] = [];
    for (const file of exported) {
      if (file.path === DESCRIPTOR_NAME) continue;
      files.push({ path: file.path, data: await readFile(join(dest, ...file.path.split("/"))) });
    }
    checkContentFiles(dataPlan.kind, files);
    const content = parseContent(dataPlan.kind, files, {
      name: dataPlan.name,
      payload: descriptor.payload,
      english: options.english,
      sourceOrigin: dataPlan.sourceOrigin,
    });
    return { plan: dataPlan, files, contentSha256: digestOf(files), content };
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
  activate(content: ParsedContent, entry: LedgerEntry, previous: LedgerEntry | null, adopt: boolean): Promise<void>;
  /** Before the ledger drops the package; a throw leaves it installed. `content` is null when its files no longer parse. */
  deactivate(entry: LedgerEntry, content: ParsedContent | null): Promise<void>;
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
      else if (entry.isFile()) files.push({ path, data: await readFile(full) });
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

  packageDir(entry: Pick<LedgerEntry, "kind" | "name" | "version">): string {
    if (!SAFE_VERSION.test(entry.version)) throw new Error(`unsafe version ${entry.version}`);
    return join(this.options.root, entry.kind, entry.name, entry.version);
  }

  async install(staged: StagedContent, options: { switchSource?: boolean; adopt?: boolean } = {}): Promise<{ action: InstallAction; entry: LedgerEntry }> {
    return this.serialize(async () => {
      const { plan } = staged;
      const previous = this.ledger.get(plan.kind, plan.name) ?? null;
      const action = classifyInstall(plan, this.installed(plan.kind, plan.name), options);
      await this.assertClaimFree(staged);
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
        },
      };
      const dir = this.packageDir(entry);
      const scratch = join(this.options.root, ".staging", randomUUID());
      const files = join(scratch, "files");
      const displaced = join(scratch, "displaced");
      let displacedDir = false;
      // The previous version's files stay in the scratch directory until they are back in place.
      let keepScratch = false;
      try {
        for (const file of staged.files) {
          const target = join(files, ...file.path.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.data);
        }
        await mkdir(dirname(dir), { recursive: true });
        // Reinstalling the same version: the live directory steps aside and comes back on failure.
        if (await lstat(dir).then(() => true, () => false)) {
          await renameDirectory(dir, displaced);
          displacedDir = true;
        }
        await renameDirectory(files, dir);
        try {
          await this.ledger.put(entry);
          await this.options.activation.activate(staged.content, entry, previous, options.adopt === true);
        } catch (error) {
          await undo([
            ["restore the ledger entry", () => (previous ? this.ledger.put(previous) : this.ledger.remove(entry.kind, entry.name))],
            ["remove the new files", () => rm(dir, { recursive: true, force: true })],
          ]);
          if (displacedDir && !(await undo([["restore the previous files", () => renameDirectory(displaced, dir)]]))) {
            keepScratch = true;
            log.error({ kept: displaced }, "content install rollback kept the previous files in its scratch directory");
          }
          throw error;
        }
        if (previous && previous.version !== entry.version) {
          await rm(this.packageDir(previous), { recursive: true, force: true });
        }
        return { action, entry };
      } finally {
        if (!keepScratch) await rm(scratch, { recursive: true, force: true });
      }
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
   * the policy's `requiredInstalls` lists cannot be removed
   * (PACKAGE_REQUIRED_BY_POLICY).
   */
  async uninstall(kind: ContentKind, name: string, policy: MarketplacePolicy): Promise<LedgerEntry | null> {
    return this.serialize(async () => {
      const entry = this.ledger.get(kind, name);
      if (!entry) return null;
      assertNotRequiredByPolicy(policy, kind, name, "uninstall");
      const loaded = await this.loadOne(entry);
      await this.options.activation.deactivate(entry, "content" in loaded ? loaded.content : null);
      await this.ledger.remove(kind, name);
      await rm(join(this.options.root, kind, name), { recursive: true, force: true });
      return entry;
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
        payload: null,
        english: this.options.english,
        sourceOrigin: entry.origin.sourceOrigin,
      });
      return { entry, content, dir };
    } catch (error) {
      return { entry, problem: errorMessage(error) };
    }
  }
}
