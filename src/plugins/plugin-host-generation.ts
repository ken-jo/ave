import type {
  PluginAccessSpec,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
} from "./types.js";
import type { PreparedPluginHookProjection } from "../hooks/plugin-hook-projection.js";
import type { PreparedPluginMcpProjection } from "../mcp/plugin-mcp-projection.js";
import type { PluginGenerationLease } from "./plugin-generation-coordinator.js";
import type { HostApiGenerationScope } from "./plugin-host-effect-scope.js";
import type { PluginConfinementReport, PluginLoadArm } from "./runtime/types.js";

type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer TItem)[] ? readonly DeepReadonly<TItem>[]
      : T extends object ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
        : T;

export interface ActivePluginGenerationSnapshot {
  readonly pluginId: string;
  readonly generationId: string;
  readonly manifest: DeepReadonly<PluginManifest>;
}

export interface PluginRuntimeGenerationProjection {
  readonly activationId: string;
  /** Raw registry identity, or null for a statically configured plugin. */
  readonly installId: string | null;
  readonly manifest: PluginManifest;
  readonly pluginRoot: string;
  readonly instance: RuntimePlugin;
  readonly methods: ReadonlyMap<string, PluginToolHandler>;
  readonly approvedPluginAccess?: PluginAccessSpec;
  readonly disposers?: readonly (() => void)[];
  readonly hostEffects?: HostApiGenerationScope;
  readonly deactivateHostApi?: () => void;
  readonly drainHostApiOperations?: () => Promise<void>;
  readonly lifecycleHookScope?: {
    active: boolean;
    depth: number;
  };
  /** The arm the routing function returned; carried into the published `LoadedPlugin`. */
  readonly arm: PluginLoadArm;
  /** The wrap the generation's child was spawned under. */
  readonly confinement: PluginConfinementReport;
}

export interface PreparedPluginRuntimeRemovalPublication {
  readonly pluginId: string;
  publish(): void;
}

export interface PreparedPluginRuntimeGenerationPublication {
  readonly pluginId: string;
  /** Pointer commit transfers candidate resources before any fallible publication; handover is idempotent. */
  handOver(): void;
  publish(): void;
}

export type PluginRuntimeRetirementPhase =
  | "runtime.authority"
  | "runtime.stop"
  | "runtime.effects"
  | "runtime.drain";

export interface PluginRuntimeRetirementStep {
  readonly phase: PluginRuntimeRetirementPhase;
  run(): void | Promise<void>;
}

export interface CommittedPluginGeneration<T> {
  readonly result: T;
  /** Settles only after every predecessor lease drains and retirement finishes. */
  readonly retirement: Promise<void>;
  /** Host-owned post-commit work that keeps the per-plugin lifecycle queue occupied. */
  readonly completion: Promise<void>;
  /** True when the caller owns the predecessor admission and must return before retirement. */
  readonly retirementDeferred: boolean;
}

/** Immutable Host view shared by runtime, Skill, Hook, MCP and operation policy. */
export interface HostPluginGenerationState {
  readonly payloadRoot: string;
  readonly runtime: PluginRuntimeGenerationProjection;
  readonly hooks: readonly PreparedPluginHookProjection[];
  readonly mcpServers: readonly PreparedPluginMcpProjection[];
}

export interface PluginRuntimeGenerationAccess {
  getActive(pluginId: string): ActivePluginGenerationSnapshot | undefined;
  /** True only while the current async operation owns a live exact-generation lease. */
  isExactAdmitted(pluginId: string, generationId: string): boolean;
  acquire(pluginId: string): Promise<PluginGenerationLease<HostPluginGenerationState>>;
  acquireExact(pluginId: string, generationId: string): Promise<PluginGenerationLease<HostPluginGenerationState>>;
  runWithLease<T>(
    lease: PluginGenerationLease<HostPluginGenerationState>,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface PluginRuntimeGenerationLifecycle extends PluginRuntimeGenerationAccess {
  /** Serialize same-plugin transitions; nested lifecycle calls reuse their current slot. */
  runInLifecycleQueue<T>(pluginId: string, operation: () => Promise<T>): Promise<T>;
  replaceRuntime(runtime: PluginRuntimeGenerationProjection): Promise<void>;
  replaceRuntimeWithCommit<T>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRaw: string,
    durableCommit: () => Promise<T>,
  ): Promise<CommittedPluginGeneration<T>>;
  deactivate(pluginId: string): Promise<void>;
  deactivateWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
  ): Promise<CommittedPluginGeneration<T>>;
  recoverRetirements(): Promise<void>;
  waitForRetirements(): Promise<void>;
  /** Closing admission permanently rejects queued and future acquisitions and prevents publication. */
  closeAdmission(reason: (pluginId: string) => Error): void;
  /** Generations whose retirement has begun and not yet finished. */
  listRetiringGenerations(): readonly RetiringPluginRuntimeGeneration[];
}

export interface RetiringPluginRuntimeGeneration {
  readonly pluginId: string;
  readonly generationId: string;
  readonly runtime: PluginRuntimeGenerationProjection;
  /** Settles when the generation's leases drained and its retirement finished. */
  readonly retired: Promise<void>;
}
