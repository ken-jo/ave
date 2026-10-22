/**
 * The host end of the reverse channel: one message off the wire becomes one
 * hostApi call, or a loud refusal
 * (`docs/blueprints/plugin-process-isolation.md` §2.2, §3).
 *
 * Everything the plugin can reach becomes a message the host services here.
 * `instrumentEffectsByPath` stops being "a wrapper we hope is total, guarded by
 * a completeness test" and becomes the only way in — but only if this file
 * refuses everything it does not recognise. So every failure mode below is a
 * throw with a code, never a default value and never a silent skip:
 *
 *   - a member with no handler yet          → `path-not-implemented`
 *   - a member the child should have answered locally → `path-not-dispatchable`
 *   - a member that does not exist          → `path-unknown`
 *   - arguments or a result that would not survive JSON → refused, not coerced
 *
 * The child never names itself: the dispatcher is constructed per child, for
 * the plugin and generation that child was spawned for, so every request on its
 * pipe IS that plugin (`docs/design/plugin-hostapi-protocol.md` §2.4). A params
 * field the member does not declare — a forged `pluginId` among them — is
 * reported and ignored, never read.
 *
 * That last one applies `describeNonJson` — the same predicate
 * `LoopbackTransport` now uses on the host→plugin direction — to the direction
 * that transport does not carry. hostApi traffic never passes through it, so
 * without this check the reverse channel would be exactly the boundary §3.6
 * describes: one that looks like a wire and passes object references.
 *
 * ONE MODULE BECAUSE IT IS ONE TABLE. `HOSTAPI_DISPATCH_TABLE` names every
 * member of the contract SOT exactly once, and the handler factories below fill
 * entries in it. The factories used to sit in four sibling files split by
 * category — interaction, service, storage, config-and-subscription — but the
 * categories were a filing label, not a boundary: all four build
 * `HostApiPathHandler`s out of {@link defineHostApiPath}, all four are spread
 * over this one table in a single expression in `out-of-process-plugin.ts`, and
 * nothing else imports any of them. The split that IS real is host vs child,
 * because it is two processes.
 *
 * HOST-SIDE ONLY. This imports the real host error classes to classify a throw
 * by identity rather than by matching its message; several of them reach
 * Electron through the approval gate, which is exactly why the child imports
 * `host-api-wire.ts` instead of this file.
 */
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

/** Runs a function inside one captured async context (`AsyncLocalStorage.snapshot()`). */
export type InvocationContextRunner = <R>(fn: () => R) => R;

/**
 * The async context in which no store is entered. It is captured when this
 * module is evaluated, during boot: `main.ts` loads `desktop-boot.js`, and
 * with it this module, before any tool invocation exists. The guard below
 * makes evaluating it inside an invocation fail loudly instead of capturing
 * that invocation as "outside".
 *
 * A request from a child arrives on the pipe's data callback. That callback
 * runs in the context that was current when the child was SPAWNED, not in a
 * neutral one. A child restarted from inside a tool call (`config.set` →
 * `restartPlugin`) would otherwise run every tokenless request of its whole
 * generation in that finished invocation: a headless invocation's deny, a
 * foreground invocation's allow-once grants and session attribution, its
 * effect ledger. It would also inherit lifecycle stores such as the install
 * locks. Anything that is not an invocation's runs here.
 */
const OUTSIDE_INVOCATION: InvocationContextRunner = (() => {
  // App-only tools have an origin frame but do not enter the executor's gate.
  if (currentEffectGateContext() !== undefined || currentInvocationOrigin() !== undefined) {
    throw new Error(
      "[host-api-dispatcher] evaluated inside a tool invocation; the outside-invocation context cannot be captured here",
    );
  }
  return AsyncLocalStorage.snapshot();
})();

/** Run `fn` with no invocation and no other async-context store entered. */
export function runOutsideInvocation<R>(fn: () => R): R {
  return OUTSIDE_INVOCATION(fn);
}

/** One inbound invocation, after its method and params have been checked. */
export interface HostApiCall {
  readonly path: HostApiPath;
  /**
   * Positional arguments, mapped back from the params object by the contract's
   * `params` axis — already JSON, marshalled per contract.
   */
  readonly args: readonly unknown[];
  /**
   * The host's controller for THIS request, aborted by the child's
   * `notifications/cancelled` naming it or by the child going away (§3.5). The
   * members that take an `AbortSignal` hand it to the host implementation.
   */
  readonly signal: AbortSignal;
}

/** A live host-side registration, held for as long as the child holds its side. */
export interface HostSubscription {
  readonly path: HostApiPath;
  /** Undo the host-side registration. Runs exactly once. */
  readonly teardown: (reason: SubscriptionCloseReason) => void;
}

/**
 * What a lifetime-bearing handler is handed so it does not have to invent its
 * own bookkeeping. Six members need this; six implementations of it would be six
 * chances to leak.
 */
export interface SubscriptionScope<Event = unknown> {
  /** Register under the id the CHILD allocated (subscriptions). */
  adopt(subscriptionId: string, teardown: (reason: SubscriptionCloseReason) => void): void;
  /** Register under a host-allocated id and return it (worker handles, key leases). */
  open(teardown: (reason: SubscriptionCloseReason) => void): string;
  /**
   * Push a payload to the child's handler for this registration. `Event` is the
   * member's entry in `HostApiEventPayloads`, which the published schema
   * documents; `never` for a member that pushes nothing.
   */
  deliver(subscriptionId: string, payload: Event): void;
  /**
   * End one registration from the host side. A handler calls this when the work
   * it was tracking is over — the exited worker behind a handle, a lease the
   * host is taking back.
   *
   * Closes as `revoked`, which is the reason that reaches the child: a host
   * decision is the only one of the three the child cannot already know about.
   * That is what makes a lease the host drops stop being spendable in the
   * child, instead of a comment claiming it does.
   */
  release(subscriptionId: string): boolean;
  /**
   * Run the child's `onShutdown` handler registered under `subscriptionId`,
   * and settle when it has — `ave/instance/shutdown`, a request the owner
   * bounds (§3.4).
   */
  shutdown(subscriptionId: string): Promise<void>;
}

/** What a handler may resolve with, derived from its declared `result` axis. */
type WireResultFor<C extends HostApiPathContract> = C["result"] extends "void"
  ? void
  : C["result"] extends "handle"
    ? HostApiHandle
    : C["result"] extends "child-local"
      ? never
      : unknown;

/**
 * The invoke signature a handler must have, DERIVED from its contract — which
 * is what stops four authors writing four differently-shaped handlers. A
 * `lifetime: "none"` member is not given a subscription scope it would have no
 * use for; a lifetime-bearing one cannot forget to take it.
 */
export type HostApiPathInvoke<C extends HostApiPathContract, Event = never> =
  C["lifetime"] extends "none"
    ? (call: HostApiCall) => Promise<WireResultFor<C>>
    : (call: HostApiCall, scope: SubscriptionScope<Event>) => Promise<WireResultFor<C>>;

/** What `P` pushes to its registration, or `never` for a member that pushes nothing. */
type EventPayloadOf<P extends HostApiPath> = P extends keyof HostApiEventPayloads
  ? HostApiEventPayloads[P]
  : never;

/**
 * How complete one table entry is. Read by the contract test, and by
 * {@link hostProtocolCapabilities}, which is how it reaches the wire.
 */
export type HostApiPathStatus = "implemented" | "unimplemented" | "child-local";

/**
 * The `ave/host/*` methods a bound table serves: its `implemented` entries,
 * as method names (§3.2).
 *
 * Read from the table the connection's dispatcher actually uses, never from
 * {@link HOSTAPI_DISPATCH_TABLE}, which marks every path unimplemented or
 * child-local. So a host build without an optional member does not advertise
 * it, and a child-local path is never a method.
 */
export function hostProtocolCapabilities(
  table: Record<HostApiPath, HostApiPathHandler>,
): string[] {
  return (Object.keys(table) as HostApiPath[])
    .filter((path) => table[path].status === "implemented")
    .map((path) => hostApiMethodOf(path))
    .sort();
}

/** One entry of the dispatch table. */
export interface HostApiPathHandler {
  readonly path: HostApiPath;
  readonly contract: HostApiPathContract;
  readonly status: HostApiPathStatus;
  invoke(call: HostApiCall, scope: SubscriptionScope): Promise<unknown>;
}

/**
 * Declare a handler for one member. The contract comes from the shared SOT, so
 * the handler cannot claim a marshalling the child does not expect, and
 * `invoke`'s signature is derived from that contract.
 */
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

/**
 * A member whose handler has not been written yet.
 *
 * It THROWS. A stub that resolved `undefined` would let a plugin read a missing
 * secret as "no secret", a missing preference as "unset", and a failed write as
 * a success — three silent wrong answers that no test would catch, because the
 * call succeeded.
 */
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

/** The members whose contract says the child answers without a round trip. */
type ChildLocalPath = {
  [P in HostApiPath]: ContractOf<P>["result"] extends "child-local" ? P : never;
}[HostApiPath];

/**
 * A member the child answers locally — from a pure computation or a host-pushed
 * snapshot. A request for one means the child stub is wrong, so it is refused
 * rather than serviced: servicing it would hide the divergence and make the
 * round-trip-free decision untrue in a way nothing would report.
 */
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

/**
 * Every member, and who answers it.
 *
 * `Record<HostApiPath, …>` makes a MISSING member a compile error — a member
 * added to the contract SOT without an entry here cannot reach a build. The
 * other direction (a member in the effect SOT with no contract) is pinned by
 * the contract test.
 *
 * Filling one in is a one-line change: replace `unimplementedHostApiPath("x")`
 * with `defineHostApiPath("x", async (call) => …)`.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// Interaction handlers: what puts something in front of the user
// ─────────────────────────────────────────────────────────────────────────

/**
 * The members that put something in front of the USER, or decide whether an
 * action is permitted (`docs/blueprints/plugin-process-isolation.md` §3).
 *
 * Seven of the 36: `openExternalUrl`, `openAuthWindow`,
 * `openAuthPartitionViewer`, `clearAuthPartition`, `triggerConversation`, and
 * the `agentApproval` pair. They are grouped because their failure modes differ
 * from a data read in one specific way:
 *
 *   A REFUSAL IS AN ANSWER. `agentApproval.request` resolves `"deny-once"`;
 *   `triggerConversation` resolves `{ accepted: false, reason }`. Both are
 *   values the plugin is expected to branch on, and neither is an error.
 *   A call that could not be DELIVERED — the gate threw, the window service is
 *   gone, the incarnation is retired — must therefore reject, never resolve
 *   with a refusal the user never gave. Collapsing the two would let a broken
 *   host read as a user who said no, and nothing downstream could tell.
 *
 * WHY THESE HANDLERS CALL `hostApi` AND VALIDATE NOTHING THEMSELVES. Every one
 * of these members already validates its own arguments host-side, and that
 * validation IS the security decision: `openExternalUrl` runs `validateExternalUrl`
 * and the webView-preference routing, `openAuthWindow` enforces the
 * `external-auth-consumer` capability and the per-plugin partition allow-list,
 * `clearAuthPartition` enforces the same partition rule, `triggerConversation`
 * runs the overlay gate, and `agentApproval.*` verifies the issuer registry and
 * the approved scope grant. A boundary check in front of any of them would be a
 * SECOND, weaker copy of a rule that lives somewhere else — the exact drift
 * §3.6 warns about. The boundary's own obligations are the ones the dispatcher
 * already discharges for every path: the method, the params mapping, the JSON
 * gate on arguments and results.
 *
 * WHY A FACTORY RATHER THAN STATIC TABLE ENTRIES. A handler has to reach the
 * plugin's own `hostApi` — the instance the effect recorder and the effect gate
 * have already wrapped for THIS plugin incarnation. `HostApiCall` carries
 * identity and arguments, not host state, so the binding can only be a closure.
 * The dispatcher composes the bound entries over `HOSTAPI_DISPATCH_TABLE` with
 * object spread, which is the mechanism its own tests already use.
 *
 * HOST-SIDE ONLY. This module reaches Electron through the approval gate; the
 * child's half of these members is `host-api-child.ts`, which imports neither.
 */

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
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

/**
 * `openAuthWindow` is TWO overloads over ONE implementation, and which applies
 * is decided by `returnFinalUrl` inside the host — `AuthWindowCookie[]` for the
 * cookie form, `{ cookies, finalUrl }` for the other. Both are plain JSON, so
 * the boundary carries whichever the host produced. Picking the branch here
 * would put a second copy of that decision on the wire, where it could disagree
 * with the host's.
 */
type OverloadedOpenAuthWindow = (options: unknown) => Promise<unknown>;

/**
 * Bind this group's handlers to one plugin incarnation's `hostApi`.
 *
 * Composed over the dispatch table by the caller that owns the child, so the
 * table keeps naming every member exactly once and an unbound member keeps its
 * throwing default.
 */
export function createInteractionHostApiPaths(
  hostApi: InteractionHostApi,
): Record<InteractionHostApiPath, HostApiPathHandler> {
  // The four `void`-declared members RETURN the host's promise rather than
  // awaiting and discarding it. Discarding would also discard a host that
  // started resolving a value, and the dispatcher's void check — the one thing
  // that catches the child's stub and the host's implementation disagreeing
  // about a member — would never see it. A drift is refused, not absorbed.
  return {
    // The host decides in-app window vs system browser from the live webView
    // preference and rejects a non-http(s) scheme; the child learns only that
    // it resolved, or which error it was.
    openExternalUrl: defineHostApiPath("openExternalUrl", (call) =>
      hostApi.openExternalUrl(call.args[0] as string),
    ),
    openAuthWindow: defineHostApiPath("openAuthWindow", async (call) => {
      const openAuthWindow = hostApi.openAuthWindow as unknown as OverloadedOpenAuthWindow;
      // `.call` keeps the receiver, because the instance handed here may be a
      // recorder/gate wrapper whose members are not free functions.
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
    // No owner argument crosses in either direction. The host binds the owner
    // from the incarnation this group was composed over, so a child that made
    // one up would be naming a field nobody reads.
    "authRedirect.open": defineHostApiPath("authRedirect.open", async () =>
      await hostApi.authRedirect.open(),
    ),
    // Blocks until the user finishes signing in, or until the host's own
    // timeout. No boundary deadline for the same reason `agentApproval.request`
    // has none: a call abandoned here would leave a bound port in the host with
    // nobody left to close it.
    "authRedirect.wait": defineHostApiPath("authRedirect.wait", async (call) =>
      await hostApi.authRedirect.wait(
        call.args[0] as { handle: string; timeoutMs?: number },
      ),
    ),
    "authRedirect.close": defineHostApiPath("authRedirect.close", (call) =>
      hostApi.authRedirect.close(call.args[0] as { handle: string }),
    ),
    // Blocks until the user answers the chooser, with no boundary deadline: a
    // dialog the user has not dismissed is not a stall, and abandoning the call
    // would leave a modal on screen that nobody is waiting for.
    pickFolders: defineHostApiPath("pickFolders", async () => await hostApi.pickFolders()),
    // `{ accepted: false, reason }` is a RESULT, not an error — the plugin is
    // documented to branch on `accepted`. A throw from here means the trigger
    // never reached the overlay at all.
    triggerConversation: defineHostApiPath("triggerConversation", async (call) =>
      hostApi.triggerConversation(call.args[0] as ConversationTriggerSpec),
    ),
    // Blocks on a human, for as long as the human takes. The boundary imposes
    // no call timeout of its own precisely so it cannot abandon a gate entry
    // that is still pending in the host (§7.5) — the gate's own timeout is the
    // only deadline, and it resolves `deny-once` as a VALUE.
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
    // Four positional arguments, the last two optional. `nonce` and `hmac` are
    // gate-issued strings echoed back verbatim; they survive JSON unchanged,
    // which is what lets the gate's confused-deputy check still work from a
    // different process.
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

// ─────────────────────────────────────────────────────────────────────────
// Service handlers: what reaches a host service
// ─────────────────────────────────────────────────────────────────────────

/**
 * The host handlers for the hostApi members that reach a host SERVICE
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2).
 *
 * Twelve members: network egress (`hostFetch`, `probePrivateHost`), the LLM
 * provider (`callLlm`), credentials (`getSecret`, `resolveApiKey`), the worker
 * supervisor (`spawnWorker`), the event bus (`emitEvent`), the audit log
 * (`logEvent`), the routine store (`hasRoutineBySource`), the Work Board
 * (`proposeWork`, `withdrawWorkProposal`), the alert pipeline
 * (`raiseAlert`, `withdrawAlert`) and the Windows
 * drive-mapping lookup (`resolveMappedDriveRoot`). Between them they
 * hold every member §3.2 classified as not JSON-representable, which is why the
 * marshalling work concentrates here.
 *
 * EVERY HANDLER CALLS THROUGH THE BOUND `hostApi`. That object is the
 * incarnation's own hostApi — effect-instrumented, effect-boundary-enforced,
 * liveness-bound — so the four-tier secret gate, the egress allow-list, the SSRF
 * resolution, the emit-denial audit and the worker's `pluginId` binding all run
 * exactly where they already run. Reaching past it to `runSecretGate` or
 * `net.fetch` would make the boundary a SECOND decision point for questions that
 * already have an authority, and a second decision point is a weaker one the
 * moment the two drift.
 *
 * WHY A FACTORY RATHER THAN STATIC TABLE ENTRIES. A handler has to reach THIS
 * incarnation's `hostApi`, and `HostApiCall` carries identity and arguments, not
 * host state — so the binding can only be a closure. The caller that owns the
 * child composes the bound entries over `HOSTAPI_DISPATCH_TABLE` by object
 * spread; the shipped table stays unbound, which is correct while nothing routes
 * out-of-process, and an unbound member keeps its throwing default.
 *
 * NOTHING HERE IS SHARED MACHINERY. The method and params mapping, the JSON
 * gate, the byte codec, the size cap, the per-request cancellation, the
 * subscription ledger and the error taxonomy are all the
 * foundation's, and these handlers consume them. What IS local is the
 * per-member argument shape — and those live in `host-api-wire.ts` because the
 * child needs the same declarations.
 *
 * HOST-SIDE ONLY. The child's half is `host-api-child.ts`, which imports neither
 * this module nor Electron.
 */

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
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

/**
 * How far a worker the CHILD asked for may reach.
 *
 * The child runs under an ASRT wrap whose filesystem grants are exactly these
 * two lists (`out-of-process-plugin.ts` derives them and hands the SAME object
 * to the wrap and to this check), and `PluginWorkerSpec` lets the caller name
 * its own `allowReadPaths` and `allowWritePaths`. In one heap those two facts
 * never met: the plugin and the worker supervisor were the same trust domain.
 * Across the boundary they are not, and a child that can ask the host to spawn
 * `/bin/sh` with `allowWritePaths: ["/"]` has escaped its jail by asking
 * someone else to hold the door — the confinement would be a property of one
 * process rather than of the plugin.
 *
 * So the envelope crosses with the binding, and a delegated worker's grants are
 * checked against it. Confinement composes: what the plugin cannot reach
 * itself, it cannot obtain by delegation.
 *
 * TWO LISTS RATHER THAN TWO NAMED DIRECTORIES. The pair used to be
 * `{ pluginRoot, pluginDataDir }`, which made the envelope's SIZE a constant of
 * the type: there was no way for the host to decide that one plugin's child
 * reaches further, so a plugin whose legitimate work lives outside those two
 * directories could not be isolated at all. Widening is a host decision
 * (the manifest's declared sandbox authority), and it belongs in the value, not in a second
 * check bolted onto the delegation path — widen the child and the delegated
 * worker composes with no further change, because both lists come from one
 * derivation.
 */
export interface DelegatedWorkerConfinement {
  /**
   * Every root the child may read.
   *
   * `derivePluginChildEnvelope` maintains it as a superset of {@link write} —
   * it pushes each admitted `userChosenDirectory` into both lists — and NOTHING
   * ENFORCES THAT, here or at runtime. It is relied on where a read grant is
   * argued from a write grant, and deliberately NOT relied on where the
   * consequence of it failing would be silent: `spawnConfinedPluginChild`
   * materialises both lists rather than `read` alone, precisely so a write-only
   * root that slipped past the invariant is still created before the wrap.
   */
  readonly read: readonly string[];
  /**
   * Every root the child may write.
   *
   * Every root this envelope GRANTS for writing, rather than every root the
   * child can reach: ASRT merges its own default write paths into every wrap
   * (axis 6 of the admission record in the history of
   * `out-of-process-plugins.ts`), and no grant here subtracts from
   * them. What matters for a delegated worker is that this list is the boundary
   * its `allowWritePaths` are checked against, and it is the same list the
   * plugin child's own wrap carries.
   */
  readonly write: readonly string[];
}

/** The purposes `resolveApiKey` accepts. Anything else is refused, not coerced. */
const RESOLVE_API_KEY_PURPOSES = ["llm", "stt", "embedding", "vision"] as const;
/** The vendors `resolveApiKey` accepts, when one is named at all. */
const RESOLVE_API_KEY_VENDORS = [
  "openai",
  "azure-openai",
  "vertex",
  "anthropic",
] as const;
/** The levels `logEvent` accepts. */
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

/**
 * Read a positional argument the contract declares as a string.
 *
 * The dispatcher has already proved the arguments survive JSON; it has NOT
 * proved they are the ones the member takes. A `getSecret(42)` would otherwise
 * reach the gate as a non-string key and be answered by whatever the gate's
 * string handling happens to do with a number.
 */
function requireString(call: HostApiCall, index: number, name: string): string {
  const value = call.args[index];
  if (typeof value !== "string") {
    rejectArgument(call.path, `${name} must be a string`);
  }
  return value;
}

/**
 * Bind an OPTIONAL hostApi member, or leave its path unimplemented.
 *
 * `hostFetch`, `resolveApiKey` and `spawnWorker` are `?`-optional on
 * `PluginHostApi` because older host builds predate them. On a build without
 * one, the honest answer is the boundary's "this host has no implementation",
 * not a `TypeError` from calling `undefined` — a plugin branching on
 * `typeof hostApi.hostFetch === "function"` in-process must get the same
 * verdict through the boundary.
 *
 * Decided once, when the table is bound, because the bound table is what
 * `construct` advertises (§3.2): a member decided per call would be advertised
 * by a host that then refuses it.
 */
function bindOptional(
  path: HostApiPath,
  member: unknown,
  bind: () => HostApiPathHandler,
): HostApiPathHandler {
  return typeof member === "function"
    ? bind()
    : unimplementedHostApiPath(path, `this host build has no '${path}'`);
}

/** Read a positional argument the contract declares as a plain object. */
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

// ───────────────────────────────────────────────────────────────────────────
// Credentials.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `getSecret(key) → Promise<string | null>`.
 *
 * The whole handler is a marshalling shim, and that is the point: the four-tier
 * gate, the audit vocabulary, the counter cardinality guard and the
 * endpoint-URL value check all stay in the host implementation. The boundary
 * adds a TYPE check on `key` and nothing else — a second allow-list here would
 * be a weaker copy of `runSecretGate` that the gate could drift away from.
 */
function getSecretPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("getSecret", async (call) =>
    hostApi.getSecret(requireString(call, 0, "key")),
  );
}

/** The registry has issued the id before this handler adopts it for child release. */
/**
 * `getAuthPartitionCookies(opts) → Array<{ url, cookies }>`.
 *
 * A credential READ, which is why it sits beside `getSecret` rather than with
 * the members that put something in front of the user: it prompts nobody and
 * refuses nobody, so it has no "the user said no" answer to distinguish from a
 * delivery failure. As with `getSecret`, the scoping that bounds it — own
 * partition only, intersected with the manifest allow-list — stays in the host
 * implementation; the boundary adds a shape check and nothing else.
 */
function getAuthPartitionCookiesPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("getAuthPartitionCookies", async (call) =>
    hostApi.getAuthPartitionCookies(
      call.args[0] as { partitionSub: string; urls: string[] },
    ),
  );
}

function resolveApiKeyPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("resolveApiKey", async (call, scope) => {
    // Called through the object, not a detached reference: that would lose the
    // hostApi proxy as its receiver, and the proxy is where the liveness and
    // effect wrappers live. Presence was settled when the table was bound.
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

// ───────────────────────────────────────────────────────────────────────────
// Network and LLM.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `hostFetch(input, init) → Response`.
 *
 * Neither direction crosses as itself. `init` arrives already reduced (headers
 * as entries, body as tagged bytes, no signal) and is rebuilt into a real
 * `RequestInit` so the host implementation sees the object an in-process plugin
 * would have passed — including the `method` the verb snapshot reads, which is
 * now a parsed JSON primitive rather than a getter the plugin could make
 * stateful — with the request's own cancellation signal in place of the
 * plugin's.
 *
 * The `Response` is drained under the boundary's ceiling and re-encoded through
 * the shared byte codec. Text would corrupt it: a body carrying invalid UTF-8,
 * a NUL, or high bytes survives base64 and does not survive a `text()` round
 * trip, and the corruption reads as success.
 */
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
    // Drained here, while the request is still in flight: a cancellation that
    // lands between the headers and the body aborts the read too, rather than
    // the body arriving for a request the plugin already gave up on.
    return (await encodeWireHttpResponse(
      response,
      `${call.path}(result)`,
    )) satisfies WireHttpResponse;
  });
}

/**
 * `callLlm(prompt, options) → Promise<string>`.
 *
 * Plain data apart from `options.signal`, which does not cross: the child's
 * `notifications/cancelled` names this request and aborts the controller the
 * dispatcher holds for it — so a cancel in the plugin reaches the provider call
 * rather than merely rejecting the child's promise.
 */
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

/** `probePrivateHost(host, opts?) → Promise<boolean>`. Plain data both ways. */
/**
 * `resolveMappedDriveRoot(drive) → Promise<string | null>`. Plain data both ways.
 *
 * The argument is coerced to a string and handed on WITHOUT a shape check here:
 * the host implementation validates the drive letter itself, and a second
 * validator in front of it would be a place for the two to disagree about what
 * a drive letter is.
 */
/** `listAudioInputDevices() → AudioCaptureDevice[]`. No arguments, plain data back. */
function listAudioInputDevicesPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("listAudioInputDevices", async () => hostApi.listAudioInputDevices());
}

/**
 * `startAudioCapture(request) → AudioCaptureHandle`.
 *
 * The same shape as `spawnWorker` and for the same reason: the host owns the
 * resource and must keep owning it. What crosses is
 * `{ handleId, captureId, opened }`; `stop()` becomes the release of that
 * registration, and `onFrame`/`onEnd` become host notifications the child fans
 * out to child-local listeners.
 *
 * WHY NOT THE EVENT BUS. Frames are addressed to the ONE plugin that started
 * the capture. `emitHostEvent` broadcasts to every installed plugin, so
 * delivering audio that way would hand all of them the microphone — the reason
 * a streaming capability that looks event-shaped is a handle here.
 *
 * The host listeners are registered EAGERLY, before this returns, because
 * audio produced between the start and the plugin's first `onFrame` call would
 * otherwise be lost, and the round trip makes that window far wider than it is
 * in-process.
 */
function startAudioCapturePath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("startAudioCapture", async (call, scope) => {
    const capture = await hostApi.startAudioCapture(call.args[0] as AudioCaptureRequest);

    let ended = false;
    let live = true;
    const handleId = openOrUndo(scope, () => {
      live = false;
      // A capture that already ended must not be stopped again: `stop()` is
      // idempotent on this side, but releasing twice is not.
      if (!ended) void capture.stop();
    });
    // Guarded at the push rather than at the end: `deliver` throws on an
    // unknown subscription, and a frame arriving after the handle was released
    // would turn a routine race into an exception inside a listener.
    const push = (payload: WireAudioCaptureEvent): void => {
      if (live) scope.deliver(handleId, payload);
    };
    capture.onFrame((frame) => {
      push({
        kind: "frame",
        seq: frame.seq,
        // Base64 because the wire is JSON. A `Uint8Array` put through it
        // arrives as an object with numeric keys — not an error anywhere, just
        // audio that decodes to noise.
        pcm: Buffer.from(frame.pcm).toString("base64"),
        peak: frame.peak,
      });
    });
    capture.onEnd((end) => {
      ended = true;
      push({ kind: "end", reason: end.reason, ...(end.detail === undefined ? {} : { detail: end.detail }) });
      // The capture is over, so the registration has nothing left to own.
      // Released here rather than left for `childGone` so a plugin that records
      // repeatedly does not accumulate host-side entries.
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
      // Releasing the handle IS the child's detach — the wire carries no
      // per-handle call channel, so `detach()` on the child side disposes the
      // subscription and this callback is what that means on the host side.
      // Guarded because a slot that already went away must not be detached
      // twice: `detach` is idempotent on the dock, but releasing is not.
      if (!detached) void panel.detach();
    });

    panel.onDetached((reason) => {
      detached = true;
      // Guarded at the push rather than at the end: `deliver` throws on an
      // unknown subscription, and a detach arriving after the handle was
      // released would turn a routine race into an exception in a listener.
      if (live) scope.deliver(handleId, { kind: "detached", reason } satisfies WireFloatingPanelEvent);
      // The slot is gone, so the registration has nothing left to own.
      // Released here rather than left for `childGone` so a plugin that
      // attaches repeatedly does not accumulate host-side entries.
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

// ───────────────────────────────────────────────────────────────────────────
// Worker supervision.
// ───────────────────────────────────────────────────────────────────────────

/** Read an optional `readonly string[]` field off the child-supplied spec. */
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

/**
 * Check one delegated grant list against the child's own envelope.
 *
 * Both sides are resolved first, so `<dataDir>/../../etc` is compared as what
 * it means rather than as what it says — and so an envelope root the host wrote
 * in one form is compared against a grant written in another. Resolving only
 * the grant left that asymmetry: on Win32 a POSIX-shaped root never prefixes a
 * drive-anchored target, so every delegable grant read as an escape. What is
 * deliberately NOT done here is a
 * `realpath` walk: the grant may name a directory the worker is about to
 * create, so the path need not exist. A symlink planted inside the data dir
 * therefore still points wherever it points. On Windows that is closed after
 * this check by granting the containing envelope root instead of the path
 * (`decodeWorkerSpec`, `outermostContainingRoots`), because `srt-win acl grant`
 * stamps its ACE on the link's target; on macOS and Linux the path goes to
 * ASRT's own normalisation, which this does not change.
 */
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

/**
 * Take a `PluginWorkerSpec` off the wire.
 *
 * Every other member in this file type-checks its arguments before handing them
 * on; this one used to cast a bare record straight into the spec, which put
 * child-controlled JSON into `spawn()`'s `command` with nothing in between. The
 * fields are checked because the boundary is where a malformed message is a
 * malformed message, and an unknown field is REFUSED rather than dropped — a
 * spec that gains a grant-shaped field must fail here until this decodes it,
 * not pass it through unexamined.
 */
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
  // The child's OWN ASRT grant set, member for member — not a restatement of
  // it. `spawnConfinedPluginChild` wraps the child with these very arrays, the
  // only addition being the throwaway sandbox HOME, which belongs to the host
  // process and is deliberately absent here because it is not the plugin's to
  // hand on. So there is no second policy to drift away from the jail, and a
  // host decision that widens the child widens what it may delegate in the same
  // edit rather than leaving a second list behind.
  assertGrantsWithinEnvelope(call, "allowReadPaths", allowReadPaths, confinement.read);
  assertGrantsWithinEnvelope(call, "allowWritePaths", allowWritePaths, confinement.write);
  // Windows: the worker's grant is an ACL that `srt-win` stamps on whatever the
  // path resolves to, junctions in any component followed — and every
  // component below an envelope root is the plugin's to re-point. So the grant
  // names the envelope root that contains each path, which the plugin cannot
  // (`outermostContainingRoots` says why that widens nothing there). The
  // lexical check above stays: it is what refuses a path outside the envelope.
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

/**
 * `spawnWorker(spec) → SpawnedPluginWorker`.
 *
 * A handle with four methods, none of which cross. The host keeps owning the
 * process — it must: the sandbox grant machinery, the wrapped-worker registry,
 * the Windows holder-PID ACL lifecycle and the managed-child registry all live
 * in main, and a grandchild spawned by the plugin's own process would sit
 * outside every grant keyed to a host-allocated path.
 *
 * What crosses is `{ handleId, socketPath, pid }`. `stop()` becomes the release
 * of that registration; `onStdout` / `onStderr` / `onExit` become host
 * notifications the child fans out to child-local listeners.
 *
 * The three host listeners are registered EAGERLY rather than on the child's
 * first subscribe, because output produced between the spawn and the plugin's
 * first `onStdout` call would otherwise be lost — in-process it is lost the same
 * way, but here the round trip makes the window far wider.
 *
 * WHAT THE GRANT CHECK DOES AND DOES NOT COVER. It bounds the worker's
 * filesystem grants by the child's own, so delegation cannot widen the jail.
 * `command` is deliberately NOT constrained: the worker executes under those
 * grants plus the shared deny floor, so naming a different binary reaches
 * nothing the grants do not already allow, and requiring the command to sit
 * inside the envelope would refuse a PATH-resolved runtime without closing
 * anything. `env` is likewise the plugin's to choose — it reaches the worker,
 * which is the plugin's own process either way.
 */
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
      // A worker that already exited must not be stopped: `stop()` signals a pid,
      // and a pid that has been reaped can belong to something else by then.
      if (!exited) worker.stop();
    });
    // Pushes stop at the release, not at the exit: `deliver` throws on an unknown
    // subscription, and a chunk arriving after the handle was released would turn
    // a routine race into an exception inside an event listener.
    const push = (payload: WireWorkerEvent): void => {
      if (live) scope.deliver(handleId, payload);
    };
    try {
      worker.onStdout((chunk) => push({ kind: "stdout", chunk }));
      worker.onStderr((chunk) => push({ kind: "stderr", chunk }));
      worker.onExit((info) => {
        exited = true;
        push({ kind: "exit", code: info.code, signal: info.signal });
        // The process is gone, so the registration has nothing left to own. Released
        // here rather than left for `childGone` so a plugin that spawns and lets
        // workers die does not accumulate host-side entries.
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

// ───────────────────────────────────────────────────────────────────────────
// Event bus, audit log, routine store.
// ───────────────────────────────────────────────────────────────────────────

/**
 * `emitEvent(type, data?) → void`.
 *
 * The child stub has already run its own `canEmitEvent` check so the plugin
 * still sees a SYNCHRONOUS throw on a denied event. This is the authoritative
 * one: it re-decides from the host's manifest and writes the denial audit. Both
 * run, and neither is a degraded substitute — the host check is the control, the
 * child check only preserves the contract's timing.
 *
 * The host's return value is RETURNED, not awaited and discarded. Both these
 * members are declared `void`, and the dispatcher's void check is the one thing
 * that catches the child's stub and the host's implementation disagreeing about
 * a member — a handler that swallowed the value would make that check
 * unreachable, so a drift would be absorbed instead of refused.
 */
function emitEventPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("emitEvent", async (call) =>
    hostApi.emitEvent(requireString(call, 0, "eventType"), call.args[1]),
  );
}

/** `logEvent(level, message, data?) → void`. Returns the host's value, as above. */
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

/**
 * `hasRoutineBySource(source) → Promise<boolean>`.
 *
 * The `suggestion:<callerPluginId>:` prefix rule is enforced by the host
 * implementation, which knows the caller's id from the incarnation it was built
 * for. Re-checking it here would need the boundary to learn the same rule, and
 * two copies of a least-privilege prefix is one copy too many.
 */
function hasRoutineBySourcePath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("hasRoutineBySource", async (call) =>
    hostApi.hasRoutineBySource(requireString(call, 0, "source")),
  );
}

/**
 * `proposeWork(input) → Promise<WorkProposalResult>`.
 *
 * The whole decision — is this kind granted, is the slot free, is the payload
 * well formed — belongs to the host implementation, which knows the caller's
 * id and its manifest from the incarnation it was built for. The boundary
 * checks only that an object arrived, because re-deriving the grant here would
 * put a second copy of the authorization rule on the wire.
 */
function proposeWorkPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("proposeWork", async (call) => {
    const input = call.args[0];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      rejectArgument(call.path, "input must be an object");
    }
    return hostApi.proposeWork(input as Parameters<ServiceHostApi["proposeWork"]>[0]);
  });
}

/** `withdrawWorkProposal(kind, key) → Promise<boolean>`. */
function withdrawWorkProposalPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("withdrawWorkProposal", async (call) =>
    hostApi.withdrawWorkProposal(
      requireString(call, 0, "kind"),
      requireString(call, 1, "key"),
    ),
  );
}

/**
 * `raiseAlert(input) → Promise<AlertResult>`.
 *
 * As with `proposeWork`, the grant, the slot shapes and every budget are the
 * host implementation's; the boundary checks only that an object arrived.
 */
function raiseAlertPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("raiseAlert", async (call) => {
    const input = call.args[0];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      rejectArgument(call.path, "input must be an object");
    }
    return hostApi.raiseAlert(input as Parameters<ServiceHostApi["raiseAlert"]>[0]);
  });
}

/** `withdrawAlert(kind, key) → Promise<boolean>`. */
function withdrawAlertPath(hostApi: ServiceHostApi): HostApiPathHandler {
  return defineHostApiPath("withdrawAlert", async (call) =>
    hostApi.withdrawAlert(
      requireString(call, 0, "kind"),
      requireString(call, 1, "key"),
    ),
  );
}

/**
 * Bind this group's handlers to one plugin incarnation's `hostApi`.
 *
 * Composed over the dispatch table by the caller that owns the child, so the
 * table keeps naming every member exactly once and an unbound member keeps its
 * throwing default.
 */
export function createServiceHostApiPaths(
  hostApi: ServiceHostApi,
  /**
   * The child's own filesystem envelope, so a worker it delegates cannot be
   * granted more than the child holds. Required rather than optional: an
   * omitted envelope would silently mean "unbounded", which is the exact
   * default this exists to remove.
   */
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

// ─────────────────────────────────────────────────────────────────────────
// Storage handlers: `hostApi.storage.*`
// ─────────────────────────────────────────────────────────────────────────

/**
 * The host end of `hostApi.storage.*`: eleven dispatchable members, one shape
 * (`docs/blueprints/plugin-process-isolation.md` §3.2).
 *
 * The twelfth, `storage.resolve`, is not here — its contract says `child-local`
 * and the dispatcher refuses it, so the child's copy of the lexical join
 * (`plugin-storage-containment.ts`) is the whole implementation.
 *
 * WHY THE GROUP IS WRITTEN TOGETHER. read/write × raw/text/json/encrypted is
 * the most symmetric corner of the surface, and the asymmetries in it are all
 * deliberate: exactly one member re-encodes its RESULT (`read`, because bytes
 * are not JSON), exactly one re-encodes its ARGUMENTS (`write`, same reason in
 * the other direction), and exactly two can fail for a reason unrelated to the
 * file (`writeEncrypted` / `readEncrypted`, when the OS keychain is not there).
 * Every other member is plain JSON in and plain JSON out. Written apart, those
 * four exceptions would be four independent judgement calls.
 *
 * WHY A FACTORY RATHER THAN STATIC TABLE ENTRIES. A handler has to reach the
 * plugin incarnation's own `PluginStorage` — the instance rooted at THIS
 * plugin's `pluginDataDir`, canonicalised at construction, and wrapped by the
 * effect recorder. `HostApiCall` carries identity and arguments, not host
 * state, so the binding can only be a closure. The caller composes the bound
 * entries over `HOSTAPI_DISPATCH_TABLE` with object spread; the shipped table
 * stays unbound, which is what stops a storage read being serviced on behalf of
 * no plugin in particular.
 *
 * ARGUMENT VALIDATION IS A BOUNDARY CONCERN, NOT A STORAGE ONE. `args` arrives
 * from the least-trusted process in the system, so each member checks its own
 * positional arguments against its declared signature and refuses a mismatch
 * with `argument-marshalling-rejected`. This is not a second copy of a host
 * rule: the containment decision — absolute paths, `..`, symlink escape — stays
 * entirely inside `PluginStorage.guard`, and nothing here anticipates it.
 * Stated deviation: in-process, a non-string `relPath` reaches `guard()` and
 * comes back as a `PluginStorageError`; across the boundary it is refused here
 * instead, because a message whose arguments do not match the member's
 * signature is a malformed message. A plugin passing the argument its own types
 * declare never sees the difference.
 *
 * Nothing here catches. A refused path, a missing file, a denied effect and an
 * unavailable keychain all propagate as the host classes they already are;
 * `classifyHostApiError` maps each to the code the member's contract lists.
 * There is no default value and no silent skip anywhere in this file.
 *
 * HOST-SIDE ONLY. This module reaches Electron through the approval gate; the
 * child's half of these members is `host-api-child.ts`, which imports neither.
 */

/**
 * The subset of `hostApi` this group services.
 *
 * Narrowed rather than taking the whole surface so a handler cannot quietly
 * start calling a member that belongs to another group's contract.
 */
export type StorageHostApi = Pick<PluginHostApi, "storage">;

/**
 * Every `StorageEncoding`, as a runtime membership test.
 *
 * `Record<StorageEncoding, true>` rather than an array: adding a member to the
 * union without adding it here is a COMPILE error, so the set cannot drift
 * behind the type it is guarding. Unvalidated, a child-chosen encoding reaches
 * `readFile`/`writeFile` and comes back as an opaque `host-internal` throw;
 * validated, it is the boundary refusal it actually is.
 */
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

/** A required positional argument the member declares as `string`. */
function stringArg(call: HostApiCall, index: number): string {
  const value = call.args[index];
  if (typeof value !== "string") reject(call, index, "a string");
  return value;
}

/**
 * A positional argument the member declares OPTIONAL.
 *
 * Absent means absent: `describeNonJson` refuses `undefined` inside an array,
 * so an unsupplied trailing argument arrives as a shorter `args` — never as an
 * explicit `undefined` element.
 */
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
  // `Object.hasOwn`, not `in`: the value is child-supplied and
  // `"toString" in STORAGE_ENCODINGS` is true.
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

/** `rm`'s only option today. An unknown key is refused rather than ignored. */
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

/**
 * Bind this group's handlers to one plugin incarnation's `hostApi`.
 *
 * Composed over the dispatch table by the caller that owns the child, so the
 * table keeps naming every member exactly once and an unbound member keeps its
 * throwing default.
 */
export function createStorageHostApiPaths(
  hostApi: StorageHostApi,
): Record<DispatchedStorageHostApiPath, HostApiPathHandler> {
  // The five `void`-declared members RETURN the host's promise rather than
  // awaiting and discarding it. Discarding would also discard a host that
  // started resolving a value, and the dispatcher's void check — the one thing
  // that catches the child's stub and the host's implementation disagreeing
  // about a member — would never see it. A drift is refused, not absorbed.
  return {
    /**
     * The one member whose RESULT is re-encoded.
     *
     * It declares `Uint8Array` and delivers a Node `Buffer`, and `Buffer`
     * carries a `toJSON()`: a naive round trip does not throw, it SUCCEEDS into
     * `{ type: "Buffer", data: number[] }` — a different type that reads as a
     * successful read. Tagging the bytes as base64 is what keeps bytes bytes.
     */
    "storage.read": defineHostApiPath("storage.read", async (call) =>
      encodeWireBytes(
        await hostApi.storage.read(stringArg(call, 0)),
        `${call.path}(result)`,
      ),
    ),

    "storage.readText": defineHostApiPath("storage.readText", (call) =>
      hostApi.storage.readText(stringArg(call, 0), optionalEncodingArg(call, 1)),
    ),

    // Resolves `null` for a missing file — the member's declared answer, not a
    // fallback the boundary invented.
    "storage.readJson": defineHostApiPath("storage.readJson", (call) =>
      hostApi.storage.readJson(stringArg(call, 0)),
    ),

    "storage.list": defineHostApiPath("storage.list", (call) =>
      hostApi.storage.list(optionalStringArg(call, 0)),
    ),

    "storage.exists": defineHostApiPath("storage.exists", (call) =>
      hostApi.storage.exists(stringArg(call, 0)),
    ),

    /**
     * The one member whose ARGUMENTS are re-encoded.
     *
     * `data` is `string | Uint8Array`, and the tag is what keeps the two
     * branches apart: without it a base64 STRING the plugin meant to write
     * verbatim is indistinguishable from bytes the child encoded, and the file
     * lands decoded. The separate `encoding` argument is orthogonal — it says
     * how the host should interpret a string it was given, not how the string
     * crossed.
     */
    "storage.write": defineHostApiPath("storage.write", (call) => {
      const relPath = stringArg(call, 0);
      const data = decodeWireBytes(call.args[1], `${call.path}(data)`);
      return hostApi.storage.write(relPath, data, optionalEncodingArg(call, 2));
    }),

    "storage.writeJson": defineHostApiPath("storage.writeJson", (call) => {
      const relPath = stringArg(call, 0);
      // An omitted value is not `undefined`-the-value: `JSON.stringify`
      // produces nothing for it and the write would fail deep inside `fs`.
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

    /**
     * Fails closed on a missing OS keychain with
     * `plugin-storage-encryption-unavailable`, which is a DIFFERENT answer from
     * a missing file: nothing was written, and the plaintext never reached the
     * disk.
     */
    "storage.writeEncrypted": defineHostApiPath("storage.writeEncrypted", (call) => {
      const relPath = stringArg(call, 0);
      return hostApi.storage.writeEncrypted(relPath, stringArg(call, 1));
    }),

    "storage.readEncrypted": defineHostApiPath("storage.readEncrypted", (call) =>
      hostApi.storage.readEncrypted(stringArg(call, 0)),
    ),
  };
}


/**
 * The HOST half of the config members and the four subscription members
 * (`docs/blueprints/plugin-process-isolation.md` §3.1).
 *
 * Each handler here does one thing: turn a message back into the call the
 * in-process plugin would have made on the REAL `PluginHostApi`, and hold the
 * lifetime that call creates. It re-implements none of what that object does —
 * the permission assertion in `onEvent`, the `format: "secret"` rejection and
 * restart policy in `config.set`, the self-event filter in `onPluginsChanged`,
 * the incarnation guard on every callback — because a second copy of any of
 * those is a second answer to a security question.
 *
 * WHY THIS IS A FACTORY AND NOT A TABLE ENTRY. `HOSTAPI_DISPATCH_TABLE` is a
 * module constant, and every member here needs the hostApi belonging to ONE
 * plugin incarnation: `config.set` writes that plugin's settings, `onEvent`
 * asserts that plugin's event access. A static entry has no way to name which
 * incarnation it is serving, so the binding happens where the dispatcher is
 * constructed — the same place `pluginId` and `isActive` already come from —
 * and the result is passed as `HostApiDispatcherOptions.table`.
 *
 * WHY NO HANDLER TELLS THE CHILD IT WAS CLOSED. A host-side teardown runs for
 * three reasons and only one of them is a message: `disposed` came from the
 * child, `peer-gone` means there is nobody to write to, and `revoked` is the
 * host's own decision. That third one IS sent, and it is sent from the
 * dispatcher's release path — the one place that sends host notifications —
 * rather than from six handlers each sending their own. Nothing in this group
 * writes a notification; `SubscriptionScope.release` is the whole interface to
 * it.
 */

/**
 * The live hostApi for the incarnation this dispatcher serves.
 *
 * Narrowed to the members this group calls so a test can bind a fake without
 * standing up the other thirty, and so a future member arriving here is a
 * deliberate widening rather than an unnoticed reach into the whole surface.
 */
export type ConfigSubscriptionHostApi = Pick<
  PluginHostApi,
  "config" | "onEvent" | "onPluginsChanged" | "onShutdown"
>;

/**
 * Read a positional argument the contract declares as a string.
 *
 * Fails with the boundary's own code rather than letting `undefined` reach the
 * hostApi, where `config.set(undefined, v)` would persist a key literally named
 * "undefined" and report success.
 */
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

/** Refuse a call whose arity does not match the member's declared arguments. */
function requireArity(call: HostApiCall, arity: number): void {
  if (call.args.length !== arity) {
    throw new HostApiBoundaryError(
      "argument-marshalling-rejected",
      `[host-api-dispatcher] '${call.path}': expected ${arity} arguments, received ${call.args.length}`,
      { path: call.path, arity, received: call.args.length },
    );
  }
}

/**
 * Register the host side under the child's id, undoing the host subscription if
 * the id is refused.
 *
 * The undo is the whole point: a duplicate or post-mortem id makes `adopt`
 * throw, and without this the host would be left subscribed to an event bus on
 * behalf of a registration no ledger knows about — a leak with no symptom,
 * which is the failure mode the ledger exists to prevent.
 */
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

/** Undo a resource created before its handle could be registered. */
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

/**
 * The five dispatchable members of this group, bound to one incarnation.
 *
 * `config.get` is absent by design: its contract answers `child-local`, the
 * table already refuses it, and servicing it here would make the
 * round-trip-free decision untrue in a way nothing would report.
 */
export function createConfigSubscriptionHostApiPaths(
  hostApi: ConfigSubscriptionHostApi,
): Record<DispatchedConfigSubscriptionPath, HostApiPathHandler> {
  return {
    "config.set": defineHostApiPath("config.set", async (call) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      // RETURNED, not awaited-and-discarded. `await` here would resolve
      // `undefined` whatever the host produced, which quietly disables the
      // dispatcher's own check that a `void` member returned nothing — the one
      // thing between a drifted host implementation and a child stub that
      // silently ignores its result. The value itself is whatever the plugin
      // passed; the dispatcher has already proven it survives JSON, and the
      // schema decision belongs to the host implementation, not here.
      return hostApi.config.set(key, call.args[1]);
    }),

    "config.onChange": defineHostApiPath("config.onChange", async (call, scope) => {
      requireArity(call, 2);
      const key = stringArgument(call, 0, "key");
      const subscriptionId = stringArgument(call, 1, "subscriptionId");
      const unsubscribe = hostApi.config.onChange(key, (value) => {
        // ENCODED, not spread. `SECRET_REDACTED_SENTINEL` is a Symbol and
        // `JSON.stringify` drops a symbol-valued property, so `{ key, value }`
        // would reach the child as `{ key }` — read there as "cleared" — and
        // the plugin would never learn its secret changed. The encoder lives
        // beside the decoder so the two halves cannot drift.
        scope.deliver(subscriptionId, encodeConfigChange(key, value));
      });
      adoptOrUndo(scope, subscriptionId, unsubscribe);
      return { handleId: subscriptionId };
    }),

    onEvent: defineHostApiPath("onEvent", async (call, scope) => {
      requireArity(call, 2);
      const eventType = stringArgument(call, 0, "eventType");
      const subscriptionId = stringArgument(call, 1, "subscriptionId");
      // Throws when the plugin has no access to this event type. That check is
      // the host's and stays the host's — the child stub does not pre-filter,
      // so there is exactly one place the answer comes from.
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

    /**
     * `lifetime: "host-terminated"`, `result: "void"` — and both are load-bearing.
     *
     * The child gets no disposer because it cannot end this one, so the ledger
     * entry exists for the OTHER two deaths: the host firing shutdown, and the
     * child dying first. The host's in-process contract is that it AWAITS the
     * plugin's handler, so firing it is `ave/instance/shutdown`, a request
     * naming this registration, and the handler settling is the reply (§3.4).
     * The wait is bounded where the request is sent: a handler that overruns
     * it gets the child killed, which in-process nothing can do.
     */
    onShutdown: defineHostApiPath("onShutdown", async (call, scope) => {
      requireArity(call, 1);
      const subscriptionId = stringArgument(call, 0, "subscriptionId");
      let ended = false;
      // Adopt BEFORE registering the shutdown handler: `hostApi.onShutdown`
      // returns no disposer, so a handler registered against a refused id could
      // never be taken back off the host's shutdown list.
      scope.adopt(subscriptionId, () => {
        ended = true;
      });
      // Returned for the same reason `config.set` is: this member declares no
      // result, and a handler that discarded the host's is a handler the
      // void-drift check can never fire on.
      return hostApi.onShutdown(async () => {
        // Already released — the child is gone, or the incarnation was torn
        // down. There is no handler left to run.
        if (ended) return;
        await scope.shutdown(subscriptionId);
      });
    }),
  };
}

/**
 * Turn a thrown host error into the identity that crosses.
 *
 * By CLASS, never by message. The host distinguishes several of these by
 * identity today; a wire drops an `Error` to `{ message, stack }`, so the
 * identity has to be named explicitly on the way out or it is gone.
 */
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
    // `settlement` is a live promise and stays host-side; the child learns the
    // call was detached, which is all it can act on.
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

/** Distinct undeclared params fields reported per connection before the rest are suppressed. */
export const UNKNOWN_FIELD_REPORTS_MAX = 32;

/** The longest field name a report carries, in code points; the rest is cut. */
const UNKNOWN_FIELD_NAME_MAX = 64;

/**
 * `field` cut to {@link UNKNOWN_FIELD_NAME_MAX} code points. Counted by code
 * point, not UTF-16 unit, so the cut never leaves half a surrogate pair in a
 * log line; and stopped early, because the child picks how long the name is.
 */
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

/** One diagnostic about an undeclared params field. */
export type UnknownFieldReport =
  | { readonly kind: "field"; readonly method: string; readonly field: string }
  | { readonly kind: "suppressed"; readonly limit: number };

export interface HostApiDispatcherOptions {
  readonly pluginId: string;
  /**
   * The host-side liveness check the in-process `enforceActiveHostApi` proxy
   * performs today. Strictly stronger here: the child cannot reach around it,
   * because it is on the other side of a pipe.
   */
  readonly isActive: () => boolean;
  /** Where host-originated notifications go. */
  readonly notifications: ChildNotificationSink;
  /**
   * Send the child `ave/instance/shutdown` for one `onShutdown` registration
   * and settle when it answers. The owner holds the request table and the
   * bound; the dispatcher only knows which registration to name.
   */
  readonly shutdownChild: (subscriptionId: string) => Promise<void>;
  /**
   * Where the child's `context.log` goes.
   *
   * Required, not optional. The in-process arm writes these straight to the
   * host logger, and for a long time this arm dropped them on the floor: the
   * child emitted a log notification, the wire declared it, and
   * {@link HostApiDispatcher.handleNotification} handled only the two
   * registration-ending kinds. Every `context.log` from every out-of-process
   * plugin went nowhere, which is how a plugin whose worker failed to start on
   * every boot could ship — it was forwarding the worker's stderr into a sink
   * that did not exist. A dispatcher with nowhere to put a log line must not be
   * constructible.
   */
  readonly log: (message: string, meta?: unknown) => void;
  /**
   * Where the HOST's own diagnostic about this connection goes: a params field
   * the member does not declare (§3.3). Accepted and ignored, and reported once
   * per (method, field), so a plugin built against a newer protocol is visible.
   * The child chooses both strings, so the reports are capped per connection
   * ({@link UNKNOWN_FIELD_REPORTS_MAX}, then one `suppressed` report) and each
   * field name is truncated: an unbounded set of distinct names is a log flood
   * and a memory leak the child controls. Separate from {@link log}, which is
   * the plugin's own voice.
   */
  readonly reportUnknownField: (report: UnknownFieldReport) => void;
  /** Host-owned, coalesced diagnostics. The callback must not include caller payloads. */
  readonly reportBudgetAudit?: (entry: HostApiBudgetAudit) => void;
  /** Injectable so a handler can be exercised without the whole table. */
  readonly table?: Record<HostApiPath, HostApiPathHandler>;
  /**
   * The host tool invocations this connection's `tools/call` requests opened
   * (decision 63). Absent, the connection holds none: a request that names a
   * token is refused, and nothing is ever in flight.
   */
  readonly invocations?: HostInvocationTable;
}

/** What {@link HostApiDispatcherOptions.invocations} answers. */
interface HostInvocationTable {
  /**
   * The async context of the invocation a token names, for a `tools/call`
   * still in flight AND for one that has settled.
   *
   * A request that names a token runs in that context, so the effect gate,
   * effect ledger and origin bound for the call apply to it as they do to an
   * in-process handler's hostApi call. This includes work the handler
   * scheduled and left running after it returned. In-process, a timer keeps
   * the invocation's frame, so a headless invocation's late write is denied
   * and a foreground one's still asks the user. A settled token must therefore
   * resolve too. If it did not, the late write would run in no invocation,
   * unasked and unrefused: a fail-open that in-process code does not have.
   *
   * `undefined` means the connection never issued the token, or no longer
   * holds it (released at close, or evicted past the retention bound). The
   * request is then refused. It never runs with less gating than its
   * invocation had.
   */
  resolve(token: string): InvocationContextRunner | undefined;
  /** How many `tools/call` requests are in flight on this connection now. */
  toolCallsInFlight(): number;
}

/** The invocation token a request carries in `params._meta`, if it is a string. */
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

/** Services one child's reverse channel for the life of one plugin incarnation. */
export class HostApiDispatcher {
  private readonly table: Record<HostApiPath, HostApiPathHandler>;
  private readonly budgets: HostApiBudgets;
  private readonly subscriptions = new SubscriptionLedger<HostSubscription>(
    "host-api-dispatcher",
  );
  /**
   * The controller of every request still being serviced, keyed by its id.
   *
   * What `notifications/cancelled` aborts, and what the child going away
   * aborts all of — so work started for a process that no longer exists does
   * not run on for nobody. An entry lives exactly as long as its request.
   */
  private readonly inFlight = new Map<string, AbortController>();
  private readonly pendingSubscriptions = new Map<HostApiPath, number>();
  private pendingSubscriptionCount = 0;
  private readonly reportedUnknownFields = new Set<string>();
  private unknownFieldsSuppressed = false;
  /** At most one omission warning per gated path for this connection. */
  private readonly warnedTokenlessPaths = new Set<HostApiPath>();

  constructor(private readonly options: HostApiDispatcherOptions) {
    this.table = options.table ?? HOSTAPI_DISPATCH_TABLE;
    this.budgets = new HostApiBudgets(options.pluginId, options.reportBudgetAudit ?? (() => {}));
  }

  /** Live host-side registrations. Zero after {@link childGone}. */
  get openSubscriptionCount(): number {
    return this.subscriptions.openCount;
  }

  async handle(request: HostApiRequest): Promise<HostApiReply> {
    const { id } = request;
    const key = String(id);
    const path = typeof request.method === "string" ? hostApiPathOf(request.method) : undefined;
    // Two live requests under one id would make a cancellation ambiguous and a
    // reply unmatchable, so the second is refused rather than let either win.
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
      // `null` for a `void` member, and for an absent value: JSON-RPC requires
      // `result`, and JSON has no `undefined` to put in it.
      return { jsonrpc: "2.0", id, result: this.checkResult(handler, value) ?? null };
    } catch (error) {
      return this.errorReply(id, error, path);
    } finally {
      reservation?.release();
      this.inFlight.delete(key);
    }
  }

  /**
   * A request that names no invocation runs outside every invocation. That is
   * where an in-process plugin's own work runs too: lifecycle hooks, and timers
   * it scheduled at start. The context is set explicitly and never inherited
   * from whatever delivered the frame (see {@link runOutsideInvocation}).
   *
   * Leaving the token out is the child's choice, so a child can always run a
   * gated write ungated this way: the residual decision 63 records. The host
   * cannot tell a mid-call write that dropped its token from honest background
   * work, so it does not refuse it. It records the case that looks like the
   * first: a gated write with no token while a `tools/call` is in flight.
   */
  private runTokenless<R>(path: HostApiPath, args: readonly unknown[], invoke: () => R): R {
    // Fetch is gated inline, so it is absent from the generic wrapper's set.
    // These args have crossed the JSON check; only the method selects a diagnostic.
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

  /** A request that names an invocation runs in it, or is refused. */
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

  /**
   * Child → host notifications.
   *
   * `subscription/release` ends a registration through the ledger;
   * `cancelled` aborts one in-flight request; `log` ends nothing — it is the
   * child's `context.log` arriving, forwarded to the sink the owner supplied.
   * Anything else is not a child→host notification and is dropped.
   */
  handleNotification(notification: HostApiNotification): void {
    if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.log) {
      if (this.budgets.take("notifications/ave/log") > 0) {
        this.budgets.deny("notifications/ave/log", "rate-limited", "logEvent");
        return;
      }
      // The message is the plugin's own text, passed through unchanged so an
      // isolated plugin's log line reads the same as an in-process one. Only
      // the attribution is the host's to add, and the owner does that.
      this.options.log(notification.params.message, notification.params.meta);
      return;
    }
    if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.subscriptionRelease) {
      // `disposed` rather than `peer-gone`: the child is alive and has already
      // dropped its side, so the host teardown must not send anything back.
      this.subscriptions.close(notification.params.subscriptionId, "disposed");
      return;
    }
    if (notification.method === HOST_PROTOCOL_NOTIFICATIONS.cancelled) {
      // Only an in-flight REQUEST can be cancelled this way. A subscription id
      // names a registration, not a request, so it can never reach a worker
      // handle or a key lease through the cancellation mechanism. An id with
      // nothing in flight — a request that already settled — is dropped.
      // An `AbortError`, which is what the plugin's own signal would have
      // produced in-process: the host implementation rejects with it and its
      // name crosses intact, so a plugin that checks `name === "AbortError"`
      // reads a cancellation the same way on both arms.
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

  /**
   * The child is gone. Every request still being serviced for it is aborted,
   * and every host-side registration it opened is released, including the ones
   * it never disposed — case 2 of the four ways a two-sided lifetime ends.
   */
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
    // JSON-RPC 2.0 §4: `params` MAY be omitted, and a member that takes no
    // arguments is called that way by a stock client. Absent is the empty
    // object; null, an array and a scalar are still refused.
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

  /**
   * Everything leaving here has to be a JSON value, whatever the contract's
   * `result` axis calls it — `encoded` and `handle` are JSON bodies too. `void`
   * and `handle` additionally have a pinned SHAPE, so a handler cannot quietly
   * return a payload the child's stub will not understand.
   */
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
    /**
     * The one place a host-side close becomes a message to the child.
     *
     * The closed notification was one the child could RECEIVE and nothing
     * could SEND, which made the child stubs that act on it — the key lease
     * dropping its copy, a handle letting go of its listeners — controls that
     * only looked like controls. It belongs here rather than in the six
     * lifetime-bearing handlers because six senders would be six chances to
     * send the wrong reason.
     *
     * Exactly one reason crosses. `disposed` came FROM the child, so echoing it
     * is a ping-pong; `peer-gone` means the pipe is already closed, so sending
     * is a write on it. `revoked` is the host's own decision and is the only
     * one the child cannot otherwise learn.
     */
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
      // A lease can be revoked between registration and the resolve reply.
      // The reply writer runs in the caller's continuation; queue closure behind it.
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
