/**
 * Git-install manifest rules (design §5.3, §6.2).
 *
 * A plugin installed from any git source must carry, in its staged
 * `plugin.json`, exactly what the descriptor promised: the same name and
 * version, a `requires.minAppVersion` equal to the descriptor's, and every
 * `PluginAuthority` field byte-for-byte after key canonicalization. The
 * descriptor is what the user consented to, so any difference is a package
 * inconsistency and stops the ladder (`MANIFEST_MISMATCH`).
 *
 * The manifest schema keeps `requires.minAppVersion` optional for local
 * development installs; this rule is the install plan's, not the schema's.
 */
import { AVE_EXTENSION_NAMESPACE, flattenAgentPluginsManifest } from "../../plugins/public-contract.js";
import { sandboxDeclarationProblem } from "../../plugins/sandbox-authority.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { PluginAuthority } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";

/** Every field of `PluginAuthority`, in the order mismatches are reported. */
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The authority a `plugin.json` declares: exactly the fields its Ave
 * extension carries, so a comparison with a descriptor's is field by field.
 * Null when the manifest has no Ave extension.
 */
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

/** Every rule the staged document breaks; empty = it matches the descriptor. */
export function gitInstallManifestMismatches(document: unknown, expected: ExpectedPlugin): string[] {
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
  for (const field of PLUGIN_AUTHORITY_FIELDS) {
    if (!sameField(ave, expected.authority, field)) problems.push(`${field} differs from the descriptor's authority`);
  }
  return problems;
}

/**
 * Throw naming every broken rule: `PACKAGE_COMPAT_UNDECLARED` when the
 * manifest does not declare `requires.minAppVersion` (design §14), else
 * `MANIFEST_MISMATCH`.
 */
export function assertGitInstallManifest(document: unknown, expected: ExpectedPlugin): void {
  const problems = gitInstallManifestMismatches(document, expected);
  if (problems.includes(COMPAT_UNDECLARED)) {
    throw new MarketplaceError("PACKAGE_COMPAT_UNDECLARED", `plugin ${expected.name}@${expected.version}: ${problems.join("; ")}`);
  }
  if (problems.length > 0) {
    throw new MarketplaceError("MANIFEST_MISMATCH", `plugin ${expected.name}@${expected.version}: ${problems.join("; ")}`);
  }
}
