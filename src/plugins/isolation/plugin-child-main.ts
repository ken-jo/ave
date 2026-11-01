/** Child entry: stdout belongs exclusively to framed protocol traffic; diagnostics go to stderr. */
import { PassThrough, Writable } from "node:stream";
import { Console } from "node:console";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importPluginFactory } from "../runtime/plugin-loader.js";
import { frameMessage } from "../../mcp/stdio-framing.js";
import {
  startPluginChildRuntime,
  type PluginChildRuntime,
} from "./plugin-child-runtime.js";
import {
  classifyMultiplexedMessage,
  FramedMessageStream,
  PendingCallTable,
  type MultiplexedMessage,
} from "./child-stream-multiplex.js";
import {
  PLUGIN_INSTANCE_METHODS,
  type PluginConstructParams,
  type PluginConstructResult,
  type PluginLifecycleHookName,
  type PluginShutdownParams,
} from "./plugin-instance-wire.js";
import {
  HOST_PROTOCOL_NOTIFICATIONS,
  HOST_PROTOCOL_VERSIONS_SERVED,
  HostApiBoundaryError,
  isServedHostProtocolVersion,
  type HostApiChannel,
  type HostApiNotification,
  type HostApiReply,
} from "./host-api-wire.js";
import {
  RPC_METHOD_NOT_FOUND,
  RPC_INTERNAL_ERROR,
} from "../../mcp/protocol-constants.js";
import { errorMessage } from "../../shared/error-message.js";
import {
  acceptHostOverLoopback,
  parseChildLaunchArgs,
  serveStdioRelay,
  type ChildLaunchMode,
} from "./child-loopback-link.js";

export interface PluginChildService {
  /** On pipe closure release registrations and settle all pending calls. */
  hostGone(): void;
}

/** Redirect nonprotocol stdout and return the framer-only stream. */
function claimProtocolStdout(): Writable {
  const rawWrite = process.stdout.write.bind(process.stdout);
  const divert = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === "function" ? encoding : callback;
    process.stderr.write(chunk as string | Uint8Array);
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  process.stdout.write = divert as typeof process.stdout.write;
  // Rebuild console on stderr because it captured the original stdout reference.
  globalThis.console = new Console(process.stderr, process.stderr);
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      rawWrite(chunk, callback);
    },
  });
}

function describeLifecycleHooks(instance: PluginChildRuntime["instance"]): PluginLifecycleHookName[] {
  const hooks: PluginLifecycleHookName[] = [];
  if (typeof instance.start === "function") hooks.push("start");
  if (typeof instance.onPublished === "function") hooks.push("onPublished");
  if (typeof instance.stop === "function") hooks.push("stop");
  return hooks;
}

/** Inject streams to exercise the same child runtime without subprocess setup. */
export function servePluginChild(
  input: NodeJS.ReadableStream,
  output: Writable,
): PluginChildService {
  let runtime: PluginChildRuntime | undefined;
  let constructedPluginId: string | undefined;
  const hostApiReplies = new PendingCallTable<HostApiReply>();
  // Each direction owns its request-ID space; match replies only within that direction.
  let nextRequestId = 0;
  // Forward whole MCP frames through the shared size guard without decoding them again.
  const mcpOut = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stream.forward(chunk);
      callback();
    },
  });
  // Forward only MCP requests to the server; lifecycle and reverse-host traffic use separate handlers.
  const mcpIn = new PassThrough();

  const stream = new FramedMessageStream(
    input as never,
    output,
    (message) => route(message),
    (reason) => {
      // A framing failure destroys input and triggers the same exit path as host loss.
      process.stderr.write(`[plugin-child] ${reason}; ending\n`);
      (input as NodeJS.ReadableStream & { destroy(): void }).destroy();
    },
    (dropped) => {
      // Log drops to stderr because the dropped frame may itself be a log notification.
      process.stderr.write(
        `[plugin-child] dropped a notification too large to frame ${JSON.stringify({
          pluginId: constructedPluginId,
          ...dropped,
        })}\n`,
      );
    },
  );

  const channel: HostApiChannel = {
    call(method, params, onSent): Promise<HostApiReply> {
      nextRequestId += 1;
      const id = nextRequestId;
      // No host-call deadline while human approval is pending; host loss rejects the call.
      const settled = hostApiReplies.register(String(id), undefined, () => undefined);
      try {
        onSent?.(id);
        stream.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        // An unwritten oversized request will never receive a reply.
        hostApiReplies.fail(String(id), error as Error);
      }
      return settled;
    },
    notify(notification: HostApiNotification): void {
      stream.send(notification);
    },
  };

  function reply(id: unknown, result: unknown): void {
    stream.send({ jsonrpc: "2.0", id, result });
  }

  function replyError(id: unknown, code: number, message: string, data?: unknown): void {
    stream.send({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  async function construct(
    params: PluginConstructParams,
  ): Promise<PluginConstructResult> {
    if (runtime) throw new Error("[plugin-child] already constructed");
    // A stale child bundle must refuse protocol mismatch rather than claim unsupported behavior.
    const version = params.hostProtocol?.version;
    if (!isServedHostProtocolVersion(version)) {
      throw new HostApiBoundaryError(
        "protocol-version-mismatch",
        `[plugin-child] host protocol ${String(version)} is not one this runtime serves `
          + `(${HOST_PROTOCOL_VERSIONS_SERVED.join(", ")})`,
        { version: String(version), served: [...HOST_PROTOCOL_VERSIONS_SERVED] },
      );
    }
    const capabilities: unknown = params.hostProtocol.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.every((entry) => typeof entry === "string")) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        "[plugin-child] construct: hostProtocol.capabilities must be an array of method names",
      );
    }
    constructedPluginId = params.context.pluginId;
    runtime = await startPluginChildRuntime({
      input: mcpIn,
      output: mcpOut,
      manifest: params.manifest,
      context: params.context,
      channel,
      loadFactory: () => importPluginFactory(params.entryPath),
    });
    const { instance } = runtime;
    return {
      // Intersect actual handlers with host-declared tool names; the child cannot announce extra tools.
      implementedToolNames: params.declaredToolNames.filter(
        (name) => typeof instance.handlers[name] === "function",
      ),
      servesUiResources: runtime.servesUiResources,
      lifecycleHooks: describeLifecycleHooks(instance),
      // JavaScript plugins report no hard optional-method requirements; missing calls refuse individually.
      pluginProtocol: { requires: [] },
    };
  }

  async function invokeInstanceMethod(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (method === PLUGIN_INSTANCE_METHODS.construct) {
      return await construct(params as unknown as PluginConstructParams);
    }
    if (!runtime) throw new Error(`[plugin-child] '${method}' before construct`);
    const { instance } = runtime;
    switch (method) {
      case PLUGIN_INSTANCE_METHODS.start:
        await instance.start?.();
        return null;
      case PLUGIN_INSTANCE_METHODS.onPublished:
        await instance.onPublished?.();
        return null;
      case PLUGIN_INSTANCE_METHODS.stop:
        await instance.stop?.();
        return null;
      case PLUGIN_INSTANCE_METHODS.shutdown: {
        const subscriptionId = (params as unknown as PluginShutdownParams | undefined)?.subscriptionId;
        if (typeof subscriptionId !== "string") {
          throw new Error("[plugin-child] shutdown requires a string 'subscriptionId'");
        }
        await runtime.runShutdownHandler(subscriptionId);
        return null;
      }
      default:
        throw new Error(`[plugin-child] unknown instance method '${method}'`);
    }
  }

  function route(message: MultiplexedMessage): void {
    switch (classifyMultiplexedMessage(message)) {
      case "instance-request": {
        const { id } = message;
        if (id === undefined) return;
        void invokeInstanceMethod(
          message.method as string,
          message.params as Record<string, unknown> | undefined,
        ).then(
          (result) => reply(id, result),
          (error: unknown) =>
            replyError(
              id,
              RPC_INTERNAL_ERROR,
              errorMessage(error),
              // Preserve boundary refusal codes so protocol mismatch remains distinct from plugin construction failure.
              error instanceof HostApiBoundaryError
                ? { code: error.code, name: error.name, ...(error.detail ? { detail: error.detail } : {}) }
                : undefined,
            ),
        );
        return;
      }
      case "mcp-request": {
        if (!runtime) {
          // Refuse preconstruct calls instead of serving an instance the host has not acknowledged.
          if (message.id !== undefined) {
            replyError(
              message.id,
              RPC_METHOD_NOT_FOUND,
              "[plugin-child] the plugin is not constructed yet",
            );
          }
          return;
        }
        mcpIn.write(frameMessage(message));
        return;
      }
      case "response":
        // Only reverse-host replies can settle this direction pending table.
        hostApiReplies.settle(String(message.id), message as unknown as HostApiReply);
        return;
      case "notification":
        // Drop cancellation for request kinds this side does not own.
        if (message.method === HOST_PROTOCOL_NOTIFICATIONS.cancelled) return;
        runtime?.deliver(message as unknown as HostApiNotification);
        return;
      case "host-request":
        // The child never serves hostApi requests; there must be no second reverse-channel implementation.
        replyError(
          message.id,
          RPC_METHOD_NOT_FOUND,
          "[plugin-child] not a hostApi server",
        );
        return;
      default:
        return;
    }
  }

  stream.start();

  return {
    hostGone(): void {
      hostApiReplies.rejectAll("[plugin-child] the host is gone");
      runtime?.hostGone();
    },
  };
}

/** Compare real entry paths so symlinks and alternate platform spellings do not change entrypoint detection. */
function isProcessEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
}

/** The stdio child exits when host pipes close. */
function serveOverStdio(): void {
  const service = servePluginChild(process.stdin, claimProtocolStdout());
  const end = (): void => {
    service.hostGone();
    // Host pipe closure must end the child; no plugin process may remain unwatched.
    process.exit(0);
  };
  process.stdin.on("end", end);
  process.stdin.on("close", end);
}

/** Apply the intended Windows environment, authenticate loopback, and fail nonzero before connection on errors. */
function serveOverLoopback(env: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  const announce = (line: string): void => {
    process.stdout.write(line);
  };
  acceptHostOverLoopback({ announce, acceptTimeoutMs: 60_000, handshakeTimeoutMs: 10_000 }).then(
    (socket) => {
      // Keep stray stdout diagnostic-only even when the protocol uses a socket.
      claimProtocolStdout();
      const service = servePluginChild(socket, socket);
      const end = (): void => {
        service.hostGone();
        process.exit(0);
      };
      socket.on("end", end);
      socket.on("close", end);
      socket.on("error", (error) => {
        process.stderr.write(`[plugin-child] channel error: ${error.message}\n`);
        end();
      });
      socket.resume();
    },
    (error: unknown) => {
      process.stderr.write(`[plugin-child] ${errorMessage(error)}; ending\n`);
      process.exit(1);
    },
  );
}

/** The relay loads no plugin; it runs the authenticated program and maps channel EOF to stdin closure. */
function serveAsRelay(): void {
  serveStdioRelay({
    announce: (line) => {
      process.stdout.write(line);
    },
    acceptTimeoutMs: 60_000,
    handshakeTimeoutMs: 10_000,
    relayEnv: process.env,
    diagnostics: process.stderr,
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`[plugin-child] relay: ${errorMessage(error)}; ending\n`);
      process.exit(1);
    },
  );
}

/** Guard the process entry so test imports cannot take over stdio. */
if (isProcessEntryModule()) {
  let mode: ChildLaunchMode;
  try {
    mode = parseChildLaunchArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[plugin-child] ${errorMessage(error)}; ending\n`);
    process.exit(1);
  }
  if (mode.transport === "loopback") serveOverLoopback(mode.env);
  else if (mode.transport === "relay") serveAsRelay();
  else serveOverStdio();
}
