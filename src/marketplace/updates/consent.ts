/** Every consent change, including narrowing, requires review; unknown fields never compare equal.
 * Catalog checks leave unseen fields pending; staged-byte checks run before activation. */
import { canonicalStringify } from "../../shared/canonical-json.js";
import { agentPluginComponentDigests, changedPayloadFiles, extensionComponentDigests, payloadTreeSha256, type PayloadFile } from "../../plugins/contribution-approval-digest.js";
import { resolvePluginContributionDeclarations } from "../../plugins/plugin-contributions.js";
import { flattenAgentPluginsManifest } from "../../plugins/public-contract.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import { type AgentPluginComponents, type IndexVersion, type PackageKind, type PluginAuthority } from "../catalog/types.js";
import { manifestAuthority } from "../resolve/manifest-rules.js";
import type { ConsentDelta, ConsentJson } from "../../shared/git-marketplace.js";
import { parseConsentFingerprint, type ConsentFingerprint } from "./consent-record.js";

export type { ConsentDelta };

export { parseConsentFingerprint, type ConsentFingerprint };

/** A staged consent difference defers to review before activation and never counts as failure. */
export class UpdateNeedsReviewError extends Error {
  constructor(readonly packageName: string, readonly delta: ConsentDelta) {
    super(`${packageName}: the update differs from what was accepted (${delta.map((entry) => entry.field).join(", ")})`);
    this.name = "UpdateNeedsReviewError";
  }
}

/** Compare staged bytes to the accepted baseline before any activation. */
export function requireConsentEqual(packageName: string, baseline: ConsentFingerprint): (staged: ConsentFingerprint) => void {
  return (staged) => {
    const delta = stagedDelta(baseline, staged);
    if (delta.length > 0) throw new UpdateNeedsReviewError(packageName, delta);
  };
}

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
  // Process entries run package code directly, so every file change changes executable authority.
  if (process) fields.processTree = payloadTreeSha256(files);
  return { kind: "plugin", fields, unknown: unknown.sort() };
}

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

export function mcpConsent(runtime: McpRuntimeSpec): ConsentFingerprint {
  return { kind: "mcp", fields: { mcpRuntime: json(runtime) }, unknown: [] };
}

/** Missing retained descriptor fields make the content baseline unknown. */
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

/** Unverifiable installed bytes produce an entirely unknown baseline requiring review. */
export function unknownConsent(kind: PackageKind): ConsentFingerprint {
  return { kind, fields: {}, unknown: ["*"] };
}

function isUnknown(print: ConsentFingerprint, field: string): boolean {
  return print.unknown.includes("*") || print.unknown.includes(field);
}

/** Catalog-visible values can establish differences; all other fields remain pending. */
function catalogFields(kind: PackageKind, version: IndexVersion): { fields: Record<string, ConsentJson>; components: Set<string> | null } {
  if (kind === "plugin") {
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

/** No catalog difference means none seen yet; staged bytes still decide before activation. */
export function catalogDelta(baseline: ConsentFingerprint, version: IndexVersion): ConsentDelta {
  const delta: ConsentDelta = [];
  if (baseline.unknown.includes("*")) {
    return [{ field: "*", checkpoint: "catalog", before: "unknown", after: null }];
  }
  // An MCP command contains its version and is itself the consent authority.
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
    for (const field of components) if (!before.has(field)) delta.push({ field, checkpoint: "catalog", before: null, after: "added" });
    for (const field of before) if (!components.has(field)) delta.push({ field, checkpoint: "catalog", before: baseline.fields[field] ?? null, after: null });
  }
  // Unknown baseline fields differ even when the catalog cannot expose them.
  for (const field of baseline.unknown) {
    if (!(field in fields) && !delta.some((entry) => entry.field === field)) delta.push({ field, checkpoint: "catalog", before: "unknown", after: null });
  }
  return delta;
}

/** Compare complete staged fingerprints while preserving catalog checkpoint attribution. */
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

function isComponentField(field: string): boolean {
  return field.startsWith("mcpServer:") || field.startsWith("hook:");
}

/** Approval digests cover the whole tree, so each changed digest shares the changed-file list. */
export function withChangedFiles(delta: ConsentDelta, installed: readonly PayloadFile[], staged: readonly PayloadFile[], declaring: ReadonlySet<string>): ConsentDelta {
  if (!delta.some((entry) => isComponentField(entry.field))) return delta;
  const changedFiles = changedPayloadFiles(installed, staged, declaring);
  return delta.map((entry) => isComponentField(entry.field) && entry.before !== "unknown" && entry.before !== null && entry.after !== null
    ? { ...entry, changedFiles }
    : entry);
}

/** Data-only component changes can shorten review but never decide eligibility. */
export function isCodeFreeChange(delta: ConsentDelta): boolean {
  return delta.length > 0 && delta.every((entry) => isComponentField(entry.field) && entry.changedFiles !== undefined && entry.changedFiles.code.length === 0);
}
