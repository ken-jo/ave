/**
 * What the marketplace service needs from each kind's installer. The host
 * composition implements these over the plugin lifecycle, the content store
 * and the MCP manager; the service only plans, stages and dispatches.
 */
import type { PluginConfigRetention } from "../../plugins/retired-config.js";
import type { ComponentConsent, ExtensionComponentConsent, ReviewedComponentConsent } from "../../shared/git-marketplace.js";
import type { PayloadFile } from "../../plugins/contribution-approval-digest.js";
import type { ConsentFingerprint } from "../updates/consent-record.js";
import type { AgentPluginComponents, PackageKind, PluginAuthority } from "../catalog/types.js";
import type { StagedContent } from "../content/store.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import type { InstallAction, InstalledPackage } from "../resolve/identity.js";
import type { ResolvedMcpServer } from "../resolve/mcp.js";
import type { PluginInstallPlan, StagedPluginArtifact } from "../resolve/plugin-ladder.js";

/** An installed package with the snapshot commit its install was bound to (null without a source). */
export interface InstalledRecord extends InstalledPackage {
  originCommit: string | null;
  /**
   * The digest of the installed bytes: a plugin's `artifactSha256`, a
   * content package's `contentSha256`; null for an MCP server or when not
   * recorded. A folder package whose tree digest differs at the same
   * version has a refresh (§18.7.6).
   */
  digest?: string | null;
}

/**
 * One bundled MCP server or hook of an installed package's running
 * generation (§18.7.2): its consent field (`mcpServer:<id>`, `hook:<id>`),
 * its approval digest, whether it is approved, and the approval digest its
 * approval record holds (null: an approval from an earlier Ave version that
 * was never matched to its bytes, which cannot carry).
 */
export interface ComponentApprovalState {
  field: string;
  approvalDigest: string | null;
  approved: boolean;
  recordDigest: string | null;
}

/**
 * The install options an automatic, required or reviewed install adds
 * (§18.7.3): checkpoint two, and the reviewed app version its receipt keeps.
 */
export interface InstallConsentOptions {
  /** Sees the staged consent fingerprint before anything activates; a throw installs nothing. */
  assertConsent?: (consent: ConsentFingerprint) => void;
}

export interface PluginInstallerPort {
  list(): Promise<InstalledRecord[]>;
  /** The authority of the installed plugin.json, for the update review when the index no longer lists that version. */
  installedAuthority(name: string): Promise<PluginAuthority | null>;
  install(
    plan: PluginInstallPlan,
    options: InstallConsentOptions & {
      switchSource: boolean;
      stage: (plan: PluginInstallPlan) => Promise<StagedPluginArtifact>;
      signal?: AbortSignal;
      reviewedAppVersion?: string;
      /** Bundled components the user approved for the generation this installs (§18.7.3). */
      componentConsents?: readonly ExtensionComponentConsent[];
    },
  ): Promise<{ action: InstallAction; staged: StagedPluginArtifact }>;
  /**
   * The installed plugin's consent baseline (§18.7.3), the reviewed app
   * version its receipt keeps, whether it is enabled, and its
   * receipt-covered files. Null when it is not installed.
   */
  baseline(name: string): Promise<{ consent: ConsentFingerprint; reviewedAppVersion: string | null; enabled: boolean; files: PayloadFile[] | null } | null>;
  /** The files of a staged artifact, as they would install. */
  stagedFiles(staged: StagedPluginArtifact): PayloadFile[];
  /** Each bundled component of the running generation and its approval (§18.7.2). */
  componentApprovals(name: string): ComponentApprovalState[];
  /** Whether a generation of the plugin is running. */
  running(name: string): boolean;
  retire(name: string, retain: PluginConfigRetention): Promise<void>;
  uninstall(name: string, retain?: PluginConfigRetention): Promise<void>;
}

export interface ContentInstallerPort {
  list(): Promise<InstalledRecord[]>;
  /** Read the installed tree's verified component inventory for update review. */
  installedComponents(name: string): Promise<AgentPluginComponents>;
  /** `adopt`: record an activation the settings already hold (the first-boot migration, design §16.3). */
  install(staged: StagedContent, options: InstallConsentOptions & { switchSource: boolean; adopt: boolean; componentConsents?: readonly ComponentConsent[] }): Promise<{ action: InstallAction }>;
  /**
   * The installed package's consent baseline (§18.7.3); `descriptor` reads
   * the catalog the install came from for a baseline the install did not
   * store. Null when it is not installed.
   */
  baseline(kind: PackageKind, name: string, descriptor: (origin: { sourceId: string | null; commit: string | null; packagePath: string; version: string }) => Promise<{ minAppVersion: string | null; hostProtocol: string | null } | null>): Promise<ConsentFingerprint | null>;
  /** The installed package's files; null when they no longer verify. */
  installedFiles(kind: PackageKind, name: string): Promise<PayloadFile[] | null>;
  /** The install id of an installed package's own directory (§18.7.4); null for a legacy install. */
  installId(kind: PackageKind, name: string): Promise<string | null>;
  /** Each server and hook of an installed agent plugin's running generation and its approval (§18.7.2). */
  componentApprovals(name: string): Promise<ComponentApprovalState[]>;
  /** Whether a call of the agent plugin's running generation is in flight (§18.7.4). */
  callsInFlight(name: string): Promise<boolean>;
  /** Approve components of an `approval-pending` agent plugin, bound to the reviewed install (§18.7.5). */
  approveComponents(name: string, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<void>;
  uninstall(kind: PackageKind, name: string, options?: { removeData: boolean }): Promise<void>;
}

export interface McpInstallerPort {
  list(): Promise<InstalledRecord[]>;
  /** The installed server's consent baseline (§18.7.3); null when this installer does not own it. */
  baseline(name: string): Promise<ConsentFingerprint | null>;
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
