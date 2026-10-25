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

export interface InstalledRecord extends InstalledPackage {
  originCommit: string | null;
  /** Installed byte digest; null for MCP or missing receipts.
     * A folder digest change at the same version is a refresh. */
  digest?: string | null;
}

/** Component approval is bound to its digest; legacy approvals without a digest cannot carry. */
export interface ComponentApprovalState {
  field: string;
  approvalDigest: string | null;
  approved: boolean;
  recordDigest: string | null;
}

/** Automatic and required installs carry checkpoint-two consent and the reviewed app version. */
interface InstallConsentOptions {
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
      componentConsents?: readonly ExtensionComponentConsent[];
    },
  ): Promise<{ action: InstallAction; staged: StagedPluginArtifact }>;
  /** Consent baseline and receipt-covered files; null when not installed. */
  baseline(name: string): Promise<{ consent: ConsentFingerprint; reviewedAppVersion: string | null; enabled: boolean; files: PayloadFile[] | null } | null>;
  stagedFiles(staged: StagedPluginArtifact): PayloadFile[];
  componentApprovals(name: string): ComponentApprovalState[];
  running(name: string): boolean;
  retire(name: string, retain: PluginConfigRetention): Promise<void>;
  uninstall(name: string, retain?: PluginConfigRetention): Promise<void>;
}

export interface ContentInstallerPort {
  list(): Promise<InstalledRecord[]>;
  installedComponents(name: string): Promise<AgentPluginComponents>;
  /** Adoption records activation already present in settings during migration. */
  install(staged: StagedContent, options: InstallConsentOptions & { switchSource: boolean; adopt: boolean; componentConsents?: readonly ComponentConsent[] }): Promise<{ action: InstallAction }>;
  /** Reconstructs missing consent from the originating catalog; null when not installed. */
  baseline(kind: PackageKind, name: string, descriptor: (origin: { sourceId: string | null; commit: string | null; packagePath: string; version: string }) => Promise<{ minAppVersion: string | null; hostProtocol: string | null } | null>): Promise<ConsentFingerprint | null>;
  /** The installed package's files; null when they no longer verify. */
  installedFiles(kind: PackageKind, name: string): Promise<PayloadFile[] | null>;
  /** Null for legacy installs without their own directory. */
  installId(kind: PackageKind, name: string): Promise<string | null>;
  componentApprovals(name: string): Promise<ComponentApprovalState[]>;
  callsInFlight(name: string): Promise<boolean>;
  approveComponents(name: string, installId: string, consents: readonly ReviewedComponentConsent[]): Promise<void>;
  uninstall(kind: PackageKind, name: string, options?: { removeData: boolean }): Promise<void>;
}

export interface McpInstallerPort {
  list(): Promise<InstalledRecord[]>;
  /** Null when this installer does not own the server. */
  baseline(name: string): Promise<ConsentFingerprint | null>;
  /** PACKAGE_POLICY_BLOCKED when the MCP governance policy would refuse the server: checked when a plan is made and again at install. */
  admit(name: string, runtime: McpRuntimeSpec): void;
  /** `connectionWarning`: the server was added but its first connection failed. */
  install(resolved: ResolvedMcpServer, options: { switchSource: boolean }): Promise<{ action: InstallAction; connectionWarning: string | null }>;
  /** Pasted server specs are bound to no source. */
  installUnbound(name: string, runtime: McpRuntimeSpec): Promise<{ connectionWarning: string | null }>;
  /** Remove data only on request; otherwise return the kept directory. */
  uninstall(name: string, options: { removeData: boolean }): Promise<{ keptDataDir: string | null }>;
}

export interface InstallerPorts {
  plugin: PluginInstallerPort;
  content: ContentInstallerPort;
  mcp: McpInstallerPort;
}

export interface TokenStore {
  get(host: string): string | null;
  has(host: string): boolean;
  set(host: string, token: string): Promise<void>;
  delete(host: string): Promise<void>;
}
