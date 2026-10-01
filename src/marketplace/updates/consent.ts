/**
 * The consent fingerprint (design §18.7.3): everything about a package that
 * the user agreed to when it was installed, as one typed record. An update
 * applies by itself only when its fingerprint equals the installed
 * **baseline**; any difference, a narrowing included, makes it
 * `needs-review`.
 *
 * | Kind | Fields |
 * |---|---|
 * | `plugin` | `minAppVersion`, `hostProtocol`, every authority field, `entryForm`, `contributionKinds`, `mcpServer:<localId>` and `hook:<localId>` (approval digests), `processTree` for a `process` entry |
 * | `agent-plugin` | `minAppVersion`, `hostProtocol`, `componentKinds`, `mcpServer:<name>`, `hook:<index>` (approval digests), `mcpAuth` |
 * | `mcp` | `mcpRuntime` (the resolved runtime spec) |
 * | `provider` | `minAppVersion`, `providerId`, `baseUrl` |
 * | `messaging-connection` | `minAppVersion`, `connection` |
 * | `skill`, `agent`, `theme`, `font`, `language` | `minAppVersion` |
 *
 * A field that cannot be computed is listed in `unknown`, and an unknown
 * field never equals anything: the first update needs review and stores a
 * complete baseline. A component whose approval digest is `null` (its
 * closure cannot be determined) is unknown the same way, every time.
 *
 * Two checkpoints compare against the baseline. The catalog
 * ({@link catalogDelta}) sees only what the index row carries; a field it
 * does not carry is *pending*, never equal. The staged bytes
 * ({@link stagedDelta}) see everything, before anything activates.
 */
import { canonicalStringify } from "../../shared/canonical-json.js";
import { agentPluginComponentDigests, changedPayloadFiles, extensionComponentDigests, payloadTreeSha256, type PayloadFile } from "../../plugins/contribution-approval-digest.js";
import { resolvePluginContributionDeclarations } from "../../plugins/plugin-contributions.js";
import { flattenAgentPluginsManifest } from "../../plugins/public-contract.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import { type AgentPluginComponents, type IndexVersion, type PackageKind, type PluginAuthority } from "../catalog/types.js";
import { manifestAuthority } from "../resolve/manifest-rules.js";
import type { ConsentDelta, ConsentDeltaEntry, ConsentJson } from "../../shared/git-marketplace.js";
import { parseConsentFingerprint, type ConsentFingerprint } from "./consent-record.js";

export type { ConsentDelta, ConsentDeltaEntry, ConsentJson };

export { parseConsentFingerprint, type ConsentFingerprint };

/**
 * Checkpoint two found a difference (§18.7.3): the staged update differs
 * from what the user accepted. Thrown before anything activates; the apply
 * pass records `needs-review`. A consent deferral, never a failure.
 */
export class UpdateNeedsReviewError extends Error {
  constructor(readonly packageName: string, readonly delta: ConsentDelta) {
    super(`${packageName}: the update differs from what was accepted (${delta.map((entry) => entry.field).join(", ")})`);
    this.name = "UpdateNeedsReviewError";
  }
}

/**
 * The checkpoint-two callback an automatic update hands an installer: it
 * sees the staged fingerprint before anything activates and throws
 * {@link UpdateNeedsReviewError} on any difference from `baseline`.
 */
export function requireConsentEqual(packageName: string, baseline: ConsentFingerprint): (staged: ConsentFingerprint) => void {
  return (staged) => {
    const delta = stagedDelta(baseline, staged);
    if (delta.length > 0) throw new UpdateNeedsReviewError(packageName, delta);
  };
}

/** The authority fields of the fingerprint, by the authority key each reads. */
const AUTHORITY_FIELDS = ["capabilities", "networkAccess", "hostSecrets", "pluginAccess", "auth", "dependencies", "sandbox"] as const;

function json(value: unknown): ConsentJson {
  return value === undefined ? null : JSON.parse(canonicalStringify(value)) as ConsentJson;
}

function same(left: ConsentJson | undefined, right: ConsentJson | undefined): boolean {
  return canonicalStringify(left ?? null) === canonicalStringify(right ?? null);
}

function authorityFields(authority: PluginAuthority | null): Record<string, ConsentJson> {
  const fields: Record<string, ConsentJson> = {};
  for (const field of AUTHORITY_FIELDS) fields[`authority.${field}`] = json(authority?.[field]);
  fields["authority.requires.capabilities"] = json(authority?.requires?.capabilities);
  fields.minAppVersion = json(authority?.requires?.minAppVersion);
  fields.hostProtocol = json(authority?.requires?.hostProtocol);
  return fields;
}

/**
 * An extension's fingerprint from its `plugin.json` document and payload
 * files: the bytes that install (the staged tree) or that are installed (the
 * receipt-covered tree).
 */
export function pluginConsent(document: unknown, files: readonly PayloadFile[]): ConsentFingerprint {
  const manifest = flattenAgentPluginsManifest(document);
  const fields = authorityFields(manifestAuthority(document));
  const unknown: string[] = [];
  const process = manifest.process !== undefined;
  fields.entryForm = process ? "process" : "entry";
  fields.contributionKinds = [...new Set(resolvePluginContributionDeclarations(manifest).map((item) => item.kind))].sort();
  for (const component of extensionComponentDigests(document, files)) {
    const field = `${component.kind === "hook" ? "hook" : "mcpServer"}:${component.localId}`;
    fields[field] = component.approvalDigest;
    if (component.approvalDigest === null) unknown.push(field);
  }
  // A `process` entry runs the package's own code with nothing in between: any file change is a change to what runs.
  if (process) fields.processTree = payloadTreeSha256(files);
  return { kind: "plugin", fields, unknown: unknown.sort() };
}

/** The component kinds an agent plugin has, sorted. */
function componentKinds(components: AgentPluginComponents): string[] {
  const kinds: string[] = [];
  if (components.skills.length > 0) kinds.push("skills");
  if (Object.keys(components.mcpServers).length > 0) kinds.push("mcpServers");
  if (components.prompts.length > 0) kinds.push("prompts");
  if (components.agents.length > 0) kinds.push("agents");
  if (components.routineTemplates.length > 0) kinds.push("routineTemplates");
  if (components.hooks.length > 0) kinds.push("hooks");
  return kinds;
}

/** An agent plugin's fingerprint from its descriptor fields, verified components and files. */
export function agentPluginConsent(input: {
  minAppVersion: string | null;
  hostProtocol: string | null;
  components: AgentPluginComponents;
  files: readonly PayloadFile[];
}): ConsentFingerprint {
  const unknown: string[] = [];
  const fields: Record<string, ConsentJson> = {
    minAppVersion: input.minAppVersion,
    hostProtocol: input.hostProtocol,
    componentKinds: componentKinds(input.components),
    mcpAuth: json(input.components.mcpAuth),
  };
  if (input.minAppVersion === null) unknown.push("minAppVersion");
  const digests = agentPluginComponentDigests(input.components, input.files);
  for (const [name, digest] of Object.entries(digests.mcpServers)) {
    fields[`mcpServer:${name}`] = digest;
    if (digest === null) unknown.push(`mcpServer:${name}`);
  }
  for (const [index, digest] of digests.hooks.entries()) {
    fields[`hook:${index}`] = digest;
    if (digest === null) unknown.push(`hook:${index}`);
  }
  return { kind: "agent-plugin", fields, unknown: unknown.sort() };
}

/** An MCP server package's fingerprint: its resolved runtime spec, whose package version is in its command. */
export function mcpConsent(runtime: McpRuntimeSpec): ConsentFingerprint {
  return { kind: "mcp", fields: { mcpRuntime: json(runtime) }, unknown: [] };
}

/**
 * A data content package's fingerprint. `minAppVersion` comes from the
 * descriptor the package was installed from (null: not known, so unknown).
 * A provider's `provider.json` and a messaging connection's
 * `connection.json` are read from its files.
 */
export function contentConsent(kind: Exclude<PackageKind, "plugin" | "agent-plugin" | "mcp">, minAppVersion: string | null, files: readonly PayloadFile[]): ConsentFingerprint {
  const fields: Record<string, ConsentJson> = { minAppVersion };
  const unknown: string[] = minAppVersion === null ? ["minAppVersion"] : [];
  const read = (path: string): Record<string, unknown> | null => {
    const file = files.find((item) => item.path === path);
    if (!file) return null;
    try {
      const value = JSON.parse(file.data.toString("utf8")) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  if (kind === "provider") {
    const provider = read("provider.json");
    fields.providerId = json(provider?.providerId);
    fields.baseUrl = json(provider?.baseUrl);
    if (!provider) unknown.push("providerId", "baseUrl");
  } else if (kind === "messaging-connection") {
    const connection = read("connection.json");
    fields.connection = json(connection);
    if (!connection) unknown.push("connection");
  }
  return { kind, fields, unknown: unknown.sort() };
}

/**
 * A fingerprint where every field is unknown: a baseline that cannot be
 * computed at all (the installed files are gone). The update needs review.
 */
export function unknownConsent(kind: PackageKind): ConsentFingerprint {
  return { kind, fields: {}, unknown: ["*"] };
}

/** Whether `field` is unknown in `print` (a `*` makes every field unknown). */
function isUnknown(print: ConsentFingerprint, field: string): boolean {
  return print.unknown.includes("*") || print.unknown.includes(field);
}

/**
 * The fields the index row of a version carries (§2.2), as the update's
 * values, and the component names a catalog-visible inventory lists. Every
 * other field is pending at checkpoint one.
 */
function catalogFields(kind: PackageKind, version: IndexVersion): { fields: Record<string, ConsentJson>; components: Set<string> | null } {
  if (kind === "plugin") {
    // The index copies plugin.json's authority, and minAppVersion and hostProtocol with it.
    return { fields: version.authority ? authorityFields(version.authority) : { minAppVersion: version.minAppVersion }, components: null };
  }
  const fields: Record<string, ConsentJson> = { minAppVersion: version.minAppVersion };
  if (kind === "agent-plugin") {
    fields.hostProtocol = version.hostProtocol ?? null;
    if (!version.components) return { fields, components: null };
    fields.componentKinds = componentKinds(version.components);
    fields.mcpAuth = json(version.components.mcpAuth);
    const components = new Set([
      ...Object.keys(version.components.mcpServers).map((name) => `mcpServer:${name}`),
      ...version.components.hooks.map((_, index) => `hook:${index}`),
    ]);
    return { fields, components };
  }
  return { fields, components: null };
}

/**
 * Checkpoint one (§18.7.3): the differences the catalog shows between the
 * baseline and `version`, without a download. An unknown baseline field is
 * a difference. An empty result means "no difference seen yet": the staged
 * bytes decide (checkpoint two).
 */
export function catalogDelta(baseline: ConsentFingerprint, version: IndexVersion): ConsentDelta {
  const delta: ConsentDelta = [];
  if (baseline.unknown.includes("*")) {
    return [{ field: "*", checkpoint: "catalog", before: "unknown", after: null }];
  }
  // An MCP server declares no authority: its command is its authority, and its version is in the command.
  if (baseline.kind === "mcp") {
    return [{ field: "mcpRuntime", checkpoint: "catalog", before: isUnknown(baseline, "mcpRuntime") ? "unknown" : baseline.fields.mcpRuntime ?? null, after: { version: version.version } }];
  }
  const { fields, components } = catalogFields(baseline.kind, version);
  for (const [field, after] of Object.entries(fields)) {
    if (isUnknown(baseline, field)) delta.push({ field, checkpoint: "catalog", before: "unknown", after });
    else if (!same(baseline.fields[field], after)) delta.push({ field, checkpoint: "catalog", before: baseline.fields[field] ?? null, after });
  }
  if (components) {
    const before = new Set(Object.keys(baseline.fields).filter((field) => field.startsWith("mcpServer:") || field.startsWith("hook:")));
    // A component the catalog adds or removes is visible without its bytes.
    for (const field of components) if (!before.has(field)) delta.push({ field, checkpoint: "catalog", before: null, after: "added" });
    for (const field of before) if (!components.has(field)) delta.push({ field, checkpoint: "catalog", before: baseline.fields[field] ?? null, after: null });
  }
  // A field the catalog does not carry but the baseline cannot vouch for is a difference already.
  for (const field of baseline.unknown) {
    if (!(field in fields) && !delta.some((entry) => entry.field === field)) delta.push({ field, checkpoint: "catalog", before: "unknown", after: null });
  }
  return delta;
}

/**
 * Checkpoint two (§18.7.3): every difference between the baseline and the
 * fingerprint computed from the staged bytes. Fields the catalog already
 * showed keep `checkpoint: "catalog"`.
 */
export function stagedDelta(baseline: ConsentFingerprint, staged: ConsentFingerprint, catalog: ConsentDelta = []): ConsentDelta {
  if (baseline.kind !== staged.kind) throw new Error(`consent of a ${baseline.kind} compared with a ${staged.kind}`);
  const seenAtCatalog = new Set(catalog.map((entry) => entry.field));
  const delta: ConsentDelta = [];
  const fields = new Set([...Object.keys(baseline.fields), ...Object.keys(staged.fields), ...staged.unknown.filter((field) => field !== "*")]);
  for (const field of [...fields].sort()) {
    const after = staged.fields[field] ?? null;
    const checkpoint = seenAtCatalog.has(field) ? "catalog" : "staged";
    if (isUnknown(baseline, field)) delta.push({ field, checkpoint, before: "unknown", after });
    else if (isUnknown(staged, field) || !same(baseline.fields[field], after)) delta.push({ field, checkpoint, before: baseline.fields[field] ?? null, after });
  }
  return delta;
}

/** The approval digests a fingerprint records, by component field (`mcpServer:<id>`, `hook:<id>`). */
export function componentDigests(print: ConsentFingerprint): Map<string, string | null> {
  const digests = new Map<string, string | null>();
  for (const [field, value] of Object.entries(print.fields)) {
    if (!field.startsWith("mcpServer:") && !field.startsWith("hook:")) continue;
    digests.set(field, typeof value === "string" ? value : null);
  }
  return digests;
}

function isComponentField(field: string): boolean {
  return field.startsWith("mcpServer:") || field.startsWith("hook:");
}

/**
 * Attach to every changed approval digest the package paths whose bytes
 * differ between the installed and the staged payload (§18.7.3 "Cheap
 * review"). The same list serves every component: each one's digest covers
 * the whole tree.
 */
export function withChangedFiles(delta: ConsentDelta, installed: readonly PayloadFile[], staged: readonly PayloadFile[]): ConsentDelta {
  if (!delta.some((entry) => isComponentField(entry.field))) return delta;
  const changedFiles = changedPayloadFiles(installed, staged);
  return delta.map((entry) => isComponentField(entry.field) && entry.before !== "unknown" && entry.before !== null && entry.after !== null
    ? { ...entry, changedFiles }
    : entry);
}

/**
 * Whether the review can be the one-row form "Only these non-code files
 * changed" with *Approve update*: the only differences are approval digests
 * of components present before and after, and no changed file is code. It
 * shortens the review; it never decides eligibility.
 */
export function isCodeFreeChange(delta: ConsentDelta): boolean {
  return delta.length > 0 && delta.every((entry) => isComponentField(entry.field) && entry.changedFiles !== undefined && entry.changedFiles.code.length === 0);
}
