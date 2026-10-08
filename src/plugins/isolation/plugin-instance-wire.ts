/**
 * The FORWARD direction of the boundary: what the host calls on a plugin
 * instance (`docs/blueprints/plugin-process-isolation.md` §2.1).
 *
 * `host-api-wire.ts` is the reverse channel — the members a plugin calls on
 * the host. This is the other half: what the HOST calls on the plugin. They are
 * separate contracts with separate failure modes, which is why they are
 * separate modules and not one file called "the wire".
 *
 * Five travel as methods declared here. The rest travel as MCP, because the
 * child already serves a `PluginMcpServer` and a second verb for an entry point
 * that already has a protocol would be two ways to reach it that could
 * disagree: `instance.handlers[tool](payload)` is `tools/call`, and
 * `instance.readUiResource(uri)` is `resources/read`, which is how a plugin in
 * any language serves its card with a stock MCP server library.
 *
 * ELECTRON-FREE BY CONSTRUCTION, for the same reason `host-api-wire.ts` is: the
 * child imports this, and the child is a plain Node process.
 */
import type { PluginManifest } from "../types.js";
import type { PluginChildContext } from "./plugin-child-runtime.js";
import type { HostProtocolVersion } from "./host-api-wire.js";

/**
 * The JSON-RPC methods the child answers besides MCP's own.
 *
 * Namespaced under `ave/` so a method can never collide with an MCP method
 * name: the child routes on this prefix, and everything without it goes to the
 * `PluginMcpServer` untouched.
 */
export const PLUGIN_INSTANCE_METHODS = {
  /** Build the hostApi stub, load the factory, create the instance. Once. */
  construct: "ave/instance/construct",
  start: "ave/instance/start",
  onPublished: "ave/instance/onPublished",
  stop: "ave/instance/stop",
  /**
   * Run one handler the plugin registered with `hostApi.onShutdown`, and
   * answer when it has settled. A request rather than a notification because
   * the host AWAITS a shutdown handler, as it does in-process — and it bounds
   * the wait, which in-process it cannot enforce.
   */
  shutdown: "ave/instance/shutdown",
} as const;

/** One of the five. */
export type PluginInstanceMethod =
  (typeof PLUGIN_INSTANCE_METHODS)[keyof typeof PLUGIN_INSTANCE_METHODS];

/** Whether `method` is served by the child's instance handler rather than MCP. */
export function isPluginInstanceMethod(method: string): method is PluginInstanceMethod {
  return method.startsWith("ave/instance/");
}

/**
 * What `construct` carries.
 *
 * The manifest crosses whole rather than being re-derived in the child from
 * `plugin.json` on disk. Re-reading it there would put a SECOND parse of the
 * security-relevant document behind the boundary, where the host's integrity
 * verification does not reach — the child would then be serving a manifest the
 * host never checked.
 */
export interface PluginConstructParams {
  /**
   * The host protocol version this connection speaks (§3.2). One version for
   * both directions: the lifecycle methods and the reverse channel release
   * together, so they are versioned together. The child refuses a version its
   * runtime does not serve, which is what makes a stale bundle fail loudly
   * instead of answering a version it does not speak.
   */
  readonly hostProtocol: {
    readonly version: HostProtocolVersion;
    /**
     * Every `ave/host/*` method this host serves on this connection (§3.2),
     * derived from the dispatcher's BOUND table, so a member this host build
     * lacks is not advertised. Method names, not feature flags, so the list
     * cannot drift from what is actually served.
     */
    readonly capabilities: readonly string[];
  };
  readonly manifest: PluginManifest;
  readonly context: PluginChildContext;
  /**
   * For an `entry` plugin, the absolute path of the JS module the reference
   * runtime imports. For a `process` plugin, the absolute, resolved path of its
   * own executable — the process receiving this frame — which it may ignore.
   */
  readonly entryPath: string;
  /**
   * The declared tool names whose handlers the instance MUST expose.
   *
   * Reported back by {@link PluginConstructResult} so the host learns which of
   * them the plugin actually implemented, exactly as `buildMethodMap` learns it
   * in-process. Sending the expectation rather than asking for the whole
   * handler map keeps the answer a set of declared names — a child cannot
   * announce a tool its manifest never declared.
   */
  readonly declaredToolNames: readonly string[];
}

/** What `construct` answers. */
export interface PluginConstructResult {
  /** The subset of `declaredToolNames` the instance exposes a handler for. */
  readonly implementedToolNames: readonly string[];
  /** Whether the instance serves its declared `ui://` cards over `resources/read`. */
  readonly servesUiResources: boolean;
  /** Which of `start` / `onPublished` / `stop` the instance implements. */
  readonly lifecycleHooks: readonly PluginLifecycleHookName[];
  /**
   * The `ave/host/*` methods the plugin will not run without (§3.2). The host
   * refuses the load with `incompatible-host-protocol` when one is missing
   * from the `capabilities` it sent, rather than letting the plugin start and
   * fail on its first call.
   */
  readonly pluginProtocol: { readonly requires: readonly string[] };
}

/** The optional lifecycle hooks a `RuntimePlugin` may implement. */
export type PluginLifecycleHookName = "start" | "onPublished" | "stop";

/** What `shutdown` carries: which `onShutdown` registration to run. */
export interface PluginShutdownParams {
  readonly subscriptionId: string;
}
