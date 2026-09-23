/**
 * Fail-closed validation of marketplace files (design §4, §5, §10.4).
 *
 * Two layers, one definition each:
 *   - shape: the JSON Schemas in `schemas/marketplace/`, compiled once with the
 *     host's AJV settings. Plugin authority fields resolve to the plugin
 *     manifest schema, so the descriptor cannot drift from `plugin.json`.
 *   - meaning: rules JSON Schema cannot state — uniqueness, version order,
 *     `latest`, kind-specific constraints, reserved names — written out here.
 *
 * An invalid index root rejects the whole commit; an invalid package entry is
 * dropped with a diagnostic and the rest of the source stays usable (§2.2).
 */
import type { ErrorObject, ValidateFunction } from "ajv";
import manifestSchema from "../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import indexSchema from "../../../schemas/marketplace/index.schema.json" with { type: "json" };
import packageSchema from "../../../schemas/marketplace/package.schema.json" with { type: "json" };
import revocationsSchema from "../../../schemas/marketplace/revocations.schema.json" with { type: "json" };
import { RESERVED_ENV_NAMES, RESERVED_HEADERS } from "../../mcp/safe-names.js";
import { resolveAddFormats, resolveAjv } from "../../plugins/config-schema.js";
import { compareSemver } from "../../shared/semver-compare.js";
import { parseStrictJson } from "./strict-json.js";
import type {
  IndexPackage,
  MarketplaceIndex,
  PackageDescriptor,
  PluginArtifactPins,
  PluginAuthority,
  RevocationsFile,
} from "./types.js";
import { parseVersionRange } from "./version-range.js";

export interface CatalogDiagnostic {
  /** `kind/name` when known, else the entry's position. */
  subject: string;
  message: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const INDEX_ID = "https://sdk.former-site.invalid/schemas/marketplace/index.schema.json";
const PACKAGE_ID = "https://sdk.former-site.invalid/schemas/marketplace/package.schema.json";
const REVOCATIONS_ID = "https://sdk.former-site.invalid/schemas/marketplace/revocations.schema.json";

interface Validators {
  indexRoot: ValidateFunction;
  indexPackage: ValidateFunction;
  descriptor: ValidateFunction;
  revocations: ValidateFunction;
}

let compiled: Validators | null = null;

function validators(): Validators {
  if (compiled) return compiled;
  const AjvCtor = resolveAjv();
  const ajv = new AjvCtor({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  resolveAddFormats()(ajv);
  ajv.addSchema(manifestSchema);
  ajv.addSchema(packageSchema);
  ajv.addSchema(indexSchema);
  ajv.addSchema(revocationsSchema);
  const get = (ref: string): ValidateFunction => {
    const fn = ajv.getSchema(ref);
    if (!fn) throw new Error(`marketplace schema reference does not resolve: ${ref}`);
    return fn;
  };
  compiled = {
    indexRoot: get(`${INDEX_ID}#/definitions/indexRoot`),
    indexPackage: get(`${INDEX_ID}#/definitions/indexPackage`),
    descriptor: get(PACKAGE_ID),
    revocations: get(REVOCATIONS_ID),
  };
  return compiled;
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function parse(text: string): Validation<unknown> {
  try {
    return { ok: true, value: parseStrictJson(text) };
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
  }
}

// ─── meaning rules shared by index versions and descriptors ─────────────

function pluginRules(authority: PluginAuthority, artifact: PluginArtifactPins, minAppVersion: string, direct: boolean): string | null {
  if (authority.requires?.minAppVersion !== minAppVersion) {
    return `authority.requires.minAppVersion (${authority.requires?.minAppVersion ?? "absent"}) must equal minAppVersion (${minAppVersion})`;
  }
  const release = artifact.release;
  if (release && !release.url && !release.repo && !direct) {
    return "artifact.release needs repo (or url) in a marketplace repository";
  }
  if (release?.url && (release.repo || release.tag || release.asset)) {
    return "artifact.release.url replaces repo, tag and asset; do not combine them";
  }
  return null;
}

function mcpRules(payload: Record<string, unknown>): string | null {
  const server = payload.server as Record<string, unknown> | undefined;
  if (!server) return null;
  if (server.transport === "stdio") {
    const command = server.command as string;
    if (!["npx", "uvx", "docker"].includes(command)) {
      const segments = command.split("/");
      if (segments[0] !== "server" || segments.length < 2 || segments.some((s) => s === "" || s === "." || s === "..")) {
        return "a stdio command other than npx, uvx or docker must be a path under server/ in the package";
      }
    }
    for (const name of Object.keys((server.env as Record<string, string> | undefined) ?? {})) {
      if (RESERVED_ENV_NAMES.has(name.toUpperCase())) return `env ${name} is reserved by the host`;
    }
    const apiKeyEnv = server.apiKeyEnv as string | undefined;
    if (apiKeyEnv && RESERVED_ENV_NAMES.has(apiKeyEnv.toUpperCase())) return `apiKeyEnv ${apiKeyEnv} is reserved by the host`;
  } else {
    const header = server.apiKeyHeader as string | undefined;
    if (header && RESERVED_HEADERS.has(header.toLowerCase())) return `apiKeyHeader ${header} is reserved by the host`;
  }
  return null;
}

// ─── index ──────────────────────────────────────────────────────────────

function indexPackageRules(entry: IndexPackage): string | null {
  const versions = entry.versions;
  if (!versions) {
    return entry.latest ? "latest needs versions[]" : null;
  }
  for (let i = 1; i < versions.length; i++) {
    if (compareSemver(versions[i - 1]!.version, versions[i]!.version) <= 0) {
      return `versions must be newest first and strictly decreasing (${versions[i - 1]!.version} before ${versions[i]!.version})`;
    }
  }
  if (entry.latest) {
    const latest = versions.find((version) => version.version === entry.latest);
    if (!latest) return `latest ${entry.latest} is not in versions[]`;
    if (latest.yanked) return `latest ${entry.latest} is yanked`;
  }
  for (const version of versions) {
    if (entry.kind === "plugin") {
      if (!version.authority || !version.artifact) return `plugin version ${version.version} needs authority and artifact`;
      const rule = pluginRules(version.authority, version.artifact, version.minAppVersion, false);
      if (rule) return `version ${version.version}: ${rule}`;
    } else if (version.authority || version.artifact) {
      return `version ${version.version}: authority and artifact are for plugins only`;
    }
  }
  return null;
}

export interface IndexContext {
  sourceId: string;
  /** The official index must name the official source id. */
  official: boolean;
}

export interface ValidatedIndex {
  index: MarketplaceIndex;
  diagnostics: CatalogDiagnostic[];
}

export function validateIndexText(text: string, context: IndexContext): Validation<ValidatedIndex> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const { indexRoot, indexPackage } = validators();
  if (!indexRoot(parsed.value)) return { ok: false, error: `marketplace.json: ${describeErrors(indexRoot.errors)}` };
  const root = parsed.value as Omit<MarketplaceIndex, "packages"> & { packages: unknown[] };
  if (context.official && root.name !== context.sourceId) {
    return { ok: false, error: `marketplace.json: the official index must be named "${context.sourceId}", not "${root.name}"` };
  }

  const diagnostics: CatalogDiagnostic[] = [];
  const candidates: IndexPackage[] = [];
  root.packages.forEach((raw, position) => {
    const entry = raw as Partial<IndexPackage>;
    const subject = typeof entry.kind === "string" && typeof entry.name === "string" ? `${entry.kind}/${entry.name}` : `packages[${position}]`;
    if (!indexPackage(raw)) {
      diagnostics.push({ subject, message: describeErrors(indexPackage.errors) });
      return;
    }
    const rule = indexPackageRules(raw as IndexPackage);
    if (rule) {
      diagnostics.push({ subject, message: rule });
      return;
    }
    candidates.push(raw as IndexPackage);
  });

  // (kind, name) and path must each name one package; an ambiguous pair drops every claimant.
  const count = (key: (entry: IndexPackage) => string) => {
    const counts = new Map<string, number>();
    for (const entry of candidates) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
    return counts;
  };
  const byName = count((entry) => `${entry.kind}/${entry.name}`);
  const byPath = count((entry) => entry.path);
  const packages = candidates.filter((entry) => {
    const subject = `${entry.kind}/${entry.name}`;
    if ((byName.get(subject) ?? 0) > 1) {
      diagnostics.push({ subject, message: "the index lists this package more than once" });
      return false;
    }
    if ((byPath.get(entry.path) ?? 0) > 1) {
      diagnostics.push({ subject, message: `another package uses the same path ${entry.path}` });
      return false;
    }
    return true;
  });
  return { ok: true, value: { index: { ...root, packages }, diagnostics } };
}

// ─── descriptor ─────────────────────────────────────────────────────────

export interface DescriptorContext {
  /** The index entry that pointed here, when there is one; kind and name must match it. */
  expected?: { kind: string; name: string };
  /** A direct source may omit `artifact.release.repo` (it defaults to the source repository). */
  direct: boolean;
}

export function validateDescriptorText(text: string, context: DescriptorContext): Validation<PackageDescriptor> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const { descriptor } = validators();
  if (!descriptor(parsed.value)) return { ok: false, error: `ave-package.json: ${describeErrors(descriptor.errors)}` };
  const value = parsed.value as PackageDescriptor;
  if (context.expected && (context.expected.kind !== value.kind || context.expected.name !== value.name)) {
    return {
      ok: false,
      error: `ave-package.json declares ${value.kind}/${value.name} but the index lists ${context.expected.kind}/${context.expected.name}`,
    };
  }
  if (value.kind === "plugin") {
    const payload = value.payload as { authority: PluginAuthority; artifact: PluginArtifactPins };
    const rule = pluginRules(payload.authority, payload.artifact, value.minAppVersion, context.direct);
    if (rule) return { ok: false, error: `ave-package.json: ${rule}` };
  }
  if (value.kind === "mcp") {
    const rule = mcpRules(value.payload);
    if (rule) return { ok: false, error: `ave-package.json: ${rule}` };
  }
  return { ok: true, value };
}

// ─── revocations ────────────────────────────────────────────────────────

export function validateRevocationsText(text: string): Validation<RevocationsFile> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const { revocations } = validators();
  if (!revocations(parsed.value)) {
    return { ok: false, error: `policy/revocations.json: ${describeErrors(revocations.errors)}` };
  }
  const file = parsed.value as RevocationsFile;
  for (const [index, revocation] of file.revocations.entries()) {
    try {
      parseVersionRange(revocation.versions);
    } catch (error) {
      return { ok: false, error: `policy/revocations.json: revocations[${index}].versions: ${(error as Error).message}` };
    }
  }
  return { ok: true, value: file };
}
