/**
 * Marketplace file formats (design §4, §5, §10.4).
 *
 * These are the shapes after validation (validate.ts). The JSON Schemas in
 * `schemas/marketplace/` describe the same files for authors and CI; the
 * plugin authority fields are the manifest's own subschemas, referenced
 * rather than restated, so one definition covers `plugin.json` and the
 * descriptor that copies it.
 */
import type { RetirementSuccessors } from "../../shared/alerts-types.js";
import type { PluginSandboxDeclaration } from "../../plugins/public-contract.js";
import type { BundledMcpAuth, StaticBundledMcpServer } from "../../mcp/portable-mcp.js";

export const PACKAGE_KINDS = [
  "plugin",
  "agent-plugin",
  "mcp",
  "skill",
  "agent",
  "theme",
  "font",
  "language",
  "provider",
  "messaging-connection",
] as const;

export type PackageKind = (typeof PACKAGE_KINDS)[number];

const PACKAGE_NAME_RE = /^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$/u;

/** A package name as the descriptor schema defines it (`definitions.packageName`). */
export function isPackageName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 64 && PACKAGE_NAME_RE.test(value);
}

type Platform = "darwin" | "win32" | "linux";

interface MarketplaceOwner {
  name: string;
  url?: string;
}

export interface MarketplaceIndex {
  schemaVersion: 2;
  name: string;
  displayName: string;
  description?: string;
  owner?: MarketplaceOwner;
  packages: IndexPackage[];
}

export interface IndexPackage {
  kind: PackageKind;
  name: string;
  path: string;
  displayName?: string;
  description?: string;
  keywords?: string[];
  icon?: string;
  latest?: string;
  /** Newest first; absent = read the descriptor at the pin. */
  versions?: IndexVersion[];
}

export interface IndexVersion {
  version: string;
  commit: string;
  minAppVersion: string;
  hostProtocol?: string;
  platforms?: Platform[];
  authority?: PluginAuthority;
  artifact?: PluginArtifactPins;
  components?: AgentPluginComponents;
  rollout?: { percent: number };
  yanked?: { reason: string; at: string };
  publishedAt: string;
}

export interface AgentPluginComponents {
  skills: Array<{ name: string; hasScripts: boolean; digest: string }>;
  mcpServers: Record<string, StaticBundledMcpServer & { digest: string }>;
  mcpAuth?: BundledMcpAuth;
  prompts: Array<{ name: string; kind: "template" | "persona"; digest: string }>;
  agents: Array<{ name: string; digest: string }>;
  routineTemplates: Array<{
    id: string; title: string; trigger: "schedule" | "shutdown"; schedule?: string;
    execution: "llm-session" | "notification-only"; suggestedScope?: string[]; digest: string;
  }>;
  hooks: Array<{ event: string; matcher?: string; command: string[]; timeoutMs: number; digest: string }>;
}

/**
 * The fields of `extensions["ai.agent-connector.ave"]` that decide what a plugin may do,
 * copied verbatim from its `plugin.json`. Shapes are the manifest's own.
 */
export interface PluginAuthority {
  capabilities: string[];
  networkAccess?: unknown;
  hostSecrets?: { read: string[] };
  pluginAccess?: unknown;
  auth?: unknown;
  requires?: { capabilities?: string[]; minAppVersion: string; hostProtocol?: string };
  dependencies?: unknown[];
  sandbox?: PluginSandboxDeclaration;
}

export interface PluginArtifactPins {
  release?: {
    repo?: string;
    tag?: string;
    asset?: string;
    url?: string;
    /** Without a pin the rung is skipped (ARTIFACT_NOT_PINNED, design §6.2). */
    sha256?: string;
  };
  archive?: { url: string; sha256?: string };
  tree?: string;
}

export interface PackageDescriptor {
  schemaVersion: 2;
  kind: PackageKind;
  name: string;
  version: string;
  minAppVersion: string;
  hostProtocol?: string;
  displayName?: string;
  description?: string;
  author?: { name: string; url?: string; email?: string };
  license?: string;
  homepage?: string;
  icon?: string;
  platforms?: Platform[];
  /** Kind-specific fields as they appear in the file (the `kind` tag is not repeated there). */
  payload: Record<string, unknown>;
}

export interface Revocation {
  kind: PackageKind;
  name: string;
  /** Semver range the revocation covers. */
  versions: string;
  reason: string;
  at: string;
  action: "disable" | "uninstall";
  /** Present only on an app-conditional retirement entry. */
  successors?: RetirementSuccessors;
}

export interface RevocationsFile {
  schemaVersion: 1;
  revocations: Revocation[];
}

export interface ConditionalRevocation extends Revocation {
  appVersions: string;
  successors: RetirementSuccessors;
}

export interface ConditionalRevocationsFile {
  schemaVersion: 1;
  revocations: ConditionalRevocation[];
}
