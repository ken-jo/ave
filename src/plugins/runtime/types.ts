/**
 * Internal types for the plugin runtime domain modules.
 * These are implementation details — consumers should use the public
 * exports from runtime.ts (PluginRuntime, PluginCard, etc.).
 */

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

/**
 * Which arm a plugin's factory came from (`docs/design/plugin-hostapi-protocol.md`
 * §9.8 A1, decisions 50-51). The routing function returns `"child"` for every
 * manifest; `"in-process"` names the retained, deprecated in-process factory
 * (`importInProcessPluginFactory`), which has no production caller, so the
 * Doctor text and `allPluginsAreOutOfProcess` stay honest about what the tree
 * still contains. Loader removal narrows this union to `"child"`.
 */
export type PluginLoadArm = "child" | "in-process";

/**
 * What the Doctor reports a plugin runs under: the wrap its child was
 * actually spawned under ({@link SpawnConfinement}), or `"not-spawned"` for a
 * construction that failed before any child existed.
 */
export type PluginConfinementReport = SpawnConfinement | "not-spawned";

/**
 * A refused update or restart of a RUNNING plugin, as the card carries it
 * (decision 52). The incumbent keeps serving, so this is the attempt's record,
 * never the plugin's load state.
 */
export interface PluginAttemptRefusal {
  attempt: "update" | "restart";
  kind: PluginInstallFailureKind;
  message: string;
  /** ISO-8601 time of the refusal. */
  at: string;
}

/**
 * A fully-loaded plugin: manifest + running instance + registered handlers.
 * #885 v6 — `manifest` is the materialized `PluginManifest` (`parsePluginJson`
 * output); every runtime consumer reads its `tools: Tool[]` via the
 * tool-visibility primitive.
 */
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
  /** The arm the routing function returned for this generation. */
  arm: PluginLoadArm;
  /** The wrap this generation's child was spawned under. */
  confinement: PluginConfinementReport;
};

/**
 * Plan entry computed by resolveManifestLoadPlan. Represents one plugin that
 * should be loaded (or skipped when enabled=false).
 */
export type ManifestLoadPlan = {
  pluginIdHint?: string;
  manifestPath: string;
  enabled: boolean;
  approvedPluginAccess?: PluginAccessSpec;
  installSource?: PluginRegistryEntryInstallSource;
  manifestSha256?: string;
  /** The marketplace install this entry came from; a host-secret grant reads it (design §10.3). */
  origin?: PluginRegistryEntryOrigin;
};

/**
 * Per-plugin manifest snapshot including resolved access grants.
 */
export type ManifestSnapshot = {
  manifest: PluginManifest;
  approvedPluginAccess?: PluginAccessSpec;
};

/**
 * Outcome of a single-plugin instantiation + start attempt. Internal to the
 * runtime domain — not part of the public runtime export surface.
 */
export type SinglePluginStartResult = "started" | "deferred" | "failed" | "cancelled";

export type PluginStartPreparationOutcome =
  | { configOverride?: Record<string, unknown> }
  | void
  | null
  | undefined;

export type PluginStartPreparationReturn =
  | PluginStartPreparationOutcome
  | Promise<PluginStartPreparationOutcome>;
