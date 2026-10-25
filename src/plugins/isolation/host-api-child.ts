/** Child HostApi stubs own marshalling and local handles; imports must remain free of host state. */
import { canEmitEvent } from "../capabilities.js";
import { getDeclaredEmittedEvents } from "../runtime/manifest-validation.js";
import { resolvePluginStoragePath } from "../plugin-storage-containment.js";
import { resolvePluginHostStorageDir } from "../plugin-storage-layout.js";
import type {
  AuthPartitionCookie,
  PluginManifest,
  PluginWorkerSpec,
  SpawnedPluginWorker,
  AudioCaptureDevice,
  AudioCaptureEnd,
  AudioCaptureFrame,
  AttachFloatingPanelRequest,
  AudioCaptureHandle,
  DetachReason,
  FloatingPanelHandle,
  AudioCaptureRequest,
  WorkProposalResult,
  AlertResult,
} from "../public-contract.js";
import type { HostApiCaller, PluginChildContext } from "./plugin-child-runtime.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  HostApiBoundaryError,
  INTERACTION_HOSTAPI_PATHS,
  SECRET_REDACTED_SENTINEL,
  STORAGE_HOSTAPI_PATHS,
  asWireWorkerEvent,
  decodeConfigChange,
  decodeHostEvent,
  decodePluginLifecycle,
  decodeWireBinary,
  decodeWireHttpResponse,
  encodeWireBytes,
  encodeHostFetchInit,
  type ConfigSubscriptionPath,
  type HostApiHandle,
  type HostApiPath,
  type InteractionHostApiPath,
  type ServiceHostApiPath,
  type StorageHostApiPath,
  type WireApiKeyLease,
  type WireCallLlmOptions,
  type WireResolveApiKeyOptions,
  type WireWorkerHandle,
  workerSubscriptionIdOfRequest,
  asWireAudioCaptureEvent,
  asWireFloatingPanelEvent,
  type WireFloatingPanelHandle,
  type WireAudioCaptureHandle,
} from "./host-api-wire.js";
import { errorMessage } from "../../shared/error-message.js";

const WORKER_PRE_LISTENER_EVENT_MAX = 256;
const WORKER_PRE_LISTENER_BYTES_MAX = 1024 * 1024;

export type ChildHostApiMember = (...args: unknown[]) => unknown;

/** Fail stub construction if a plain relay contract gains an encoded axis. */
function assertRelayable(path: HostApiPath): void {
  const contract = HOSTAPI_PATH_CONTRACTS[path];
  if (
    contract.arguments !== "plain-json"
    || (contract.result !== "plain-json" && contract.result !== "void")
    || contract.lifetime !== "none"
  ) {
    throw new Error(
      `[host-api-child] '${path}' no longer crosses as plain JSON `
        + `(arguments=${contract.arguments} result=${contract.result} `
        + `lifetime=${contract.lifetime}) — it needs a stub of its own`,
    );
  }
}

/** Route every stub through the shared caller so method and params encoding has one implementation. */
export function createInteractionChildMembers(
  call: HostApiCaller,
): Record<InteractionHostApiPath, (...args: unknown[]) => Promise<unknown>> {
  const members = {} as Record<
    InteractionHostApiPath,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (const path of INTERACTION_HOSTAPI_PATHS) {
    assertRelayable(path);
    members[path] = (...args: unknown[]) => call(path, args);
  }
  return members;
}

/** The runtime owns ledgers; inject them so this module owns only marshalling. */
export interface ServiceChildMemberDeps {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** Abort signals cancel requests and never cross the wire. */
  readonly call: HostApiCaller;
  /** Adopt host-allocated handle IDs; disposing closes both registrations. */
  readonly adoptSubscription: (
    path: HostApiPath,
    subscriptionId: string,
    handler: (payload: unknown) => void,
    /** Host revocation must also clear state held in member closures. */
    onRevoked?: (reason: "revoked" | "peer-gone") => void,
  ) => () => void;
  /** Report asynchronous void-member refusals without unhandled rejections. */
  readonly report: (message: string, meta?: unknown) => void;
}

/** Trim trailing undefined options; undefined array elements are invalid wire values. */
function positional(...args: unknown[]): readonly unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args.slice(0, end);
}

function requireHandle(value: unknown, path: HostApiPath): HostApiHandle {
  const handle = value as HostApiHandle | null;
  if (handle === null || typeof handle !== "object" || typeof handle.handleId !== "string") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-child] '${path}': reply is not a handle`,
      { path },
    );
  }
  return handle;
}

/** Preserve sync/async signatures so void calls report late errors without returning ignored promises. */
export function createServiceChildMembers(
  deps: ServiceChildMemberDeps,
): Record<ServiceHostApiPath, ChildHostApiMember> {
  const { call, pluginId } = deps;

  const reportDetached = (path: HostApiPath, error: unknown): void => {
    deps.report(`hostApi.${path} failed after returning`, {
      error: errorMessage(error),
    });
  };

  return {
    getSecret: async (...args) =>
      call("getSecret", positional(args[0])) as Promise<string | null>,

    getAuthPartitionCookies: async (...args) =>
      call("getAuthPartitionCookies", positional(args[0])) as Promise<
        Array<{ url: string; cookies: AuthPartitionCookie[] }>
      >,

    hasRoutineBySource: async (...args) =>
      call("hasRoutineBySource", positional(args[0])) as Promise<boolean>,

    // Promise-returning proposeWork receives the host refusal at await; do not duplicate grant checks.
    proposeWork: async (...args) =>
      call("proposeWork", positional(args[0])) as Promise<WorkProposalResult>,

    withdrawWorkProposal: async (...args) =>
      call("withdrawWorkProposal", positional(args[0], args[1])) as Promise<boolean>,

    raiseAlert: async (...args) =>
      call("raiseAlert", positional(args[0])) as Promise<AlertResult>,

    withdrawAlert: async (...args) =>
      call("withdrawAlert", positional(args[0], args[1])) as Promise<boolean>,

    probePrivateHost: async (...args) =>
      call("probePrivateHost", positional(args[0], args[1])) as Promise<boolean>,

    resolveMappedDriveRoot: async (...args) =>
      call("resolveMappedDriveRoot", positional(args[0])) as Promise<string | null>,

    /** Recheck emit policy locally only for synchronous-throw timing; the host still decides access and audit. */
    emitEvent: (...args) => {
      const eventType = args[0] as string;
      const declared = getDeclaredEmittedEvents(deps.manifest);
      if (!canEmitEvent(eventType, declared)) {
        throw new Error(
          `Plugin '${pluginId}' is not allowed to emit undeclared event '${String(eventType)}'`,
        );
      }
      call("emitEvent", positional(eventType, args[1])).catch((error: unknown) => {
        reportDetached("emitEvent", error);
      });
    },

    logEvent: (...args) => {
      call("logEvent", positional(args[0], args[1], args[2])).catch((error: unknown) => {
        reportDetached("logEvent", error);
      });
    },

    callLlm: async (...args) => {
      const options = args[1] as { signal?: AbortSignal; maxTokens?: number; systemPrompt?: string } | undefined;
      const wire: WireCallLlmOptions = {
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      };
      return (await call("callLlm", positional(args[0], wire), options?.signal)) as string;
    },

    /** Flatten URL instances to strings before JSON to preserve fetch input semantics. */
    hostFetch: async (...args) => {
      const input = args[0] as string | URL;
      const init = args[1] as import("../public-contract.js").HostFetchInit | undefined;
      const wire = await encodeHostFetchInit(init, "hostFetch(init)");
      const reply = await call(
        "hostFetch",
        positional(String(input), wire),
        init?.signal ?? undefined,
      );
      return decodeWireHttpResponse(reply, "hostFetch(result)");
    },

    resolveApiKey: async (...args) => {
      const opts = args[0] as {
        purpose: WireResolveApiKeyOptions["purpose"];
        vendor?: WireResolveApiKeyOptions["vendor"];
        exposure?: WireResolveApiKeyOptions["exposure"];
        signal?: AbortSignal;
      };
      const wire: WireResolveApiKeyOptions = {
        purpose: opts.purpose,
        ...(opts.vendor !== undefined ? { vendor: opts.vendor } : {}),
        ...(opts.exposure !== undefined ? { exposure: opts.exposure } : {}),
      };
      const lease = await call("resolveApiKey", [wire], opts?.signal) as WireApiKeyLease;
      if (!lease.ok) return { ok: false as const, reason: lease.reason };
      const handle = requireHandle(lease, "resolveApiKey") as WireApiKeyLease & { ok: true };
      let closedReason: "revoked" | "peer-gone" | undefined;
      let released = false;
      const listeners = new Set<(reason: "revoked" | "peer-gone") => void>();
      const dispose = deps.adoptSubscription(
        "resolveApiKey",
        handle.handleId,
        // A lease cannot carry events; report them as a protocol disagreement.
        () => {
          deps.report("hostApi.resolveApiKey: the host pushed an event on a lease", {
            handleId: handle.handleId,
          });
        },
        // Replay revocations that arrive before the handle is adopted.
        (reason) => {
          closedReason = reason;
          if (!released) for (const listener of listeners) listener(reason);
          listeners.clear();
        },
      );
      const release = async () => {
        if (released) return;
        released = true;
        listeners.clear();
        dispose();
      };
      if (handle.exposure === "raw") return {
        ok: true as const,
        exposure: "raw" as const,
        vendor: handle.vendor,
        ...(handle.baseUrl !== undefined ? { baseUrl: handle.baseUrl } : {}),
        key: handle.key,
        release,
      };
      return {
        ok: true as const,
        exposure: "lease" as const,
        leaseId: handle.handleId,
        vendor: handle.vendor,
        ...(handle.baseUrl !== undefined ? { baseUrl: handle.baseUrl } : {}),
        onClosed: (listener: (reason: "revoked" | "peer-gone") => void) => {
          if (closedReason) listener(closedReason);
          else if (!released) listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        release,
      };
    },

    /** Handle methods stay local; process ownership and stop remain with the host. */
    listAudioInputDevices: async () =>
      call("listAudioInputDevices", positional()) as Promise<readonly AudioCaptureDevice[]>,
    /** Fan out host capture notifications through child-local listeners; media objects never cross. */
    startAudioCapture: async (...args) => {
      const request = args[0] as AudioCaptureRequest;
      const reply = await call("startAudioCapture", [request]);
      const handle = requireHandle(reply, "startAudioCapture") as unknown as WireAudioCaptureHandle;
      const frames: ((frame: AudioCaptureFrame) => void)[] = [];
      const ends: ((end: AudioCaptureEnd) => void)[] = [];
      const dispose = deps.adoptSubscription("startAudioCapture", handle.handleId, (payload) => {
        const event = asWireAudioCaptureEvent(payload, "startAudioCapture(event)");
        if (event.kind === "frame") {
          // Decode each audio frame once before fan-out.
          const pcm = new Uint8Array(Buffer.from(event.pcm, "base64"));
          for (const listener of frames) listener({ seq: event.seq, pcm, peak: event.peak });
          return;
        }
        for (const listener of ends) {
          listener({
            reason: event.reason as AudioCaptureEnd["reason"],
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          });
        }
        // The host owns capture completion and releases its registration.
      });
      const capture: AudioCaptureHandle = {
        captureId: handle.captureId,
        opened: handle.opened,
        onFrame: (listener) => {
          frames.push(listener);
          return () => {
            const at = frames.indexOf(listener);
            if (at >= 0) frames.splice(at, 1);
          };
        },
        onEnd: (listener) => {
          ends.push(listener);
          return () => {
            const at = ends.indexOf(listener);
            if (at >= 0) ends.splice(at, 1);
          };
        },
        stop: async () => { dispose(); },
      };
      return capture;
    },
    /** Detach disposes the subscription; resize is a separately addressed request carrying the panel ID. */
    attachFloatingPanel: async (...args) => {
      const request = args[0] as AttachFloatingPanelRequest;
      const reply = await call("attachFloatingPanel", [request]);
      const handle = requireHandle(reply, "attachFloatingPanel") as unknown as WireFloatingPanelHandle;
      const listeners: ((reason: DetachReason) => void)[] = [];
      let height = handle.height;
      // Retain the actual detach reason for subscribers arriving after closure.
      let detachedAs: DetachReason | null = null;
      const dispose = deps.adoptSubscription("attachFloatingPanel", handle.handleId, (payload) => {
        const event = asWireFloatingPanelEvent(payload, "attachFloatingPanel(event)");
        if (detachedAs) return;
        detachedAs = event.reason as DetachReason;
        for (const listener of listeners) listener(detachedAs);
        listeners.length = 0;
        // The host owns slot closure and releases its registration.
      });
      const panel: FloatingPanelHandle = {
        panelId: handle.panelId,
        get height() {
          return height;
        },
        resize: async (next: number) => {
          height = Number(await call("resizeFloatingPanel", [handle.panelId, next]));
          return height;
        },
        detach: async () => {
          dispose();
        },
        onDetached: (listener) => {
          if (detachedAs) {
            // Late subscribers must receive the original detach reason so requested closure cannot mask an orphaned capture.
            listener(detachedAs);
            return;
          }
          listeners.push(listener);
        },
      };
      return panel;
    },
    resizeFloatingPanel: async (...args) =>
      call("resizeFloatingPanel", [String(args[0]), Number(args[1])]),
    spawnWorker: async (...args) => {
      const spec = args[0] as PluginWorkerSpec;
      const stdout: ((chunk: string) => void)[] = [];
      const stderr: ((chunk: string) => void)[] = [];
      const exit: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = [];
      let pendingStdout: string[] = [];
      let pendingStderr: string[] = [];
      let pendingBytes = 0;
      let pendingEvents = 0;
      let backlogError: HostApiBoundaryError | undefined;
      let handoffComplete = false;
      let terminalExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let disposeAdopted: (() => void) | undefined;
      let disposed = false;
      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        pendingStdout = [];
        pendingStderr = [];
        pendingBytes = 0;
        pendingEvents = 0;
        stdout.length = 0;
        stderr.length = 0;
        exit.length = 0;
        disposeAdopted?.();
      };
      const bufferOutput = (kind: "stdout" | "stderr", chunk: string): void => {
        if (backlogError || handoffComplete) return;
        const bytes = chunk.length * 2;
        if (
          pendingEvents >= WORKER_PRE_LISTENER_EVENT_MAX
          || pendingBytes + bytes > WORKER_PRE_LISTENER_BYTES_MAX
        ) {
          pendingStdout = [];
          pendingStderr = [];
          pendingBytes = 0;
          pendingEvents = 0;
          const error = new HostApiBoundaryError(
            "payload-too-large",
            "Worker output exceeded the pre-listener buffer.",
            { limit: WORKER_PRE_LISTENER_BYTES_MAX },
          );
          backlogError = error;
          dispose();
          return;
        }
        (kind === "stdout" ? pendingStdout : pendingStderr).push(chunk);
        pendingBytes += bytes;
        pendingEvents += 1;
      };
      const handleEvent = (payload: unknown): void => {
        if (disposed) return;
        const event = asWireWorkerEvent(payload, "spawnWorker(event)");
        if (event.kind === "stdout") {
          if (stdout.length === 0) bufferOutput("stdout", event.chunk);
          else for (const listener of stdout) listener(event.chunk);
          return;
        }
        if (event.kind === "stderr") {
          if (stderr.length === 0) bufferOutput("stderr", event.chunk);
          else for (const listener of stderr) listener(event.chunk);
          return;
        }
        if (terminalExit) return;
        terminalExit = { code: event.code, signal: event.signal as NodeJS.Signals | null };
        for (const listener of exit) {
          listener(terminalExit);
        }
        // Wait for the host-owned exit notification; child listeners do not decide process lifetime.
      };
      let subscriptionId: string | undefined;
      let handle: WireWorkerHandle;
      try {
        const reply = await call("spawnWorker", [spec], undefined, (id) => {
          subscriptionId = workerSubscriptionIdOfRequest(id);
          disposeAdopted = deps.adoptSubscription("spawnWorker", subscriptionId, handleEvent);
        });
        handle = requireHandle(reply, "spawnWorker") as unknown as WireWorkerHandle;
        if (handle.handleId !== subscriptionId) {
          throw new Error("Worker reply did not match its request registration.");
        }
        if (backlogError) throw backlogError;
      } catch (error) {
        dispose();
        throw error;
      }
      const worker: SpawnedPluginWorker = {
        socketPath: handle.socketPath,
        pid: handle.pid,
        stop: dispose,
        onStdout: (listener) => {
          if (backlogError) throw backlogError;
          stdout.push(listener);
          const queued = pendingStdout;
          pendingStdout = [];
          pendingEvents -= queued.length;
          pendingBytes -= queued.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
          try {
            for (const chunk of queued) listener(chunk);
          } catch (error) {
            dispose();
            throw error;
          }
        },
        onStderr: (listener) => {
          if (backlogError) throw backlogError;
          stderr.push(listener);
          const queued = pendingStderr;
          pendingStderr = [];
          pendingEvents -= queued.length;
          pendingBytes -= queued.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
          try {
            for (const chunk of queued) listener(chunk);
          } catch (error) {
            dispose();
            throw error;
          }
        },
        onExit: (listener) => {
          if (backlogError) throw backlogError;
          exit.push(listener);
          if (terminalExit) listener(terminalExit);
        },
      };
      handoffComplete = true;
      return worker;
    },
  };
}

/** Only read/write require payload codecs; resolve never crosses. */
const NON_RELAYED_STORAGE_PATHS: readonly StorageHostApiPath[] = [
  "storage.resolve",
  "storage.read",
  "storage.write",
];

/** Trim only trailing undefined; interior holes must refuse rather than shift arguments. */
function withoutTrailingAbsent(args: readonly unknown[]): unknown[] {
  const wire = [...args];
  while (wire.length > 0 && wire[wire.length - 1] === undefined) wire.pop();
  return wire;
}

/** Refuse invalid write data at the plugin call site so diagnostics retain its stack. */
function requireBytesOrText(pluginId: string, value: unknown): string | Uint8Array {
  if (typeof value === "string" || value instanceof Uint8Array) return value;
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[plugin-child:${pluginId}] hostApi.storage.write: data must be a string or Uint8Array`,
  );
}

/** Use the shared caller for every storage request to avoid duplicate wire encoding. */
export function createStorageChildMembers(
  call: HostApiCaller,
  context: Pick<PluginChildContext, "pluginId" | "pluginDataDir">,
): Record<StorageHostApiPath, ChildHostApiMember> {
  const { pluginId, pluginDataDir } = context;
  for (const path of STORAGE_HOSTAPI_PATHS) {
    if (NON_RELAYED_STORAGE_PATHS.includes(path)) continue;
    assertRelayable(path);
  }
  return {
    // Resolve storage against the host-only sibling root.
    "storage.resolve": (...segments) =>
      resolvePluginStoragePath(pluginId, resolvePluginHostStorageDir(pluginDataDir), segments),

    // Require binary tagging so text replies cannot masquerade as byte arrays.
    "storage.read": async (relPath) =>
      decodeWireBinary(await call("storage.read", [relPath]), "storage.read(result)"),

    "storage.readText": async (relPath, encoding) =>
      (await call(
        "storage.readText",
        withoutTrailingAbsent([relPath, encoding]),
      )) as string,

    "storage.readJson": (relPath) => call("storage.readJson", [relPath]),

    "storage.list": async (relPath) =>
      (await call("storage.list", withoutTrailingAbsent([relPath]))) as string[],

    "storage.exists": async (relPath) =>
      (await call("storage.exists", [relPath])) as boolean,

    // Tag literal text separately from bytes so base64-looking strings are not decoded.
    "storage.write": async (relPath, data, encoding) => {
      const bytes = encodeWireBytes(
        requireBytesOrText(pluginId, data),
        "storage.write(data)",
      );
      await call("storage.write", withoutTrailingAbsent([relPath, bytes, encoding]));
    },

    "storage.writeJson": async (relPath, value, indent) => {
      await call(
        "storage.writeJson",
        withoutTrailingAbsent([relPath, value, indent]),
      );
    },

    "storage.rm": async (relPath, removeOptions) => {
      await call("storage.rm", withoutTrailingAbsent([relPath, removeOptions]));
    },

    "storage.mkdir": async (relPath) => {
      await call("storage.mkdir", [relPath]);
    },

    "storage.writeEncrypted": async (relPath, plaintext) => {
      await call("storage.writeEncrypted", [relPath, plaintext]);
    },

    "storage.readEncrypted": async (relPath) =>
      (await call("storage.readEncrypted", [relPath])) as string,
  };
}

/** Child subscriptions need local registration before asynchronous host acknowledgement, with failure cleanup. */

interface ChildSubscriptionHandle {
  readonly subscriptionId: string;
  readonly dispose: () => void;
}

export interface ConfigSubscriptionChildDeps {
  readonly pluginId: string;
  readonly call: HostApiCaller;
  /** Share one child subscription ledger across all members. */
  readonly openSubscription: (
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ) => ChildSubscriptionHandle;
  /** Update the shared config snapshot only after host confirmation and before set resolves. */
  readonly config: Record<string, unknown>;
  readonly report: (message: string, meta?: unknown) => void;
  /** Shutdown handlers are awaited requests, not event deliveries. */
  readonly shutdownHandlers: Map<string, () => void | Promise<void>>;
}

/** Throw invalid member arguments locally; a boundary failure must not masquerade as an unset value. */
function requireStringArgument(
  pluginId: string,
  member: string,
  name: string,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `[plugin-child:${pluginId}] hostApi.${member}: '${name}' must be a string`,
    );
  }
  return value;
}

function requireFunctionArgument(
  pluginId: string,
  member: string,
  name: string,
  value: unknown,
): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new TypeError(
      `[plugin-child:${pluginId}] hostApi.${member}: '${name}' must be a function`,
    );
  }
  return value as (...args: unknown[]) => unknown;
}

/** Register locally before host subscribe; report refusals and remove the local half. */
function subscribe(
  deps: ConfigSubscriptionChildDeps,
  path: HostApiPath,
  args: (subscriptionId: string) => readonly unknown[],
  handler: (payload: unknown) => void,
): ChildSubscriptionHandle {
  const subscription = deps.openSubscription(path, handler);
  void deps.call(path, args(subscription.subscriptionId)).catch((error: unknown) => {
    deps.report(`hostApi.${path}: the host refused the subscription`, {
      subscriptionId: subscription.subscriptionId,
      error: errorMessage(error),
    });
    // A refused host subscription must also drop the local registration.
    subscription.dispose();
  });
  return subscription;
}

/** Compose partial groups over throwing defaults so unwired paths remain explicit refusals. */
export function createConfigSubscriptionChildMembers(
  deps: ConfigSubscriptionChildDeps,
): Record<ConfigSubscriptionPath, ChildHostApiMember> {
  const { pluginId } = deps;
  return {
    // Synchronous config.get reads the pushed snapshot and must never make a round trip.
    "config.get": (...args) =>
      deps.config[requireStringArgument(pluginId, "config.get", "key", args[0])],

    "config.set": async (...args) => {
      const key = requireStringArgument(pluginId, "config.set", "key", args[0]);
      const value = args[1];
      await deps.call("config.set", [key, value]);
      // Update the snapshot only after persistence succeeds.
      deps.config[key] = value;
    },

    "config.onChange": (...args) => {
      const key = requireStringArgument(pluginId, "config.onChange", "key", args[0]);
      const callback = requireFunctionArgument(
        pluginId,
        "config.onChange",
        "callback",
        args[1],
      );
      const subscription = subscribe(
        deps,
        "config.onChange",
        (subscriptionId) => [key, subscriptionId],
        (payload) => {
          const change = decodeConfigChange(payload);
          // Refresh the snapshot before the callback can reread it.
          if (change.value === SECRET_REDACTED_SENTINEL) {
            // Secret sentinels are notifications only and must never enter cleartext config.
            delete deps.config[change.key];
          } else {
            deps.config[change.key] = change.value;
          }
          callback(change.value);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    onEvent: (...args) => {
      const eventType = requireStringArgument(pluginId, "onEvent", "eventType", args[0]);
      const handler = requireFunctionArgument(pluginId, "onEvent", "handler", args[1]);
      const subscription = subscribe(
        deps,
        "onEvent",
        (subscriptionId) => [eventType, subscriptionId],
        (payload) => {
          handler(decodeHostEvent(payload).data);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    onPluginsChanged: (...args) => {
      const handler = requireFunctionArgument(
        pluginId,
        "onPluginsChanged",
        "handler",
        args[0],
      );
      const subscription = subscribe(
        deps,
        "onPluginsChanged",
        (subscriptionId) => [subscriptionId],
        (payload) => {
          handler(decodePluginLifecycle(payload).event);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    // The host owns shutdown termination; retain a ledger entry so its handler can be awaited once.
    onShutdown: (...args) => {
      const handler = requireFunctionArgument(pluginId, "onShutdown", "handler", args[0]);
      const subscription: ChildSubscriptionHandle = subscribe(
        deps,
        "onShutdown",
        (subscriptionId) => [subscriptionId],
        () => undefined,
      );
      deps.shutdownHandlers.set(subscription.subscriptionId, async () => {
        try {
          await handler();
        } finally {
          // Release shutdown registration after either success or failure.
          deps.shutdownHandlers.delete(subscription.subscriptionId);
          subscription.dispose();
        }
      });
      return undefined;
    },
  };
}
