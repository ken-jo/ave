import type { PluginAccessSpec } from "./public-contract.js";

export * from "./public-contract.js";

/**
 * Host-private persistence and marketplace DTOs. These are intentionally kept
 * outside `public-contract.ts` so they cannot enter the generated SDK surface.
 */

/**
 * `"admin"` is read only from registries written before the git marketplace:
 * the first-boot migration turns it into `"user"` (design §16.3), and it
 * grants nothing.
 */
export type PluginRegistryEntryInstallSource = "admin" | "user" | "local-dev";

/**
 * Where a git install came from (design §2.3). `commit` is the snapshot
 * commit the plan was bound to, so the source keeps that snapshot while the
 * install references it. Only a git install writes this; every other install
 * path removes it, because it would otherwise describe bytes it did not
 * install.
 */
export interface PluginRegistryEntryOrigin {
  sourceId: string;
  sourceOrigin: "official" | "managed" | "custom" | "direct";
  commit: string;
  packagePath: string;
  version: string;
  /** `legacy`: bound by the §16.3 migration, no digest yet. */
  rung: "release" | "archive" | "tree" | "legacy";
  /** Zip sha256 (release, archive), tree digest (tree), null for legacy. */
  artifactSha256: string | null;
  installedAt: string;
}

export interface PluginRegistryEntry {
  id: string;
  manifestPath: string;
  /**
   * Canonical JSON SHA-256 of plugin.json recorded at install time. Runtime
   * HostApi gates compare the running manifest against this host-owned value
   * before honoring admin secret-access bypasses.
   */
  manifestSha256?: string;
  enabled?: boolean;
  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;
  installSource?: PluginRegistryEntryInstallSource;
  origin?: PluginRegistryEntryOrigin;
  /** Durable replacement marker; runtime discovery skips marked rows. */
  pendingUpdate?: {
    kind: "marketplace" | "local-dev";
    previousManifestFileSha256: string | null;
    previousReceiptRaw: string | null;
    recoveryBackupDir?: string;
    recoveryBackupMode?: "rename" | "copy";
  };
  /** Durable ownership journal for obsolete, never-restorable directories. */
  pendingCleanup?: Array<{
    kind: "obsolete-artifact" | "obsolete-local-backup";
    path: string;
  }>;
}

/**
 * The host-owned registry fields a running plugin's HostApi trusts: the
 * install source, the manifest pin taken at install, and where the install
 * came from. The host-secret gate (`plugins/secret-access/`) reads them;
 * `plugin.json` sits inside the plugin's writable surface and is never
 * trusted for any of them.
 */
export type PluginRegistryTrust = Pick<PluginRegistryEntry, "installSource" | "manifestSha256" | "origin">;

export interface PluginRegistry {
  version: number;
  plugins: PluginRegistryEntry[];
}

/**
 * A signed registry document after envelope verification, together with where
 * it was read from. The whitelist, admission and revocation registries all
 * cache exactly this pair.
 */
export interface ResolvedSignedSnapshot<Doc, Source extends string> {
  doc: Doc;
  source: Source;
}
