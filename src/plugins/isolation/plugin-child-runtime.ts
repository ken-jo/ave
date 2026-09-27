/**
 * The plugin end of the boundary: what runs INSIDE a child process
 * (`docs/blueprints/plugin-process-isolation.md` §3.4, §5.2).
 *
 * It builds the hostApi stub, hands it to the plugin factory, and serves the
 * resulting instance as an MCP server over `StdioServerLoop` — the same
 * `PluginMcpServer` and the same projection the in-process loopback arm already
 * uses, over a different transport. That symmetry is the reason this is a
 * transport swap rather than a new protocol.
 *
 * TWO INJECTION POINTS, BOTH DELIBERATE.
 *
 * `loadFactory` is required rather than defaulting to `importPluginFactory`.
 * That helper lives in `runtime/plugin-loader.ts`, which imports
 * `runtime/sandbox.ts` → `plugins/storage.ts` → `electron`. A child is a plain
 * Node process where that import does not resolve, so reusing the helper as-is
 * would produce a child that cannot start — and copying its four lines here
 * would be the second copy of a function this repo has already been bitten by.
 * De-tangling `buildImportUrl` from the Electron-bound half of `sandbox.ts` is
 * the prerequisite for a real child entrypoint, and it is a change to a
 * heavily-shared module that does not belong in the same commit as this.
 *
 * `channel` is required for the same class of reason: the reverse channel has to
 * be multiplexed onto the stdio pipes that `StdioServerLoop` already owns, and
 * pinning that here would make every hostApi handler untestable without
 * spawning a subprocess.
 */
import type { Readable, Writable } from "node:stream";
import { StdioServerLoop } from "../../mcp/experimental/stdio-server-loop.js";
import {
  PluginMcpServer,
  type PluginToolDelegate,
} from "../../mcp/plugin-mcp-server.js";
import { createPluginUiResourceProvider } from "../../mcp/plugin-ui-resource-provider.js";
import { describeNonJson } from "../../shared/json-representable.js";
import { errorMessage } from "../../shared/error-message.js";
import { RAW_RESULT_META } from "../../mcp/protocol-constants.js";
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

/**
 * The construction payload, which is `PluginRuntimeContext` minus the two
 * members that cannot cross: `log` is rebuilt from a notification and `hostApi`
 * is rebuilt from the channel. Everything else is already plain data.
 */
export interface PluginChildContext {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly hostRoot: string;
  readonly pluginDataDir: string;
  /**
   * The real user home and the host's storage root, as the HOST process reads
   * them.
   *
   * CARRIED, not derived — which is the opposite of `pluginSocketDir` below,
   * and for the opposite reason. That one is a pure function of a value already
   * on this payload, so recomputing it in the child cannot disagree with the
   * host. These two are functions of the child's ENVIRONMENT, and the child's
   * environment is deliberately not the host's: the sandbox substitutes `HOME`
   * with a throwaway. Recomputing them here would answer with that throwaway,
   * silently, and the answer would still look like a directory.
   */
  readonly userHome: string;
  readonly aveHome: string;
  /** The already-resolved config object, not the schema. */
  readonly config?: Record<string, unknown>;
  /**
   * The installed-plugin ids as of construction.
   *
   * `getInstalledPluginIds` is synchronous, so §3.1 answers it from a
   * host-pushed snapshot; this is the first push. Later ones arrive as
   * installed-plugin snapshot notifications.
   */
  readonly installedPluginIds: readonly string[];
  /**
   * The allow-listed host preferences as of construction, split into `keys` and
   * `values` exactly as the preferences snapshot notification splits them.
   *
   * OPTIONAL, and the absence carries meaning rather than being a convenience:
   * `getAppPreference` is itself an OPTIONAL member of `PluginHostApi`, so "this
   * host publishes no preferences" and "this preference is unset" are two
   * different states that would both read as `undefined` at a plugin's call
   * site. Absent here means the first, and the child's member THROWS rather
   * than answering — merging the two would hand a plugin a wrong answer it has
   * no way to detect.
   */
  readonly appPreferences?: {
    readonly keys: readonly string[];
    readonly values: Record<string, unknown>;
  };
}

/** How the child obtains the plugin's factory export. */
export type PluginFactoryLoader = (
  manifest: PluginManifest,
) => Promise<RuntimePluginFactory | undefined>;

/** One child-side registration: the plugin's callback and the member it serves. */
interface ChildSubscription {
  readonly path: HostApiPath;
  readonly handler: (payload: unknown) => void;
  /**
   * What to run when the HOST ends this registration, for the members that own
   * something the child must let go of — the key a lease closed over being the
   * one that matters. Absent for a registration whose only state is the handler
   * itself, which the ledger drops on its own.
   */
  readonly onRevoked?: (reason: "revoked" | "peer-gone") => void;
}

/** What `deliver` did, so a dropped notification is reported rather than silent. */
export type NotificationOutcome =
  | "delivered"
  | "closed"
  | "unknown-subscription";

export interface PluginChildRuntimeOptions {
  /** Framed JSON-RPC in (the child's stdin in production). */
  readonly input: Readable;
  /** Framed JSON-RPC out (the child's stdout in production). */
  readonly output: Writable;
  readonly manifest: PluginManifest;
  readonly context: PluginChildContext;
  readonly channel: HostApiChannel;
  readonly loadFactory: PluginFactoryLoader;
}

export interface PluginChildRuntime {
  readonly instance: RuntimePlugin;
  readonly hostApi: PluginHostApi;
  /**
   * Whether MCP `resources/read` answers a card here: the plugin implements
   * the hook AND its manifest declares a card. `construct` reports this, not
   * the hook alone, so the host never routes a read to a server that refuses.
   */
  readonly servesUiResources: boolean;
  /** Live child-side registrations. Zero after {@link hostGone}. */
  readonly openSubscriptionCount: number;
  /**
   * Open a child-side registration under a CHILD-allocated id, and return the
   * disposer the plugin gets. The four subscription members share this rather
   * than each inventing a lifetime.
   */
  openSubscription(
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ): { readonly subscriptionId: string; readonly dispose: () => void };
  /**
   * Open a child-side registration under a HOST-allocated id, and return the
   * disposer.
   *
   * The counterpart to {@link openSubscription}, and both exist because the two
   * lifetime-bearing shapes allocate their ids at opposite ends. A
   * `handler-registration` member (`onEvent`, `config.onChange`, …) is named by
   * the CHILD so no event can arrive before its handler is registered; a
   * `handle` member (`spawnWorker`, `resolveApiKey`) is named by the HOST,
   * because the host owns the resource and cannot be told what to call it.
   */
  adoptSubscription(
    path: HostApiPath,
    subscriptionId: string,
    handler: (payload: unknown) => void,
    /**
     * Run when the HOST revokes this registration, never when the child
     * disposes it and never when the host is simply gone. `resolveApiKey` uses
     * it to drop the credential it closed over: a lease the host has taken back
     * must stop being spendable in the child, and the child cannot learn that
     * from an event because a revoked registration delivers none.
     */
    onRevoked?: (reason: "revoked" | "peer-gone") => void,
  ): () => void;
  /** Host → child notification. */
  deliver(notification: HostApiNotification): NotificationOutcome;
  /**
   * Run the `onShutdown` handler registered under `subscriptionId` and settle
   * when it has — the child's half of `ave/instance/shutdown`. An id with no
   * open registration is refused: the host names only ids the plugin gave it.
   */
  runShutdownHandler(subscriptionId: string): Promise<void>;
  /**
   * The host is gone. Every registration is dropped WITHOUT notifying, because
   * there is no longer anyone to notify — the case that turns a release into a
   * write on a closed pipe.
   */
  hostGone(): number;
}

/**
 * Send one hostApi call and settle it the way an in-process call settles: a
 * value, or a throw whose identity survived the wire.
 *
 * Every child-side stub goes through this, so the positional call becomes its
 * `ave/host/*` method and params object in exactly one place.
 *
 * `signal` is how the three members that take an `AbortSignal` cancel. It does
 * not cross: when it aborts, the child names the in-flight REQUEST in a
 * `notifications/cancelled` and the host aborts the controller it holds for
 * that request (§3.5). The call still settles through the host's reply, so the
 * plugin sees the host's answer to the cancellation rather than a local guess
 * at it.
 */
export type HostApiCaller = (
  path: HostApiPath,
  args: readonly unknown[],
  signal?: AbortSignal,
) => Promise<unknown>;

export function createHostApiCaller(
  channel: HostApiChannel,
  context: Pick<PluginChildContext, "pluginId">,
): HostApiCaller {
  return async (path, args, signal) => {
    const nonJson = describeNonJson(args, `${path}(args)`);
    if (nonJson) {
      // Refused here rather than sent, so the plugin sees the failure at its own
      // call site with its own stack instead of a dispatcher rejection whose
      // stack points at the transport.
      throw new Error(
        `[plugin-child:${context.pluginId}] ${path}: argument cannot cross the boundary — ${nonJson}`,
      );
    }
    // An ALREADY-aborted signal throws its own reason without a round trip —
    // that is what the in-process call does, and sending a request the host
    // would immediately be told to cancel is a slower way to say the same thing.
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
      const reply = await channel.call(
        hostApiMethodOf(path),
        hostApiParamsOf(path, args),
        (id) => {
          requestId = id;
        },
      );
      if ("error" in reply) throw reconstructWireError(fromHostApiRpcError(reply.error));
      // A `void` member answers `null` because JSON-RPC requires a result and
      // JSON has no `undefined`; the plugin is owed the `undefined` it would
      // get in-process.
      return HOSTAPI_PATH_CONTRACTS[path].result === "void" ? undefined : reply.result;
    } finally {
      // Detached once the call settles, whichever way: an abort after the
      // reply names a request the host no longer holds.
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * Every member of the hostApi surface, present and throwing.
 *
 * Present, because a plugin reading `hostApi.getSecret` must find a function —
 * an absent member is a `TypeError` that says nothing about why. Throwing,
 * because a stub that resolved `undefined` would turn "not wired yet" into "no
 * secret", "no preference", "write succeeded". The nesting is derived from the
 * contract SOT, so a member added there appears here without a second edit.
 */
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
  // Backed by the assertion above: every declared member resolves to a
  // function, which is the only claim `PluginHostApi` makes structurally.
  return root as unknown as PluginHostApi;
}

/** The stub a member with no child-side implementation yet gets. */
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

/**
 * Stand the plugin up in this process and start serving.
 *
 * The tool delegate is the child's half of §3.5: a result that would not survive
 * JSON is refused HERE, at the plugin that produced it, rather than arriving at
 * the host as a shape the host cannot explain. `LoopbackTransport` refuses the
 * same shapes on the in-process arm; refusing them here too means a plugin gets
 * one answer about its own return value rather than one answer per transport.
 */
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
    // A host revocation is the one close the MEMBER has to act on: the ledger
    // dropping the entry releases the handler, but not whatever the stub closed
    // over on the plugin's behalf.
    if (reason === "revoked" || reason === "peer-gone") subscription.onRevoked?.(reason);
    // Only a child-initiated dispose owes the host a message. `revoked` came
    // FROM the host and `peer-gone` means there is no host to tell.
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
  /**
   * The child's copy of the resolved config.
   *
   * Seeded from the construction push and never re-read from `context`, so
   * `config.get` answers from one place. `ctx.config` keeps pointing at the
   * construction object the in-process contract gives it — a plugin that
   * captured it sees exactly what it sees today.
   */
  const config: Record<string, unknown> = { ...(context.config ?? {}) };
  const shutdownHandlers = new Map<string, () => void | Promise<void>>();
  /**
   * The child's copy of the installed-plugin set, and the member that reads it.
   *
   * It lives here rather than in one of the four bound groups because it
   * belongs to none of them: there is no host handler to bind: the contract
   * says `child-local`, and the dispatcher REFUSES the path if it is ever sent.
   * A group factory for a member with no dispatched half would be a factory
   * that binds nothing.
   *
   * A COPY is returned per call. Handing out the array itself would let a
   * plugin mutate the snapshot the next `getInstalledPluginIds` reads, which
   * the in-process member — a fresh array from the registry each time — cannot
   * do.
   */
  let installedPluginIds: readonly string[] = [...context.installedPluginIds];
  /**
   * The child's copy of the allow-listed host preferences, or `undefined` when
   * this host publishes none.
   *
   * MUTATED IN PLACE by the preferences snapshot, never rebound, for the same
   * reason `config` is: the member below closes over it.
   */
  const appPreferences: Record<string, unknown> | undefined = context.appPreferences
    ? { ...context.appPreferences.values }
    : undefined;
  /**
   * The wired members, composed group by group. One spread per group keeps four
   * parallel authors out of each other's lines; a member no group claims still
   * throws rather than resolving `undefined`.
   */
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
    /**
     * `getAppPreference`, answered from the host-pushed preference snapshot.
     *
     * It used to be the one member with no child half, and the reason was
     * sound: §3.1 answers a synchronous member from a snapshot, a snapshot is
     * only correct while something re-pushes it, and `hostApi` had no
     * preference-change signal to re-push from — so the member would have
     * answered with the value the preference held when the plugin started,
     * forever. `lyra-mail` reads `webView.preferredFlow` at CALL time, so that
     * is precisely the wrong answer it would have received.
     *
     * The missing half is now `subscribeAppPreferenceChange`
     * (`plugins/config-change-bus.ts`), which the host end of every child
     * subscribes to; each announcement re-pushes this snapshot, and the host
     * pushes once more as soon as the construct reply lands so the value read
     * for the construct params cannot be left behind by a change that raced it
     * (`out-of-process-plugin.ts`).
     *
     * A key OFF the host allowlist answers `undefined`, which is what the
     * in-process reader answers for it too — the allowlist is `keys`, and a
     * denied key is simply not in the snapshot. The one thing the child cannot
     * reproduce is the host reader's warn-once-per-denied-key line, which is
     * host-side observability and not part of the answer.
     *
     * NOT AN ANSWER THE HOST CAN MAKE: this member throwing when nothing was
     * seeded. `host-api-factory.ts` always defines `getAppPreference`, so every
     * child the app builds is seeded; the throw exists because the member is
     * OPTIONAL on `PluginHostApi` and a partial hostApi can therefore omit it.
     */
    getAppPreference: (...args) => {
      if (!appPreferences) {
        throw new Error(
          `[plugin-child:${pluginId}] hostApi.getAppPreference: this host published no `
            + `preference snapshot, so 'unset' and 'unavailable' cannot be told apart`,
        );
      }
      const key = args[0];
      // `Object.hasOwn`, not a bare index. The snapshot is a plain object, so
      // `appPreferences["toString"]` would answer with `Object.prototype`'s
      // member — a FUNCTION where the host reader, which tests the key against
      // the allowlist, answers `undefined`. Non-string keys answer `undefined`
      // for the same reason: no allow-listed key can be reached by one, so the
      // two ends agree on the value.
      return typeof key === "string" && Object.hasOwn(appPreferences, key)
        ? appPreferences[key]
        : undefined;
    },
  };
  const hostApi = createChildHostApiStub(
    pluginId,
    (path) => members[path] ?? unimplementedChildMember(pluginId, path),
  );

  // A payload without these is a host that predates them, and the child cannot
  // fill the gap: `homedir()` here answers with the sandbox's throwaway and
  // `AVE_HOME` is not part of the child's environment either. Refuse
  // construction rather than hand the plugin `undefined`, which every `join`
  // and `startsWith` downstream would treat as an ordinary — and wrong — path.
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
    // DERIVED, not carried. It is a pure function of the data directory, and
    // the host's spawn path computes it with the SAME function — so the
    // directory the sandbox was told about and the one the plugin is handed
    // cannot come apart. A second wire field could.
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

  const delegate: PluginToolDelegate = async (name, args) => {
    const handler = instance.handlers[name];
    if (!handler) {
      throw new Error(`[plugin-child:${pluginId}] tool '${name}' has no handler`);
    }
    // `{}` becomes NO payload, which is the convention the in-process delegate
    // already applies (`plugin-runtime-delegate.ts`) because some plugins
    // distinguish an absent payload from an empty object. MCP has no way to
    // carry "absent" — `tools/call` params are an object — so the two arms have
    // to agree on where the conversion happens, and this is that place on the
    // isolated arm.
    const value = await handler(Object.keys(args).length > 0 ? args : undefined);
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
      // The text branch is LOSSY and cannot be the only carrier: a plugin
      // returning the string `'{"a":1}'` and one returning the object `{a:1}`
      // produce identical text, so a host reading only `content[0].text` would
      // have to guess which it was. `_meta` carries the value itself — the same
      // key, for the same reason, as the in-process delegate. It is safe to put
      // here because `describeNonJson` above has already proven it survives.
      _meta: { [RAW_RESULT_META]: value },
    };
  };

  // The plugin's `ui://` cards are MCP `resources/read`, behind the same gate
  // the in-process loopback host builds — own namespace, declared only, policy
  // from the manifest — with the instance's hook as the content. Absent when
  // the plugin declares no card or implements no hook, so a read fails closed.
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
  // Fed only by the child's multiplexer, which has already bounded every line
  // it forwards by the same limit.
  new StdioServerLoop(options.input, options.output, server, FRAME_BYTES_MAX).start();

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
        // MUTATED IN PLACE, never rebound: `createConfigSubscriptionChildMembers`
        // captured this object, so a fresh one would leave `config.get` reading
        // the record the construction push seeded and nothing would report it.
        //
        // Only the keys the push ENUMERATES are touched. A key the plugin set
        // itself and the host cannot enumerate keeps the value the child wrote
        // when its own `config.set` resolved, instead of being erased by a
        // snapshot that never knew about it.
        for (const key of keys) {
          if (Object.hasOwn(values, key)) {
            config[key] = values[key];
          } else {
            // Absent from `values` means unset, which is what `config.get`
            // answers `undefined` for. Deleted rather than assigned
            // `undefined` so `Object.keys(config)` stays the truth.
            delete config[key];
          }
        }
        return "delivered";
      }
      if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.preferencesSnapshot) {
        // Reported as a DROP through the outcome the union already has for
        // "this named something I do not hold". A host that pushes preferences
        // to a child it never seeded would otherwise leave `getAppPreference`
        // throwing while the pushes looked like they landed: the member reads
        // the seeded object, and there is no seeded object to move.
        //
        // The production host cannot reach it — `out-of-process-plugin.ts`
        // pushes only when it seeded, and it always seeds because
        // `host-api-factory.ts` always implements the reader. It is the same
        // defensive pair as the member's throw above, kept because the two
        // halves are wired by separate objects in tests.
        if (!appPreferences) return "unknown-subscription";
        // MUTATED IN PLACE for the same reason the config snapshot is: the
        // member above captured this object.
        const { keys, values } = notification.params;
        for (const key of keys) {
          if (Object.hasOwn(values, key)) {
            appPreferences[key] = values[key];
          } else {
            // Absent from `values` means unset, which is what the reader
            // answers `undefined` for. `delete` rather than assigning
            // `undefined` mirrors the config snapshot handler above; through
            // this member the two are indistinguishable, so this is hygiene
            // rather than a behaviour anything can observe.
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
      return subscriptions.end("peer-gone");
    },
  };
}
