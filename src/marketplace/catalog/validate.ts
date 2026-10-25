/** Schemas check shape; semantic rules enforce uniqueness, ordering and reserved identities.
 * Invalid roots reject the commit; invalid entries are dropped with diagnostics. */
import type { ErrorObject, ValidateFunction } from "ajv";
import manifestSchema from "../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import indexSchema from "../../../schemas/marketplace/index.schema.json" with { type: "json" };
import packageSchema from "../../../schemas/marketplace/package.schema.json" with { type: "json" };
import conditionalSchema from "../../../schemas/marketplace/revocations-by-app.schema.json" with { type: "json" };
import type { SourceSnapshot } from "../sources/snapshot.js";
import type { ConditionalRevocationsFile } from "./types.js";
import revocationsSchema from "../../../schemas/marketplace/revocations.schema.json" with { type: "json" };
import { RESERVED_ENV_NAMES, RESERVED_HEADERS } from "../../mcp/safe-names.js";
import { resolveAddFormats, resolveAjv } from "../../plugins/config-schema.js";
import { ALERT_RESERVED_PACKAGE_ID } from "../../shared/alerts-types.js";
import { CREDENTIAL_ISSUER_NAMES, holdsCredential, reservedPrefixIn } from "../../shared/dlp.js";
import type { MarketplaceErrorDetail } from "../errors.js";
import { isRecord } from "../../shared/is-record.js";
import { compareSemver } from "../../shared/semver-compare.js";
import { parseStrictJson } from "./strict-json.js";
import {
  MARKETPLACE_DESCRIPTOR_FILE,
  MARKETPLACE_INDEX_FILE,
  NULL_OBJECT_ID,
  type AgentPluginComponents,
  type IndexPackage,
  type MarketplaceIndex,
  type PackageDescriptor,
  type PluginArtifactPins,
  type PluginAuthority,
  type RevocationsFile,
} from "./types.js";
import { parseVersionRange } from "./version-range.js";

export interface CatalogDiagnostic {
  subject: string;
  message: string;
}

/** Credential-shaped identifiers set credential so refusals can omit their unsafe text. */
export type Validation<T> = { ok: true; value: T } | { ok: false; error: string; credential?: CredentialDetail };

export type CredentialDetail = MarketplaceErrorDetail<"SOURCE_INDEX_INVALID">;

export type IdentifierPart = "name" | "version" | "component";

const PART_TEXT: Readonly<Record<IdentifierPart, string>> = { name: "its name", version: "a version", component: "a component name" };

/** Credential prefixes reserve their namespace; other credential shapes are refused without echoing them. */
export function credentialRefusal(part: IdentifierPart, text: string): { detail: CredentialDetail; message: string } {
  const reserved = reservedPrefixIn(text);
  if (reserved) {
    const reason = ({ name: "name-reserved-prefix", version: "version-reserved-prefix", component: "component-reserved-prefix" } as const)[part];
    return {
      detail: { reason, prefix: reserved.prefix, issuer: reserved.issuer },
      message: `${PART_TEXT[part]} uses the reserved prefix ${reserved.prefix}, which looks like ${CREDENTIAL_ISSUER_NAMES[reserved.issuer]}; choose a different one`,
    };
  }
  const reason = ({ name: "name-holds-credential", version: "version-holds-credential", component: "component-holds-credential" } as const)[part];
  return { detail: { reason }, message: `${PART_TEXT[part]} looks like a password or token` };
}

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

/** Reject identifiers the egress scrubber would change, so admitted packages remain addressable. */
function credentialIn(name: string, versions: readonly string[], components: ReadonlyArray<AgentPluginComponents | undefined>): { detail: CredentialDetail; message: string } | null {
  if (holdsCredential(name)) return credentialRefusal("name", name);
  const version = versions.find(holdsCredential);
  if (version !== undefined) return credentialRefusal("version", version);
  const component = components.flatMap(componentNames).find(holdsCredential);
  if (component !== undefined) return credentialRefusal("component", component);
  return null;
}

// Read schema ids from their files so published URLs have one source of truth.
const INDEX_ID = indexSchema.$id;
const PACKAGE_ID = packageSchema.$id;
const REVOCATIONS_ID = revocationsSchema.$id;

interface Validators {
  indexRoot: ValidateFunction;
  indexPackage: ValidateFunction;
  descriptor: ValidateFunction;
  revocations: ValidateFunction;
  conditionalRevocations: ValidateFunction;
  snapshot: ValidateFunction;
}

const SNAPSHOT_PIN = { anyOf: [{ $ref: PACKAGE_ID + "#/definitions/commit" }, { type: "string", pattern: "^local-[0-9a-f]{64}$" }] };

let compiled: Validators | null = null;

/** Only the current catalog schema is supported; reject other versions before schema validation. */
const CATALOG_SCHEMA_VERSION = 2;

function unsupportedSchemaVersion(document: unknown, file: string): string | null {
  if (!isRecord(document) || !Object.hasOwn(document, "schemaVersion")) return null;
  if (document.schemaVersion === CATALOG_SCHEMA_VERSION) return null;
  return `${file}: schemaVersion ${JSON.stringify(document.schemaVersion)} is not supported; this app reads schemaVersion ${CATALOG_SCHEMA_VERSION}`;
}

function validators(): Validators {
  if (compiled) return compiled;
  const AjvCtor = resolveAjv();
  const ajv = new AjvCtor({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  resolveAddFormats()(ajv);
  ajv.addSchema(manifestSchema);
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
        // Folder revisions are cache pins, never index commit values.
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

/** Reserve host to prevent plugin alerts from impersonating host overlay sources. */
function reservedPluginName(kind: string, name: string): string | null {
  return kind === "plugin" && name === ALERT_RESERVED_PACKAGE_ID
    ? `the plugin name ${ALERT_RESERVED_PACKAGE_ID} is reserved for the host`
    : null;
}

/** Legacy zero-commit pins retain a release digest only and are always yanked. */
function legacyPinRule(kind: string, version: IndexVersionShape): string | null {
  if (version.commit !== NULL_OBJECT_ID) return null;
  if (kind !== "plugin") return "only a plugin version can be a legacy grant pin (the all-zero commit)";
  if (!version.yanked) return "a legacy grant pin (the all-zero commit) must be yanked";
  const artifact = version.artifact;
  const release = artifact?.release;
  if (!release?.sha256 || release.tag || release.asset || release.url || artifact?.archive || artifact?.tree !== undefined) {
    return "a legacy grant pin (the all-zero commit) pins only its release sha256";
  }
  return null;
}

type IndexVersionShape = NonNullable<IndexPackage["versions"]>[number];

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
    const pin = legacyPinRule(entry.kind, version);
    if (pin) return `version ${version.version}: ${pin}`;
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
  official: boolean;
}

export interface ValidatedIndex {
  index: MarketplaceIndex;
  diagnostics: CatalogDiagnostic[];
}

export function validateIndexText(text: string, context: IndexContext): Validation<ValidatedIndex> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const version = unsupportedSchemaVersion(parsed.value, MARKETPLACE_INDEX_FILE);
  if (version) return { ok: false, error: version };
  const { indexRoot, indexPackage } = validators();
  if (!indexRoot(parsed.value)) return { ok: false, error: `${MARKETPLACE_INDEX_FILE}: ${describeErrors(indexRoot.errors)}` };
  const root = parsed.value as Omit<MarketplaceIndex, "packages"> & { packages: unknown[] };
  if (context.official && root.name !== context.sourceId) {
    return { ok: false, error: `${MARKETPLACE_INDEX_FILE}: the official index must be named "${context.sourceId}", not "${root.name}"` };
  }

  const diagnostics: CatalogDiagnostic[] = [];
  const candidates: IndexPackage[] = [];
  // Broken entries still claim names; paths become claims only after full validation.
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

export interface DescriptorContext {
  expected?: { kind: string; name: string };
  direct: boolean;
}

export function validateDescriptorText(text: string, context: DescriptorContext): Validation<PackageDescriptor> {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  return validateDescriptorValue(parsed.value, context, MARKETPLACE_DESCRIPTOR_FILE);
}

function validateDescriptorValue(document: unknown, context: DescriptorContext, file: string): Validation<PackageDescriptor> {
  const version = unsupportedSchemaVersion(document, file);
  if (version) return { ok: false, error: version };
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
  if (credential) return { ok: false, error: `${file}: ${credential.message}`, credential: credential.detail };
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

const ROOT_TREE_STAND_IN = "tree";

/** Synthesized descriptors use normal validation; root tree artifacts need a temporary path stand-in. */
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
/** Apply current identifier admission on every cached read, including offline; keep stored files unchanged. */
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
