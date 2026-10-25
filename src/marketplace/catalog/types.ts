/** Validated catalog shapes share plugin authority schemas with manifests. */
import type { RetirementSuccessors } from "../../shared/alerts-types.js";
import type { PluginSandboxDeclaration } from "../../plugins/public-contract.js";
import type { BundledMcpAuth, StaticBundledMcpServer } from "../../mcp/portable-mcp.js";
import type { RoutineSchedule } from "../../shared/routines-types.js";

export const MARKETPLACE_INDEX_FILE = "marketplace.json";

export const MARKETPLACE_DESCRIPTOR_FILE = "ave-package.json";

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

export function isPackageName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 64 && PACKAGE_NAME_RE.test(value);
}

export type Platform = "darwin" | "win32" | "linux";

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

/** Zero object ids retain legacy grant evidence only; they are not trees and must never reach git. */
export const NULL_OBJECT_ID = "0".repeat(40);

export function hasVersionTree(version: Pick<IndexVersion, "commit">): boolean {
  return version.commit !== NULL_OBJECT_ID;
}

export interface AgentPluginComponents {
  skills: Array<{ name: string; hasScripts: boolean; digest: string }>;
  mcpServers: Record<string, StaticBundledMcpServer & { digest: string }>;
  mcpAuth?: BundledMcpAuth;
  prompts: Array<{ name: string; kind: "template" | "persona"; digest: string }>;
  agents: Array<{ name: string; digest: string }>;
  routineTemplates: Array<{
    id: string; title: string; trigger: "schedule" | "shutdown"; schedule?: RoutineSchedule;
    execution: "llm-session" | "notification-only"; suggestedScope?: string[]; digest: string;
  }>;
  hooks: Array<{ event: string; matcher?: string; command: string[]; env?: Record<string, string>; timeoutMs: number; digest: string }>;
}

/** Plugin authority fields are copied verbatim from the manifest schema. */
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
    /** Skip artifact rungs without a pin. */
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
  payload: Record<string, unknown>;
}

export interface Revocation {
  kind: PackageKind;
  name: string;
  versions: string;
  reason: string;
  at: string;
  action: "disable" | "uninstall";
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
