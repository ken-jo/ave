// Start no listener or discovery write unless an independently opted-in route family has a handler. A fresh per-boot bearer is never logged; discovery
// uses openFeatureNamespace and the local OS user boundary.
import { randomBytes } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { AppServices } from "../boot.js";
import type { SettingsService } from "../data/settings-store.js";
import { resolveEnvBackedBoolean } from "../shared/env-backed-settings.js";
import type { IpcDeps } from "../ipc/types.js";
import {
  createConversationCommandPort,
  type ConversationCommandPort,
} from "./conversation-command-port.js";
import {
  createConversationSurfaceRuntime,
  type ConversationSurfaceRuntime,
} from "../engine/conversation-surface-runtime.js";
import { createLocalApi, type ExternalMutationApprover } from "../api/local-api.js";
import type { A2AHttpRouter } from "../api/a2a-router.js";
import { A2A_PROTOCOL_VERSION } from "../shared/a2a-wire.js";
import {
  startLocalApiHttpServer,
  type LocalApiHttpServer,
  type LoopbackRouteFamilies,
} from "../api/http-server.js";
import { createPlatformConversationLegacyStreamAdapter } from "../api/platform-conversation-legacy-adapter.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import {
  buildSingleFlightAgentActionApprover,
  type AgentActionApprover,
} from "../permissions/agent-action-approver.js";
import { openFeatureNamespace } from "./storage/feature-namespace.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("local-api");

// Feature namespace id — resolves to `~/.ave/local-api/`; the CLI reads the same namespace.
export const LOCAL_API_FEATURE = "local-api";

// The discovery file the CLI reads to find the running server.
export const LOCAL_API_INFO_FILE = "server.json";

// Discovery info persisted after the server is listening. `secret` is a local capability token protected only by the 0o600 file mode (see module doc) —
// treat it exactly like an SSH private key.
export interface LocalApiServerInfoFile {
  // The actual bound loopback port (ephemeral; never 0 once listening).
  port: number;
  // Per-boot bearer secret (64 hex chars). NEVER logged.
  secret: string;
  // The main-process pid, so a CLI can detect a stale file after a crash.
  pid: number;
  // Additive A2A discovery, present only when that route family is active.
  a2a?: {
    protocolVersion: string;
    agentCardPaths: string[];
  };
}

// Blank discovery atomically on stop so stale bearer/port data cannot survive; the namespace exposes atomic writes rather than deletion.
const LOCAL_API_TOMBSTONE: LocalApiServerInfoFile = { port: 0, secret: "", pid: 0 };

// Module-level handle to the running server (C17 shared-handle pattern).
let runningServer: LocalApiHttpServer | null = null;
let bootRouteFamilies: Readonly<LoopbackRouteFamilies> | undefined;
let bootA2ARuntime: Promise<A2ARouterRuntime | null> | undefined;
let initializedA2ARuntime: A2ARouterRuntime | null | undefined;
let bootAgentActionApprover: AgentActionApprover | undefined;
let bootAgentActionApproverInitialized = false;
let bootStartPromise: Promise<{ port: number } | null> | undefined;
let cancelBootStart: (() => void) | undefined;
let stopPromise: Promise<void> | undefined;
let lifecycleGeneration = 0;
let stopped = false;
let disposedA2ARuntimes = new WeakSet<object>();

const START_CANCELLED: unique symbol = Symbol("start-cancelled");

export interface A2ARouterRuntime {
  router: A2AHttpRouter;
  discovery: {
    protocolVersion: string;
    agentCardPaths: readonly string[];
  };
  dispose?: () => void | Promise<void>;
}

export interface A2ARouterFactoryContext {
  approveAgentAction: AgentActionApprover | undefined;
}

type A2ARouterFactoryResult = A2AHttpRouter | A2ARouterRuntime | null;

export type A2ARouterFactory = (
  context: A2ARouterFactoryContext,
) => A2ARouterFactoryResult | Promise<A2ARouterFactoryResult>;

export function resolveLoopbackRouteFamilies(
  settingsService: SettingsService,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<LoopbackRouteFamilies> {
  // The environment registry owns precedence; this gate separately requires literal true so malformed settings fail closed.
  return Object.freeze({
    localApi: resolveEnvBackedBoolean(
      "system.localApiServer",
      settingsService.get("system").localApiServer === true,
      env,
      false,
    ),
    a2a: resolveEnvBackedBoolean(
      "features.a2aLoopbackServer",
      settingsService.get("features")?.a2aLoopbackServer === true,
      env,
      false,
    ),
  });
}

// Is the opt-in local API server enabled? True when the user turned it on in Settings OR the environment sets `AVE_LOCAL_API=1`. Fail-closed: anything
// else (undefined flag, malformed env) is OFF.
export function isLocalApiEnabled(
  settingsService: SettingsService,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveLoopbackRouteFamilies(settingsService, env).localApi;
}

// Is the independently opt-in A2A loopback family enabled for this boot?
export function isA2ALoopbackEnabled(
  settingsService: SettingsService,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveLoopbackRouteFamilies(settingsService, env).a2a;
}

function auditA2ARouteDisabled(
  services: AppServices,
  reason: "initialization-failed" | "no-routable-handler",
): void {
  try {
    services.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "a2a-loopback",
      type: "warn",
      input: "a2a:loopback:" + reason,
    });
  } catch {
    // Audit persistence must not brick the independently enabled local API.
  }
}

function normalizeA2ARouterRuntime(result: A2ARouterFactoryResult): A2ARouterRuntime | null {
  if (!result) return null;
  const router = "router" in result ? result.router : result;
  if (router.handlerIds.length === 0) return null;
  const agentCardPaths = router.handlerIds.map(
    (id) => `/a2a/${id}/.well-known/agent-card.json`,
  );
  if ("router" in result) {
    if (
      result.discovery.protocolVersion !== A2A_PROTOCOL_VERSION
      || result.discovery.agentCardPaths.length !== agentCardPaths.length
      || result.discovery.agentCardPaths.some((path, index) => path !== agentCardPaths[index])
    ) {
      throw new Error("a2a-runtime-discovery-mismatch");
    }
    return result;
  }
  return {
    router,
    discovery: {
      protocolVersion: A2A_PROTOCOL_VERSION,
      agentCardPaths,
    },
  };
}

async function disposeA2ARuntime(runtime: A2ARouterRuntime | null): Promise<void> {
  if (!runtime || disposedA2ARuntimes.has(runtime)) return;
  disposedA2ARuntimes.add(runtime);
  try {
    await runtime.dispose?.();
  } catch {
    // Auxiliary runtime cleanup failure must not block app shutdown.
  }
}

async function invalidateA2ARuntime(runtime: A2ARouterRuntime | null): Promise<void> {
  if (!runtime) return;
  await disposeA2ARuntime(runtime);
  if (initializedA2ARuntime === runtime) initializedA2ARuntime = undefined;
  bootA2ARuntime = undefined;
}

async function initializeA2ARouter(
  factory: A2ARouterFactory | undefined,
  services: AppServices,
  emit: (message: string) => void,
  approveAgentAction: AgentActionApprover | undefined,
): Promise<A2ARouterRuntime | null> {
  bootA2ARuntime ??= (async () => {
    if (!factory) {
      auditA2ARouteDisabled(services, "no-routable-handler");
      emit("[a2a] no routable handlers; route family disabled for this boot");
      return null;
    }
    try {
      const produced = await factory({ approveAgentAction });
      let runtime: A2ARouterRuntime | null;
      try {
        runtime = normalizeA2ARouterRuntime(produced);
      } catch (error) {
        if (produced && "router" in produced) await disposeA2ARuntime(produced);
        throw error;
      }
      if (runtime) return runtime;
      if (produced && "router" in produced) await disposeA2ARuntime(produced);
      auditA2ARouteDisabled(services, "no-routable-handler");
      emit("[a2a] no routable handlers; route family disabled for this boot");
      return null;
    } catch {
      auditA2ARouteDisabled(services, "initialization-failed");
      emit("[a2a] initialization failed; route family disabled for this boot");
      return null;
    }
  })();
  const runtime = await bootA2ARuntime;
  initializedA2ARuntime = runtime;
  return runtime;
}

// External mutations use the live agent-action ApprovalGate; absent gates, timeouts, errors, and non-allow choices deny.
// Never persist rememberPattern here: every allow choice grants one mutation only.
// Allow one pending prompt per server approver and refuse concurrent asks to prevent attention flooding.
export function buildExternalMutationApprover(
  approvalGate: ApprovalGate | undefined,
  emit: (message: string) => void,
): ExternalMutationApprover | undefined {
  const approve = buildLoopbackAgentActionApprover(approvalGate, emit);
  return buildExternalMutationApproverFromAgentAction(approve);
}

function buildLoopbackAgentActionApprover(
  approvalGate: ApprovalGate | undefined,
  emit: (message: string) => void,
): AgentActionApprover | undefined {
  return buildSingleFlightAgentActionApprover(approvalGate, {
    onConcurrent: ({ toolName, trustOrigin }) => {
      emit(
        `[local-api] external mutation approval already pending — denying concurrent request channel=${toolName} origin=${trustOrigin}`,
      );
    },
    onError: ({ toolName, trustOrigin }) => {
      emit(
        `[local-api] external-mutation approval errored channel=${toolName} origin=${trustOrigin} → denied`,
      );
    },
  });
}

function getBootAgentActionApprover(
  approvalGate: ApprovalGate | undefined,
  emit: (message: string) => void,
): AgentActionApprover | undefined {
  if (!bootAgentActionApproverInitialized) {
    bootAgentActionApprover = buildLoopbackAgentActionApprover(approvalGate, emit);
    bootAgentActionApproverInitialized = true;
  }
  return bootAgentActionApprover;
}

function buildExternalMutationApproverFromAgentAction(
  approve: AgentActionApprover | undefined,
): ExternalMutationApprover | undefined {
  if (!approve) return undefined;

  return async ({ channel, args, origin }) => Boolean(await approve({
    toolName: channel,
    args,
    reason: "An external CLI/API requested a permission-mode change. Do you want to allow it?",
    trustOrigin: origin,
  }));
}

// A disabled gate opens no socket and writes no state; repeated starts return the existing server.
interface LocalApiStartInput {
  services: AppServices;
  getMainWindow: () => BrowserWindow | null;
  getAppWindows: () => Array<BrowserWindow | null | undefined>;
  conversationSurfaceRuntime?: ConversationSurfaceRuntime;
  createA2ARouter?: A2ARouterFactory;
  log?: (message: string) => void;
  conversationCommandPort?: ConversationCommandPort;
}

async function startLocalApiServerForBoot(
  input: LocalApiStartInput,
  generation: number,
  cancellation: Promise<void>,
): Promise<{ port: number } | null> {
  const {
    services, getMainWindow, getAppWindows,
    conversationSurfaceRuntime: suppliedSurfaceRuntime,
    conversationCommandPort: suppliedConversationCommandPort,
  } = input;
  const emit = input.log ?? ((m: string) => log.info(m));

  bootRouteFamilies ??= resolveLoopbackRouteFamilies(services.settingsService);
  if (!bootRouteFamilies.localApi && !bootRouteFamilies.a2a) {
    return null;
  }
  const approveAgentAction = getBootAgentActionApprover(services.approvalGate, emit);
  const conversationSurfaceRuntime = suppliedSurfaceRuntime ?? createConversationSurfaceRuntime();
  conversationSurfaceRuntime.activity.bindSessionTransitionGuard(
    () => services.conversationLoop.isSessionTransitioning?.() ?? false,
    (notify) => services.conversationLoop.onSessionTransitionSettled?.(notify) ?? (() => undefined),
  );
  const a2aRuntime = bootRouteFamilies.a2a
    ? await Promise.race([
      initializeA2ARouter(input.createA2ARouter, services, emit, approveAgentAction),
      cancellation.then((): typeof START_CANCELLED => START_CANCELLED),
    ])
    : null;
  if (a2aRuntime === START_CANCELLED) return null;
  if (generation !== lifecycleGeneration) {
    await invalidateA2ARuntime(a2aRuntime);
    return null;
  }
  const activeRouteFamilies = Object.freeze({
    localApi: bootRouteFamilies.localApi,
    a2a: a2aRuntime !== null,
  });
  if (!activeRouteFamilies.localApi && !activeRouteFamilies.a2a) {
    return null;
  }

  let server: LocalApiHttpServer;
  let secret = "";
  try {
    // Same DI bag the IPC registrars receive (see registerIpcHandlers).
    const ipc: IpcDeps = {
      ...services,
      getMainWindow,
      getAppWindows,
      conversationSurfaceRuntime,
    };

    // SSE is a compatibility adapter over the same Runtime Electron publishes to; it no longer owns a second stream id or turn lease.
    const broadcaster = createPlatformConversationLegacyStreamAdapter(
      conversationSurfaceRuntime.timeline,
    );
    const conversationCommandPort = suppliedConversationCommandPort
      ?? createConversationCommandPort(ipc, conversationSurfaceRuntime);

    // #1409 approval-mediated external-mutation gate. Undefined when no ApprovalGate is available → the dispatcher keeps its fail-closed default.
    const externalMutationApprover = buildExternalMutationApproverFromAgentAction(
      approveAgentAction,
    );
    const api = createLocalApi({ ipc, conversationCommandPort, externalMutationApprover });

    // Fresh per-boot bearer secret (64 hex chars). Never logged.
    secret = randomBytes(32).toString("hex");

    // Port 0 → OS-assigned ephemeral loopback port; the actual value is read back.
    server = await startLocalApiHttpServer({
      api,
      secret,
      broadcaster,
      a2aRouter: a2aRuntime?.router,
      routeFamilies: activeRouteFamilies,
      // Do NOT forward the secret into the transport log — startLocalApiHttpServer is documented to never receive it, and this callback only sees benign
      // dispatch/routing diagnostics.
      log: (message: string) => emit(`[local-api] ${message}`),
    });
  } catch (error) {
    await invalidateA2ARuntime(a2aRuntime);
    throw error;
  }
  if (generation !== lifecycleGeneration) {
    try {
      await server.close();
    } finally {
      await invalidateA2ARuntime(a2aRuntime);
    }
    return null;
  }
  runningServer = server;

  // Persist discovery info AFTER listen succeeds so the file never points at a dead port for this boot. 0o600 file mode (via openFeatureNamespace) is the
  // protection model for this capability token — same as an SSH key.
  const info: LocalApiServerInfoFile = {
    port: server.port,
    secret,
    pid: process.pid,
    ...(a2aRuntime
      ? {
          a2a: {
            protocolVersion: a2aRuntime.discovery.protocolVersion,
            agentCardPaths: [...a2aRuntime.discovery.agentCardPaths],
          },
        }
      : {}),
  };
  try {
    await openFeatureNamespace(LOCAL_API_FEATURE).writeJson(LOCAL_API_INFO_FILE, info);
  } catch (err) {
    if (runningServer === server) runningServer = null;
    try {
      await server.close();
    } finally {
      await invalidateA2ARuntime(a2aRuntime);
    }
    await tombstoneDiscoveryFile();
    throw err;
  }

  if (generation !== lifecycleGeneration) {
    if (runningServer === server) {
      runningServer = null;
      try {
        await server.close();
      } finally {
        await invalidateA2ARuntime(a2aRuntime);
      }
    } else {
      await invalidateA2ARuntime(a2aRuntime);
    }
    await tombstoneDiscoveryFile();
    return null;
  }

  emit(`[local-api] listening on 127.0.0.1:${server.port}`);
  return { port: server.port };
}

export async function maybeStartLocalApiServer(
  input: LocalApiStartInput,
): Promise<{ port: number } | null> {
  if (stopped) return null;
  if (stopPromise) {
    await stopPromise;
    return null;
  }
  if (bootStartPromise) return await bootStartPromise;
  if (runningServer) return { port: runningServer.port };

  let cancel!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const pending = startLocalApiServerForBoot(input, lifecycleGeneration, cancellation);
  bootStartPromise = pending;
  cancelBootStart = cancel;
  try {
    return await pending;
  } finally {
    if (bootStartPromise === pending) bootStartPromise = undefined;
    if (cancelBootStart === cancel) cancelBootStart = undefined;
  }
}

async function tombstoneDiscoveryFile(): Promise<void> {
  try {
    await openFeatureNamespace(LOCAL_API_FEATURE).writeJson(
      LOCAL_API_INFO_FILE,
      LOCAL_API_TOMBSTONE,
    );
  } catch (err) {
    log.warn(
      "failed to blank local-api discovery file: %s",
      errorMessage(err),
    );
  }
}

async function closeAndTombstone(server: LocalApiHttpServer): Promise<void> {
  await server.close();
  await tombstoneDiscoveryFile();
}

// Close streams and idle sockets before blanking discovery; repeated stops are safe, including disabled boots.
async function stopLocalApiServerForShutdown(): Promise<void> {
  stopped = true;
  lifecycleGeneration += 1;
  const pending = bootStartPromise;
  cancelBootStart?.();
  const server = runningServer;
  runningServer = null;
  try {
    if (server) {
      await closeAndTombstone(server);
    }
    if (pending) {
      await pending.catch(() => undefined);
    }
    const lateServer = runningServer;
    if (lateServer) {
      runningServer = null;
      await closeAndTombstone(lateServer);
    }
  } finally {
    await disposeA2ARuntime(initializedA2ARuntime ?? null);
    void bootA2ARuntime?.then(disposeA2ARuntime, () => undefined);
  }
}

export function stopLocalApiServer(): Promise<void> {
  if (stopPromise) return stopPromise;
  const operation = stopLocalApiServerForShutdown();
  const tracked = operation.finally(() => {
    if (stopPromise === tracked) stopPromise = undefined;
  });
  stopPromise = tracked;
  return tracked;
}

// @internal Test-only module-state reset; production boot snapshots never reset.
export function resetLocalApiServerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("local-api-server-test-reset-outside-test");
  }
  if (runningServer || bootStartPromise || stopPromise) {
    throw new Error("local-api-server-test-reset-while-active");
  }
  bootRouteFamilies = undefined;
  bootA2ARuntime = undefined;
  initializedA2ARuntime = undefined;
  bootAgentActionApprover = undefined;
  bootAgentActionApproverInitialized = false;
  disposedA2ARuntimes = new WeakSet<object>();
  lifecycleGeneration += 1;
  stopped = false;
}
