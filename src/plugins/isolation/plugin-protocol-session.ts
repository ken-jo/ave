// Own construction, snapshots and exactly-once session release between a child link and lifecycle callers.
// Stop is nondestructive; teardown terminates only a still-live child.
import { createLogger } from "../../lib/logger.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { RAW_RESULT_META } from "../../mcp/protocol-constants.js";
import { errorMessage } from "../../shared/error-message.js";
// Read the declared preference allowlist directly so security policy has one source.
import { HOST_PUBLIC_PREFERENCE_KEYS } from "../../boot/steps/plugin-runtime/app-preference.js";
import { subscribeAppPreferenceChange } from "../config-change-bus.js";
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  PluginToolHandler,
  RuntimePlugin,
} from "../types.js";
import { hostProtocolCapabilities, type UnknownFieldReport } from "./host-api-dispatcher.js";
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

/** Read synchronous host members through snapshots; an absent optional preference reader must stay distinguishable. */
type SessionHostApi = DispatchableHostApi &
  Pick<PluginHostApi, "getInstalledPluginIds"> &
  Pick<PluginHostApi, "getAppPreference">;

export interface PluginProtocolSessionSpec {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly hostProtocolVersion: HostProtocolVersion;
  readonly link: ChildLink;
  readonly context: PluginRuntimeContext;
  /** Construct names the resolved plugin module or process executable, never the child runtime entry. */
  readonly entryPath: string;
  /** The bound table is the whole authority; derive advertised methods from it without defaults. */
  readonly table: BoundHostApiDispatchTable;
  readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** Observe each undeclared params field after it is logged; it cannot alter the dispatcher's result. */
  readonly onUnknownField?: (report: UnknownFieldReport & { readonly pluginId: string }) => void;
  /** Run owner cleanup once after either teardown or natural child exit. */
  readonly onClosed: (reason: string) => Promise<void>;
  /** Observe abort from the first setup step through release, including construct. */
  readonly signal?: AbortSignal;
}

export interface PluginProtocolChannel {
  requestMcp(
    method: PluginMcpRequestMethod,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  probe(method: string, params?: Record<string, unknown>): Promise<PluginChildProbeReply>;
  /** Stop invokes the optional hook without closing the channel or terminating. */
  runStopHook(): Promise<void>;
  /** End only stdin to simulate host loss. */
  closeInput(): void;
  /** Only observed terminal exit settles exited; timeout, fault and close do not. */
  readonly exited: Promise<string>;
}

export interface PluginProtocolSession {
  readonly instance: RuntimePlugin;
  readonly capabilities: readonly string[];
  readonly construction: PluginConstructResult;
  readonly channel: PluginProtocolChannel;
  /** Teardown ends calls and watchers and terminates at most once; natural exit requires no signal. */
  teardown(reason: string): Promise<void>;
}

/** Snapshot keys cover schema defaults, manifest config and saved overrides. */
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

/** Derive tools from the manifest so a compromised child cannot announce undeclared names. */
function declaredToolNames(manifest: PluginManifest): string[] {
  return [...new Set((manifest.tools ?? []).map((tool) => tool.name))];
}

/** Accept only absent or object tool payloads; do not coerce invalid input into empty arguments. */
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

/** Read RAW_RESULT_META so structured objects stay distinct from JSON-looking text. */
function readToolResult(pluginId: string, toolName: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    throw new Error(
      `[out-of-process-plugin] ${pluginId}: tool '${toolName}' returned no result body`,
    );
  }
  const body = result as { isError?: boolean; content?: unknown; _meta?: Record<string, unknown> };
  if (body.isError === true) {
    // Throw isError results using the surviving message without reconstructing classes by text.
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

/** Refuse construct requirements not advertised by this connection; malformed requires is not an empty list. */
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

function readUiResourceHtml(pluginId: string, uri: string, result: unknown): string {
  const contents = (result as { contents?: unknown } | undefined)?.contents;
  const first = Array.isArray(contents) ? (contents[0] as { text?: unknown } | undefined) : undefined;
  if (typeof first?.text !== "string") {
    throw new Error(`[out-of-process-plugin] ${pluginId}: resources/read('${uri}') returned no html`);
  }
  return first.text;
}

function abortReasonText(signal: AbortSignal): string {
  return errorMessage(signal.reason);
}

/** Construction failure or abort must release the session; abort rejects with its own reason. */
export async function openPluginProtocolSession(
  spec: PluginProtocolSessionSpec,
): Promise<PluginProtocolSession> {
  const { pluginId, context, signal } = spec;
  // The connection is the incarnation; generation identity never crosses as caller input.
  const hostApi = context.hostApi as unknown as SessionHostApi;

  let live = true;
  const transport = new PluginChildTransport({
    pluginId,
    // Wire liveness mirrors the authoritative HostApi guard; it does not create a second authority.
    isActive: () => live,
    // Forward child diagnostics with the same searchable message shape as host plugin logs.
    log: (message, meta) => {
      if (meta !== undefined) {
        log.info({ pluginId, meta }, message);
        return;
      }
      log.info({ pluginId }, message);
    },
    // Report undeclared params once per method and field to reveal protocol skew.
    reportUnknownField: (report) => {
      try {
        spec.onUnknownField?.({ ...report, pluginId });
      } catch { /* an observer failure cannot alter a dispatcher result */ }
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
    // Serve and advertise the same bound table.
    table: spec.table,
    link: spec.link,
  });

  /** Own all watcher disposers together so any bring-up failure can release them. */
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
  /** Release watchers and owner cleanup exactly once, regardless of exit or teardown ordering. */
  const release = (reason: string): Promise<void> => {
    live = false;
    stopHostWatchers();
    signal?.removeEventListener("abort", onAbort);
    if (closed !== undefined) return closed;
    // Mark released before owner cleanup can synchronously reenter teardown.
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
    // Drop invocation retention even if watcher cleanup fails.
    try {
      transport.close(reason);
    } finally {
      await release(reason);
    }
  };
  // Natural exit releases the session without terminating an already-gone child.
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
    // Push installed-plugin snapshots even if the plugin never subscribes to changes.
    hostWatchers.push(hostApi.onPluginsChanged(() => {
      transport.sendToChild({
        jsonrpc: "2.0",
        method: HOST_PROTOCOL_NOTIFICATIONS.installedPluginsSnapshot,
        params: { pluginIds: hostApi.getInstalledPluginIds() },
      });
    }));

    /** Push config by rereading the authoritative host member rather than reconstructing state from events. */
    const configKeys = resolvableConfigKeys(spec.manifest, context.config);
    hostWatchers.push(hostApi.config.onChange("*", () => {
      const values: Record<string, unknown> = {};
      for (const key of configKeys) {
        const value = hostApi.config.get(key);
        // Omit unset values; JSON cannot carry undefined.
        if (value !== undefined) values[key] = value;
      }
      transport.sendToChild({
        jsonrpc: "2.0",
        method: HOST_PROTOCOL_NOTIFICATIONS.configSnapshot,
        params: { keys: configKeys, values },
      });
    }));
    /** Read preference snapshots through the actual optional host reader so absence and unset stay distinct. */
    const readAppPreferences = ():
      | { keys: readonly string[]; values: Record<string, unknown> }
      | undefined => {
      const read = hostApi.getAppPreference;
      if (typeof read !== "function") return undefined;
      const values: Record<string, unknown> = {};
      for (const key of HOST_PUBLIC_PREFERENCE_KEYS) {
        const value = read.call(hostApi, key);
        // Omit unset values; JSON cannot carry undefined.
        if (value !== undefined) values[key] = value;
      }
      return { keys: HOST_PUBLIC_PREFERENCE_KEYS, values };
    };

    /** Use the same current-value push for watchers and postconstruct refresh. */
    const pushPreferenceSnapshot = (): void => {
      const snapshot = readAppPreferences();
      // Do not push to a child whose host has no preference reader.
      if (!snapshot) return;
      transport.sendToChild({
        jsonrpc: "2.0",
        method: HOST_PROTOCOL_NOTIFICATIONS.preferencesSnapshot,
        params: { keys: snapshot.keys, values: snapshot.values },
      });
    };

    /** Preference events only announce changed allowlisted values; reread and repush the snapshot. */
    hostWatchers.push(subscribeAppPreferenceChange(pushPreferenceSnapshot));

    const constructionPreferences = readAppPreferences();
    const childContext: PluginChildContext = {
      pluginId,
      pluginRoot: context.pluginRoot,
      hostRoot: context.hostRoot,
      pluginDataDir: context.pluginDataDir,
      // Carry paths from the host-built context rather than rereading a potentially different spawn-time value.
      userHome: context.userHome,
      aveHome: context.aveHome,
      installedPluginIds: hostApi.getInstalledPluginIds(),
      ...(context.config !== undefined ? { config: context.config } : {}),
      // Omit the snapshot entirely when no reader exists so unavailable differs from unset.
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
      // Bound import and factory construction together; terminate rather than abandon a timed-out child.
      TOOL_TIMEOUT_POLICY.pluginImportMs + TOOL_TIMEOUT_POLICY.pluginFactoryMs,
    )) as PluginConstructResult;
    requireServedCapabilities(pluginId, construction, capabilities);

    /** Repush after construct to close the window where notifications arrived before the child runtime existed. */
    pushPreferenceSnapshot();

    const channel: PluginProtocolChannel = {
      requestMcp: (method, params, timeoutMs) => transport.requestMcp(method, params, timeoutMs),
      probe: (method, params) => transport.probe(method, params),
      runStopHook: async () => {
        if (!construction.lifecycleHooks.includes("stop")) return;
        await transport.request(
          PLUGIN_INSTANCE_METHODS.stop,
          {},
          // Bound child shutdown handlers so they cannot hang host shutdown forever.
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
          // Only absent payload becomes an empty MCP arguments object; reject nonobjects.
          arguments: asToolArguments(pluginId, toolName, payload),
        });
        return readToolResult(pluginId, toolName, result);
      };
    }

    const instance: RuntimePlugin = {
      handlers,
      /** Always expose stop as the host lifetime control, even without a plugin stop hook. */
      stop: async () => {
        try {
          stopHostWatchers();
          await channel.runStopHook();
        } finally {
          // Run the stop hook before teardown so its final host writes remain authorized.
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
      // Read card content through MCP; manifest policy remains the host provider responsibility.
      instance.readUiResource = async (uri: string) =>
        readUiResourceHtml(pluginId, uri, await transport.requestMcp("resources/read", { uri }));
    }
    // Abort racing construction must tear down the result instead of return it.
    if (signal?.aborted) throw signal.reason;
    return { instance, capabilities, construction, channel, teardown };
  } catch (error) {
    // Any bring-up failure releases child, transport and watchers without delaying the original refusal.
    teardown(`[out-of-process-plugin] ${pluginId}: startup failed`).catch(reportClosedFailure);
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}
