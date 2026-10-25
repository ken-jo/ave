import type { PluginAccessSpec } from "./public-contract.js";

export * from "./public-contract.js";

/** Keep host-private persisted and marketplace shapes outside the vendored public contract. */

/** Legacy admin source migrates to user and grants no authority. */
export type PluginRegistryEntryInstallSource = "admin" | "user" | "local-dev";

/** Origin binds installed bytes to a source snapshot or folder revision; local replacement removes stale provenance. */
export interface PluginRegistryEntryOrigin {
  sourceId: string;
  sourceOrigin: "official" | "managed" | "custom" | "direct";
  commit: string;
  packagePath: string;
  version: string;
  /** Legacy migration bindings may lack digests; folder sources have their own rung. */
  rung: "release" | "archive" | "tree" | "folder" | "legacy";
  artifactSha256: string | null;
  installedAt: string;
}

export interface PluginRegistryEntry {
  id: string;
  manifestPath: string;
  /** Pin the authored plugin document so running host-secret requests can be compared to install-time evidence. */
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

/** Trust provenance only from host-owned registry fields, never writable plugin.json. */
export type PluginRegistryTrust = Pick<PluginRegistryEntry, "installSource" | "manifestSha256" | "origin">;

export interface PluginRegistry {
  version: number;
  plugins: PluginRegistryEntry[];
}
