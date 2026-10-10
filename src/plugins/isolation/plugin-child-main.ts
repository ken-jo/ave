/**
 * The entrypoint of a confined plugin child process
 * (`docs/blueprints/plugin-process-isolation.md` §5.2).
 *
 * This module IS the child's `main`. It is spawned by
 * `out-of-process-plugin.ts` through the ASRT wrapper, speaks the multiplexed
 * framed protocol on stdin/stdout, and hands everything above the transport to
 * `startPluginChildRuntime`.
 *
 * ELECTRON-FREE, and enforced by the import graph rather than promised: every
 * module reachable from here is free of `electron`, which is why
 * `buildImportUrl` had to move out of `runtime/sandbox.ts` (that file reaches
 * `electron`'s `safeStorage` through `plugins/storage.ts`) and into
 * `runtime/plugin-loader.ts`. The child therefore obtains its factory from the
 * SAME `importPluginFactory` the in-process loader uses — not a second copy of
 * it that could pick a different export.
 *
 * STDOUT IS THE PROTOCOL. A plugin that calls `console.log` or writes to
 * `process.stdout` directly would interleave stray bytes into the stream — a
 * failure that looks like a corrupt plugin rather than a stray log line,
 * because the decoder drops a line it cannot parse, and a write without its own
 * newline joins the next frame's line and takes that frame with it. Before any plugin
 * code can run, stdout is taken away from it: the real write is captured
 * privately for the framer and everything else is rebound to stderr, which the
 * host pipes and reads as diagnostics.
 */
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
  type ChildLaunchMode,
} from "./child-loopback-link.js";

/** What {@link servePluginChild} hands back so a caller can end it. */
export interface PluginChildService {
  /** The host's pipes closed: release both sides and settle everything pending. */
  hostGone(): void;
}

/**
 * Take stdout away from everything except the framer, and return the stream the
 * protocol writes to.
 */
function claimProtocolStdout(): Writable {
  const rawWrite = process.stdout.write.bind(process.stdout);
  const divert = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === "function" ? encoding : callback;
    process.stderr.write(chunk as string | Uint8Array);
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  process.stdout.write = divert as typeof process.stdout.write;
  // `console.log` captured `process.stdout` when `node:console` was first
  // loaded, so rebinding the method alone leaves it writing to the old
  // reference. The global console is rebuilt onto stderr instead.
  globalThis.console = new Console(process.stderr, process.stderr);
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      rawWrite(chunk);
      callback();
    },
  });
}

/** Which optional lifecycle hooks an instance actually implements. */
function describeLifecycleHooks(instance: PluginChildRuntime["instance"]): PluginLifecycleHookName[] {
  const hooks: PluginLifecycleHookName[] = [];
  if (typeof instance.start === "function") hooks.push("start");
  if (typeof instance.onPublished === "function") hooks.push("onPublished");
  if (typeof instance.stop === "function") hooks.push("stop");
  return hooks;
}

/**
 * Serve one plugin over the given streams.
 *
 * Exported and stream-injected so the whole child can be driven over in-memory
 * paired streams, exactly as `stdio-server-loop`'s own tests drive the serving
 * core — spawning a subprocess to assert a routing decision would make the
 * cheapest tests the slowest ones. The production entry below supplies the real
 * pipes.
 */
export function servePluginChild(
  input: NodeJS.ReadableStream,
  output: Writable,
): PluginChildService {
  let runtime: PluginChildRuntime | undefined;
  // Named in this child's own diagnostics once construct has told it.
  let constructedPluginId: string | undefined;
  const hostApiReplies = new PendingCallTable<HostApiReply>();
  // This direction's own id space: the host allocates the ids of the requests
  // it sends, and a response is matched against the table of the direction it
  // arrived on, so the two can never be confused.
  let nextRequestId = 0;
  // The MCP server writes whole frames into this and they are forwarded
  // as they are — nothing re-decodes them, so a forwarded chunk is always
  // exactly one frame and can never split around another writer's. They go
  // through the stream's own writer so a tool result too large to frame is
  // refused for its call instead of ending the channel at the host's reader.
  const mcpOut = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stream.forward(chunk);
      callback();
    },
  });
  // What `StdioServerLoop` reads. Only MCP requests are written into it: the
  // five lifecycle methods and the entire hostApi direction never reach it.
  const mcpIn = new PassThrough();

  const stream = new FramedMessageStream(
    input as never,
    output,
    (message) => route(message),
    (reason) => {
      // A host that broke the framing is a host this child can no longer
      // serve. Destroying stdin is what the process entry already treats as
      // the host being gone, so the child exits the one way it always does.
      process.stderr.write(`[plugin-child] ${reason}; ending\n`);
      (input as NodeJS.ReadableStream & { destroy(): void }).destroy();
    },
    (dropped) => {
      // Stderr, which the host already collects for this child: the dropped
      // notification may itself be the `context.log` line that would have
      // carried this.
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
      // No deadline: a hostApi call may legitimately block on a human at the
      // approval gate (§7.5). It rejects when the host is gone, which is the
      // condition a deadline here would only be standing in for.
      const settled = hostApiReplies.register(String(id), undefined, () => undefined);
      onSent?.(id);
      try {
        stream.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        // Refused before it was written (a request too large to frame), so no
        // reply will ever come for it.
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
    // The reference runtime ships with the host, so the two served sets are
    // equal by construction. The check exists so a stale bundle fails loudly
    // instead of answering a version it does not speak.
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
      // Filtered from the HOST's declared set rather than enumerated from the
      // instance: a child cannot announce a tool its manifest never declared,
      // which is the same set `buildMethodMap` derives in-process.
      implementedToolNames: params.declaredToolNames.filter(
        (name) => typeof instance.handlers[name] === "function",
      ),
      servesUiResources: runtime.servesUiResources,
      lifecycleHooks: describeLifecycleHooks(instance),
      // Nothing, for a JavaScript plugin: an optional member it lacks answers
      // `path-not-implemented` at the call, which is what it gets in-process
      // from `typeof hostApi.hostFetch !== "function"` — there is no
      // declaration for this runtime to report. A plugin that speaks the
      // protocol itself names its hard needs here.
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
              // A coded boundary refusal keeps its code, so the host can tell
              // "this runtime does not speak that version" from a plugin that
              // threw while constructing.
              error instanceof HostApiBoundaryError
                ? { code: error.code, name: error.name, ...(error.detail ? { detail: error.detail } : {}) }
                : undefined,
            ),
        );
        return;
      }
      case "mcp-request": {
        if (!runtime) {
          // Refused rather than queued: a queued call would be answered by an
          // instance the host had not yet been told exists.
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
        // Only the child's own `ave/host/*` requests are answered on this
        // direction, so this is the one table a response can settle.
        hostApiReplies.settle(String(message.id), message as unknown as HostApiReply);
        return;
      case "notification":
        // A `notifications/cancelled` arriving here would name a `tools/call`;
        // the host sends none today, so it is dropped like any frame naming a
        // request this side does not hold (§3.5).
        if (message.method === HOST_PROTOCOL_NOTIFICATIONS.cancelled) return;
        runtime?.deliver(message as unknown as HostApiNotification);
        return;
      case "host-request":
        // The child never services hostApi calls. A host that sent one is
        // confused, and answering would put a second implementation of the
        // reverse channel in the least trustworthy process.
        replyError(
          message.id,
          RPC_METHOD_NOT_FOUND,
          "[plugin-child] not a hostApi server",
        );
        return;
      default:
        // Dropped. A frame matching no shape is not guessed at.
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

/**
 * Whether this module is what the process was launched to run.
 *
 * Compared as REAL paths on both sides: Node resolves symlinks when it derives
 * `import.meta.url` for the main module, so comparing it against a raw
 * `process.argv[1]` would answer "no" for a correct launch through any
 * symlinked directory — `/tmp` on macOS being the one every developer hits.
 * Both sides go through `realpathSync.native` rather than one: under
 * `--preserve-symlinks-main` (the Windows sandboxed launch) Node does NOT
 * resolve the main module's URL, and the native call works through a handle
 * where the JavaScript one would `lstat` every ancestor directory.
 */
function isProcessEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
}

/**
 * The stdio child: real pipes, and exit when the host closes them. Every
 * platform except a sandboxed Windows launch.
 */
function serveOverStdio(): void {
  const service = servePluginChild(process.stdin, claimProtocolStdout());
  const end = (): void => {
    service.hostGone();
    // The host owns this process's lifetime. Once its pipes are closed there is
    // no one left to serve, and a child that lingered would be a confined
    // process running plugin code nothing is watching.
    process.exit(0);
  };
  process.stdin.on("end", end);
  process.stdin.on("close", end);
}

/**
 * The sandboxed Windows child (`child-loopback-link.ts`): apply the
 * environment the host intended, announce a loopback listener on stdout, and
 * serve the one connection that presents the nonce. stdin is not read at all —
 * srt-win relays none, and its end must not be taken for the host leaving.
 * Any failure before the connection exists ends the process non-zero.
 */
function serveOverLoopback(env: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  const announce = (line: string): void => {
    process.stdout.write(line);
  };
  acceptHostOverLoopback({ announce, acceptTimeoutMs: 60_000, handshakeTimeoutMs: 10_000 }).then(
    (socket) => {
      // Stray output still has to land somewhere the host only logs: stdout is
      // no longer the protocol, but a plugin's `console.log` is still not one.
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

/**
 * The production entry. Guarded so importing this file from a test does not
 * hijack the test runner's stdio.
 */
if (isProcessEntryModule()) {
  let mode: ChildLaunchMode;
  try {
    mode = parseChildLaunchArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[plugin-child] ${errorMessage(error)}; ending\n`);
    process.exit(1);
  }
  if (mode.transport === "loopback") serveOverLoopback(mode.env);
  else serveOverStdio();
}
