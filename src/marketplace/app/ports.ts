/**
 * What the marketplace service needs from each kind's installer. The host
 * composition implements these over the plugin lifecycle, the content store
 * and the MCP manager; the service only plans, stages and dispatches.
 */
import type { PluginConfigRetention } from "../../plugins/retired-config.js";
import type { PackageKind, PluginAuthority } from "../catalog/types.js";
import type { StagedContent } from "../content/store.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import type { InstallAction, InstalledPackage } from "../resolve/identity.js";
import type { ResolvedMcpServer } from "../resolve/mcp.js";
import type { PluginInstallPlan, StagedPluginArtifact } from "../resolve/plugin-ladder.js";

/** An installed package with the snapshot commit its install was bound to (null without a source). */
export interface InstalledRecord extends InstalledPackage {
  originCommit: string | null;
}

export interface PluginInstallerPort {
  list(): Promise<InstalledRecord[]>;
  /** The authority of the installed plugin.json, for the update review when the index no longer lists that version. */
  installedAuthority(name: string): Promise<PluginAuthority | null>;
  install(
    plan: PluginInstallPlan,
    options: { switchSource: boolean; stage: (plan: PluginInstallPlan) => Promise<StagedPluginArtifact>; signal?: AbortSignal },
  ): Promise<{ action: InstallAction; staged: StagedPluginArtifact }>;
  retire(name: string, retain: PluginConfigRetention): Promise<void>;
  uninstall(name: string, retain?: PluginConfigRetention): Promise<void>;
}

export interface ContentInstallerPort {
  list(): Promise<InstalledRecord[]>;
  /** `adopt`: record an activation the settings already hold (the first-boot migration, design §16.3). */
  install(staged: StagedContent, options: { switchSource: boolean; adopt: boolean }): Promise<{ action: InstallAction }>;
  uninstall(kind: PackageKind, name: string): Promise<void>;
}

export interface McpInstallerPort {
  list(): Promise<InstalledRecord[]>;
  /** PACKAGE_POLICY_BLOCKED when the MCP governance policy would refuse the server: checked when a plan is made and again at install. */
  admit(name: string, runtime: McpRuntimeSpec): void;
  /** `connectionWarning`: the server was added but its first connection failed. */
  install(resolved: ResolvedMcpServer, options: { switchSource: boolean }): Promise<{ action: InstallAction; connectionWarning: string | null }>;
  /** A server from a pasted server.json (design §8.1): an MCP entry bound to no source. */
  installUnbound(name: string, runtime: McpRuntimeSpec): Promise<{ connectionWarning: string | null }>;
  /** `removeData` also removes `$DATA_DIR` (design §5.2); the kept directory is returned otherwise. */
  uninstall(name: string, options: { removeData: boolean }): Promise<{ keptDataDir: string | null }>;
}

export interface InstallerPorts {
  plugin: PluginInstallerPort;
  content: ContentInstallerPort;
  mcp: McpInstallerPort;
}

/** Stored tokens, per normalized host (design §2.1: `marketplace.gitToken.<host>`). */
export interface TokenStore {
  get(host: string): string | null;
  has(host: string): boolean;
  set(host: string, token: string): Promise<void>;
  delete(host: string): Promise<void>;
}
