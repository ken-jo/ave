/** Repository checks reuse install validators so publication and runtime acceptance agree. */
import { messages } from "../i18n/messages/index.js";
import { MARKETPLACE_INDEX_FILE as INDEX_PATH, MARKETPLACE_DESCRIPTOR_FILE, type IndexPackage, type IndexVersion, type PackageDescriptor, type PluginArtifactPins, type PluginAuthority } from "./catalog/types.js";
import { validateConditionalRevocationsText, validateDescriptorText, validateIndexText, validateRevocationsText } from "./catalog/validate.js";
import { isDataContentKind, parseContent } from "./content/kinds.js";
import { checkContentFiles, isContentKind } from "./content/rules.js";
import { descriptorDiffersFromIndex, repoPath } from "./resolve/descriptor.js";
import { gitInstallManifestMismatches } from "./resolve/manifest-rules.js";
import { declaredMcpServer, mcpPayloadReadsServerJson, parseServerJson } from "./resolve/mcp.js";
import { hasProcessEntry } from "../plugins/process-entry.js";
import { AVE_EXTENSION_NAMESPACE } from "../plugins/public-contract.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/is-record.js";
import { compareSemver, isSemver } from "../shared/semver-compare.js";

export interface RepositoryTree {
  read(path: string): Buffer | null;
  list(dir: string): string[];
}

export interface RepositoryCheckOptions {
  /** Requires the published stable alerts-contract version; never guesses a default. */
  alertsReleaseVersion: string;
  sourceId: string;
  official: boolean;
  /** Validate each downloaded release manifest against its own index version; yanked pins preserve grants only. */
  releasedManifests?: ReadonlyMap<string, unknown>;
}

export interface RepositoryProblem {
  subject: string;
  message: string;
}

const REVOCATIONS_PATH = "policy/revocations.json";
const TREE_TOP_LEVEL = new Set(["plugin.json", "dist", "assets"]);

function packageFiles(tree: RepositoryTree, dir: string): Array<{ path: string; data: Buffer }> {
  const prefix = dir === "" ? "" : `${dir}/`;
  return tree
    .list(dir)
    .map((path) => path.slice(prefix.length))
    .filter((path) => path !== MARKETPLACE_DESCRIPTOR_FILE)
    .sort()
    .map((path) => {
      const data = tree.read(repoPath(dir, path));
      // Listed but unreadable: an empty stand-in would pass the size and extension rules.
      if (!data) throw new Error(`${path} is listed but cannot be read`);
      return { path, data };
    });
}

function newestVersion(entry: IndexPackage): IndexVersion | null {
  return entry.versions?.[0] ?? null;
}

function pluginCopyDiffers(descriptor: PackageDescriptor, version: IndexVersion): string[] {
  const payload = descriptor.payload as { authority: PluginAuthority; artifact: PluginArtifactPins };
  const differs: string[] = [];
  if (canonicalStringify(payload.authority) !== canonicalStringify(version.authority ?? null)) differs.push("authority");
  if (canonicalStringify(payload.artifact) !== canonicalStringify(version.artifact ?? null)) differs.push("artifact");
  return differs;
}

function manifestMismatches(document: unknown, descriptor: PackageDescriptor, descriptorPath: string): string[] {
  const payload = descriptor.payload as { authority: PluginAuthority; artifact: PluginArtifactPins };
  return gitInstallManifestMismatches(document, {
    name: descriptor.name,
    version: descriptor.version,
    minAppVersion: descriptor.minAppVersion,
    hostProtocol: descriptor.hostProtocol,
    authority: payload.authority,
    platforms: descriptor.platforms,
    artifact: payload.artifact,
  }, descriptorPath);
}

/** Legacy field pins omit historical installPolicy and publisher fields; other checks still apply. */
function withoutLegacyFields(document: unknown): unknown {
  const extensions = isRecord(document) ? document.extensions : undefined;
  const ave = isRecord(extensions) ? extensions[AVE_EXTENSION_NAMESPACE] : undefined;
  if (!isRecord(document) || !isRecord(extensions) || !isRecord(ave)) return document;
  const { installPolicy: _installPolicy, publisher: _publisher, ...rest } = ave;
  return { ...document, extensions: { ...extensions, [AVE_EXTENSION_NAMESPACE]: rest } };
}

function checkRetiredNotificationDeclaration(document: unknown, minAppVersion: string, alertsReleaseVersion: string, report: (message: string) => void): void {
  const extensions = isRecord(document) ? document.extensions : undefined;
  const ave = isRecord(extensions) ? extensions[AVE_EXTENSION_NAMESPACE] : undefined;
  if (isRecord(ave) && Object.hasOwn(ave, "notificationEvents") && compareSemver(minAppVersion, alertsReleaseVersion) >= 0) {
    report(`notificationEvents is retired for minAppVersion ${minAppVersion} at or above the alerts release ${alertsReleaseVersion}; declare alerts kinds instead`);
  }
}

function checkReleasedManifests(entry: IndexPackage, released: ReadonlyMap<string, unknown>, alertsReleaseVersion: string, report: (message: string) => void): void {
  const prefix = `${entry.name}@`;
  const versions = new Map((entry.versions ?? []).map((version) => [version.version, version]));
  for (const [key, document] of released) {
    if (!key.startsWith(prefix)) continue;
    const version = versions.get(key.slice(prefix.length));
    if (!version) {
      report(`a released plugin.json was supplied for ${key}, which the index does not list`);
      continue;
    }
    // Apply process-entry rules only to the released manifest version that declares a process.
    const expected = {
      name: entry.name,
      version: version.version,
      minAppVersion: version.minAppVersion,
      hostProtocol: version.hostProtocol,
      authority: version.authority as PluginAuthority,
      platforms: version.platforms,
      artifact: version.artifact,
    };
    const held = version.yanked ? withoutLegacyFields(document) : document;
    for (const mismatch of gitInstallManifestMismatches(held, expected, repoPath(entry.path, MARKETPLACE_DESCRIPTOR_FILE))) {
      report(`the released plugin.json of ${version.version}: ${mismatch}`);
    }
    checkRetiredNotificationDeclaration(held, version.minAppVersion, alertsReleaseVersion,
      (message) => report(`the released plugin.json of ${version.version}: ${message}`));
  }
}

function checkPlugin(
  tree: RepositoryTree,
  entry: IndexPackage,
  descriptor: PackageDescriptor,
  options: RepositoryCheckOptions,
  report: (message: string) => void,
): void {
  if (options.releasedManifests) checkReleasedManifests(entry, options.releasedManifests, options.alertsReleaseVersion, report);
  const manifestPath = repoPath(entry.path, "plugin.json");
  const manifest = tree.read(manifestPath);
  const artifact = (descriptor.payload as { artifact: PluginArtifactPins }).artifact;
  if (!manifest) {
    if (artifact.tree !== undefined) report(`artifact.tree is declared but ${manifestPath} is missing`);
    if (compareSemver(descriptor.minAppVersion, options.alertsReleaseVersion) >= 0 && !options.releasedManifests?.has(`${descriptor.name}@${descriptor.version}`)) {
      report(`Supply releasedManifests for ${descriptor.name}@${descriptor.version} to check notificationEvents at or above the alerts release`);
    }
    return;
  }
  // A package plugin.json declares a tree rung and must satisfy its layout.
  const prefix = entry.path === "" ? "" : `${entry.path}/`;
  for (const path of tree.list(entry.path)) {
    const top = path.slice(prefix.length).split("/")[0]!;
    if (top !== MARKETPLACE_DESCRIPTOR_FILE && !TREE_TOP_LEVEL.has(top)) {
      report(`${path}: the tree rung installs plugin.json, dist/ and assets/ only`);
    }
  }
  let document: unknown;
  try {
    document = JSON.parse(manifest.toString("utf8"));
  } catch (error) {
    report(`${manifestPath} does not parse: ${errorMessage(error)}`);
    return;
  }
  for (const mismatch of manifestMismatches(document, descriptor, repoPath(entry.path, MARKETPLACE_DESCRIPTOR_FILE))) report(`${manifestPath}: ${mismatch}`);
  // Process manifests cannot install from an implicit tree rung.
  if (hasProcessEntry(document)) {
    report(`${manifestPath}: a process entry is never installed from the tree rung, which this file declares; publish it as a pinned release or archive only`);
  }
  checkRetiredNotificationDeclaration(document, descriptor.minAppVersion, options.alertsReleaseVersion,
    (message) => report(`${manifestPath}: ${message}`));
}

function checkMcp(tree: RepositoryTree, entry: IndexPackage, descriptor: PackageDescriptor, report: (message: string) => void): void {
  const prefix = entry.path === "" ? "" : `${entry.path}/`;
  for (const path of tree.list(entry.path)) {
    const relative = path.slice(prefix.length);
    if (relative !== MARKETPLACE_DESCRIPTOR_FILE && relative !== "server.json" && !relative.startsWith("server/")) {
      report(`${path}: an mcp package holds ${MARKETPLACE_DESCRIPTOR_FILE}, server.json and server/ only`);
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
    version: descriptor.version,
    minAppVersion: descriptor.minAppVersion,
    payload: descriptor.payload,
    english: messages.en,
    sourceOrigin: options.official ? "official" : "custom",
    unknownMessageKeys: "refuse",
  });
}

function checkPackage(tree: RepositoryTree, entry: IndexPackage, options: RepositoryCheckOptions, problems: RepositoryProblem[]): void {
  const subject = `${entry.kind}/${entry.name}`;
  const report = (text: string) => problems.push({ subject, message: text });
  const path = repoPath(entry.path, MARKETPLACE_DESCRIPTOR_FILE);
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
    report(errorMessage(error));
  }
}

function unlisted(tree: RepositoryTree, listed: ReadonlySet<string>): string[] {
  return tree
    .list("")
    .filter((path) => path === MARKETPLACE_DESCRIPTOR_FILE || path.endsWith(`/${MARKETPLACE_DESCRIPTOR_FILE}`))
    .map((path) => (path === MARKETPLACE_DESCRIPTOR_FILE ? "" : path.slice(0, -(MARKETPLACE_DESCRIPTOR_FILE.length + 1))))
    .filter((dir) => !listed.has(dir))
    .sort();
}

/** Report violations in runtime order: index, listed packages, unlisted descriptors, revocations. */
export function checkMarketplaceRepository(tree: RepositoryTree, options: RepositoryCheckOptions): RepositoryProblem[] {
  if (typeof options.alertsReleaseVersion !== "string" || !isSemver(options.alertsReleaseVersion) || /[-+]/.test(options.alertsReleaseVersion)) {
    return [{ subject: "alertsReleaseVersion", message: "Set alertsReleaseVersion to the published stable app version carrying the complete alerts contract before checking a repository" }];
  }
  const problems: RepositoryProblem[] = [];
  const indexBytes = tree.read(INDEX_PATH);
  if (!indexBytes) return [{ subject: INDEX_PATH, message: "is missing" }];
  const index = validateIndexText(indexBytes.toString("utf8"), { official: options.official, sourceId: options.sourceId });
  if (!index.ok) return [{ subject: INDEX_PATH, message: index.error }];
  for (const diagnostic of index.value.diagnostics) problems.push(diagnostic);
  for (const entry of index.value.index.packages) checkPackage(tree, entry, options, problems);
  const plugins = new Set(index.value.index.packages.filter((entry) => entry.kind === "plugin").map((entry) => entry.name));
  for (const key of options.releasedManifests?.keys() ?? []) {
    if (!plugins.has(key.slice(0, key.lastIndexOf("@")))) {
      problems.push({ subject: key, message: "a released plugin.json was supplied for a plugin the index does not list" });
    }
  }
  const listed = new Set(index.value.index.packages.map((entry) => entry.path));
  for (const dir of unlisted(tree, listed)) {
    problems.push({ subject: repoPath(dir, MARKETPLACE_DESCRIPTOR_FILE), message: "no index entry points at this package" });
  }
  const revocations = tree.read(REVOCATIONS_PATH);
  if (revocations) {
    const checked = validateRevocationsText(revocations.toString("utf8"));
    if (!checked.ok) problems.push({ subject: REVOCATIONS_PATH, message: checked.error });
  }
  const conditionalPath = "policy/revocations-by-app.json";
  const conditional = tree.read(conditionalPath);
  if (conditional) {
    const checked = validateConditionalRevocationsText(conditional.toString("utf8"));
    if (!checked.ok) problems.push({ subject: conditionalPath, message: checked.error });
  }
  return problems;
}
