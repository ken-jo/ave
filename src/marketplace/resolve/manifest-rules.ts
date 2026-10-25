/** Staged manifests must match reviewed identity, version and canonicalized authority.
 * Process entries require supported platforms, a pinned artifact, no tree rung and sufficient host floors. */
import { AVE_EXTENSION_NAMESPACE, flattenAgentPluginsManifest } from "../../plugins/public-contract.js";
import { HOST_PROTOCOL_FIRST_APP_VERSION, isServedHostProtocolVersion } from "../../plugins/isolation/host-api-wire.js";
import { hasProcessEntry, PROCESS_ENTRY_FIRST_APP_VERSION } from "../../plugins/process-entry.js";
import { sandboxDeclarationProblem } from "../../plugins/sandbox-authority.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { compareSemver } from "../../shared/semver-compare.js";
import { MARKETPLACE_DESCRIPTOR_FILE, type Platform, type PluginArtifactPins, type PluginAuthority } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";
import { isRecord } from "../../shared/is-record.js";

export const PLUGIN_AUTHORITY_FIELDS = [
  "capabilities",
  "networkAccess",
  "hostSecrets",
  "pluginAccess",
  "auth",
  "requires",
  "dependencies",
  "sandbox",
] as const satisfies ReadonlyArray<keyof PluginAuthority>;

export interface ExpectedPlugin {
  name: string;
  version: string;
  minAppVersion: string;
  hostProtocol?: string;
  authority: PluginAuthority;
  /** Every producer supplies platform and artifact fields so process admission cannot be skipped. */
  platforms: readonly Platform[] | undefined;
  artifact: PluginArtifactPins | undefined;
}

interface ExpectedPluginSource {
  name: string;
  version: string;
  minAppVersion: string;
  hostProtocol?: string;
  platforms?: readonly Platform[];
  authority: PluginAuthority;
  artifact: PluginArtifactPins;
}

export function expectedPluginOf(plan: ExpectedPluginSource): ExpectedPlugin {
  return {
    name: plan.name,
    version: plan.version,
    minAppVersion: plan.minAppVersion,
    hostProtocol: plan.hostProtocol,
    authority: plan.authority,
    platforms: plan.platforms,
    artifact: plan.artifact,
  };
}

/** Null without the host extension; compare its authority fields against the descriptor. */
export function manifestAuthority(manifest: unknown): PluginAuthority | null {
  const ave = isRecord(manifest) && isRecord(manifest.extensions) ? manifest.extensions[AVE_EXTENSION_NAMESPACE] : undefined;
  if (!isRecord(ave)) return null;
  return Object.fromEntries(PLUGIN_AUTHORITY_FIELDS.filter((field) => ave[field] !== undefined).map((field) => [field, ave[field]])) as unknown as PluginAuthority;
}

function sameField(record: Record<string, unknown>, expected: PluginAuthority, field: keyof PluginAuthority): boolean {
  const has = Object.prototype.hasOwnProperty.call(record, field) && record[field] !== undefined;
  const wants = expected[field] !== undefined;
  if (has !== wants) return false;
  return !has || canonicalStringify(record[field]) === canonicalStringify(expected[field]);
}

const COMPAT_UNDECLARED = "requires.minAppVersion is required for a git install";

function processEntryMismatches(expected: ExpectedPlugin, descriptor: string): string[] {
  const problems: string[] = [];
  if (expected.platforms === undefined) {
    problems.push(`platforms is not declared in ${descriptor}; a process entry must list its platforms, without "win32"`);
  } else if (expected.platforms.includes("win32")) {
    problems.push(`platforms in ${descriptor} includes "win32", where a process entry cannot run`);
  }
  const pinned = Boolean(expected.artifact?.release?.sha256) || Boolean(expected.artifact?.archive?.sha256);
  if (!pinned) {
    problems.push(`artifact in ${descriptor} pins no release or archive by sha256, which a process entry is installed from`);
  }
  if (expected.artifact?.tree !== undefined) {
    problems.push(`artifact.tree is declared in ${descriptor}; a process entry is never installed from the tree rung`);
  }
  if (compareSemver(expected.minAppVersion, PROCESS_ENTRY_FIRST_APP_VERSION) < 0) {
    problems.push(
      `minAppVersion in ${descriptor} is "${expected.minAppVersion}"; a process entry needs ${PROCESS_ENTRY_FIRST_APP_VERSION} or newer, the first release that runs one`,
    );
  }
  return problems;
}

/** Reports every mismatch; descriptor identifies the file in diagnostics. */
export function gitInstallManifestMismatches(document: unknown, expected: ExpectedPlugin, descriptor = MARKETPLACE_DESCRIPTOR_FILE): string[] {
  if (!isRecord(document)) return ["plugin.json is not a JSON object"];
  const problems: string[] = [];
  if (document.name !== expected.name) problems.push(`name is ${JSON.stringify(document.name)}, the descriptor says "${expected.name}"`);
  if (document.version !== expected.version) {
    problems.push(`version is ${JSON.stringify(document.version)}, the descriptor says "${expected.version}"`);
  }
  const extensions = document.extensions;
  const ave = isRecord(extensions) ? extensions[AVE_EXTENSION_NAMESPACE] : undefined;
  if (!isRecord(ave)) return [...problems, `extensions["${AVE_EXTENSION_NAMESPACE}"] is missing`];
  const sandboxProblem = sandboxDeclarationProblem(flattenAgentPluginsManifest(document));
  if (sandboxProblem) problems.push(sandboxProblem);
  if (Object.prototype.hasOwnProperty.call(ave, "installPolicy")) {
    problems.push("installPolicy is no longer supported: no package is installed or locked by its own manifest");
  }
  if (Object.prototype.hasOwnProperty.call(ave, "publisher")) {
    problems.push("publisher is no longer supported: no verified publishing identity backs it");
  }
  const requires = ave.requires;
  const minAppVersion = isRecord(requires) ? requires.minAppVersion : undefined;
  if (typeof minAppVersion !== "string") {
    problems.push(COMPAT_UNDECLARED);
  } else if (minAppVersion !== expected.minAppVersion) {
    problems.push(`requires.minAppVersion is "${minAppVersion}", the descriptor says "${expected.minAppVersion}"`);
  }
  const hostProtocol = isRecord(requires) ? requires.hostProtocol : undefined;
  if (hostProtocol !== expected.hostProtocol) {
    problems.push(`requires.hostProtocol differs from the descriptor's hostProtocol`);
  }
  const protocolFloor = expected.hostProtocol !== undefined && isServedHostProtocolVersion(expected.hostProtocol)
    ? HOST_PROTOCOL_FIRST_APP_VERSION[expected.hostProtocol]
    : undefined;
  if (protocolFloor !== undefined && compareSemver(expected.minAppVersion, protocolFloor) < 0) {
    problems.push(
      `minAppVersion in ${descriptor} is "${expected.minAppVersion}"; host protocol ${expected.hostProtocol} needs ${protocolFloor} or newer, the first release that serves it`,
    );
  }
  for (const field of PLUGIN_AUTHORITY_FIELDS) {
    if (!sameField(ave, expected.authority, field)) problems.push(`${field} differs from the descriptor's authority`);
  }
  if (hasProcessEntry(document)) problems.push(...processEntryMismatches(expected, descriptor));
  return problems;
}

/** Missing compatibility declarations differ from other manifest mismatches. */
export function assertGitInstallManifest(document: unknown, expected: ExpectedPlugin): void {
  const problems = gitInstallManifestMismatches(document, expected);
  if (problems.includes(COMPAT_UNDECLARED)) {
    throw new MarketplaceError("PACKAGE_COMPAT_UNDECLARED", `plugin ${expected.name}@${expected.version}: ${problems.join("; ")}`);
  }
  if (problems.length > 0) {
    throw new MarketplaceError("MANIFEST_MISMATCH", `plugin ${expected.name}@${expected.version}: ${problems.join("; ")}`);
  }
}
