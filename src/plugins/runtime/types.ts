/** Internal runtime types; consumers use public exports from runtime.ts. */

import type {
  PluginAccessSpec,
  PluginManifest,
  PluginRegistryEntryInstallSource,
  PluginRegistryEntryOrigin,
  PluginToolHandler,
  RuntimePlugin,
} from "../types.js";
import type { HostApiGenerationScope } from "../plugin-host-effect-scope.js";
import type { SpawnConfinement } from "../../permissions/confined-child.js";
import type { PluginInstallFailureKind } from "../../shared/plugin-install-failure.js";

export type { PluginAccessSpec, PluginManifest, PluginToolHandler, RuntimePlugin };

export type PluginLifecycleHookScope = {
  active: boolean;
  depth: number;
};

/** Routing records the actual factory arm; in-process remains only while its deprecated factory exists. */
export type PluginLoadArm = "child" | "in-process";

/** Report actual spawn confinement, or not-spawned when construction failed first. */
export type PluginConfinementReport = SpawnConfinement | "not-spawned";

/** A refused replacement belongs to that attempt; the incumbent keeps serving and stays loaded. */
export interface PluginAttemptRefusal {
  attempt: "update" | "restart";
  kind: PluginInstallFailureKind;
  message: string;
  at: string;
}

/** Loaded manifests are materialized once; consumers use the shared visibility reader. */
export type LoadedPlugin = {
  activationId: string;
  manifest: PluginManifest;
  pluginRoot: string;
  instance: RuntimePlugin;
  methods: Map<string, PluginToolHandler>;
  approvedPluginAccess?: PluginAccessSpec;
  hostEffects?: HostApiGenerationScope;
  started?: boolean;
  deactivateHostApi?: () => void;
  drainHostApiOperations?: () => Promise<void>;
  lifecycleHookScope?: PluginLifecycleHookScope;
  arm: PluginLoadArm;
  confinement: PluginConfinementReport;
};

export type ManifestLoadPlan = {
  pluginIdHint?: string;
  manifestPath: string;
  enabled: boolean;
  approvedPluginAccess?: PluginAccessSpec;
  installSource?: PluginRegistryEntryInstallSource;
  manifestSha256?: string;
  /** Install provenance feeds host-secret admission. */
  origin?: PluginRegistryEntryOrigin;
};

export type ManifestSnapshot = {
  manifest: PluginManifest;
  approvedPluginAccess?: PluginAccessSpec;
};

/** Instantiation outcomes remain internal to runtime. */
export type SinglePluginStartResult = "started" | "deferred" | "failed" | "cancelled";

export type PluginStartPreparationOutcome =
  | { configOverride?: Record<string, unknown> }
  | void
  | null
  | undefined;

export type PluginStartPreparationReturn =
  | PluginStartPreparationOutcome
  | Promise<PluginStartPreparationOutcome>;
