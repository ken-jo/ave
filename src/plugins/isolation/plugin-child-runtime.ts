/** Build the child HostApi from pure data and injected channel operations; runtime tests must not require subprocesses. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable, Writable } from "node:stream";
import { StdioServerLoop } from "../../mcp/experimental/stdio-server-loop.js";
import {
  PluginMcpServer,
  type PluginToolDelegate,
} from "../../mcp/plugin-mcp-server.js";
import { createPluginUiResourceProvider } from "../../mcp/plugin-ui-resource-provider.js";
import { describeNonJson } from "../../shared/json-representable.js";
import { errorMessage } from "../../shared/error-message.js";
import { INVOCATION_META, RAW_RESULT_META } from "../../mcp/protocol-constants.js";
import { resolvePluginSocketDir } from "../plugin-storage-layout.js";
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  RuntimePlugin,
  RuntimePluginFactory,
} from "../types.js";
import {
  createConfigSubscriptionChildMembers,
  createInteractionChildMembers,
  createServiceChildMembers,
  createStorageChildMembers,
} from "./host-api-child.js";
import {
  FRAME_BYTES_MAX,
  HOSTAPI_PATH_CONTRACTS,
  HOST_PROTOCOL_NOTIFICATIONS,
  fromHostApiRpcError,
  hostApiMethodOf,
  hostApiParamsOf,
  reconstructWireError,
  type HostApiChannel,
  type HostApiNotification,
  type HostApiPath,
  type JsonRpcRequestId,
} from "./host-api-wire.js";
import {
  SubscriptionLedger,
  type SubscriptionRelease,
} from "./subscription-ledger.js";
import { OUTBOUND_QUEUE_BYTES_MAX } from "./child-stream-multiplex.js";

/**
 * MCP responses the child may hold unwritten while protocol stdout drains, one frame at a time, to the host.
 * The same size as the protocol's outbound bound: two maximal replies always fit, and a response past it is
 * refused as an error reply for that call rather than buffered without limit. Requests keep arriving
 * (cancellations included), so a slow host reader never stalls host-to-child traffic.
 */
const CHILD_MCP_UNWRITTEN_OUTPUT_BYTES_MAX = OUTBOUND_QUEUE_BYTES_MAX;

/** Carry runtime context as data; rebuild log and hostApi from the channel. */
export interface PluginChildContext {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly hostRoot: string;
  readonly pluginDataDir: string;
  /** Carry the real host home and storage root; deriving them inside confinement returns sandbox paths. */
  readonly userHome: string;
  readonly aveHome: string;
  readonly config?: Record<string, unknown>;
  /** Synchronous installed-plugin reads use a pushed snapshot seeded at construction. */
  readonly installedPluginIds: readonly string[];
  /** Split preference keys from values to preserve unset values; absent reader differs from an unset preference. */
  readonly appPreferences?: {
    readonly keys: readonly string[];
    readonly values: Record<string, unknown>;
  };
}

export type PluginFactoryLoader = (
  manifest: PluginManifest,
) => Promise<RuntimePluginFactory | undefined>;

interface ChildSubscription {
  readonly path: HostApiPath;
  readonly handler: (payload: unknown) => void;
  /** Revocation must release closure-held resources as well as ledger entries. */
  readonly onRevoked?: (reason: "revoked" | "peer-gone") => void;
}

/** Report dropped notifications rather than silently ignore unknown registrations. */
export type NotificationOutcome =
  | "delivered"
  | "closed"
  | "unknown-subscription";

export interface PluginChildRuntimeOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly manifest: PluginManifest;
  readonly context: PluginChildContext;
  readonly channel: HostApiChannel;
  readonly loadFactory: PluginFactoryLoader;
}

export interface PluginChildRuntime {
  readonly instance: RuntimePlugin;
  readonly hostApi: PluginHostApi;
  /** Advertise card reads only when both the hook and a manifest card exist. */
  readonly servesUiResources: boolean;
  readonly openSubscriptionCount: number;
  /** Allocate subscription IDs locally before sending registrations. */
  openSubscription(
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ): { readonly subscriptionId: string; readonly dispose: () => void };
  /** Adopt host IDs for handles; early notifications can race the reply. */
  adoptSubscription(
    path: HostApiPath,
    subscriptionId: string,
    handler: (payload: unknown) => void,
    /** Run closure cleanup on host revocation, never for local disposal or host loss. */
    onRevoked?: (reason: "revoked" | "peer-gone") => void,
  ): () => void;
  deliver(notification: HostApiNotification): NotificationOutcome;
  /** Await shutdown only for an open registration the child actually supplied. */
  runShutdownHandler(subscriptionId: string): Promise<void>;
  /** Host loss drops registrations without writing release messages to closed pipes. */
  hostGone(): number;
}

/** Settle calls with the host result or preserved error identity, including cancellation. */
// Carry an opaque invocation token through the tool async chain, including late timers.
// Only the host resolves it to gate, ledger and origin context.
const invocationScope = new AsyncLocalStorage<string>();

export type HostApiCaller = (
  path: HostApiPath,
  args: readonly unknown[],
  signal?: AbortSignal,
  onRequestId?: (id: JsonRpcRequestId) => void,
) => Promise<unknown>;

export function createHostApiCaller(
  channel: HostApiChannel,
  context: Pick<PluginChildContext, "pluginId">,
): HostApiCaller {
  return async (path, args, signal, onRequestId) => {
    const nonJson = describeNonJson(args, `${path}(args)`);
    if (nonJson) {
      // Refuse invalid payloads at the plugin call site to retain its stack.
      throw new Error(
        `[plugin-child:${context.pluginId}] ${path}: argument cannot cross the boundary — ${nonJson}`,
      );
    }
    // An already-aborted signal throws its own reason without dispatching a request.
    if (signal?.aborted) throw signal.reason;
    let requestId: JsonRpcRequestId | undefined;
    const onAbort = (): void => {
      if (requestId === undefined) return;
      channel.notify({
        jsonrpc: "2.0",
        method: HOST_PROTOCOL_NOTIFICATIONS.cancelled,
        params: { requestId, reason: errorMessage(signal?.reason) },
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const params = hostApiParamsOf(path, args);
      const invocation = invocationScope.getStore();
      if (invocation !== undefined) params._meta = { [INVOCATION_META]: invocation };
      const reply = await channel.call(
        hostApiMethodOf(path),
        params,
        (id) => {
          requestId = id;
          onRequestId?.(id);
        },
      );
      if ("error" in reply) throw reconstructWireError(fromHostApiRpcError(reply.error));
      // Map JSON-RPC null back to undefined for void contracts.
      return HOSTAPI_PATH_CONTRACTS[path].result === "void" ? undefined : reply.result;
    } finally {
      // Remove abort listeners on settlement so later aborts cannot name stale requests.
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Every declared member must exist and throw explicitly until its implementation is wired. */
export function createChildHostApiStub(
  pluginId: string,
  member: (path: HostApiPath) => (...args: unknown[]) => unknown,
): PluginHostApi {
  const root: Record<string, unknown> = {};
  for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]) {
    const segments = path.split(".");
    const leaf = segments.pop() as string;
    let cursor = root;
    for (const segment of segments) {
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[leaf] = member(path);
  }
  assertStubIsTotal(pluginId, root);
  return root as unknown as PluginHostApi;
}

export function unimplementedChildMember(
  pluginId: string,
  path: HostApiPath,
): (...args: unknown[]) => never {
  return () => {
    throw new Error(
      `[plugin-child:${pluginId}] hostApi.${path} is not wired to the boundary yet`,
    );
  };
}

function assertStubIsTotal(pluginId: string, root: Record<string, unknown>): void {
  for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS)) {
    const resolved = path
      .split(".")
      .reduce<unknown>(
        (cursor, segment) =>
          cursor === null || typeof cursor !== "object"
            ? undefined
            : (cursor as Record<string, unknown>)[segment],
        root,
      );
    if (typeof resolved !== "function") {
      throw new Error(
        `[plugin-child:${pluginId}] hostApi stub is missing '${path}'`,
      );
    }
  }
}

/** Reject tool results that cannot survive JSON so all transports give the plugin the same answer. */
export async function startPluginChildRuntime(
  options: PluginChildRuntimeOptions,
): Promise<PluginChildRuntime> {
  const { manifest, context, channel } = options;
  const { pluginId } = context;

  const subscriptions = new SubscriptionLedger<ChildSubscription>(
    `plugin-child:${pluginId}`,
  );
  const pendingLeaseClosures = new Map<string, "revoked" | "peer-gone">();
  const log = (message: string, meta?: unknown): void => {
    channel.notify({
      jsonrpc: "2.0",
      method: HOST_PROTOCOL_NOTIFICATIONS.log,
      params: { message, meta },
    });
  };
  const releaseChildSubscription: SubscriptionRelease<ChildSubscription> = (
    subscription,
    reason,
    subscriptionId,
  ) => {
    // Host revocation must clear state captured by member closures.
    if (reason === "revoked" || reason === "peer-gone") subscription.onRevoked?.(reason);
    // Only child-initiated disposal sends a release; host revocation and host loss do not.
    if (reason !== "disposed") return;
    channel.notify({
      jsonrpc: "2.0",
      method: HOST_PROTOCOL_NOTIFICATIONS.subscriptionRelease,
      params: { subscriptionId },
    });
  };
  const openSubscription = (
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ) => {
    const subscriptionId = subscriptions.open(
      { path, handler },
      releaseChildSubscription,
    );
    return {
      subscriptionId,
      dispose: () => {
        subscriptions.close(subscriptionId, "disposed");
      },
    };
  };
  const adoptSubscription = (
    path: HostApiPath,
    subscriptionId: string,
    handler: (payload: unknown) => void,
    onRevoked?: (reason: "revoked" | "peer-gone") => void,
  ) => {
    subscriptions.adopt(
      subscriptionId,
      { path, handler, ...(onRevoked ? { onRevoked } : {}) },
      releaseChildSubscription,
    );
    const pendingClosure = pendingLeaseClosures.get(subscriptionId);
    if (pendingClosure) {
      pendingLeaseClosures.delete(subscriptionId);
      subscriptions.close(subscriptionId, pendingClosure);
    }
    return () => {
      subscriptions.close(subscriptionId, "disposed");
    };
  };
  const caller = createHostApiCaller(channel, context);
  /** Mutate the captured config snapshot in place; context remains its original startup view. */
  const config: Record<string, unknown> = { ...(context.config ?? {}) };
  const shutdownHandlers = new Map<string, () => void | Promise<void>>();
  /** Keep an internal installed-plugin snapshot and return fresh arrays so callers cannot mutate it. */
  let installedPluginIds: readonly string[] = [...context.installedPluginIds];
  /** Mutate the captured preference snapshot in place; undefined means no reader. */
  const appPreferences: Record<string, unknown> | undefined = context.appPreferences
    ? { ...context.appPreferences.values }
    : undefined;
  /** Compose groups over throwing defaults so missing implementations never resolve undefined. */
  const members: Partial<Record<HostApiPath, (...args: unknown[]) => unknown>> = {
    ...createInteractionChildMembers(caller),
    ...createServiceChildMembers({
      pluginId,
      manifest,
      call: caller,
      adoptSubscription,
      report: log,
    }),
    ...createConfigSubscriptionChildMembers({
      pluginId,
      call: caller,
      openSubscription,
      config,
      report: log,
      shutdownHandlers,
    }),
    ...createStorageChildMembers(caller, context),
    getInstalledPluginIds: () => [...installedPluginIds],
    /** Synchronous preference reads use the pushed snapshot; an absent optional reader must refuse. */
    getAppPreference: (...args) => {
      if (!appPreferences) {
        throw new Error(
          `[plugin-child:${pluginId}] hostApi.getAppPreference: this host published no `
            + `preference snapshot, so 'unset' and 'unavailable' cannot be told apart`,
        );
      }
      const key = args[0];
      // Use own-key checks so inherited prototype members cannot appear as preferences.
      return typeof key === "string" && Object.hasOwn(appPreferences, key)
        ? appPreferences[key]
        : undefined;
    },
  };
  const hostApi = createChildHostApiStub(
    pluginId,
    (path) => members[path] ?? unimplementedChildMember(pluginId, path),
  );

  // Refuse missing host path fields before any plugin code can treat sandbox-derived paths as real.
  for (const field of ["userHome", "aveHome"] as const) {
    const value = context[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `[plugin-child:${pluginId}] construction payload is missing '${field}'. `
          + "The child cannot derive it — its HOME is a sandbox throwaway — so the "
          + "host must send it.",
      );
    }
  }

  const runtimeContext: PluginRuntimeContext = {
    pluginId,
    pluginRoot: context.pluginRoot,
    hostRoot: context.hostRoot,
    pluginDataDir: context.pluginDataDir,
    // Derive socket directories with the same pure function used by host confinement.
    pluginSocketDir: resolvePluginSocketDir(context.pluginDataDir),
    userHome: context.userHome,
    aveHome: context.aveHome,
    config: context.config,
    log,
    hostApi,
  };

  const factory = await options.loadFactory(manifest);
  if (!factory) {
    throw new Error(
      `[plugin-child:${pluginId}] entry '${manifest.entry}' exports no plugin factory`,
    );
  }
  const instance = await factory(runtimeContext);

  const delegate: PluginToolDelegate = async (name, args, invocationContext) => {
    const handler = instance.handlers[name];
    if (!handler) {
      throw new Error(`[plugin-child:${pluginId}] tool '${name}' has no handler`);
    }
    // Convert empty MCP argument objects to absent payload, matching the in-process delegate.
    const payload = Object.keys(args).length > 0 ? args : undefined;
    const value = invocationContext
      ? await invocationScope.run(invocationContext.invocation, () => handler(payload))
      : await handler(payload);
    const nonJson = describeNonJson(value, `${name}(result)`);
    if (nonJson) {
      throw new Error(
        `[plugin-child:${pluginId}] tool '${name}' returned a value the boundary cannot carry — ${nonJson}`,
      );
    }
    return {
      content: [
        {
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value ?? null),
        },
      ],
      // Carry the raw result alongside text so JSON-looking strings remain distinct from objects.
      _meta: { [RAW_RESULT_META]: value },
    };
  };

  // Card reads require own namespace, declaration and policy checks just as in-process reads do.
  const readUiResource = instance.readUiResource?.bind(instance);
  const uiResources =
    readUiResource && manifest.uiResources && manifest.uiResources.length > 0
      ? createPluginUiResourceProvider({
          pluginId,
          declarations: manifest.uiResources,
          readHtml: async (uri) => await readUiResource(uri),
        })
      : undefined;
  const server = new PluginMcpServer(manifest, delegate, uiResources);
  new StdioServerLoop(options.input, options.output, server, FRAME_BYTES_MAX, CHILD_MCP_UNWRITTEN_OUTPUT_BYTES_MAX).start();

  return {
    instance,
    hostApi,
    servesUiResources: uiResources !== undefined,
    get openSubscriptionCount() {
      return subscriptions.openCount;
    },
    openSubscription,
    adoptSubscription,
    deliver(notification) {
      if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.installedPluginsSnapshot) {
        installedPluginIds = [...notification.params.pluginIds];
        return "delivered";
      }
      if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.configSnapshot) {
        const { keys, values } = notification.params;
        // Mutate only enumerated snapshot keys so existing closures and plugin-created keys survive.
        for (const key of keys) {
          if (Object.hasOwn(values, key)) {
            config[key] = values[key];
          } else {
            // Delete cleared keys rather than assign undefined so key enumeration stays accurate.
            delete config[key];
          }
        }
        return "delivered";
      }
      if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.preferencesSnapshot) {
        // Report a preference push without a reader as an unknown delivery.
        if (!appPreferences) return "unknown-subscription";
        const { keys, values } = notification.params;
        for (const key of keys) {
          if (Object.hasOwn(values, key)) {
            appPreferences[key] = values[key];
          } else {
            // Delete unset preference keys instead of retaining undefined entries.
            delete appPreferences[key];
          }
        }
        return "delivered";
      }
      if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.subscriptionClosed) {
        if (subscriptions.close(notification.params.subscriptionId, notification.params.reason)) return "closed";
        if ((notification.params.subscriptionId.startsWith("lease_")
          || notification.params.subscriptionId.startsWith("raw_")) && pendingLeaseClosures.size < 32) {
          pendingLeaseClosures.set(notification.params.subscriptionId, notification.params.reason);
          return "closed";
        }
        return "unknown-subscription";
      }
      if (notification.method !== HOST_PROTOCOL_NOTIFICATIONS.subscription) {
        return "unknown-subscription";
      }
      const subscription = subscriptions.get(notification.params.subscriptionId);
      if (!subscription) return "unknown-subscription";
      subscription.handler(notification.params.payload);
      return "delivered";
    },
    async runShutdownHandler(subscriptionId) {
      const run = shutdownHandlers.get(subscriptionId);
      if (!run || !subscriptions.get(subscriptionId)) {
        throw new Error(
          `[plugin-child:${pluginId}] no open onShutdown registration '${subscriptionId}'`,
        );
      }
      await run();
    },
    hostGone() {
      pendingLeaseClosures.clear();
      return subscriptions.end("peer-gone");
    },
  };
}
