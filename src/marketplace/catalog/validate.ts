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
import indexSchema from "../../../schemas/marketplace/index.2.schema.json" with { type: "json" };
import packageSchema from "../../../schemas/marketplace/package.2.schema.json" with { type: "json" };
import legacyIndexSchema from "../../../schemas/marketplace/index.schema.json" with { type: "json" };
import legacyPackageSchema from "../../../schemas/marketplace/package.schema.json" with { type: "json" };
import conditionalSchema from "../../../schemas/marketplace/revocations-by-app.schema.json" with { type: "json" };
import type { SourceSnapshot } from "../sources/snapshot.js";
import type { ConditionalRevocationsFile } from "./types.js";
import revocationsSchema from "../../../schemas/marketplace/revocations.schema.json" with { type: "json" };
import { RESERVED_ENV_NAMES, RESERVED_HEADERS } from "../../mcp/safe-names.js";
import { resolveAddFormats, resolveAjv } from "../../plugins/config-schema.js";
import { ALERT_RESERVED_PACKAGE_ID } from "../../shared/alerts-types.js";
import { holdsCredential } from "../../shared/dlp.js";
import { compareSemver } from "../../shared/semver-compare.js";
import { parseStrictJson } from "./strict-json.js";
import type {
  AgentPluginComponents,
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

/**
 * A failure; `credential` is set when the reason is an identifier with a
 * credential's shape (§18.8), the detail reason the refusal carries.
 */
export type Validation<T> = { ok: true; value: T } | { ok: false; error: string; credential?: CredentialReason };

/** The identifier of a package that has a credential's shape (§18.8). */
export type CredentialReason = "name-holds-credential" | "version-holds-credential" | "component-holds-credential";

/** Every name the renderer can name a component of an agent plugin by. */
function componentNames(components: AgentPluginComponents | undefined): string[] {
  if (!components) return [];
  return [
    ...components.skills.map((skill) => skill.name),
    ...Object.keys(components.mcpServers),
    ...components.prompts.map((prompt) => prompt.name),
    ...components.agents.map((agent) => agent.name),
    ...components.routineTemplates.map((routine) => routine.id),
  ];
}

/**
 * The first identifier of a package that has a credential's shape, as the
 * one detector the scrubber uses (§18.8). The renderer gets every string
 * from main scrubbed and names a package, a version or a component back by
 * it, so an identifier the scrubber would change could never be named
 * again: it is refused here, where it enters, and egress scrubbing leaves
 * every identifier that passed unchanged.
 */
function credentialIn(name: string, versions: readonly string[], components: ReadonlyArray<AgentPluginComponents | undefined>): { reason: CredentialReason; message: string } | null {
  if (holdsCredential(name)) return { reason: "name-holds-credential", message: "its name looks like a password or token" };
  if (versions.some(holdsCredential)) return { reason: "version-holds-credential", message: "a version looks like a password or token" };
  if (components.some((item) => componentNames(item).some(holdsCredential))) {
    return { reason: "component-holds-credential", message: "a component name looks like a password or token" };
  }
  return null;
}

const INDEX_ID = "https://sdk.former-site.invalid/schemas/marketplace/index.2.schema.json";
const PACKAGE_ID = "https://sdk.former-site.invalid/schemas/marketplace/package.2.schema.json";
const REVOCATIONS_ID = "https://sdk.former-site.invalid/schemas/marketplace/revocations.schema.json";

interface Validators {
  indexRoot: ValidateFunction;
  indexPackage: ValidateFunction;
  descriptor: ValidateFunction;
  revocations: ValidateFunction;
  conditionalRevocations: ValidateFunction;
  snapshot: ValidateFunction;
}

/** A cached snapshot's pin: a commit, or a folder source's `local-<sha256>` revision (§18.4.3). */
const SNAPSHOT_PIN = { anyOf: [{ $ref: PACKAGE_ID + "#/definitions/commit" }, { type: "string", pattern: "^local-[0-9a-f]{64}$" }] };

let compiled: Validators | null = null;
let legacyIndexValidator: ValidateFunction | null = null;

/** Check the frozen file with its original closed format, independent of format 2. */
export function validateLegacyIndexText(text: string): Validation<Record<string, unknown>> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  if (!legacyIndexValidator) {
    const AjvCtor = resolveAjv();
    const ajv = new AjvCtor({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
    resolveAddFormats()(ajv);
    ajv.addSchema(manifestSchema);
    ajv.addSchema(legacyPackageSchema);
    legacyIndexValidator = ajv.compile(legacyIndexSchema);
  }
  if (!legacyIndexValidator(parsed.value)) {
    return { ok: false, error: `marketplace.json: ${describeErrors(legacyIndexValidator.errors)}` };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

function validators(): Validators {
  if (compiled) return compiled;
  const AjvCtor = resolveAjv();
  const ajv = new AjvCtor({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  resolveAddFormats()(ajv);
  ajv.addSchema(manifestSchema);
  ajv.addSchema(legacyPackageSchema);
  ajv.addSchema(packageSchema);
  ajv.addSchema(indexSchema);
  ajv.addSchema(revocationsSchema);
  ajv.addSchema(conditionalSchema);
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
    conditionalRevocations: get(conditionalSchema.$id),
    snapshot: ajv.compile({
      type: "object", additionalProperties: false,
      required: ["formatVersion", "sourceId", "commit", "fetchedAt", "marketplace", "packages", "revocations", "conditionalRevocations", "diagnostics"],
      properties: {
        formatVersion: { const: 2 },
        sourceId: { $ref: PACKAGE_ID + "#/definitions/sourceId" },
        // A folder source's pin is its revision (§18.4.3); only a cached snapshot names one, never an index.
        commit: SNAPSHOT_PIN,
        fetchedAt: { type: "string", format: "date-time" },
        marketplace: {
          type: "object", additionalProperties: false, required: ["name", "displayName"],
          properties: Object.fromEntries(["name", "displayName", "description", "owner"].map((key) =>
            [key, { $ref: INDEX_ID + "#/definitions/indexRoot/properties/" + key }])),
        },
        packages: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["kind", "name", "path", "versions"],
          properties: {
            ...Object.fromEntries(Object.keys(indexSchema.definitions.indexPackage.properties).map((key) =>
              [key, { $ref: INDEX_ID + "#/definitions/indexPackage/properties/" + key }])),
            // Direct sources can install a package from the repository root.
            path: { anyOf: [{ const: "" }, { $ref: PACKAGE_ID + "#/definitions/repoPath" }] },
            treeSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            versions: {
              ...indexSchema.definitions.indexPackage.properties.versions,
              items: {
                ...indexSchema.definitions.indexVersion,
                properties: {
                  ...Object.fromEntries(Object.keys(indexSchema.definitions.indexVersion.properties).map((key) =>
                    [key, { $ref: INDEX_ID + "#/definitions/indexVersion/properties/" + key }])),
                  commit: SNAPSHOT_PIN,
                  // An implicit tree install synthesized at the root has no artifact pins.
                  artifact: { anyOf: [{ type: "object", maxProperties: 0 }, { $ref: PACKAGE_ID + "#/definitions/pluginArtifactPins" }] },
                },
              },
            },
          },
        } },
        revocations: { $ref: REVOCATIONS_ID + "#/properties/revocations" },
        conditionalRevocations: { $ref: conditionalSchema.$id + "#/properties/revocations" },
        diagnostics: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["subject", "message"],
          properties: { subject: { type: "string" }, message: { type: "string" } },
        } },
      },
    }),
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

function pluginRules(authority: PluginAuthority, artifact: PluginArtifactPins, minAppVersion: string, hostProtocol: string | undefined, direct: boolean): string | null {
  if (authority.requires?.minAppVersion !== minAppVersion) {
    return `authority.requires.minAppVersion (${authority.requires?.minAppVersion ?? "absent"}) must equal minAppVersion (${minAppVersion})`;
  }
  if (authority.requires?.hostProtocol !== hostProtocol) {
    return "authority.requires.hostProtocol must equal hostProtocol";
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
      // `\` and `:` would be separators or a drive on Windows, where the split above cannot see them.
      if (
        /[\\:\u0000-\u001f\u007f]/u.test(command)
        || segments[0] !== "server"
        || segments.length < 2
        || segments.some((s) => s === "" || s === "." || s === "..")
      ) {
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

/**
 * A plugin may not take the host's own package id: host alert kinds stage
 * the overlay source `overlay:host--<kind>`, which a plugin named `host`
 * would mint for its own kinds. Plugin load refuses the id as well.
 */
function reservedPluginName(kind: string, name: string): string | null {
  return kind === "plugin" && name === ALERT_RESERVED_PACKAGE_ID
    ? `the plugin name ${ALERT_RESERVED_PACKAGE_ID} is reserved for the host`
    : null;
}

function indexPackageRules(entry: IndexPackage): string | null {
  const reserved = reservedPluginName(entry.kind, entry.name);
  if (reserved) return reserved;
  if ((entry.kind === "agent-plugin" && entry.path.startsWith("plugins/"))
    || (entry.kind === "plugin" && entry.path.startsWith("agent-plugins/"))) {
    return `${entry.kind} cannot use the other kind's package directory`;
  }
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
      if (version.components !== undefined) return `version ${version.version}: components are for agent plugins only`;
      const rule = pluginRules(version.authority, version.artifact, version.minAppVersion, version.hostProtocol, false);
      if (rule) return `version ${version.version}: ${rule}`;
    } else if (entry.kind === "agent-plugin") {
      if (!version.components) return `agent-plugin version ${version.version} needs components`;
      if (version.authority || version.artifact || version.hostProtocol) return `agent-plugin version ${version.version} cannot declare extension authority`;
    } else if (version.authority || version.artifact || version.components) {
      return `version ${version.version}: authority, artifact and components require their matching kind`;
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
  // A broken entry still claims its name, since the author listed it twice.
  // A path only becomes a claim after the entry passes both validation layers.
  const byName = new Map<string, number>();
  const byPath = new Map<string, number>();
  const claim = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  root.packages.forEach((raw, position) => {
    const entry = raw as Partial<IndexPackage>;
    // A name with a credential's shape is named by its position, never by itself.
    const named = typeof entry.kind === "string" && typeof entry.name === "string" && !holdsCredential(entry.name);
    const subject = named ? `${entry.kind}/${entry.name}` : `packages[${position}]`;
    if (typeof entry.kind === "string" && typeof entry.name === "string") claim(byName, `${entry.kind}/${entry.name}`);
    if (!indexPackage(raw)) {
      diagnostics.push({ subject, message: describeErrors(indexPackage.errors) });
      return;
    }
    const listed = raw as IndexPackage;
    const credential = credentialIn(
      listed.name,
      [...(listed.latest !== undefined ? [listed.latest] : []), ...(listed.versions ?? []).map((version) => version.version)],
      (listed.versions ?? []).map((version) => version.components),
    );
    if (credential) {
      diagnostics.push({ subject, message: credential.message });
      return;
    }
    const rule = indexPackageRules(listed);
    if (rule) {
      diagnostics.push({ subject, message: rule });
      return;
    }
    claim(byPath, (raw as IndexPackage).path);
    candidates.push(raw as IndexPackage);
  });

  // (kind, name) and path must each name one package; an ambiguous pair drops every claimant.
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
  return validateDescriptorValue(parsed.value, context, "ave-package.json");
}

function validateDescriptorValue(document: unknown, context: DescriptorContext, file: string): Validation<PackageDescriptor> {
  const { descriptor } = validators();
  if (!descriptor(document)) return { ok: false, error: `${file}: ${describeErrors(descriptor.errors)}` };
  const value = document as PackageDescriptor;
  if (context.expected && (context.expected.kind !== value.kind || context.expected.name !== value.name)) {
    return {
      ok: false,
      error: `${file} declares ${value.kind}/${value.name} but the index lists ${context.expected.kind}/${context.expected.name}`,
    };
  }
  const credential = credentialIn(value.name, [value.version], value.kind === "agent-plugin" ? [(value.payload as { components?: AgentPluginComponents }).components] : []);
  if (credential) return { ok: false, error: `${file}: ${credential.message}`, credential: credential.reason };
  const reserved = reservedPluginName(value.kind, value.name);
  if (reserved) return { ok: false, error: `${file}: ${reserved}` };
  if (value.kind === "plugin") {
    const payload = value.payload as { authority: PluginAuthority; artifact: PluginArtifactPins };
    const rule = pluginRules(payload.authority, payload.artifact, value.minAppVersion, value.hostProtocol, context.direct);
    if (rule) return { ok: false, error: `${file}: ${rule}` };
  }
  if (value.kind === "mcp") {
    const rule = mcpRules(value.payload);
    if (rule) return { ok: false, error: `${file}: ${rule}` };
  }
  return { ok: true, value };
}

/** Stands in for the default tree rung, which at a repository root has no path to name. */
const ROOT_TREE_STAND_IN = "tree";

/**
 * A descriptor synthesized from a direct package's own file (design §8.2),
 * held to the same schema and rules as a written one; errors name `file`.
 * A plugin at the root of its repository has an empty `artifact`: its tree
 * rung is the default, and the schema's one-rung minimum cannot name the
 * root as a path, so that one field is checked with a stand-in and returned
 * empty.
 */
export function validateSynthesizedDescriptor(document: PackageDescriptor, file: string): Validation<PackageDescriptor> {
  const artifact = document.kind === "plugin" ? (document.payload as { artifact?: unknown }).artifact : undefined;
  const rootTree = typeof artifact === "object" && artifact !== null && Object.keys(artifact).length === 0;
  const checked = validateDescriptorValue(
    rootTree ? { ...document, payload: { ...document.payload, artifact: { tree: ROOT_TREE_STAND_IN } } } : document,
    { direct: true },
    file,
  );
  if (!checked.ok || !rootTree) return checked;
  return { ok: true, value: { ...checked.value, payload: { ...checked.value.payload, artifact: {} } } };
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

/** The sibling policy is optional, but a present invalid file rejects its commit. */
export function validateConditionalRevocationsText(text: string): Validation<ConditionalRevocationsFile> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const check = validators().conditionalRevocations;
  if (!check(parsed.value)) return { ok: false, error: "policy/revocations-by-app.json: " + describeErrors(check.errors) };

  const file = parsed.value as ConditionalRevocationsFile;
  for (const entry of file.revocations) {
    try { parseVersionRange(entry.versions); } catch (error) {
      return { ok: false, error: "policy/revocations-by-app.json: " + (error as Error).message };
    }
    if (entry.kind !== "plugin" && (entry.successors.plugins.length || entry.successors.hostKinds.length)) {
      return { ok: false, error: "Only plugin retirements may name successors" };
    }
  }
  return { ok: true, value: file };
}

/** A same-pin sync may reuse only a complete, current and readable cache. */
/**
 * A stored snapshot as it is served: its packages held to the identifier
 * admission a fresh read applies (§18.8). A snapshot written before that
 * rule, or at a commit a refresh does not rebuild, can still list a package
 * whose name, version or component name has a credential's shape; it is
 * left out here, with the diagnostic a fresh read gives, on every read
 * (offline ones included). The file, and its revocations, stay as stored.
 */
export function admitSnapshotPackages(snapshot: SourceSnapshot): SourceSnapshot {
  const diagnostics: CatalogDiagnostic[] = [];
  const packages = snapshot.packages.filter((entry, position) => {
    const credential = credentialIn(
      entry.name,
      [...(entry.latest !== undefined ? [entry.latest] : []), ...entry.versions.map((version) => version.version)],
      entry.versions.map((version) => version.components),
    );
    if (!credential) return true;
    diagnostics.push({ subject: holdsCredential(entry.name) ? `packages[${position}]` : `${entry.kind}/${entry.name}`, message: credential.message });
    return false;
  });
  return diagnostics.length === 0 ? snapshot : { ...snapshot, packages, diagnostics: [...snapshot.diagnostics, ...diagnostics] };
}

export function validateCachedSnapshotText(text: string): Validation<SourceSnapshot> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const validate = validators().snapshot;
  if (!validate(parsed.value)) return { ok: false, error: "snapshot: " + describeErrors(validate.errors) };
  const snapshot = parsed.value as SourceSnapshot;
  const plain = validateRevocationsText(JSON.stringify({ schemaVersion: 1, revocations: snapshot.revocations }));
  if (!plain.ok) return plain;
  const conditional = validateConditionalRevocationsText(JSON.stringify({ schemaVersion: 1, revocations: snapshot.conditionalRevocations }));
  if (!conditional.ok) return conditional;
  return { ok: true, value: snapshot };
}
