/**
 * Check a marketplace repository's working tree the way the app reads it
 * (design §4, §5, §10.4).
 *
 * The app refuses or drops what breaks a rule when it syncs and installs.
 * This runs the same rules over a checkout before anything is published, so
 * a marketplace's CI can fail a pull request instead of a user's install
 * failing later. Every rule here is the one the install path uses: the
 * catalog validators, the descriptor-to-index comparison, the MCP launcher
 * grammar, the content file rules and the content parsers. Nothing is
 * restated.
 *
 * The official repository runs a bundle of this module (its
 * `tools/vendor/`), built from an ave ref, so its CI and the app never
 * disagree about what is valid.
 */
import { messages } from "../i18n/messages/index.js";
import type { IndexPackage, IndexVersion, PackageDescriptor, PluginArtifactPins, PluginAuthority } from "./catalog/types.js";
import { validateDescriptorText, validateIndexText, validateRevocationsText } from "./catalog/validate.js";
import { isDataContentKind, parseContent } from "./content/kinds.js";
import { checkContentFiles, isContentKind } from "./content/rules.js";
import { DESCRIPTOR_NAME, descriptorDiffersFromIndex, repoPath } from "./resolve/descriptor.js";
import { gitInstallManifestMismatches } from "./resolve/manifest-rules.js";
import { declaredMcpServer, mcpPayloadReadsServerJson, parseServerJson } from "./resolve/mcp.js";
import { canonicalStringify } from "../shared/canonical-json.js";

/** Read access to a repository tree. Paths are repository-relative with `/` separators. */
export interface RepositoryTree {
  /** The file's bytes, or null when there is no file at `path`. */
  read(path: string): Buffer | null;
  /** Every file under `dir` (recursively), as repository-relative paths; `""` is the root. */
  list(dir: string): string[];
}

export interface RepositoryCheckOptions {
  /** The source id the index must carry when `official` (the official source is `ave`). */
  sourceId: string;
  official: boolean;
  /**
   * The `plugin.json` inside each plugin's released artifact, by plugin name,
   * for the plugins whose release the caller downloaded. Each is held to the
   * git-install manifest rules against the descriptor, as the ladder holds
   * the staged manifest (design §5.3, §6.2).
   */
  releasedManifests?: ReadonlyMap<string, unknown>;
}

export interface RepositoryProblem {
  /** `kind/name`, a file path, or `marketplace.json`. */
  subject: string;
  message: string;
}

const INDEX_PATH = "marketplace.json";
const REVOCATIONS_PATH = "policy/revocations.json";
/** Files a plugin's tree rung installs (design §6.2), besides the descriptor. */
const TREE_TOP_LEVEL = new Set(["plugin.json", "dist", "assets"]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageFiles(tree: RepositoryTree, dir: string): Array<{ path: string; data: Buffer }> {
  const prefix = dir === "" ? "" : `${dir}/`;
  return tree
    .list(dir)
    .map((path) => path.slice(prefix.length))
    .filter((path) => path !== DESCRIPTOR_NAME)
    .sort()
    .map((path) => ({ path, data: tree.read(repoPath(dir, path)) ?? Buffer.alloc(0) }));
}

function newestVersion(entry: IndexPackage): IndexVersion | null {
  return entry.versions?.[0] ?? null;
}

/** Plugin fields every version copies from the descriptor, compared after key canonicalization. */
function pluginCopyDiffers(descriptor: PackageDescriptor, version: IndexVersion): string[] {
  const payload = descriptor.payload as { authority: PluginAuthority; artifact: PluginArtifactPins };
  const differs: string[] = [];
  if (canonicalStringify(payload.authority) !== canonicalStringify(version.authority ?? null)) differs.push("authority");
  if (canonicalStringify(payload.artifact) !== canonicalStringify(version.artifact ?? null)) differs.push("artifact");
  return differs;
}

function manifestMismatches(document: unknown, descriptor: PackageDescriptor): string[] {
  const payload = descriptor.payload as { authority: PluginAuthority };
  return gitInstallManifestMismatches(document, {
    name: descriptor.name,
    version: descriptor.version,
    minAppVersion: descriptor.minAppVersion,
    authority: payload.authority,
  });
}

function checkPlugin(
  tree: RepositoryTree,
  entry: IndexPackage,
  descriptor: PackageDescriptor,
  options: RepositoryCheckOptions,
  report: (message: string) => void,
): void {
  const released = options.releasedManifests;
  if (released?.has(descriptor.name)) {
    for (const mismatch of manifestMismatches(released.get(descriptor.name), descriptor)) report(`the released plugin.json: ${mismatch}`);
  }
  const manifestPath = repoPath(entry.path, "plugin.json");
  const manifest = tree.read(manifestPath);
  const artifact = (descriptor.payload as { artifact: PluginArtifactPins }).artifact;
  if (!manifest) {
    if (artifact.tree !== undefined) report(`artifact.tree is declared but ${manifestPath} is missing`);
    return;
  }
  // A plugin.json in the package directory declares the tree rung (design §6.2): hold it to that rung's layout.
  const prefix = entry.path === "" ? "" : `${entry.path}/`;
  for (const path of tree.list(entry.path)) {
    const top = path.slice(prefix.length).split("/")[0]!;
    if (top !== DESCRIPTOR_NAME && !TREE_TOP_LEVEL.has(top)) {
      report(`${path}: the tree rung installs plugin.json, dist/ and assets/ only`);
    }
  }
  let document: unknown;
  try {
    document = JSON.parse(manifest.toString("utf8"));
  } catch (error) {
    report(`${manifestPath} does not parse: ${message(error)}`);
    return;
  }
  for (const mismatch of manifestMismatches(document, descriptor)) report(`${manifestPath}: ${mismatch}`);
}

function checkMcp(tree: RepositoryTree, entry: IndexPackage, descriptor: PackageDescriptor, report: (message: string) => void): void {
  const prefix = entry.path === "" ? "" : `${entry.path}/`;
  for (const path of tree.list(entry.path)) {
    const relative = path.slice(prefix.length);
    if (relative !== DESCRIPTOR_NAME && relative !== "server.json" && !relative.startsWith("server/")) {
      report(`${path}: an mcp package holds ave-package.json, server.json and server/ only`);
    }
  }
  let serverJson: unknown;
  if (mcpPayloadReadsServerJson(descriptor.payload)) {
    const path = repoPath(entry.path, "server.json");
    const bytes = tree.read(path);
    if (!bytes) {
      report(`${path} is missing`);
      return;
    }
    serverJson = parseServerJson(path, bytes);
  }
  const declared = declaredMcpServer(descriptor.name, descriptor.payload, serverJson);
  if (declared.packageCommand !== null && !tree.read(repoPath(entry.path, declared.packageCommand))) {
    report(`${declared.packageCommand} is not a file in the package`);
  }
}

function checkContent(tree: RepositoryTree, entry: IndexPackage, descriptor: PackageDescriptor, options: RepositoryCheckOptions): void {
  const kind = descriptor.kind;
  if (!isContentKind(kind)) return;
  const files = packageFiles(tree, entry.path);
  checkContentFiles(kind, files);
  if (!isDataContentKind(kind)) return;
  parseContent(kind, files, {
    name: descriptor.name,
    payload: descriptor.payload,
    english: messages.en,
    sourceOrigin: options.official ? "official" : "custom",
  });
}

function checkPackage(tree: RepositoryTree, entry: IndexPackage, options: RepositoryCheckOptions, problems: RepositoryProblem[]): void {
  const subject = `${entry.kind}/${entry.name}`;
  const report = (text: string) => problems.push({ subject, message: text });
  const path = repoPath(entry.path, DESCRIPTOR_NAME);
  const bytes = tree.read(path);
  if (!bytes) {
    report(`${path} is missing`);
    return;
  }
  const checked = validateDescriptorText(bytes.toString("utf8"), { expected: { kind: entry.kind, name: entry.name }, direct: false });
  if (!checked.ok) {
    report(checked.error);
    return;
  }
  const descriptor = checked.value;
  const newest = newestVersion(entry);
  if (newest) {
    const differs = descriptorDiffersFromIndex(descriptor, { ...newest, kind: entry.kind, name: entry.name });
    if (descriptor.kind === "plugin") differs.push(...pluginCopyDiffers(descriptor, newest));
    if (differs.length > 0) report(`the index's newest version differs from ${path} in ${differs.join(", ")}`);
  }
  try {
    if (descriptor.kind === "plugin") checkPlugin(tree, entry, descriptor, options, report);
    else if (descriptor.kind === "mcp") checkMcp(tree, entry, descriptor, report);
    else checkContent(tree, entry, descriptor, options);
  } catch (error) {
    report(message(error));
  }
}

/** Every descriptor in the tree that no index entry points at. */
function unlisted(tree: RepositoryTree, listed: ReadonlySet<string>): string[] {
  return tree
    .list("")
    .filter((path) => path === DESCRIPTOR_NAME || path.endsWith(`/${DESCRIPTOR_NAME}`))
    .map((path) => (path === DESCRIPTOR_NAME ? "" : path.slice(0, -(DESCRIPTOR_NAME.length + 1))))
    .filter((dir) => !listed.has(dir))
    .sort();
}

/**
 * Every rule the repository breaks, in the order the app would meet them:
 * the index, each listed package, descriptors the index leaves out, and the
 * revocations file. Empty = the app accepts every package as it stands.
 */
export function checkMarketplaceRepository(tree: RepositoryTree, options: RepositoryCheckOptions): RepositoryProblem[] {
  const problems: RepositoryProblem[] = [];
  const indexBytes = tree.read(INDEX_PATH);
  if (!indexBytes) return [{ subject: INDEX_PATH, message: "is missing" }];
  const index = validateIndexText(indexBytes.toString("utf8"), { official: options.official, sourceId: options.sourceId });
  if (!index.ok) return [{ subject: INDEX_PATH, message: index.error }];
  for (const diagnostic of index.value.diagnostics) problems.push(diagnostic);
  for (const entry of index.value.index.packages) checkPackage(tree, entry, options, problems);
  const listed = new Set(index.value.index.packages.map((entry) => entry.path));
  for (const dir of unlisted(tree, listed)) {
    problems.push({ subject: repoPath(dir, DESCRIPTOR_NAME), message: "no index entry points at this package" });
  }
  const revocations = tree.read(REVOCATIONS_PATH);
  if (revocations) {
    const checked = validateRevocationsText(revocations.toString("utf8"));
    if (!checked.ok) problems.push({ subject: REVOCATIONS_PATH, message: checked.error });
  }
  return problems;
}
