// Dispatch reverse calls through the complete effect-instrumented host table; unknown, local-only, and non-JSON calls fail explicitly.
// Bind caller and generation identity to the connection, never request fields.
// Host error classification stays here; children import only the wire contract.
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { describeNonJson } from "../../shared/json-representable.js";
import { INVOCATION_META } from "../../mcp/protocol-constants.js";
import {
  currentEffectGateContext,
  EffectBoundaryDeniedError,
  GATED_EFFECT_PATHS,
} from "../../permissions/effect-enforcement.js";
import { ManifestIntegrityError } from "../../permissions/manifest-integrity.js";
import { methodEffect } from "../../permissions/effect-kind.js";
import { PluginRuntimeDetachedOperationError } from "../runtime/detached-operation.js";
import { currentInvocationOrigin } from "../runtime/origin-chain.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
  type ApprovalChoice,
  type ConversationTriggerSpec,
  type PluginHostApi,
  type PluginWorkerSpec,
  type StorageEncoding,
  type AttachFloatingPanelRequest,
  type AudioCaptureRequest,
} from "../public-contract.js";
import { isGrantPathWithin, outermostContainingRoots } from "../../permissions/asrt-sandbox.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  HOST_PROTOCOL_NOTIFICATIONS,
  HostApiBoundaryError,
  decodeWireBytes,
  decodeWireRequestInit,
  encodeConfigChange,
  encodeWireBytes,
  encodeWireHttpResponse,
  hostApiArgsOf,
  hostApiMethodOf,
  workerSubscriptionIdOfRequest,
  hostApiPathOf,
  inactiveHostApiMessage,
  toHostApiRpcError,
  type ChildNotificationSink,
  type ContractOf,
  type DispatchedConfigSubscriptionPath,
  type DispatchedStorageHostApiPath,
  type HostApiHandle,
  type HostApiNotification,
  type HostApiPath,
  type HostApiPathContract,
  type HostApiReply,
  type HostApiRequest,
  type HostApiWireError,
  type InteractionHostApiPath,
  type JsonRpcRequestId,
  type ServiceHostApiPath,
  type SubscriptionCloseReason,
  type WireApiKeyLease,
  type WireCallLlmOptions,
  type WireHttpResponse,
  type WireResolveApiKeyOptions,
  type WireWorkerHandle,
  type WireWorkerEvent,
  type HostApiEventPayloads,
  type WireAudioCaptureEvent,
  type WireFloatingPanelEvent,
  type WireFloatingPanelHandle,
  type WireAudioCaptureHandle,
} from "./host-api-wire.js";
import { CredentialLeaseError } from "../secret-access/credential-lease-registry.js";
import { SubscriptionLedger } from "./subscription-ledger.js";
import {
  DISPATCH_IN_FLIGHT_MAX,
  DISPATCH_SUBSCRIPTIONS_MAX,
  DISPATCH_SUBSCRIPTION_KIND_MAX,
  HostApiBudgets,
  type HostApiBudgetAudit,
} from "./host-api-budgets.js";

const log = createLogger("host-api-dispatcher");

export type InvocationContextRunner = <R>(fn: () => R) => R;

/** Capture an empty async context at boot so unscoped work inherits neither invocation nor install locks. */
const OUTSIDE_INVOCATION: InvocationContextRunner = (() => {
  // App-only tools have an origin frame but do not enter the executor's gate.
  if (currentEffectGateContext() !== undefined || currentInvocationOrigin() !== undefined) {
    throw new Error(
      "[host-api-dispatcher] evaluated inside a tool invocation; the outside-invocation context cannot be captured here",
    );
  }
  return AsyncLocalStorage.snapshot();
})();

export function runOutsideInvocation<R>(fn: () => R): R {
  return OUTSIDE_INVOCATION(fn);
}

export interface HostApiCall {
  readonly path: HostApiPath;
  /** Map named wire params to positional args using the declared contract. */
  readonly args: readonly unknown[];
  /** Abort this request controller on matching cancellation or child loss; signals remain host-local. */
  readonly signal: AbortSignal;
}

export interface HostSubscription {
  readonly path: HostApiPath;
  /** Dispose exactly once. */
  readonly teardown: (reason: SubscriptionCloseReason) => void;
}

export interface SubscriptionScope<Event = unknown> {
  /** Adopt the child-allocated subscription ID. */
  adopt(subscriptionId: string, teardown: (reason: SubscriptionCloseReason) => void): void;
  /** Allocate host IDs for worker handles and key leases. */
  open(teardown: (reason: SubscriptionCloseReason) => void): string;
  /** Event payload types come from the shared contract; never means no pushes. */
  deliver(subscriptionId: string, payload: Event): void;
  /** Host closure releases its registration and tells the child to clear local handle or credential state. */
  release(subscriptionId: string): boolean;
  /** Await the registered child shutdown handler under the owner request bound. */
  shutdown(subscriptionId: string): Promise<void>;
}

type WireResultFor<C extends HostApiPathContract> = C["result"] extends "void"
  ? void
  : C["result"] extends "handle"
    ? HostApiHandle
    : C["result"] extends "child-local"
      ? never
      : unknown;

/** Derive handler signatures and required subscription scopes from the declared contract. */
export type HostApiPathInvoke<C extends HostApiPathContract, Event = never> =
  C["lifetime"] extends "none"
    ? (call: HostApiCall) => Promise<WireResultFor<C>>
    : (call: HostApiCall, scope: SubscriptionScope<Event>) => Promise<WireResultFor<C>>;

type EventPayloadOf<P extends HostApiPath> = P extends keyof HostApiEventPayloads
  ? HostApiEventPayloads[P]
  : never;

/** Implemented entries determine advertised capabilities. */
export type HostApiPathStatus = "implemented" | "unimplemented" | "child-local";

/** Advertise only implemented wire methods from this connection table; omit absent optional and child-local members. */
export function hostProtocolCapabilities(
  table: Record<HostApiPath, HostApiPathHandler>,
): string[] {
  return (Object.keys(table) as HostApiPath[])
    .filter((path) => table[path].status === "implemented")
    .map((path) => hostApiMethodOf(path))
    .sort();
}

export interface HostApiPathHandler {
  readonly path: HostApiPath;
  readonly contract: HostApiPathContract;
  readonly status: HostApiPathStatus;
  invoke(call: HostApiCall, scope: SubscriptionScope): Promise<unknown>;
}

/** Derive marshalling and invoke signature from the shared contract. */
export function defineHostApiPath<P extends HostApiPath>(
  path: P,
  invoke: HostApiPathInvoke<ContractOf<P>, EventPayloadOf<P>>,
): HostApiPathHandler {
  return {
    path,
    contract: HOSTAPI_PATH_CONTRACTS[path],
    status: "implemented",
    invoke: invoke as HostApiPathHandler["invoke"],
  };
}

/** Unimplemented members must throw; resolving undefined would fabricate successful host answers. */
export function unimplementedHostApiPath(path: HostApiPath, why?: string): HostApiPathHandler {
  return {
    path,
    contract: HOSTAPI_PATH_CONTRACTS[path],
    status: "unimplemented",
    invoke: () =>
      Promise.reject(
        new HostApiBoundaryError(
          "path-not-implemented",
          why === undefined
            ? `[host-api-dispatcher] '${path}' has no handler`
            : `[host-api-dispatcher] '${path}': ${why}`,
          { path },
        ),
      ),
  };
}

type ChildLocalPath = {
  [P in HostApiPath]: ContractOf<P>["result"] extends "child-local" ? P : never;
}[HostApiPath];

/** Refuse child-local paths on the wire rather than duplicate their implementation. */
export function childLocalHostApiPath(path: ChildLocalPath): HostApiPathHandler {
  return {
    path,
    contract: HOSTAPI_PATH_CONTRACTS[path],
    status: "child-local",
    invoke: () =>
      Promise.reject(
        new HostApiBoundaryError(
          "path-not-dispatchable",
          `[host-api-dispatcher] '${path}' is answered in the child and must never be sent`,
          { path },
        ),
      ),
  };
}

/** Enumerate every path at compile time; unwired entries retain throwing defaults. */
export const HOSTAPI_DISPATCH_TABLE: Record<HostApiPath, HostApiPathHandler> = {
  "storage.resolve": childLocalHostApiPath("storage.resolve"),
  "storage.read": unimplementedHostApiPath("storage.read"),
  "storage.readText": unimplementedHostApiPath("storage.readText"),
  "storage.readJson": unimplementedHostApiPath("storage.readJson"),
  "storage.list": unimplementedHostApiPath("storage.list"),
  "storage.exists": unimplementedHostApiPath("storage.exists"),
  "storage.write": unimplementedHostApiPath("storage.write"),
  "storage.writeJson": unimplementedHostApiPath("storage.writeJson"),
  "storage.rm": unimplementedHostApiPath("storage.rm"),
  "storage.mkdir": unimplementedHostApiPath("storage.mkdir"),
  "storage.writeEncrypted": unimplementedHostApiPath("storage.writeEncrypted"),
  "storage.readEncrypted": unimplementedHostApiPath("storage.readEncrypted"),
  "config.get": childLocalHostApiPath("config.get"),
  "config.set": unimplementedHostApiPath("config.set"),
  "config.onChange": unimplementedHostApiPath("config.onChange"),
  getSecret: unimplementedHostApiPath("getSecret"),
  getInstalledPluginIds: childLocalHostApiPath("getInstalledPluginIds"),
  hasRoutineBySource: unimplementedHostApiPath("hasRoutineBySource"),
  proposeWork: unimplementedHostApiPath("proposeWork"),
  withdrawWorkProposal: unimplementedHostApiPath("withdrawWorkProposal"),
  raiseAlert: unimplementedHostApiPath("raiseAlert"),
  withdrawAlert: unimplementedHostApiPath("withdrawAlert"),
  getAppPreference: childLocalHostApiPath("getAppPreference"),
  probePrivateHost: unimplementedHostApiPath("probePrivateHost"),
  resolveApiKey: unimplementedHostApiPath("resolveApiKey"),
  emitEvent: unimplementedHostApiPath("emitEvent"),
  onEvent: unimplementedHostApiPath("onEvent"),
  onPluginsChanged: unimplementedHostApiPath("onPluginsChanged"),
  onShutdown: unimplementedHostApiPath("onShutdown"),
  logEvent: unimplementedHostApiPath("logEvent"),
  callLlm: unimplementedHostApiPath("callLlm"),
  hostFetch: unimplementedHostApiPath("hostFetch"),
  spawnWorker: unimplementedHostApiPath("spawnWorker"),
  resolveMappedDriveRoot: unimplementedHostApiPath("resolveMappedDriveRoot"),
  listAudioInputDevices: unimplementedHostApiPath("listAudioInputDevices"),
  startAudioCapture: unimplementedHostApiPath("startAudioCapture"),
  attachFloatingPanel: unimplementedHostApiPath("attachFloatingPanel"),
  resizeFloatingPanel: unimplementedHostApiPath("resizeFloatingPanel"),
  openExternalUrl: unimplementedHostApiPath("openExternalUrl"),
  openAuthWindow: unimplementedHostApiPath("openAuthWindow"),
  openAuthPartitionViewer: unimplementedHostApiPath("openAuthPartitionViewer"),
  clearAuthPartition: unimplementedHostApiPath("clearAuthPartition"),
  "authRedirect.open": unimplementedHostApiPath("authRedirect.open"),
  "authRedirect.wait": unimplementedHostApiPath("authRedirect.wait"),
  "authRedirect.close": unimplementedHostApiPath("authRedirect.close"),
  pickFolders: unimplementedHostApiPath("pickFolders"),
  getAuthPartitionCookies: unimplementedHostApiPath("getAuthPartitionCookies"),
  triggerConversation: unimplementedHostApiPath("triggerConversation"),
  "agentApproval.request": unimplementedHostApiPath("agentApproval.request"),
  "agentApproval.respond": unimplementedHostApiPath("agentApproval.respond"),
};

/** Bind user interactions on the host; the child imports only pure wire helpers. */

export type InteractionHostApi = Pick<
  PluginHostApi,
  | "openExternalUrl"
  | "openAuthWindow"
  | "openAuthPartitionViewer"
  | "clearAuthPartition"
  | "authRedirect"
  | "pickFolders"
  | "triggerConversation"
  | "agentApproval"
>;

/** The host decides the auth-window overload; the boundary carries its actual result. */
type OverloadedOpenAuthWindow = (options: unknown) => Promise<unknown>;

/** Compose incarnation-bound handlers over throwing defaults. */
export function createInteractionHostApiPaths(
  hostApi: InteractionHostApi,
): Record<InteractionHostApiPath, HostApiPathHandler> {
  // Return void-member results unchanged so the dispatcher can detect signature drift.
  return {
    // The host validates URL schemes and reads the current window-routing preference.
    openExternalUrl: defineHostApiPath("openExternalUrl", (call) =>
      hostApi.openExternalUrl(call.args[0] as string),
    ),
    openAuthWindow: defineHostApiPath("openAuthWindow", async (call) => {
      const openAuthWindow = hostApi.openAuthWindow as unknown as OverloadedOpenAuthWindow;
      // Preserve the receiver for recorder and permission wrappers.
      return await openAuthWindow.call(hostApi, call.args[0]);
    }),
    openAuthPartitionViewer: defineHostApiPath("openAuthPartitionViewer", (call) =>
      hostApi.openAuthPartitionViewer(
        call.args[0] as { url: string; windowTitle?: string },
      ),
    ),
    clearAuthPartition: defineHostApiPath("clearAuthPartition", (call) =>
      hostApi.clearAuthPartition(call.args[0] as string),
    ),
    // Bind owner identity from the incarnation; no caller-supplied owner crosses.
    "authRedirect.open": defineHostApiPath("authRedirect.open", async () =>
      await hostApi.authRedirect.open(),
    ),
    // Only the host redirect timeout applies; abandoning the call would strand its bound port.
    "authRedirect.wait": defineHostApiPath("authRedirect.wait", async (call) =>
      await hostApi.authRedirect.wait(
        call.args[0] as { handle: string; timeoutMs?: number },
      ),
    ),
    "authRedirect.close": defineHostApiPath("authRedirect.close", (call) =>
      hostApi.authRedirect.close(call.args[0] as { handle: string }),
    ),
    // Do not impose a boundary timeout on a chooser awaiting its user.
    pickFolders: defineHostApiPath("pickFolders", async () => await hostApi.pickFolders()),
    // Trigger refusal is an accepted:false value; throwing means it never reached the overlay.
    triggerConversation: defineHostApiPath("triggerConversation", async (call) =>
      hostApi.triggerConversation(call.args[0] as ConversationTriggerSpec),
    ),
    // Only the host approval gate timeout applies; its denial is a value.
    "agentApproval.request": defineHostApiPath(
      "agentApproval.request",
      async (call) =>
        hostApi.agentApproval.request(
          call.args[0] as {
            toolName: string;
            args: unknown;
            reason: string;
            scope: string;
          },
        ),
    ),
    // Echo gate-issued nonce/hmac only when present; never invent confused-deputy fields.
    "agentApproval.respond": defineHostApiPath("agentApproval.respond", (call) =>
      hostApi.agentApproval.respond(
        call.args[0] as string,
        call.args[1] as ApprovalChoice,
        call.args[2] as string | undefined,
        call.args[3] as string | undefined,
      ),
    ),
  };
}

/** Bind service implementations on the host; child-side marshalling imports no host state. */

export type ServiceHostApi = Pick<
  PluginHostApi,
  | "getSecret"
  | "getAuthPartitionCookies"
  | "hasRoutineBySource"
  | "proposeWork"
  | "withdrawWorkProposal"
  | "raiseAlert"
  | "withdrawAlert"
  | "probePrivateHost"
  | "resolveApiKey"
  | "emitEvent"
  | "logEvent"
  | "callLlm"
  | "hostFetch"
  | "spawnWorker"
  | "resolveMappedDriveRoot"
  | "listAudioInputDevices"
  | "startAudioCapture"
  | "attachFloatingPanel"
  | "resizeFloatingPanel"
>;

/** Delegated workers must stay within the exact child envelope, including host-widened roots. */
export interface DelegatedWorkerConfinement {
  /** The read list includes writable roots so each granted directory exists before confinement. */
  readonly read: readonly string[];
  /** Check delegation against the complete write grant list, not just the data directory. */
  readonly write: readonly string[];
}

const RESOLVE_API_KEY_PURPOSES = ["llm", "stt", "embedding", "vision"] as const;
const RESOLVE_API_KEY_VENDORS = [
  "openai",
  "azure-openai",
  "vertex",
  "anthropic",
] as const;
const LOG_EVENT_LEVELS = ["info", "warn", "error"] as const;

type ResolveApiKeyPurpose = (typeof RESOLVE_API_KEY_PURPOSES)[number];
type ResolveApiKeyVendor = (typeof RESOLVE_API_KEY_VENDORS)[number];
type LogEventLevel = (typeof LOG_EVENT_LEVELS)[number];

function rejectArgument(path: HostApiPath, detail: string): never {
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[host-api-dispatcher] '${path}': ${detail}`,
    { path },
  );
}

/** Validate argument types before calling host policy; malformed types must not reach permissive string handling. */
function requireString(call: HostApiCall, index: number, name: string): string {
  const value = call.args[index];
  if (typeof value !== "string") {
    rejectArgument(call.path, `${name} must be a string`);
  }
  return value;
}

/** Bind optional methods only when present so capabilities never advertise a per-call refusal. */
function bindOptional(
  path: HostApiPath,
  member: unknown,
  bind: () => HostApiPathHandler,
): HostApiPathHandler {
  return typeof member === "function"
    ? bind()
    : unimplementedHostApiPath(path, `this host build has no '${path}'`);
}

function requireRecord(
  call: HostApiCall,
  index: number,
  name: string,
): Record<string, unknown> {
  const value = call.args[index];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    rejectArgument(call.path, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Check secret argument types here; authorization remains entirely in the host secret gate. */
function getSecretPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("getSecret", async (call) =>
    hostApi.getSecret(requireString(call, 0, "key")),
  );
}

/** The registry issues the ID before child-release adoption. */
/** Cookie reads retain host partition and allowlist checks; the boundary only validates shape. */
function getAuthPartitionCookiesPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("getAuthPartitionCookies", async (call) =>
    hostApi.getAuthPartitionCookies(
      call.args[0] as { partitionSub: string; urls: string[] },
    ),
  );
}

function resolveApiKeyPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("resolveApiKey", async (call, scope) => {
    // Preserve the HostApi receiver so liveness and effect wrappers remain active.
    const wire = requireRecord(call, 0, "opts") as unknown as WireResolveApiKeyOptions;
    const purpose = wire.purpose;
    if (!RESOLVE_API_KEY_PURPOSES.includes(purpose as ResolveApiKeyPurpose)) {
      rejectArgument(call.path, `unknown purpose '${String(purpose)}'`);
    }
    const vendor = wire.vendor;
    if (
      vendor !== undefined
      && !RESOLVE_API_KEY_VENDORS.includes(vendor as ResolveApiKeyVendor)
    ) {
      rejectArgument(call.path, `unknown vendor '${String(vendor)}'`);
    }
    if (wire.exposure !== undefined && wire.exposure !== "lease" && wire.exposure !== "raw") {
      rejectArgument(call.path, "unknown credential exposure");
    }
      const result = await hostApi.resolveApiKey!({
        purpose,
        ...(vendor !== undefined ? { vendor } : {}),
        ...(wire.exposure !== undefined ? { exposure: wire.exposure } : {}),
        signal: call.signal,
      });
      if (!result.ok) {
        return { ok: false, reason: result.reason } satisfies WireApiKeyLease;
      }
      const handleId = result.exposure === "lease" ? result.leaseId
        : (result as typeof result & { handleId: string }).handleId;
      try {
        scope.adopt(handleId, () => { void result.release(); });
      } catch {
        void result.release();
        throw new HostApiBoundaryError("plugin-inactive", "Plugin connection ended before credential adoption.");
      }
      const onClosed = result.exposure === "lease" ? result.onClosed
        : (result as typeof result & { onClosed?: (listener: () => void) => () => void }).onClosed;
      onClosed?.(() => { scope.release(handleId); });
      if (result.exposure === "raw") return {
        handleId, ok: true, exposure: "raw", vendor: result.vendor,
        ...(result.baseUrl !== undefined ? { baseUrl: result.baseUrl } : {}),
        key: result.key,
      } satisfies WireApiKeyLease;
      return {
        handleId, ok: true, exposure: "lease", vendor: result.vendor,
        ...(result.baseUrl !== undefined ? { baseUrl: result.baseUrl } : {}),
      } satisfies WireApiKeyLease;
  });
}

/** Marshal request and response bodies as tagged bytes; text round trips can silently corrupt them. */
function hostFetchPath(
  hostApi: ServiceHostApi,
  onMalformedCredentialSelector?: () => void,
): HostApiPathHandler {
  return defineHostApiPath("hostFetch", async (call) => {
    const input = requireString(call, 0, "input");
    let init: ReturnType<typeof decodeWireRequestInit>;
    try {
      init = decodeWireRequestInit(call.args[1], call.signal, `${call.path}(init)`);
    } catch (error) {
      if (error instanceof HostApiBoundaryError && error.code === "credential-conflict") {
        onMalformedCredentialSelector?.();
      }
      throw error;
    }
    const response = await hostApi.hostFetch!(input, init);
    // Drain response bodies while the request controller is live so cancellation aborts the read too.
    return (await encodeWireHttpResponse(
      response,
      `${call.path}(result)`,
    )) satisfies WireHttpResponse;
  });
}

/** Rebuild the host signal for provider calls; cancellation must reach work rather than reject only the child promise. */
function callLlmPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("callLlm", async (call) => {
    const prompt = requireString(call, 0, "prompt");
    const raw = call.args[1];
    if (raw !== undefined && raw !== null && typeof raw !== "object") {
      rejectArgument(call.path, "options must be an object");
    }
    const wire = (raw ?? {}) as WireCallLlmOptions;
    return await hostApi.callLlm(prompt, {
      ...(wire.maxTokens !== undefined ? { maxTokens: wire.maxTokens } : {}),
      ...(wire.systemPrompt !== undefined ? { systemPrompt: wire.systemPrompt } : {}),
      signal: call.signal,
    });
  });
}

/** Mapped-drive policy belongs to the host implementation; do not duplicate parsing on the boundary. */
function listAudioInputDevicesPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("listAudioInputDevices", async () => hostApi.listAudioInputDevices());
}

/** Capture handles retain host ownership; forward early frames and terminal state across adoption races. */
function startAudioCapturePath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("startAudioCapture", async (call, scope) => {
    const capture = await hostApi.startAudioCapture(call.args[0] as AudioCaptureRequest);

    let ended = false;
    let live = true;
    const handleId = openOrUndo(scope, () => {
      live = false;
      // Do not stop an already-ended capture or release it twice.
      if (!ended) void capture.stop();
    });
    // Check registration liveness before every push to tolerate post-release events.
    const push = (payload: WireAudioCaptureEvent): void => {
      if (live) scope.deliver(handleId, payload);
    };
    capture.onFrame((frame) => {
      push({
        kind: "frame",
        seq: frame.seq,
        // Encode audio as base64; JSON would convert a byte array to a numeric-key object.
        pcm: Buffer.from(frame.pcm).toString("base64"),
        peak: frame.peak,
      });
    });
    capture.onEnd((end) => {
      ended = true;
      push({ kind: "end", reason: end.reason, ...(end.detail === undefined ? {} : { detail: end.detail }) });
      // Release capture registrations at completion so repeated recordings do not accumulate entries.
      scope.release(handleId);
    });

    return {
      handleId,
      captureId: capture.captureId,
      opened: capture.opened,
    } satisfies WireAudioCaptureHandle;
  });
}

function attachFloatingPanelPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("attachFloatingPanel", async (call, scope) => {
    const panel = await hostApi.attachFloatingPanel(
      call.args[0] as AttachFloatingPanelRequest,
    );

    let detached = false;
    let live = true;
    const handleId = openOrUndo(scope, () => {
      live = false;
      // Disposing the handle detaches the slot; never release an already-closed slot twice.
      if (!detached) void panel.detach();
    });

    panel.onDetached((reason) => {
      detached = true;
      // Check registration liveness before every push to tolerate post-release events.
      if (live) scope.deliver(handleId, { kind: "detached", reason } satisfies WireFloatingPanelEvent);
      // Release detached slots immediately rather than retain them until child exit.
      scope.release(handleId);
    });

    return {
      handleId,
      panelId: panel.panelId,
      height: panel.height,
    } satisfies WireFloatingPanelHandle;
  });
}

function resizeFloatingPanelPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("resizeFloatingPanel", async (call) =>
    hostApi.resizeFloatingPanel(String(call.args[0]), Number(call.args[1])),
  );
}

function resolveMappedDriveRootPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("resolveMappedDriveRoot", async (call) =>
    hostApi.resolveMappedDriveRoot(String(call.args[0])),
  );
}

function probePrivateHostPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("probePrivateHost", async (call) => {
    const host = requireString(call, 0, "host");
    const raw = call.args[1];
    if (raw === undefined || raw === null) return hostApi.probePrivateHost(host);
    const opts = requireRecord(call, 1, "opts");
    const timeoutMs = opts.timeoutMs;
    if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
      rejectArgument(call.path, "opts.timeoutMs must be a number");
    }
    return hostApi.probePrivateHost(host, {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  });
}

function optionalStringList(
  call: HostApiCall,
  spec: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = spec[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    rejectArgument(call.path, `spec.${field} must be an array of strings`);
  }
  return value as readonly string[];
}

/** Resolve delegated paths before containment and preserve platform canonicalization rules. */
function assertGrantsWithinEnvelope(
  call: HostApiCall,
  field: string,
  granted: readonly string[] | undefined,
  envelope: readonly string[],
): void {
  for (const path of granted ?? []) {
    if (!isAbsolute(path)) {
      rejectArgument(call.path, `spec.${field} entry '${path}' must be an absolute path`);
    }
    if (envelope.some((root) => isGrantPathWithin(root, path))) continue;
    throw new HostApiBoundaryError(
      "effect-boundary-denied",
      `[host-api-dispatcher] '${call.path}': spec.${field} entry '${path}' `
        + `is outside the plugin's own confinement — a delegated worker cannot be `
        + `granted a path the plugin process itself may not reach`,
      { path: call.path, field, granted: path, envelope: [...envelope] },
    );
  }
}

/** Decode only known worker-spec fields; new grant-shaped fields must fail until explicitly checked. */
function decodeWorkerSpec(
  call: HostApiCall,
  confinement: DelegatedWorkerConfinement,
): PluginWorkerSpec {
  const spec = requireRecord(call, 0, "spec");
  const known = new Set([
    "workerId",
    "command",
    "args",
    "env",
    "allowReadPaths",
    "allowWritePaths",
    "udsArgName",
  ]);
  for (const field of Object.keys(spec)) {
    if (!known.has(field)) rejectArgument(call.path, `spec has unknown field '${field}'`);
  }
  const workerId = spec.workerId;
  const command = spec.command;
  if (typeof workerId !== "string") rejectArgument(call.path, "spec.workerId must be a string");
  if (typeof command !== "string") rejectArgument(call.path, "spec.command must be a string");
  const args = optionalStringList(call, spec, "args");
  const allowReadPaths = optionalStringList(call, spec, "allowReadPaths");
  const allowWritePaths = optionalStringList(call, spec, "allowWritePaths");
  const env = spec.env;
  if (
    env !== undefined
    && (env === null || typeof env !== "object" || Array.isArray(env)
      || Object.values(env).some((value) => value !== undefined && typeof value !== "string"))
  ) {
    rejectArgument(call.path, "spec.env must be a record of strings");
  }
  const udsArgName = spec.udsArgName;
  if (
    udsArgName !== undefined
    && typeof udsArgName !== "string"
    && !(
      typeof udsArgName === "object"
      && udsArgName !== null
      && typeof (udsArgName as { env?: unknown }).env === "string"
    )
  ) {
    rejectArgument(call.path, "spec.udsArgName must be a string or { env: string }");
  }
  // Consume the actual child grant set so envelope widening updates delegation at the same boundary.
  assertGrantsWithinEnvelope(call, "allowReadPaths", allowReadPaths, confinement.read);
  assertGrantsWithinEnvelope(call, "allowWritePaths", allowWritePaths, confinement.write);
  // Windows grants must name envelope roots, never child-controlled descendants that may resolve through junctions.
  const windows = process.platform === "win32";
  const readGrants = allowReadPaths !== undefined && windows
    ? outermostContainingRoots(allowReadPaths, confinement.read)
    : allowReadPaths;
  const writeGrants = allowWritePaths !== undefined && windows
    ? outermostContainingRoots(allowWritePaths, confinement.write)
    : allowWritePaths;
  return {
    workerId,
    command,
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env: env as Record<string, string | undefined> } : {}),
    ...(readGrants !== undefined ? { allowReadPaths: readGrants } : {}),
    ...(writeGrants !== undefined ? { allowWritePaths: writeGrants } : {}),
    ...(udsArgName !== undefined
      ? { udsArgName: udsArgName as PluginWorkerSpec["udsArgName"] }
      : {}),
  };
}

/** Worker handles carry IDs and notifications; the host retains process ownership. */
function spawnWorkerPath(
  hostApi: ServiceHostApi,
  confinement: DelegatedWorkerConfinement,
): HostApiPathHandler {
  return defineHostApiPath("spawnWorker", async (call, scope) => {
    const spec = decodeWorkerSpec(call, confinement);
    const worker = await hostApi.spawnWorker!(spec);

    let exited = false;
    let live = true;
    const handleId = openOrUndo(scope, () => {
      live = false;
      // Never signal an already-reaped PID; it may belong to another process.
      if (!exited) worker.stop();
    });
    // Stop notifications at release to tolerate chunks arriving while worker pipes drain.
    const push = (payload: WireWorkerEvent): void => {
      if (live) scope.deliver(handleId, payload);
    };
    try {
      worker.onStdout((chunk) => push({ kind: "stdout", chunk }));
      worker.onStderr((chunk) => push({ kind: "stderr", chunk }));
      worker.onExit((info) => {
        exited = true;
        push({ kind: "exit", code: info.code, signal: info.signal });
        // Release exited worker registrations immediately so repeated spawns do not accumulate entries.
        scope.release(handleId);
      });
    } catch (error) {
      scope.release(handleId);
      throw error;
    }
    return {
      handleId,
      socketPath: worker.socketPath,
      pid: worker.pid,
    } satisfies WireWorkerHandle;
  });
}

/** The host rechecks emit authorization and audits refusal; return its result so void drift remains detectable. */
function emitEventPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("emitEvent", async (call) =>
    hostApi.emitEvent(requireString(call, 0, "eventType"), call.args[1]),
  );
}

function logEventPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("logEvent", async (call) => {
    const level = requireString(call, 0, "level");
    if (!LOG_EVENT_LEVELS.includes(level as LogEventLevel)) {
      rejectArgument(call.path, `unknown level '${level}'`);
    }
    return hostApi.logEvent(
      level as LogEventLevel,
      requireString(call, 1, "message"),
      call.args[2],
    );
  });
}

/** Caller-specific routine prefixes belong to host policy; do not duplicate them here. */
function hasRoutineBySourcePath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("hasRoutineBySource", async (call) =>
    hostApi.hasRoutineBySource(requireString(call, 0, "source")),
  );
}

/** The host owns proposal grants and validation; the boundary checks only shape. */
function proposeWorkPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("proposeWork", async (call) => {
    const input = call.args[0];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      rejectArgument(call.path, "input must be an object");
    }
    return hostApi.proposeWork(input as Parameters<ServiceHostApi["proposeWork"]>[0]);
  });
}

function withdrawWorkProposalPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("withdrawWorkProposal", async (call) =>
    hostApi.withdrawWorkProposal(
      requireString(call, 0, "kind"),
      requireString(call, 1, "key"),
    ),
  );
}

/** The host owns alert grants, validation and budgets; the boundary checks only shape. */
function raiseAlertPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("raiseAlert", async (call) => {
    const input = call.args[0];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      rejectArgument(call.path, "input must be an object");
    }
    return hostApi.raiseAlert(input as Parameters<ServiceHostApi["raiseAlert"]>[0]);
  });
}

function withdrawAlertPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("withdrawAlert", async (call) =>
    hostApi.withdrawAlert(
      requireString(call, 0, "kind"),
      requireString(call, 1, "key"),
    ),
  );
}

/** Bind this incarnation over throwing defaults. */
export function createServiceHostApiPaths(
  hostApi: ServiceHostApi,
  /** An explicit child envelope is mandatory; absence must never mean unbounded delegation. */
  confinement: DelegatedWorkerConfinement,
  onMalformedCredentialSelector?: () => void,
): Record<ServiceHostApiPath, HostApiPathHandler> {
  return {
    getSecret: getSecretPath(hostApi),
    getAuthPartitionCookies: getAuthPartitionCookiesPath(hostApi),
    hasRoutineBySource: hasRoutineBySourcePath(hostApi),
    proposeWork: proposeWorkPath(hostApi),
    withdrawWorkProposal: withdrawWorkProposalPath(hostApi),
    raiseAlert: raiseAlertPath(hostApi),
    withdrawAlert: withdrawAlertPath(hostApi),
    probePrivateHost: probePrivateHostPath(hostApi),
    resolveApiKey: bindOptional("resolveApiKey", hostApi.resolveApiKey, () =>
      resolveApiKeyPath(hostApi)),
    emitEvent: emitEventPath(hostApi),
    logEvent: logEventPath(hostApi),
    callLlm: callLlmPath(hostApi),
    hostFetch: bindOptional("hostFetch", hostApi.hostFetch, () =>
      hostFetchPath(hostApi, onMalformedCredentialSelector)),
    spawnWorker: bindOptional("spawnWorker", hostApi.spawnWorker, () =>
      spawnWorkerPath(hostApi, confinement)),
    resolveMappedDriveRoot: resolveMappedDriveRootPath(hostApi),
    listAudioInputDevices: listAudioInputDevicesPath(hostApi),
    startAudioCapture: startAudioCapturePath(hostApi),
    attachFloatingPanel: attachFloatingPanelPath(hostApi),
    resizeFloatingPanel: resizeFloatingPanelPath(hostApi),
  };
}

/** Bind storage calls to this incarnation; child marshalling remains free of host state. */

export type StorageHostApi = Pick<PluginHostApi, "storage">;

/** Validate encodings at runtime with a typed exhaustive table. */
const STORAGE_ENCODINGS: Record<StorageEncoding, true> = {
  "utf-8": true,
  utf8: true,
  ascii: true,
  base64: true,
  base64url: true,
  hex: true,
  latin1: true,
  binary: true,
};

function reject(call: HostApiCall, index: number, expected: string): never {
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[host-api-dispatcher] '${call.path}' argument ${index} must be ${expected}`,
    { path: call.path, index },
  );
}

function stringArg(call: HostApiCall, index: number): string {
  const value = call.args[index];
  if (typeof value !== "string") reject(call, index, "a string");
  return value;
}

/** Omitted optional args stay absent; never send explicit undefined array elements. */
function optionalStringArg(call: HostApiCall, index: number): string | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "string") reject(call, index, "a string when present");
  return value;
}

function optionalEncodingArg(
  call: HostApiCall,
  index: number,
): StorageEncoding | undefined {
  const value = optionalStringArg(call, index);
  if (value === undefined) return undefined;
  // Only own keys are encodings; child-controlled prototype names must refuse.
  if (!Object.hasOwn(STORAGE_ENCODINGS, value)) {
    reject(call, index, `one of ${Object.keys(STORAGE_ENCODINGS).join(", ")}`);
  }
  return value as StorageEncoding;
}

function optionalIndentArg(call: HostApiCall, index: number): number | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(call, index, "a non-negative integer when present");
  }
  return value;
}

/** Refuse unknown rm options rather than silently drop them. */
function optionalRemoveOptionsArg(
  call: HostApiCall,
  index: number,
): { recursive?: boolean } | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(call, index, "an options object when present");
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "recursive" || typeof item !== "boolean") {
      reject(call, index, "an options object with only a boolean 'recursive'");
    }
  }
  return value as { recursive?: boolean };
}

/** Bind this incarnation over throwing defaults. */
export function createStorageHostApiPaths(
  hostApi: StorageHostApi,
): Record<DispatchedStorageHostApiPath, HostApiPathHandler> {
  // Return void-member results unchanged so the dispatcher can detect signature drift.
  return {
    /** Tag read bytes instead of allowing Buffer.toJSON to change their type. */
    "storage.read": defineHostApiPath("storage.read", async (call) =>
      encodeWireBytes(
        await hostApi.storage.read(stringArg(call, 0)),
        `${call.path}(result)`,
      ),
    ),

    "storage.readText": defineHostApiPath("storage.readText", (call) =>
      hostApi.storage.readText(stringArg(call, 0), optionalEncodingArg(call, 1)),
    ),

    // A missing file returns the declared null result.
    "storage.readJson": defineHostApiPath("storage.readJson", (call) =>
      hostApi.storage.readJson(stringArg(call, 0)),
    ),

    "storage.list": defineHostApiPath("storage.list", (call) =>
      hostApi.storage.list(optionalStringArg(call, 0)),
    ),

    "storage.exists": defineHostApiPath("storage.exists", (call) =>
      hostApi.storage.exists(stringArg(call, 0)),
    ),

    /** Tag write text separately from bytes; encoding options control interpretation after decoding. */
    "storage.write": defineHostApiPath("storage.write", (call) => {
      const relPath = stringArg(call, 0);
      const data = decodeWireBytes(call.args[1], `${call.path}(data)`);
      return hostApi.storage.write(relPath, data, optionalEncodingArg(call, 2));
    }),

    "storage.writeJson": defineHostApiPath("storage.writeJson", (call) => {
      const relPath = stringArg(call, 0);
      // Missing values must refuse before stringify or filesystem writes.
      if (call.args.length < 2) reject(call, 1, "present");
      return hostApi.storage.writeJson(relPath, call.args[1], optionalIndentArg(call, 2));
    }),

    "storage.rm": defineHostApiPath("storage.rm", (call) => {
      const relPath = stringArg(call, 0);
      return hostApi.storage.rm(relPath, optionalRemoveOptionsArg(call, 1));
    }),

    "storage.mkdir": defineHostApiPath("storage.mkdir", (call) =>
      hostApi.storage.mkdir(stringArg(call, 0)),
    ),

    /** Encryption unavailability has its own error code and must leave no plaintext on disk. */
    "storage.writeEncrypted": defineHostApiPath("storage.writeEncrypted", (call) => {
      const relPath = stringArg(call, 0);
      return hostApi.storage.writeEncrypted(relPath, stringArg(call, 1));
    }),

    "storage.readEncrypted": defineHostApiPath("storage.readEncrypted", (call) =>
      hostApi.storage.readEncrypted(stringArg(call, 0)),
    ),
  };
}

/** Host subscriptions share the ledger; handlers never write release frames themselves. */

export type ConfigSubscriptionHostApi = Pick<
  PluginHostApi,
  "config" | "onEvent" | "onPluginsChanged" | "onShutdown"
>;

/** Validate string arguments before config calls can persist a literal "undefined" key. */
function stringArgument(call: HostApiCall, index: number, name: string): string {
  const value = call.args[index];
  if (typeof value !== "string") {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[host-api-dispatcher] '${call.path}': ${name} must be a string`,
      { path: call.path, index },
    );
  }
  return value;
}

function requireArity(call: HostApiCall, arity: number): void {
  if (call.args.length !== arity) {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[host-api-dispatcher] '${call.path}': expected ${arity} arguments, received ${call.args.length}`,
      { path: call.path, arity, received: call.args.length },
    );
  }
}

/** Dispose a new host subscription if adopting its child ID fails. */
function adoptOrUndo(
  scope: SubscriptionScope,
  subscriptionId: string,
  unsubscribe: () => void,
): void {
  try {
    scope.adopt(subscriptionId, () => {
      unsubscribe();
    });
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

function openOrUndo(
  scope: SubscriptionScope,
  teardown: (reason: SubscriptionCloseReason) => void,
): string {
  try {
    return scope.open(teardown);
  } catch (error) {
    try { teardown("peer-gone"); } catch { /* preserve the registration refusal */ }
    throw error;
  }
}

/** config.get remains child-local; dispatch only members requiring a host round trip. */
export function createConfigSubscriptionHostApiPaths(
  hostApi: ConfigSubscriptionHostApi,
): Record<DispatchedConfigSubscriptionPath, HostApiPathHandler> {
  return {
    "config.set": defineHostApiPath("config.set", async (call) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      // Return host results unchanged so void drift and schema decisions stay observable.
      return hostApi.config.set(key, call.args[1]);
    }),

    "config.onChange": defineHostApiPath("config.onChange", async (call, scope) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      const subscriptionId = stringArgument(call, 1, "subscriptionId");
      const unsubscribe = hostApi.config.onChange(key, (value) => {
        // Encode secret changes explicitly because stringify silently drops Symbols.
        scope.deliver(subscriptionId, encodeConfigChange(key, value));
      });
      adoptOrUndo(scope, subscriptionId, unsubscribe);
      return { handleId: subscriptionId };
    }),

    onEvent: defineHostApiPath("onEvent", async (call, scope) => {
      requireArity(call, 2);
      const eventType = stringArgument(call, 0, "eventType");
      const subscriptionId = stringArgument(call, 1, "subscriptionId");
      // Keep event authorization in the host implementation; the child does not prefilter.
      const unsubscribe = hostApi.onEvent(eventType, (data) => {
        scope.deliver(subscriptionId, { data });
      });
      adoptOrUndo(scope, subscriptionId, unsubscribe);
      return { handleId: subscriptionId };
    }),

    onPluginsChanged: defineHostApiPath("onPluginsChanged", async (call, scope) => {
      requireArity(call, 1);
      const subscriptionId = stringArgument(call, 0, "subscriptionId");
      const unsubscribe = hostApi.onPluginsChanged((event) => {
        scope.deliver(subscriptionId, { event });
      });
      adoptOrUndo(scope, subscriptionId, unsubscribe);
      return { handleId: subscriptionId };
    }),

    /** Shutdown registrations are host-terminated and awaited once; the child cannot unregister a host shutdown list entry. */
    onShutdown: defineHostApiPath("onShutdown", async (call, scope) => {
      requireArity(call, 1);
      const subscriptionId = stringArgument(call, 0, "subscriptionId");
      let ended = false;
      // Adopt the ID before registering onShutdown because that API supplies no disposer.
      scope.adopt(subscriptionId, () => {
        ended = true;
      });
      // Return the host result so void-contract drift cannot be swallowed.
      return hostApi.onShutdown(async () => {
        if (ended) return;
        await scope.shutdown(subscriptionId);
      });
    }),
  };
}

/** Classify host errors by class, never message text; JSON does not preserve Error identity. */
export function classifyHostApiError(error: unknown): HostApiWireError {
  if (error instanceof CredentialLeaseError) {
    return { code: error.code, name: error.name, message: error.message, detail: error.detail };
  }
  if (error instanceof HostApiBoundaryError) {
    return {
      code: error.code,
      name: error.name,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.code === "rate-limited" && typeof error.detail?.retryAfterMs === "number"
        ? { retryAfterMs: error.detail.retryAfterMs } : {}),
    };
  }
  if (error instanceof EffectBoundaryDeniedError) {
    return {
      code: "effect-boundary-denied",
      name: error.name,
      message: error.message,
      detail: {
        pluginId: error.pluginId,
        methodPath: error.methodPath,
        target: error.target ?? null,
        reason: error.reason,
      },
    };
  }
  if (error instanceof ManifestIntegrityError) {
    return {
      code: "manifest-integrity-violation",
      name: error.name,
      message: error.message,
      detail: {
        pluginId: error.pluginId,
        toolName: error.toolName,
        attemptedMethod: error.attemptedMethod,
      },
    };
  }
  if (error instanceof PluginRuntimeDetachedOperationError) {
    // Keep settlement promises host-side; the child only learns that the call detached.
    return {
      code: "detached-operation",
      name: error.name,
      message: error.message,
    };
  }
  if (error instanceof PluginStorageEncryptionUnavailableError) {
    return {
      code: "plugin-storage-encryption-unavailable",
      name: error.name,
      message: error.message,
      detail: { pluginId: error.pluginId },
    };
  }
  if (error instanceof PluginStorageError) {
    return {
      code: "plugin-storage",
      name: error.name,
      message: error.message,
      detail: { pluginId: error.pluginId, attemptedPath: error.attemptedPath },
    };
  }
  return {
    code: "host-internal",
    name: error instanceof Error ? error.name : "Error",
    message: "Host request failed.",
    detail: { kind: transportFailureKind(error) },
  };
}

function transportFailureKind(error: unknown): "dns" | "tls" | "connect" | "timeout" | "aborted" | "other" {
  if (!(error instanceof Error)) return "other";
  const code = (error as Error & { code?: unknown }).code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "tls";
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return "connect";
  if (code === "ETIMEDOUT") return "timeout";
  if (error.name === "AbortError") return "aborted";
  return "other";
}

export const UNKNOWN_FIELD_REPORTS_MAX = 32;

const UNKNOWN_FIELD_NAME_MAX = 64;

/** Bound names by code points and stop early so attacker input cannot split surrogate pairs or force long scans. */
function shownFieldName(field: string): string {
  let shown = "";
  let count = 0;
  for (const point of field) {
    if (count === UNKNOWN_FIELD_NAME_MAX) return `${shown}…`;
    shown += point;
    count += 1;
  }
  return field;
}

export type UnknownFieldReport =
  | { readonly kind: "field"; readonly method: string; readonly field: string }
  | { readonly kind: "suppressed"; readonly limit: number };

export interface HostApiDispatcherOptions {
  readonly pluginId: string;
  /** Keep the host liveness check inside the dispatcher; the child cannot bypass it. */
  readonly isActive: () => boolean;
  readonly notifications: ChildNotificationSink;
  /** The transport owns shutdown request correlation and timeout; dispatch supplies only the registration ID. */
  readonly shutdownChild: (subscriptionId: string) => Promise<void>;
  /** Require a host log sink so forwarded child diagnostics cannot disappear silently. */
  readonly log: (message: string, meta?: unknown) => void;
  /** Keep host connection diagnostics separate from plugin-authored log text and bound attacker-controlled dedup state. */
  readonly reportUnknownField: (report: UnknownFieldReport) => void;
  /** Host-owned, coalesced diagnostics. The callback must not include caller payloads. */
  readonly reportBudgetAudit?: (entry: HostApiBudgetAudit) => void;
  readonly table?: Record<HostApiPath, HostApiPathHandler>;
  /** Connections without invocation tracking must refuse tokens rather than fabricate authority. */
  readonly invocations?: HostInvocationTable;
}

interface HostInvocationTable {
  /** Resolve both live and retained invocation contexts; missing or evicted tokens refuse without weaker gating. */
  resolve(token: string): InvocationContextRunner | undefined;
  toolCallsInFlight(): number;
}

function invocationTokenOf(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const token = (meta as Record<string, unknown>)[INVOCATION_META];
  return typeof token === "string" ? token : undefined;
}

class HostApiRateLimitError extends HostApiBoundaryError {
  constructor(method: string, retryAfterMs: number, readonly bucket: string) {
    super("rate-limited", "Host API rate limit exceeded.", { method, retryAfterMs });
  }
}

export class HostApiDispatcher {
  private readonly table: Record<HostApiPath, HostApiPathHandler>;
  private readonly budgets: HostApiBudgets;
  private readonly subscriptions = new SubscriptionLedger<HostSubscription>(
    "host-api-dispatcher",
  );
  /** Retain a controller exactly for each in-flight request; child death aborts every operation. */
  private readonly inFlight = new Map<string, AbortController>();
  private readonly pendingSubscriptions = new Map<HostApiPath, number>();
  private pendingSubscriptionCount = 0;
  private readonly reportedUnknownFields = new Set<string>();
  private unknownFieldsSuppressed = false;
  private readonly warnedTokenlessPaths = new Set<HostApiPath>();

  constructor(private readonly options: HostApiDispatcherOptions) {
    this.table = options.table ?? HOSTAPI_DISPATCH_TABLE;
    this.budgets = new HostApiBudgets(options.pluginId, options.reportBudgetAudit ?? (() => {}));
  }

  get openSubscriptionCount(): number {
    return this.subscriptions.openCount;
  }

  async handle(request: HostApiRequest): Promise<HostApiReply> {
    const { id } = request;
    const key = String(id);
    const path = typeof request.method === "string" ? hostApiPathOf(request.method) : undefined;
    // Refuse duplicate live request IDs because replies and cancellation would be ambiguous.
    if (this.inFlight.has(key)) {
      return this.errorReply(
        id,
        new HostApiBoundaryError(
          "argument-marshalling-rejected",
          `[host-api-dispatcher] request id '${key}' is already in flight`,
        ),
        path,
      );
    }
    if (path === "emitEvent" || path === "logEvent") {
      if (this.budgets.take(path) > 0 || this.inFlight.size >= DISPATCH_IN_FLIGHT_MAX) {
        this.budgets.deny(path, "rate-limited", path);
        return { jsonrpc: "2.0", id, result: null };
      }
    } else {
      if (this.inFlight.size >= DISPATCH_IN_FLIGHT_MAX) {
        return this.errorReply(id, this.rateLimited(path, 100, "in-flight"), path);
      }
      if (path !== undefined) {
        const retryAfterMs = this.budgets.take(path);
        if (retryAfterMs > 0) {
          return this.errorReply(id, this.rateLimited(path, retryAfterMs, path), path);
        }
      }
    }
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    let reservation: { active: boolean; release: () => void; consume: () => void } | undefined;
    try {
      const { handler, args } = this.resolve(request);
      if (handler.contract.lifetime !== "none") {
        reservation = this.reserveSubscription(handler.path);
      }
      const invoke = () => handler.invoke(
        { path: handler.path, args, signal: controller.signal },
        this.scopeFor(handler.path, reservation, request.id),
      );
      const token = invocationTokenOf(request.params);
      const value = await (token === undefined
        ? this.runTokenless(handler.path, args, invoke)
        : this.runInInvocation(handler.path, token, invoke));
      // JSON-RPC requires result; void or absent values cross as null.
      return { jsonrpc: "2.0", id, result: this.checkResult(handler, value) ?? null };
    } catch (error) {
      return this.errorReply(id, error, path);
    } finally {
      reservation?.release();
      this.inFlight.delete(key);
    }
  }

  /** Tokenless work runs outside invocation context; warn on gated writes while tool calls are in flight. */
  private runTokenless<R>(path: HostApiPath, args: readonly unknown[], invoke: () => R): R {
    // Fetch gates its verb inline; use checked args only to select diagnostics.
    const rawMethod = path === "hostFetch" ? (args[1] as { method?: unknown } | undefined)?.method : undefined;
    const isFetchWrite = path === "hostFetch"
      && methodEffect(typeof rawMethod === "string" && rawMethod.length > 0 ? rawMethod : "GET") === "write";
    if (GATED_EFFECT_PATHS.has(path) || isFetchWrite) {
      const toolCallsInFlight = this.options.invocations?.toolCallsInFlight() ?? 0;
      if (toolCallsInFlight > 0 && !this.warnedTokenlessPaths.has(path)) {
        this.warnedTokenlessPaths.add(path);
        log.warn(
          { pluginId: this.options.pluginId, path, toolCallsInFlight },
          "a gated hostApi write arrived without an invocation token while a tool call was in flight; it runs outside any invocation",
        );
      }
    }
    return runOutsideInvocation(invoke);
  }

  /** A named invocation must resolve or the request refuses. */
  private runInInvocation<R>(path: HostApiPath, token: string, invoke: () => R): R {
    const inInvocation = this.options.invocations?.resolve(token);
    if (inInvocation === undefined) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-dispatcher] '${path}' names an invocation this connection does not hold`,
      );
    }
    return inInvocation(invoke);
  }

  /** Accept only declared child notification kinds; dispatch release, cancellation and logs through their owners. */
  handleNotification(notification: HostApiNotification): void {
    if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.log) {
      if (this.budgets.take("notifications/ave/log") > 0) {
        this.budgets.deny("notifications/ave/log", "rate-limited", "logEvent");
        return;
      }
      // Preserve plugin log content; only host attribution is added.
      this.options.log(notification.params.message, notification.params.meta);
      return;
    }
    if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.subscriptionRelease) {
      // The child already disposed its side, so host cleanup sends no close back.
      this.subscriptions.close(notification.params.subscriptionId, "disposed");
      return;
    }
    if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.cancelled) {
      // Cancellation targets in-flight requests only, never registration IDs; preserve AbortError identity.
      const { requestId, reason } = notification.params;
      this.inFlight.get(String(requestId))?.abort(
        new DOMException(
          `[host-api-dispatcher] request '${String(requestId)}' cancelled by the plugin`
            + (typeof reason === "string" ? `: ${reason}` : ""),
          "AbortError",
        ),
      );
    }
  }

  /** Child loss aborts requests and releases every host registration without waiting for cooperation. */
  childGone(): number {
    for (const controller of this.inFlight.values()) {
      controller.abort(new DOMException("[host-api-dispatcher] the child is gone", "AbortError"));
    }
    this.inFlight.clear();
    this.warnedTokenlessPaths.clear();
    this.budgets.end();
    const closed = this.subscriptions.end("peer-gone");
    this.pendingSubscriptions.clear();
    this.pendingSubscriptionCount = 0;
    return closed;
  }

  private errorReply(id: JsonRpcRequestId, error: unknown, path?: HostApiPath): HostApiReply {
    const classified = classifyHostApiError(error);
    this.budgets.deny(path ?? "<unknown>", classified.code,
      error instanceof HostApiRateLimitError ? error.bucket : undefined);
    return { jsonrpc: "2.0", id, error: toHostApiRpcError(classified) };
  }

  private rateLimited(path: HostApiPath | undefined, retryAfterMs: number, bucket: string): HostApiBoundaryError {
    return new HostApiRateLimitError(path ?? "<unknown>", retryAfterMs, bucket);
  }

  private ensureSubscriptionCapacity(path: HostApiPath): void {
    if (this.subscriptions.openCount + this.pendingSubscriptionCount >= DISPATCH_SUBSCRIPTIONS_MAX) {
      throw this.rateLimited(path, 100, "subscriptions");
    }
    const kindMax = DISPATCH_SUBSCRIPTION_KIND_MAX[path];
    if (kindMax !== undefined && this.subscriptions.countWhere((entry) => entry.path === path)
      + (this.pendingSubscriptions.get(path) ?? 0) >= kindMax) {
      throw this.rateLimited(path, 100, path);
    }
  }

  private reserveSubscription(path: HostApiPath): { active: boolean; release: () => void; consume: () => void } {
    this.ensureSubscriptionCapacity(path);
    this.pendingSubscriptionCount += 1;
    this.pendingSubscriptions.set(path, (this.pendingSubscriptions.get(path) ?? 0) + 1);
    const reservation = {
      active: true,
      release: () => {
        if (!reservation.active) return;
        reservation.active = false;
        if (this.subscriptions.isEnded) return;
        this.pendingSubscriptionCount -= 1;
        const count = (this.pendingSubscriptions.get(path) ?? 1) - 1;
        if (count === 0) this.pendingSubscriptions.delete(path);
        else this.pendingSubscriptions.set(path, count);
      },
      consume: () => reservation.release(),
    };
    return reservation;
  }

  private resolve(request: HostApiRequest): {
    readonly handler: HostApiPathHandler;
    readonly args: unknown[];
  } {
    const path = hostApiPathOf(request.method);
    if (path === undefined) {
      throw new HostApiBoundaryError(
        "path-unknown",
        `[host-api-dispatcher] '${String(request.method)}' is not a hostApi method`,
      );
    }
    if (!this.options.isActive()) {
      throw new HostApiBoundaryError(
        "plugin-inactive",
        inactiveHostApiMessage(this.options.pluginId, `hostApi.${path}`),
      );
    }
    // Omitted params means an empty object; null, arrays and scalars still refuse.
    const params = request.params === undefined ? {} : request.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-dispatcher] '${path}': params is not an object`,
      );
    }
    const nonJson = describeNonJson(params, `${path}(params)`);
    if (nonJson) {
      throw new HostApiBoundaryError(
        "argument-marshalling-rejected",
        `[host-api-dispatcher] ${nonJson}`,
      );
    }
    const { args, unknownFields } = hostApiArgsOf(path, params);
    for (const field of unknownFields) this.reportUnknownField(request.method, field);
    return { handler: this.table[path], args };
  }

  private reportUnknownField(method: string, field: string): void {
    if (this.unknownFieldsSuppressed) return;
    const shown = shownFieldName(field);
    const key = `${method}\u0000${shown}`;
    if (this.reportedUnknownFields.has(key)) return;
    if (this.reportedUnknownFields.size >= UNKNOWN_FIELD_REPORTS_MAX) {
      this.unknownFieldsSuppressed = true;
      this.options.reportUnknownField({ kind: "suppressed", limit: UNKNOWN_FIELD_REPORTS_MAX });
      return;
    }
    this.reportedUnknownFields.add(key);
    this.options.reportUnknownField({ kind: "field", method, field: shown });
  }

  /** Validate every outgoing result as JSON and enforce its declared wire shape. */
  private checkResult(handler: HostApiPathHandler, value: unknown): unknown {
    const { result } = handler.contract;
    if (result === "void") {
      if (value !== undefined) {
        throw new HostApiBoundaryError(
          "result-marshalling-rejected",
          `[host-api-dispatcher] '${handler.path}' declares no result but returned one`,
        );
      }
      return undefined;
    }
    if (result === "handle" && !isHandle(value)) {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-dispatcher] '${handler.path}' must resolve { handleId: string }`,
      );
    }
    if (result === "handle-or-denied" && (
      value === null || typeof value !== "object"
      || ((value as { ok?: unknown }).ok === true && !isHandle(value))
      || ((value as { ok?: unknown }).ok === false && Object.hasOwn(value, "handleId"))
      || ((value as { ok?: unknown }).ok !== true && (value as { ok?: unknown }).ok !== false)
    )) {
      throw new HostApiBoundaryError("result-marshalling-rejected", "Credential resolve result has an invalid handle.");
    }
    const nonJson = describeNonJson(value, `${handler.path}(result)`);
    if (nonJson) {
      throw new HostApiBoundaryError(
        "result-marshalling-rejected",
        `[host-api-dispatcher] ${nonJson}`,
      );
    }
    return value;
  }

  private scopeFor(
    path: HostApiPath,
    reservation: { active: boolean; consume: () => void } | undefined,
    requestId: JsonRpcRequestId,
  ): SubscriptionScope {
    /** Only host revocation sends subscription-closed; local disposal and peer loss need no reply. */
    const release = (
      subscription: HostSubscription,
      reason: SubscriptionCloseReason,
      subscriptionId: string,
    ) => {
      subscription.teardown(reason);
      if (reason !== "revoked") return;
      const deliver = () => {
        if (this.subscriptions.isEnded) return;
        this.options.notifications.deliver({
          jsonrpc: "2.0",
          method: HOST_PROTOCOL_NOTIFICATIONS.subscriptionClosed,
          params: { subscriptionId, reason },
        });
      };
      // Queue lease revocation behind the resolve reply so the child can adopt its handle first.
      if (path === "resolveApiKey") setImmediate(deliver);
      else deliver();
    };
    return {
      adopt: (subscriptionId, teardown) => {
        if (!reservation?.active) this.ensureSubscriptionCapacity(path);
        this.subscriptions.adopt(subscriptionId, { path, teardown }, release);
        reservation?.consume();
      },
      open: (teardown) => {
        if (!reservation?.active) this.ensureSubscriptionCapacity(path);
        const subscriptionId = path === "spawnWorker"
          ? workerSubscriptionIdOfRequest(requestId)
          : this.subscriptions.open({ path, teardown }, release);
        if (path === "spawnWorker") {
          this.subscriptions.adopt(subscriptionId, { path, teardown }, release);
        }
        reservation?.consume();
        return subscriptionId;
      },
      release: (subscriptionId) => this.subscriptions.close(subscriptionId, "revoked"),
      shutdown: (subscriptionId) => this.options.shutdownChild(subscriptionId),
      deliver: (subscriptionId, payload) => {
        if (!this.subscriptions.get(subscriptionId)) {
          throw new HostApiBoundaryError(
            "subscription-unknown",
            `[host-api-dispatcher] no open subscription '${subscriptionId}'`,
          );
        }
        this.options.notifications.deliver({
          jsonrpc: "2.0",
          method: HOST_PROTOCOL_NOTIFICATIONS.subscription,
          params: { subscriptionId, payload },
        });
      },
    };
  }
}

function isHandle(value: unknown): value is HostApiHandle {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as HostApiHandle).handleId === "string"
  );
}
