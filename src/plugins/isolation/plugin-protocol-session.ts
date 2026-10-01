/**
 * The layer between "a child exists on a link" and "a `RuntimePlugin` the
 * lifecycle can call" (`docs/design/plugin-hostapi-protocol.md` §9.7, S1).
 *
 * The production factory owns admission and the confined spawn; this owns
 * what runs over the child's pipes once it exists — the transport, the host's
 * own watchers, `construct`, the capability check, the seed re-push and the
 * tool, card and lifecycle proxy. The validator opens the same session over
 * its own link, so the protocol it checks is the one production speaks.
 *
 * ITS AUTHORITY IS AN INPUT. The session serves exactly the bound table it is
 * handed and advertises exactly that table's members in `construct`. It never
 * derives, widens or defaults an envelope, spawns nothing and reads no sandbox
 * state: who may do what is decided by whoever bound the table.
 *
 * ONE DESTRUCTIVE OPERATION. `teardown` ends the child. Everything on the
 * channel — MCP requests, the probe, the stop hook alone, closing stdin — is
 * non-destructive, and a child that exits on its own is released without being
 * terminated.
 */
import { createLogger } from "../../lib/logger.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { RAW_RESULT_META } from "../../mcp/protocol-constants.js";
import { errorMessage } from "../../shared/error-message.js";
// The allowlist is READ where it is declared rather than mirrored here. It is
// the host's answer to "which preferences may a plugin see", and a second copy
// of that list would be a second answer to a security question.
import { HOST_PUBLIC_PREFERENCE_KEYS } from "../../boot/steps/plugin-runtime/app-preference.js";
import { subscribeAppPreferenceChange } from "../config-change-bus.js";
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  PluginToolHandler,
  RuntimePlugin,
} from "../types.js";
import { hostProtocolCapabilities } from "./host-api-dispatcher.js";
import {
  HOST_PROTOCOL_NOTIFICATIONS,
  IncompatibleHostProtocolError,
  type HostProtocolVersion,
} from "./host-api-wire.js";
import {
  PLUGIN_INSTANCE_METHODS,
  type PluginConstructParams,
  type PluginConstructResult,
} from "./plugin-instance-wire.js";
import {
  PluginChildTransport,
  type ChildLink,
  type PluginChildProbeReply,
  type PluginMcpRequestMethod,
} from "./plugin-child-transport.js";
import type { PluginChildContext } from "./plugin-child-runtime.js";
import type { BoundHostApiDispatchTable, DispatchableHostApi } from "./bound-host-api-table.js";

const log = createLogger("plugin-protocol-session");

/**
 * The `hostApi` members the session reads besides the ones the table binds.
 *
 * `getInstalledPluginIds` belongs to no dispatch group because it is
 * DISPATCHED BY NOBODY: its contract is `child-local` and the table refuses it
 * if it ever arrives. The host still calls it — to build the snapshot the
 * child answers from. `getAppPreference` joins it for the same reason and
 * stays OPTIONAL, because it is optional on `PluginHostApi`. A host that does
 * not implement it publishes no preference snapshot at all, and the child's
 * member then throws instead of answering `undefined` — see
 * `PluginChildContext.appPreferences`.
 */
type SessionHostApi = DispatchableHostApi &
  Pick<PluginHostApi, "getInstalledPluginIds"> &
  Pick<PluginHostApi, "getAppPreference">;

export interface PluginProtocolSessionSpec {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** The admitted host protocol version this connection speaks (§3.2). */
  readonly hostProtocolVersion: HostProtocolVersion;
  readonly link: ChildLink;
  readonly context: PluginRuntimeContext;
  /** The resolved, real entry path of the PLUGIN (not of the child runtime). */
  readonly entryPath: string;
  /**
   * The session's whole authority: the table it serves, and the members it
   * advertises in `construct`. Required, so there is no default to fall back
   * on and no envelope the session could derive for itself.
   */
  readonly table: BoundHostApiDispatchTable;
  readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /**
   * Run once, after the child is released — by `teardown` or by its own exit.
   * The owner's cleanup: waiting for the process and disposing what it
   * registered for it.
   */
  readonly onClosed: (reason: string) => Promise<void>;
  /**
   * Abort tears the session down at any point, including while `construct` is
   * pending. Listened to from the opener's first line until the release.
   */
  readonly signal?: AbortSignal;
}

/** The non-destructive controls over a constructed child. */
export interface PluginProtocolChannel {
  /** `server/discover`, `tools/list`, `tools/call`, `resources/read`, with MCP's metadata. */
  requestMcp(
    method: PluginMcpRequestMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** One request verbatim, answered with its `result` or its `error`. */
  probe(method: string, params?: Record<string, unknown>): Promise<PluginChildProbeReply>;
  /**
   * Send `ave/instance/stop` when the construction declared it. Does not
   * close the channel, mark it dead or terminate the child.
   */
  runStopHook(): Promise<void>;
  /** End the child's stdin, and nothing else — what a crashed host looks like to it. */
  closeInput(): void;
  /**
   * Settles with the reason the link reported the child gone, and on nothing
   * else. A fault, a deadline, an abort or a teardown does not settle it; each
   * ends the child, and this settles when that exit is observed.
   */
  readonly exited: Promise<string>;
}

export interface PluginProtocolSession {
  readonly instance: RuntimePlugin;
  /** The `ave/host/*` methods advertised in `construct`, read off the bound table. */
  readonly capabilities: readonly string[];
  readonly construction: PluginConstructResult;
  readonly channel: PluginProtocolChannel;
  /**
   * The only destructive operation: the channel stops carrying calls, the host
   * watchers end, the child is terminated, then `onClosed` runs. Idempotent;
   * after the child already left on its own it terminates nothing.
   */
  teardown(reason: string): Promise<void>;
}

/**
 * Every config key the host can resolve for this plugin.
 *
 * `config.get` merges schema defaults, the manifest's own config, a host
 * wildcard slot and the user's saved settings, and `PluginHostApi` publishes no
 * way to enumerate the result — so the key set is assembled from the three
 * sources the host DOES hold: the schema's declared properties, the manifest's
 * config, and the construction snapshot (which is the merge, as it stood when
 * the plugin started). Their union is what the settings surface can change,
 * which is what a re-push has to cover.
 */
function resolvableConfigKeys(
  manifest: PluginManifest,
  constructionConfig: Record<string, unknown> | undefined,
): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.configSchema?.properties ?? {}),
      ...Object.keys(manifest.config ?? {}),
      ...Object.keys(constructionConfig ?? {}),
    ]),
  ];
}

/**
 * Read a plugin's declared tool names.
 *
 * The same derivation `buildMethodMap` performs, and it is repeated here rather
 * than shared because it answers a different question: that one asks which
 * handlers an instance HAS, this one tells the child which handlers the host
 * will ask it for. Passing the declared set is what stops a compromised child
 * announcing a tool the reviewed manifest never contained.
 */
function declaredToolNames(manifest: PluginManifest): string[] {
  return [...new Set((manifest.tools ?? []).map((tool) => tool.name))];
}

/**
 * The `tools/call` arguments object for one invocation.
 *
 * Refuses anything that is neither absent nor a plain object. Coercing a
 * string or an array to `{}` would turn "you invoked this tool wrongly" into
 * "you invoked it with no payload", which the plugin would answer as a normal
 * call — a wrong answer with no error anywhere.
 */
function asToolArguments(
  pluginId: string,
  toolName: string,
  payload: unknown,
): Record<string, unknown> {
  if (payload === undefined) return {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' payload must be an ` +
        `object or absent to cross the boundary, received ${typeof payload}`,
    );
  }
  return payload as Record<string, unknown>;
}

/**
 * Read a tool result off the MCP reply.
 *
 * `_meta[RAW_RESULT_META]` and NOT `content[0].text`: the text branch is lossy,
 * because a plugin returning the string `'{"a":1}'` and one returning the
 * object `{a:1}` produce the same text. The raw value is the plugin's own
 * return, and this is the same key the in-process delegate uses, so a tool's
 * result has one representation regardless of which arm ran it.
 */
function readToolResult(pluginId: string, toolName: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' returned no result body`,
    );
  }
  const body = result as { isError?: boolean; content?: unknown; _meta?: Record<string, unknown> };
  if (body.isError === true) {
    // The child turns a throwing handler into an `isError` result, which is the
    // mechanism `plugin-mcp-server.ts` already has for the child→host
    // direction (§3.3). The identity that survives is the message; nothing is
    // reconstructed by matching it.
    const content = Array.isArray(body.content) ? body.content : [];
    const first = content[0] as { text?: unknown } | undefined;
    throw new Error(
      typeof first?.text === "string"
        ? first.text
        : `[out-of-process-plugin] ${pluginId}: tool '${toolName}' failed`,
    );
  }
  const meta = body._meta;
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, RAW_RESULT_META)) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' returned a result ` +
        `without '${RAW_RESULT_META}' — the child and the host disagree about the wire`,
    );
  }
  return meta[RAW_RESULT_META];
}

/**
 * Refuse a child whose `construct` reply names a method it cannot run without
 * that this connection did not advertise (§3.2). A reply with no
 * `pluginProtocol` is a child that does not speak this protocol version, and
 * fails as one rather than being read as "requires nothing".
 */
function requireServedCapabilities(
  pluginId: string,
  construction: PluginConstructResult,
  capabilities: readonly string[],
): void {
  const requires: unknown = construction.pluginProtocol?.requires;
  if (!Array.isArray(requires) || !requires.every((entry) => typeof entry === "string")) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: construct answered no pluginProtocol.requires list`,
    );
  }
  const served = new Set(capabilities);
  const missing = requires.filter((method) => !served.has(method));
  if (missing.length > 0) {
    throw new IncompatibleHostProtocolError(pluginId, { missingCapabilities: missing });
  }
}

/** The card's HTML out of an MCP `resources/read` result, or a clear failure. */
function readUiResourceHtml(pluginId: string, uri: string, result: unknown): string {
  const contents = (result as { contents?: unknown } | undefined)?.contents;
  const first = Array.isArray(contents) ? (contents[0] as { text?: unknown } | undefined) : undefined;
  if (typeof first?.text !== "string") {
    throw new Error(`[out-of-process-plugin] ${pluginId}: resources/read('${uri}') returned no html`);
  }
  return first.text;
}

/** An abort's reason as the text a teardown records. */
function abortReasonText(signal: AbortSignal): string {
  return errorMessage(signal.reason);
}

/**
 * Open the protocol over a child that already exists on `spec.link`, and
 * construct the plugin in it.
 *
 * Rejects — with the child terminated and `onClosed` run — when construction
 * fails or the signal aborts; the abort's own reason is what it rejects with.
 */
export async function openPluginProtocolSession(
  spec: PluginProtocolSessionSpec,
): Promise<PluginProtocolSession> {
  const { pluginId, context, signal } = spec;
  // No generation id crosses: each session runs over its own child, so the
  // connection IS the incarnation (§2.4), and the pipe closing when the
  // incarnation retires is what pins it.
  const hostApi = context.hostApi as unknown as SessionHostApi;

  let live = true;
  const transport = new PluginChildTransport({
    pluginId,
    // The boundary's own liveness, not a second authority. The authoritative
    // check is still `enforceActiveHostApi` on the object below, which throws
    // on every member once the incarnation deactivates — and which the child
    // cannot reach around, because it is on the other side of a pipe. This
    // one exists so a call arriving after `stop()` is refused at the wire
    // instead of being carried to a hostApi that will refuse it anyway.
    isActive: () => live,
    // Same shape the in-process arm emits from `buildPluginContext`, so a
    // reader searching the log by `pluginId` finds an isolated plugin's lines
    // next to an in-process one's rather than not at all. The module tag
    // differs — these did come from a child — and that is the only difference.
    log: (message, meta) => {
      if (meta !== undefined) {
        log.info({ pluginId, meta }, message);
        return;
      }
      log.info({ pluginId }, message);
    },
    // The host's own voice about the connection, not the plugin's: a params
    // field the member does not declare is accepted and ignored (§3.3), and
    // named here once per (method, field) so a protocol skew is visible.
    reportUnknownField: (report) => {
      if (report.kind === "suppressed") {
        log.warn(
          { pluginId, limit: report.limit },
          "further undeclared params fields suppressed for this connection",
        );
        return;
      }
      log.warn(
        { pluginId, method: report.method, field: report.field },
        "ignored an undeclared params field",
      );
    },
    reportBudgetAudit: (entry) => {
      try {
        spec.auditLog?.("warn", entry.type, {
          pluginId: entry.pluginId,
          method: entry.method,
          code: entry.code,
          count: entry.count,
          summary: entry.summary,
          ...(entry.bucket === undefined ? {} : { bucket: entry.bucket }),
        });
      } catch { /* audit sink failure cannot alter a dispatcher result */ }
      log.warn(entry, entry.type);
    },
    // ONE table: the dispatcher serves it and `construct` advertises it, so
    // what the child is told it may call is what the host will answer.
    table: spec.table,
    link: spec.link,
  });

  /**
   * Every host-owned watcher for this incarnation, ended together.
   *
   * A LIST rather than three named disposers, because REGISTERING one can
   * fail: `hostApi` here is the generation-scoped proxy, and every member on
   * it throws once that generation retires. A failure partway through has to
   * end the ones that already exist, and by then the child already exists —
   * so anything that escapes without this leaves a live process reading stdin
   * with nobody subscribed on its behalf.
   */
  const hostWatchers: Array<() => void> = [];
  const stopHostWatchers = (): void => {
    while (hostWatchers.length > 0) hostWatchers.pop()?.();
  };

  const reportClosedFailure = (error: unknown): void => {
    log.warn({ pluginId, error: String(error) }, "the session's close handler failed");
  };
  const onAbort = (): void => {
    teardown(abortReasonText(signal!)).catch(reportClosedFailure);
  };
  let closed: Promise<void> | undefined;
  /**
   * The child is no longer served: nothing it sends is honoured, the host's
   * watchers end and the owner's `onClosed` runs — once, whichever of the exit
   * and the teardown came first.
   */
  const release = (reason: string): Promise<void> => {
    live = false;
    stopHostWatchers();
    signal?.removeEventListener("abort", onAbort);
    if (closed !== undefined) return closed;
    // The guard is set BEFORE the owner's cleanup runs: an `onClosed` that
    // re-enters `teardown` synchronously must find the release already taken,
    // not start a second one.
    let adopt!: (outcome: Promise<void>) => void;
    closed = new Promise<void>((resolve) => {
      adopt = resolve;
    });
    try {
      adopt(spec.onClosed(reason));
    } catch (error) {
      adopt(Promise.reject(error));
    }
    return closed;
  };
  const teardown = async (reason: string): Promise<void> => {
    live = false;
    stopHostWatchers();
    transport.close(reason);
    await release(reason);
  };
  // A natural exit is not a teardown: the transport has already released the
  // channel without terminating anything, and this releases the rest.
  const exited = transport.exited.then((reason) => {
    release(reason).catch(reportClosedFailure);
    return reason;
  });

  if (signal) {
    if (signal.aborted) {
      await teardown(abortReasonText(signal));
      throw signal.reason;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  transport.start();

  try {
    // The host re-pushes the installed-plugin snapshot the child answers
    // `getInstalledPluginIds` from. It is the host's OWN subscription, separate
    // from any the plugin opens: the member has to answer whether or not the
    // plugin ever subscribed to `onPluginsChanged`.
    hostWatchers.push(hostApi.onPluginsChanged(() => {
      transport.sendToChild({
        jsonrpc: "2.0",
        method: HOST_PROTOCOL_NOTIFICATIONS.installedPluginsSnapshot,
        params: { pluginIds: hostApi.getInstalledPluginIds() },
      });
    }));

    /**
     * The host re-pushes the config snapshot the child answers `config.get`
     * from. Also the host's OWN subscription, and for the same reason as the
     * one above: `config.get` has to answer whether or not the plugin ever
     * called `config.onChange`, and without a re-push it would answer with the
     * value the key had at construction for the life of the process.
     *
     * `"*"` is the change bus's every-key wildcard, so this fires for a user's
     * settings edit and for the plugin's own `config.set` alike. The bus emits
     * INSIDE `config.set`'s persistence chain, before that call's reply is
     * produced — which is what makes the contract's ordering obligation ("the
     * push is emitted before the `config.set` reply") hold on the wire rather
     * than by luck: both are written to the same pipe in that order.
     *
     * The callback's value is ignored on purpose. It carries one key's new
     * value and not which key, and a snapshot rebuilt through `config.get` is
     * the same merge the in-process member reads — one authority for what a
     * config value is, rather than a second assembled from change events.
     */
    const configKeys = resolvableConfigKeys(spec.manifest, context.config);
    hostWatchers.push(hostApi.config.onChange("*", () => {
      const values: Record<string, unknown> = {};
      for (const key of configKeys) {
        const value = hostApi.config.get(key);
        // Absent, not `undefined`: the wire distinguishes "unset" from "has a
        // value" by presence in this record, because JSON has no `undefined`.
        if (value !== undefined) values[key] = value;
      }
      transport.sendToChild({
        jsonrpc: "2.0",
        method: HOST_PROTOCOL_NOTIFICATIONS.configSnapshot,
        params: { keys: configKeys, values },
      });
    }));
    /**
     * The allow-listed host preferences, read through the SAME member a plugin
     * would call — so the snapshot is the reader's answer, not a second one.
     *
     * `undefined` when this host implements no `getAppPreference`: the member
     * is optional on `PluginHostApi`, and a child seeded with an empty snapshot
     * could not tell "unset" from "unavailable". Not seeding at all keeps those
     * apart, because the child's member throws when nothing was seeded.
     *
     * NO HOST THE APP BUILDS TAKES THAT BRANCH — `host-api-factory.ts` always
     * defines the member — so it is the shape of a partial hostApi assembled in
     * a test, kept because the optional member and this reader are two objects
     * that nothing forces to agree.
     */
    const readAppPreferences = ():
      | { keys: readonly string[]; values: Record<string, unknown> }
      | undefined => {
      const read = hostApi.getAppPreference;
      if (typeof read !== "function") return undefined;
      const values: Record<string, unknown> = {};
      for (const key of HOST_PUBLIC_PREFERENCE_KEYS) {
        const value = read.call(hostApi, key);
        // Absent, not `undefined`: the wire distinguishes "unset" from "has a
        // value" by presence in this record, because JSON has no `undefined`.
        if (value !== undefined) values[key] = value;
      }
      return { keys: HOST_PUBLIC_PREFERENCE_KEYS, values };
    };

    /**
     * Send the child the preferences as they read RIGHT NOW.
     *
     * One function for the watcher below and for the post-construct push, so
     * the two cannot disagree about what a snapshot contains.
     */
    const pushPreferenceSnapshot = (): void => {
      const snapshot = readAppPreferences();
      // A host with no reader never seeded the child, so there is nothing this
      // push could correct. Unreachable for the same reason the branch above
      // is; it is here so the two stay one decision rather than two.
      if (!snapshot) return;
      transport.sendToChild({
        jsonrpc: "2.0",
        method: HOST_PROTOCOL_NOTIFICATIONS.preferencesSnapshot,
        params: { keys: snapshot.keys, values: snapshot.values },
      });
    };

    /**
     * The host re-pushes the preference snapshot the child answers
     * `getAppPreference` from — the third host-owned watcher, and the one that
     * makes the member answerable out of process at all.
     *
     * `getAppPreference` is synchronous, so §3.1 answers it from a snapshot,
     * and a snapshot with no re-push is the value the preference held at plugin
     * start. `lyra-mail` reads `webView.preferredFlow` at CALL time, so it would
     * have read a stale answer for the life of the process with nothing
     * reporting it. The bus announces only a REAL change to an allow-listed
     * key (`publishAppPreferenceChange` diffs before emitting), so an unrelated
     * settings save costs nothing here.
     */
    hostWatchers.push(subscribeAppPreferenceChange(pushPreferenceSnapshot));

    const constructionPreferences = readAppPreferences();
    const childContext: PluginChildContext = {
      pluginId,
      pluginRoot: context.pluginRoot,
      hostRoot: context.hostRoot,
      pluginDataDir: context.pluginDataDir,
      // From the context the HOST built, not re-read here. Re-reading would
      // work today — this line runs in main — but it would put a second
      // reader of the same two environment values on the spawn path, and the
      // two would only ever disagree in the case that matters.
      userHome: context.userHome,
      aveHome: context.aveHome,
      installedPluginIds: hostApi.getInstalledPluginIds(),
      ...(context.config !== undefined ? { config: context.config } : {}),
      // Omitted entirely when the host implements no reader, which is what lets
      // the child tell "unset" from "unavailable".
      ...(constructionPreferences ? { appPreferences: constructionPreferences } : {}),
    };
    const capabilities = hostProtocolCapabilities(spec.table);
    const constructParams: PluginConstructParams = {
      hostProtocol: { version: spec.hostProtocolVersion, capabilities },
      manifest: spec.manifest,
      context: childContext,
      entryPath: spec.entryPath,
      declaredToolNames: declaredToolNames(spec.manifest),
    };

    const construction = (await transport.request(
      PLUGIN_INSTANCE_METHODS.construct,
      constructParams as unknown as Record<string, unknown>,
      // The child performs BOTH halves of what the in-process path splits
      // between `importPluginFactory` and the factory call, so the import
      // bound is applied here and the outer factory bound covers the rest. A
      // child that hangs is killed by this deadline rather than left running
      // under a confinement nobody is watching.
      TOOL_TIMEOUT_POLICY.pluginImportMs + TOOL_TIMEOUT_POLICY.pluginFactoryMs,
    )) as PluginConstructResult;
    requireServedCapabilities(pluginId, construction, capabilities);

    /**
     * The seed above was read BEFORE the child could receive anything, so this
     * re-push closes the window between the two.
     *
     * A preferences snapshot sent while the child is still constructing is
     * DROPPED: the child routes notifications through a runtime it assigns only
     * after the plugin module has imported and its factory has run
     * (`plugin-child-main.ts`). The two watchers above survive that: neither
     * compares anything, so the next event either of them receives re-pushes
     * its whole snapshot and repairs the drop. Preferences do not work that
     * way — the bus announces only a MOVE, and the value that moved is already
     * the current one — so the child would answer `getAppPreference` with its
     * construction value until the preference moved AGAIN, which is exactly the
     * staleness this member was wired to end.
     *
     * Sending it here cannot be dropped in turn: the child assigns its runtime
     * before it writes the construct reply, this runs after that reply arrived,
     * and one pipe delivers both in order.
     */
    pushPreferenceSnapshot();

    const channel: PluginProtocolChannel = {
      requestMcp: (method, params, timeoutMs) => transport.requestMcp(method, params, timeoutMs),
      probe: (method, params) => transport.probe(method, params),
      runStopHook: async () => {
        if (!construction.lifecycleHooks.includes("stop")) return;
        await transport.request(
          PLUGIN_INSTANCE_METHODS.stop,
          {},
          // Bounded where the in-process call is not, which §3.1 names as an
          // improvement: today a plugin can hang shutdown forever.
          TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
        );
      },
      closeInput: () => {
        spec.link.output.end();
      },
      exited,
    };

    const handlers: Record<string, PluginToolHandler> = {};
    for (const toolName of construction.implementedToolNames) {
      handlers[toolName] = async (payload?: unknown) => {
        const result = await transport.requestMcp("tools/call", {
          name: toolName,
          // MCP's `tools/call` params are an OBJECT, so an absent payload
          // crosses as `{}` and the child's delegate turns it back into
          // "absent" — the same conversion the in-process delegate performs.
          // A payload that is neither absent nor an object cannot make that
          // round trip, and is refused rather than silently replaced by `{}`.
          arguments: asToolArguments(pluginId, toolName, payload),
        });
        return readToolResult(pluginId, toolName, result);
      };
    }

    const instance: RuntimePlugin = {
      handlers,
      /**
       * ALWAYS present, unlike the other two hooks.
       *
       * `stop` is the host's only hand on the child's lifetime: the lifecycle
       * calls `instance.stop?.()` when it retires a generation, and if the
       * proxy omitted it for a plugin that implements no `stop()` the child
       * would outlive the incarnation it serves. So the plugin's own hook is
       * optional and the teardown is not.
       */
      stop: async () => {
        stopHostWatchers();
        try {
          await channel.runStopHook();
        } finally {
          // Torn down AFTER the hook, not before. The in-process lifecycle
          // deactivates the incarnation once `stop()` has returned, so a
          // plugin's stop hook can still reach hostApi — tearing down first
          // would refuse the very last thing a plugin does (flush a file, log a
          // shutdown line) and would do it silently, as a `plugin-inactive`
          // rejection on a `void` member the plugin never awaits.
          await teardown(`[out-of-process-plugin] ${pluginId}: stopped`);
        }
      },
    };
    if (construction.lifecycleHooks.includes("start")) {
      instance.start = async () => {
        await transport.request(PLUGIN_INSTANCE_METHODS.start, {});
      };
    }
    if (construction.lifecycleHooks.includes("onPublished")) {
      instance.onPublished = async () => {
        await transport.request(PLUGIN_INSTANCE_METHODS.onPublished, {});
      };
    }
    if (construction.servesUiResources) {
      // MCP `resources/read`, which the child's server answers with the
      // card's HTML — the same verb a plugin in any language serves its card
      // with. The host's own provider still applies the manifest's policy to
      // what comes back; this is only the content.
      instance.readUiResource = async (uri: string) =>
        readUiResourceHtml(pluginId, uri, await transport.requestMcp("resources/read", { uri }));
    }
    // A construction that raced an abort is torn down, never returned.
    if (signal?.aborted) throw signal.reason;
    return { instance, capabilities, construction, channel, teardown };
  } catch (error) {
    // Named for the whole bring-up rather than for `construct`: a throw from
    // any of the steps above leaves the same three things owned — the child,
    // the open transport, and the watchers registered so far — and one
    // teardown for all of them is what keeps a failed start from turning into
    // an orphaned process no ledger knows about. Not awaited: the owner's
    // `onClosed` waits for the process, and the failure is the caller's to
    // see now.
    teardown(`[out-of-process-plugin] ${pluginId}: startup failed`).catch(reportClosedFailure);
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}
