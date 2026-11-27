async function runGuardedOwnerOperation<T>(guard: () => void, operation: () => Promise<T>): Promise<T> { guard(); const result = await operation(); guard(); return result; }
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { refuseNamespaceFileCreation } from "../../__tests__/support/feature-namespace.js";
import { DEFAULT_TAILNET_OBSERVER_PORT, TAILNET_OBSERVER_PORT_BLOCKED } from "../../shared/tailnet-observer-config.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { useTempDirs as trackTempDirs } from "../../__tests__/test-helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as windowsRuntime from "@anthropic-ai/sandbox-runtime";
import * as windowsIntegrity from "../../permissions/srt-win-integrity.js";
import * as sandboxCapability from "../../permissions/sandbox-capability.js";
import * as aveHome from "../../shared/ave-home.js";
import * as sandbox from "../../permissions/asrt-sandbox.js";
import * as portHints from "../tailnet-port-hint.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { TailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import { writeJsonAtomic, type FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { createTailnetObserverConfigService } from "../tailnet-observer-config-service.js";
import type { TailnetShareActorId } from "../tailnet-pairing-share-store.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { TailnetPairingDeviceStatus } from "../../api/tailnet-surface-server.js";
import {
  configureTailscaleServe,
  getTailnetObserverRuntimeState,
  getTailnetPairedSharingRuntime,
  loadTailnetObserverConfig,
  maybeStartTailnetObserverServer,
  parseTailnetObserverConfigFile,
  probeTailscaleEnvironment,
  isPrivateServeTarget,
  resetTailnetObserverServerForTests,
  isTailnetOwnDeviceAdmissionEnabled,
  readTailnetObserverConfigFile,
  resolveTailnetObserverConfig,
  restartTailnetObserverServer,
  setTailnetOwnDeviceAdmission,
  stopTailnetObserverServer,
  tailnetWebOriginFor,
  tailscaleServeCommandText,
  writeTailnetObserverConfigFile,
  type TailnetObserverConfigFile,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from "../tailnet-surface-server.js";

vi.mock(import("@anthropic-ai/sandbox-runtime"), async importOriginal => {
  const runtime = await importOriginal();
  return {
    ...runtime,
    resolveSrtWin: vi.fn(runtime.resolveSrtWin),
    checkWindowsSandboxStatusAsync: vi.fn(runtime.checkWindowsSandboxStatusAsync),
  };
});

const CAPABILITY = "ave.example.com/cap/conversation-observer";
const CAPABILITY_ENV = "app-capability:" + CAPABILITY;
const APP_CAPABILITY = Object.freeze({ kind: "app-capability" as const, capability: CAPABILITY });
const TAILNET_IDENTITY = Object.freeze({ kind: "tailnet-identity" as const });
const WEB_ORIGIN = "https://ave.example.ts.net";
const makeTempDir = trackTempDirs("tailnet-observer-");

function runtime(): ConversationSurfaceRuntime {
  return {
    sharedProjection: {},
  } as ConversationSurfaceRuntime;
}

// A probe reading whose only question is which login this desktop is signed in as.
function tailscaleEnvironment(login: string | null) {
  return {
    state: "ready" as const,
    cliPath: "tailscale",
    login,
    dnsName: null,
    tailnetName: null,
    serveConfigured: false,
    serveTargetPort: null,
    serveStatusKnown: true,
    detail: null,
  };
}

function options(
  env: NodeJS.ProcessEnv,
  startServer = vi.fn(async (input: { port: number }) => ({
    host: "127.0.0.1" as const,
    port: input.port,
    close: vi.fn(async () => undefined),
  })),
) {
  return {
    startServer,
    input: {
      encryption: unavailableSecretEncryption,
      conversationSurfaceRuntime: runtime(),
      getCurrentConversationId: () => "main-session",
      isConversationBusy: () => false,
      env,
      dependencies: {
        startServer: startServer as never,
        // This matrix asks an environment question. Reading the real host-owned file would make the answer depend on whether the developer running it happens to
        // have an observer configured.
        readConfigFile: async (): Promise<TailnetObserverConfigFile | null> => null,
        probeEnvironment: async () => tailscaleEnvironment(null),
      },
    },
  };
}

afterEach(async () => {
  await stopTailnetObserverServer();
  resetTailnetObserverServerForTests();
});

describe("Tailnet observer lifecycle", () => {
  it("refuses an overridden port in the confined-worker loopback range before starting", async () => {
    const port = DEFAULT_TAILNET_OBSERVER_PORT;
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const range = vi.spyOn(sandbox, "getWindowsProxyPortRange").mockReturnValue([port - 1, port]);
    try {
      const f = options({
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_OBSERVER_PORT: String(port),
      });
      await expect(maybeStartTailnetObserverServer(f.input)).rejects.toThrow("tailnet-observer-port-confined-worker-range");
      expect(f.startServer).not.toHaveBeenCalled();
      expect(getTailnetObserverRuntimeState().lastStartError).toBe("tailnet-observer-port-confined-worker-range");

      range.mockReturnValue(sandbox.DEFAULT_WINDOWS_PROXY_PORT_RANGE);
      const accepted = options({ AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV });
      await expect(maybeStartTailnetObserverServer(accepted.input)).resolves.toEqual({ port });
    } finally {
      range.mockRestore();
      platform.mockRestore();
    }
  });

  it.each(["extended", "unreadable", "stock", "disabled save", "environment-disabled save"] as const)("handles the %s Windows listener case", async installed => {
    const port = DEFAULT_TAILNET_OBSERVER_PORT;
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const requested = vi.spyOn(sandboxCapability, "isPluginWorkerConfinementRequestedAtBoot").mockReturnValue(true);
    // The dependency check passed, but background Windows isolation has not selected the worker yet.
    const substrate = vi.spyOn(sandboxCapability, "getWindowsSandboxSubstrate").mockReturnValue({
      mxc: { state: "available" }, windowsBuild: "26100", shells: "mxc", extensions: "none",
      srtWinReady: true, shellEgressIdentity: "kernel-channel", extensionEgressIdentity: "shared",
    });
    const stock = [...sandbox.DEFAULT_WINDOWS_PROXY_PORT_RANGE] as [number, number];
    const configured = vi.spyOn(sandbox, "getWindowsProxyPortRange").mockReturnValue(stock);
    const privacy = vi.spyOn(aveHome, "getAveHomePrivacyFailure").mockReturnValue(undefined);
    const prepare = vi.spyOn(windowsIntegrity, "prepareSrtWinExecutable").mockReturnValue("srt-win.exe");
    vi.mocked(windowsRuntime.resolveSrtWin).mockReturnValue({ exe: "srt-win.exe", prependArgs: [] });
    const unreadable = installed !== "stock" && installed !== "extended";
    const status = vi.mocked(windowsRuntime.checkWindowsSandboxStatusAsync).mockResolvedValue({
      user: { provisioned: false, groupExists: false, inBuiltinUsers: false, inSandboxGroup: false, hiddenFromLogon: false, credPresent: false, realUserSid: "S-1-5-21-1" },
      wfp: unreadable ? { state: "cannot-read", filters: 0 } : {
        state: "installed", filters: 2, portRange: installed === "stock" ? stock : [port, stock[1]],
      },
    });
    try {
      if (installed === "disabled save" || installed === "environment-disabled save") {
        const customPort = port - 1;
        const dir = makeTempDir();
        const namespace = {
          dir, writeJson: (name: string, value: unknown) => writeJsonAtomic(dir, name, value),
        } as FeatureNamespaceHandle;
        const read = () => readTailnetObserverConfigFile(namespace);
        await namespace.writeJson("observer.json", { enabled: true, authorization: TAILNET_IDENTITY, port: customPort });
        const env = installed === "environment-disabled save" ? { AVE_TAILNET_OBSERVER: "0" } : {};
        const f = options(env);
        f.input.dependencies.readConfigFile = read;
        const starting = maybeStartTailnetObserverServer(f.input);
        if (installed === "disabled save") await expect(starting).rejects.toThrow("tailnet-observer-confined-range-unverified");
        else await expect(starting).resolves.toBeNull();

        const service = createTailnetObserverConfigService({
          pairedSharingBootstrapFailed: () => false,
          env, readConfigFile: read,
          writeConfigFile: file => writeTailnetObserverConfigFile(file, namespace),
          readOwnDeviceAdmission: async () => false,
          probeEnvironment: async () => tailscaleEnvironment(null),
        });
        const saved = (await service.snapshot()).saved;
        status.mockClear();
        if (installed === "disabled save") {
          await expect(service.apply(saved)).rejects.toThrow("tailnet-observer-confined-range-unverified");
          expect(status).toHaveBeenCalledOnce();
          status.mockClear();
        }
        const enabled = installed === "environment-disabled save";
        await expect.soft(service.apply({ ...saved, enabled })).resolves.toBeUndefined();
        expect.soft(status).not.toHaveBeenCalled();
        expect.soft(await read()).toEqual({ ...(enabled ? { enabled } : {}), authorization: TAILNET_IDENTITY, port: customPort });
        await stopTailnetObserverServer();
        resetTailnetObserverServerForTests();
        const rebooted = options(env);
        rebooted.input.dependencies.readConfigFile = read;
        await expect.soft(maybeStartTailnetObserverServer(rebooted.input)).resolves.toBeNull();
        expect.soft(status).not.toHaveBeenCalled();
        expect(rebooted.startServer).not.toHaveBeenCalled();
        return;
      }
      const f = options({
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_OBSERVER_PORT: String(port),
      });
      const starting = maybeStartTailnetObserverServer(f.input);
      if (installed === "stock") {
        await expect(starting).resolves.toEqual({ port });
      } else {
        const reason = installed === "extended" ? "tailnet-observer-port-confined-worker-range"
          : "tailnet-observer-confined-range-unverified";
        await expect(starting).rejects.toThrow(reason);
        expect(getTailnetObserverRuntimeState().lastStartError).toBe(reason);
        expect(f.startServer).not.toHaveBeenCalled();
      }
      expect(status).toHaveBeenCalledOnce();
    } finally {
      status.mockClear();
      for (const spy of [prepare, privacy, configured, substrate, requested, platform]) spy.mockRestore();
    }
  });

  it("is default OFF and has zero listener construction effect", async () => {
    const f = options({});
    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toBeNull();
    expect(f.startServer).not.toHaveBeenCalled();
  });

  it("requires an explicitly named authorization boundary and a valid fixed port when enabled", () => {
    expect(resolveTailnetObserverConfig({})).toBeNull();
    expect(resolveTailnetObserverConfig({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
    })).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      authorization: APP_CAPABILITY,
      controllerEnabled: false,
      pairedSharingEnabled: false,
    });

    // Identity mode is a first-class choice, not the absence of one: it has to be named as explicitly as the capability it replaces.
    expect(resolveTailnetObserverConfig({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: "tailnet-identity",
    })).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      authorization: TAILNET_IDENTITY,
      controllerEnabled: false,
      pairedSharingEnabled: false,
    });

    expect(resolveTailnetObserverConfig({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_PAIRED_SHARING: "1",
    })).toMatchObject({
      pairedSharingEnabled: true,
    });

    // The controller needs the pairing boundary, so it is only valid WITH paired sharing — the same coupling the web adapter already requires.
    expect(resolveTailnetObserverConfig({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_CONTROLLER: "1",
      AVE_TAILNET_PAIRED_SHARING: "1",
    })).toMatchObject({
      controllerEnabled: true,
      pairedSharingEnabled: true,
    });
    expect(resolveTailnetObserverConfig({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_PAIRED_SHARING: "1",
      AVE_TAILNET_WEB: "1",
      AVE_TAILNET_WEB_ORIGIN: WEB_ORIGIN,
    })).toMatchObject({
      pairedSharingEnabled: true,
      webOrigin: WEB_ORIGIN,
    });

    for (const env of [
      { AVE_TAILNET_OBSERVER: "1" },
      { AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: "" },
      { AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: "app-capability:" },
      { AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY },
      { AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: "app-capability:__proto__" },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_OBSERVER_PORT: "0",
      },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_OBSERVER_PORT: "65536",
      },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_CONTROLLER: "true",
      },
      // Controller enabled (valid "1") but WITHOUT paired sharing — the new coupling gate rejects it rather than leaving the native routes ungated.
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_CONTROLLER: "1",
      },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_PAIRED_SHARING: "true",
      },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_WEB: "true",
      },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_WEB: "1",
      },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_PAIRED_SHARING: "1",
        AVE_TAILNET_WEB: "1",
        AVE_TAILNET_WEB_ORIGIN: "http://ave.example.ts.net",
      },
      {
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_PAIRED_SHARING: "1",
        AVE_TAILNET_WEB: "1",
        AVE_TAILNET_WEB_ORIGIN: WEB_ORIGIN + "/path",
      },

    ]) {
      expect(() => resolveTailnetObserverConfig(env)).toThrow();
    }
  });
  it("uses one injected paired-sharing runtime for the listener and main lifecycle", async () => {
    const claimInvitation = vi.fn(async () => ({ expiresAt: 123_456 }));
    const pairedRuntime = {
      store: { claimInvitation, withOwnerIdentityGuard: runGuardedOwnerOperation },
      authorizer: {
        probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), currentOwnerLogin: () => "owner@example.test", ownerIdentityError: () => null, actorIdFor: vi.fn(),
        authorize: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
    } as unknown as TailnetPairedSharingRuntime;
    const f = options({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_PAIRED_SHARING: "1",
      AVE_TAILNET_WEB: "1",
      AVE_TAILNET_WEB_ORIGIN: WEB_ORIGIN,

    });

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      tailnetPairedSharingRuntime: pairedRuntime,
    })).resolves.toEqual({ port: DEFAULT_TAILNET_OBSERVER_PORT });

    expect(getTailnetPairedSharingRuntime()).toBe(pairedRuntime);
    const serverOptions = f.startServer.mock.calls[0]?.[0] as {
      pairedSharing?: unknown;
      pairing?: { claimInvitation?: (code: string, actorId: `tailnet:${string}`, assertIdentity: () => void) => Promise<unknown> };
      web?: { origin?: string };
    };
    expect(serverOptions.pairedSharing).toBe(pairedRuntime.authorizer);
    expect(serverOptions.pairing?.claimInvitation).toBeTypeOf("function");
    expect(serverOptions.web).toEqual({ origin: WEB_ORIGIN });
    await expect(serverOptions.pairing?.claimInvitation?.(
      "ave-pair-v1." + "a".repeat(43),
      ("tailnet:" + "b".repeat(64)) as `tailnet:${string}`,
      () => {},
    )).resolves.toEqual({ expiresAt: 123_456 });
    expect(claimInvitation).toHaveBeenCalledOnce();
  });

  it("pairs the desktop's own signed-in login without a code, still only as pending", async () => {
    const ACTOR = ("tailnet:" + "b".repeat(64)) as `tailnet:${string}`;
    const OWNER_LOGIN = "owner@example.test";
    let pairing: { readonly id: string; readonly state: "pending"; readonly expiresAt: number } | null = null;
    const createInvitation = vi.fn(async () => ({
      id: "44444444-4444-4444-8444-444444444444",
      code: "ave-pair-v1." + "c".repeat(43),
      expiresAt: 4_102_444_800_000,
    }));
    const claimInvitation = vi.fn(async () => {
      pairing = { id: "55555555-5555-4555-8555-555555555555", state: "pending", expiresAt: 123_456 };
      return { pairingId: pairing.id, expiresAt: 123_456 };
    });
    const pairedRuntime = {
      store: { createInvitation, claimInvitation, currentPairing: () => pairing, withOwnerIdentityGuard: async <T>(guard: () => void, operation: () => Promise<T>): Promise<T> => { guard(); const result = await operation(); guard(); return result; } },
      authorizer: { probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), currentOwnerLogin: () => "owner@example.test", ownerIdentityError: () => null, actorIdFor: vi.fn(), authorize: vi.fn(), subscribe: vi.fn(() => () => {}) },
    } as unknown as TailnetPairedSharingRuntime;
    const f = options({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_PAIRED_SHARING: "1",
      AVE_TAILNET_WEB: "1",
      AVE_TAILNET_WEB_ORIGIN: WEB_ORIGIN,
    });

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: {
        ...f.input.dependencies,
        probeEnvironment: async () => tailscaleEnvironment(OWNER_LOGIN),
      },
      tailnetPairedSharingRuntime: pairedRuntime,
    })).resolves.toEqual({ port: DEFAULT_TAILNET_OBSERVER_PORT });

    const deviceStatus = (f.startServer.mock.calls[0]?.[0] as {
      pairing?: {
        deviceStatus?: (login: string, actorId: `tailnet:${string}`, assertIdentity: () => void) => Promise<unknown>;
      };
    }).pairing?.deviceStatus;
    expect(deviceStatus).toBeTypeOf("function");

    // The owner's own device pairs, but through the ordinary invitation: the pairing is pending and the desktop still has to activate it.
    await expect(deviceStatus?.(OWNER_LOGIN, ACTOR, () => {}))
      .resolves.toEqual({ pairing: "pending", ownDevice: true });
    expect(createInvitation).toHaveBeenCalledOnce();
    // The deadline stays on this side: what crossed the boundary is only that a pairing exists, and it is `pending` — the desktop still has to activate it.
    expect(pairing).toMatchObject({ state: "pending", expiresAt: 123_456 });

    // The waiting page reloads on a timer; re-entry must not spend a second invitation on a claim that the existing pairing would refuse.
    await expect(deviceStatus?.(OWNER_LOGIN, ACTOR, () => {}))
      .resolves.toEqual({ pairing: "pending", ownDevice: true });
    expect(createInvitation).toHaveBeenCalledOnce();

    // Another account on the same tailnet is not this desktop's device.
    await expect(deviceStatus?.("guest@example.test", ACTOR, () => {}))
      .resolves.toEqual({ pairing: "pending", ownDevice: false });
    expect(createInvitation).toHaveBeenCalledOnce();
  });

  it("pairs nobody without a code when it cannot read its own Tailscale login", async () => {
    const createInvitation = vi.fn();
    const pairedRuntime = {
      store: {
        createInvitation,
        claimInvitation: vi.fn(),
        currentPairing: () => null,
        withOwnerIdentityGuard: runGuardedOwnerOperation,
      },
      authorizer: { probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: "owner@example.com" }), currentOwnerLogin: () => null, ownerIdentityError: () => null, actorIdFor: vi.fn(), authorize: vi.fn(), subscribe: vi.fn(() => () => {}) },
    } as unknown as TailnetPairedSharingRuntime;
    const f = options({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_PAIRED_SHARING: "1",
    });

    await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: {
        ...f.input.dependencies,
        probeEnvironment: async () => tailscaleEnvironment(null),
      },
      tailnetPairedSharingRuntime: pairedRuntime,
    });

    const deviceStatus = (f.startServer.mock.calls[0]?.[0] as {
      pairing?: {
        deviceStatus?: (login: string, actorId: `tailnet:${string}`, assertIdentity: () => void) => Promise<unknown>;
      };
    }).pairing?.deviceStatus;
    await expect(deviceStatus?.(
      "owner@example.test",
      ("tailnet:" + "b".repeat(64)) as `tailnet:${string}`,
      () => {},
    )).resolves.toEqual({ pairing: "none", ownDevice: false });
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("fails closed when P2 bootstrap could not create the shared runtime", async () => {
    const f = options({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_PAIRED_SHARING: "1",
    });

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      tailnetPairedSharingRuntime: null,
    })).rejects.toThrow("tailnet-paired-sharing-runtime-unavailable");
    expect(f.startServer).not.toHaveBeenCalled();
    expect(getTailnetPairedSharingRuntime()).toBeNull();
  });

  it("starts only the separate literal-loopback observer and closes it idempotently", async () => {
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async (input: { port: number }) => ({
      host: "127.0.0.1" as const,
      port: input.port,
      close,
    }));
    const f = options({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_OBSERVER_PORT: "46174",
    }, startServer);

    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toEqual({ port: 46174 });
    await expect(maybeStartTailnetObserverServer(f.input)).resolves.toEqual({ port: 46174 });
    expect(startServer).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 46174,
      authorization: APP_CAPABILITY,
      projectionStore: f.input.conversationSurfaceRuntime.sharedProjection,
    }));

    await Promise.all([
      stopTailnetObserverServer(),
      stopTailnetObserverServer(),
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a listener that finishes starting after shutdown begins", async () => {
    let resolveServer: ((value: {
      host: "127.0.0.1";
      port: number;
      close: () => Promise<void>;
    }) => void) | undefined;
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(() => new Promise<{
      host: "127.0.0.1";
      port: number;
      close: () => Promise<void>;
    }>((resolve) => {
      resolveServer = resolve;
    }));
    const f = options({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
    }, startServer as never);

    const starting = maybeStartTailnetObserverServer(f.input);
    // Resolving the configuration reads the host-owned file, so listener construction is no longer reached within the caller's own tick. Wait for it rather
    // than assuming: this case is about the shutdown race, and a `resolveServer` that is still undefined would hang instead of failing.
    await vi.waitFor(() => expect(startServer).toHaveBeenCalled());
    const stopping = stopTailnetObserverServer();
    resolveServer?.({
      host: "127.0.0.1",
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      close,
    });

    await expect(starting).resolves.toBeNull();
    await stopping;
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("Tailnet observer configuration surface", () => {
  const file = (config: TailnetObserverConfigFile) => async () => config;

  it("boots from the host-owned file with no environment at all", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        authorization: APP_CAPABILITY,
        port: DEFAULT_TAILNET_OBSERVER_PORT,
        pairedSharingEnabled: true,
      }),
    });

    expect(resolution.config).toEqual({
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      authorization: APP_CAPABILITY,
      controllerEnabled: false,
      pairedSharingEnabled: true,
    });
    expect(resolution.fileConfigured).toBe(true);
    expect(resolution.provenance.enabled).toBe("file");
    expect(resolution.provenance.port).toBe("file");
  });

  it("stays OFF and side-effect free when neither source enables it", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: {},
      readConfigFile: async () => null,
    });

    expect(resolution.config).toBeNull();
    expect(resolution.fileConfigured).toBe(false);
    expect(new Set(Object.values(resolution.provenance))).toEqual(new Set(["unset"]));
  });

  it("lets an env var override the file per key, and says which key it took", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: { AVE_TAILNET_OBSERVER_PORT: "47000" },
      readConfigFile: file({
        enabled: true,
        authorization: APP_CAPABILITY,
        port: 46_500,
      }),
    });

    expect(resolution.config?.port).toBe(47_000);
    expect(resolution.provenance.port).toBe("env-override");
    expect(resolution.provenance.authorization).toBe("file");
  });

  it("lets the environment turn a file-enabled observer back off", async () => {
    const resolution = await loadTailnetObserverConfig({
      env: { AVE_TAILNET_OBSERVER: "0" },
      readConfigFile: file({ enabled: true, authorization: APP_CAPABILITY }),
    });

    expect(resolution.config).toBeNull();
    expect(resolution.provenance.enabled).toBe("env-override");
  });

  it("puts the file through the same gates the environment goes through", async () => {
    // One vocabulary, one validator: the file cannot admit a port, a capability key, or a scope combination the env form would have rejected.
    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({ enabled: true, authorization: APP_CAPABILITY, port: 65_536 }),
    })).rejects.toThrow("tailnet-observer-port-invalid");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        authorization: { kind: "app-capability", capability: "__proto__" },
      }),
    })).rejects.toThrow("tailnet-observer-authorization-missing-or-invalid");

    // Neither boundary named is still invalid: there is no implicit default.
    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({ enabled: true }),
    })).rejects.toThrow("tailnet-observer-authorization-missing-or-invalid");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        authorization: APP_CAPABILITY,
        controllerEnabled: true,
      }),
    })).rejects.toThrow("tailnet-controller-requires-paired-sharing");

    await expect(loadTailnetObserverConfig({
      env: {},
      readConfigFile: file({
        enabled: true,
        authorization: APP_CAPABILITY,
        pairedSharingEnabled: true,
        webEnabled: true,
      }),
    })).rejects.toThrow("tailnet-web-origin-missing-or-invalid");
  });

  it("rejects a malformed file rather than booting a half-applied config", () => {
    for (const raw of [
      [],
      "enabled",
      { enabled: "1" },
      { enabled: true, port: String(DEFAULT_TAILNET_OBSERVER_PORT) },
      { enabled: true, unknownKey: true },
      { enabled: true, authorization: "tailnet-identity" },
      { enabled: true, authorization: { kind: "app-capability" } },
      { enabled: true, authorization: { kind: "tailnet-identity", capability: "x" } },
    ]) {
      expect(() => parseTailnetObserverConfigFile(raw))
        .toThrow("tailnet-observer-config-file-invalid");
    }
  });

  it("keeps the env-only resolver on the answers it has always given", async () => {
    const env = {
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_PAIRED_SHARING: "1",
    };

    expect(resolveTailnetObserverConfig(env)).toEqual(
      (await loadTailnetObserverConfig({ env, readConfigFile: async () => null })).config,
    );
  });

  it.each([
    { name: "legacy route", target: 46_173, override: undefined, port: 46_173, notice: "Preserving listener port 46173" },
    { name: "fresh install", target: null, override: undefined, port: 28_173, notice: null },
    { name: "explicit override", target: 46_173, override: "28999", port: 28_999, notice: "Serve targets port 46173; the configured listener port is 28999" },
    { name: "unrelated route", target: 39_000, override: undefined, port: 28_173, notice: "Serve targets port 39000; the configured listener port is 28173" },
  ])("resolves an environment-only listener with $name", async ({ target, override, port, notice }) => {
    const env = {
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      ...(override === undefined ? {} : { AVE_TAILNET_OBSERVER_PORT: override }),
    };
    const { input, startServer } = options(env);
    const runCommand = runner({
      "status --json": { kind: "ran", code: 0, stdout: readyStatus(), stderr: "" },
      "serve status --json": {
        kind: "ran", code: 0, stderr: "",
        stdout: JSON.stringify(target === null ? {} : {
          Web: { "desk.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${target}` } } } },
        }),
      },
    });
    const probeEnvironment = () => probeTailscaleEnvironment({ platform: "linux", runCommand });
    const log = vi.fn();
    const settings = createTailnetObserverConfigService({
      pairedSharingBootstrapFailed: () => false,
      env,
      readConfigFile: input.dependencies.readConfigFile,
      readOwnDeviceAdmission: async () => false,
      probeEnvironment,
    });

    await expect.soft(maybeStartTailnetObserverServer({
      ...input, log, dependencies: { ...input.dependencies, probeEnvironment },
    })).resolves.toEqual({ port });
    expect.soft(startServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port }));
    await expect.soft(settings.snapshot()).resolves.toMatchObject({
      saved: { port: target === 46_173 ? target : DEFAULT_TAILNET_OBSERVER_PORT, enabled: false },
      effective: { port, enabled: true },
      listeningPort: port,
      provenance: { port: override === undefined ? "unset" : "env-override" },
      environment: { serveTargetPort: target },
    });
    if (notice !== null) expect(log).toHaveBeenCalledWith(expect.stringContaining(notice));
  });

  it.each([
    { name: "missing CLI", status: { kind: "not-found" } },
    { name: "stopped daemon", status: { kind: "ran", code: 0, stdout: readyStatus({ BackendState: "Stopped" }), stderr: "" } },
    { name: "failed Serve query", serve: { kind: "ran", code: 1, stdout: "", stderr: "Unavailable" } },
    { name: "unparseable Serve status", serve: { kind: "ran", code: 0, stdout: "", stderr: "" } },
    { name: "malformed Serve route", serve: { kind: "ran", code: 0, stdout: '{"Web":{"desk.example-tailnet.ts.net:443":{}}}', stderr: "" } },
  ] satisfies { name: string; status?: TailscaleCommandResult; serve?: TailscaleCommandResult }[])(
    "keeps the implicit legacy port during $name and after Serve recovers",
    async ({ status, serve }) => {
      const port = 46_173;
      const { input, startServer } = options({
        AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      });
      const ready: TailscaleCommandResult = { kind: "ran", code: 0, stdout: readyStatus(), stderr: "" };
      const recovered: TailscaleCommandResult = {
        kind: "ran", code: 0, stderr: "",
        stdout: JSON.stringify({
          Web: { "desk.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:46173" } } } },
        }),
      };
      let available = false;
      const probeEnvironment = () => probeTailscaleEnvironment({
        platform: "linux",
        runCommand: runner({
          "status --json": available ? ready : status ?? ready,
          "serve status --json": available ? recovered : serve ?? recovered,
        }),
      });

      await expect.soft(maybeStartTailnetObserverServer({
        ...input, dependencies: { ...input.dependencies, probeEnvironment },
      })).resolves.toEqual({ port });
      available = true;
      await expect.soft(probeEnvironment()).resolves.toMatchObject({ serveTargetPort: port });
      expect(startServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port }));
    },
  );

  it("identifies the observer Serve route among multiple handlers and listeners", async () => {
    const port = 46_173;
    const { input, startServer } = options({
      AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
    });
    const probeEnvironment = () => probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": { kind: "ran", code: 0, stdout: readyStatus(), stderr: "" },
        "serve status --json": {
          kind: "ran", code: 0, stderr: "",
          stdout: JSON.stringify({
            Web: {
              "unrelated.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:29001" } } },
              "desk.example-tailnet.ts.net:443": {
                Handlers: {
                  "/other": { Proxy: "http://127.0.0.1:29002" },
                  "/": { Proxy: "http://127.0.0.1:46173" },
                },
              },
            },
          }),
        },
      }),
    });

    await expect.soft(maybeStartTailnetObserverServer({
      ...input, dependencies: { ...input.dependencies, probeEnvironment },
    })).resolves.toEqual({ port });
    await expect.soft(probeEnvironment()).resolves.toMatchObject({ serveConfigured: true, serveTargetPort: port });
    expect(startServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port }));
  });

  it.each([
    { route: "foreground root", foreground: "root", override: undefined, port: 46_173, target: 46_173, known: true },
    { route: "empty foreground", foreground: "empty", override: undefined, port: 28_173, target: null, known: true },
    { route: "malformed foreground", foreground: "invalid", override: undefined, port: 46_173, target: null, known: false },
    { route: "conflicting foreground and background roots", foreground: "conflict", override: undefined, port: 46_173, target: null, known: false },
    { route: "foreground root with override", foreground: "root", override: "29999", port: 29_999, target: 46_173, known: true },
  ])("uses $route as boot port evidence", async ({ foreground, override, port, target, known }) => {
    const { input, startServer } = options({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_OBSERVER_PORT: override,
    });
    const foregroundWeb = {
      "desk.example-tailnet.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:46173" } },
      },
    };
    const status = foreground === "empty" ? { Foreground: {} }
      : foreground === "invalid" ? { Foreground: { session: { Web: false } } }
      : {
        Foreground: { session: { Web: foregroundWeb } },
        ...(foreground === "conflict" ? {
          Web: { "desk.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:28173" } } } },
        } : {}),
      };
    const runCommand = runner({
      "status --json": { kind: "ran", code: 0, stdout: readyStatus(), stderr: "" },
      "serve status --json": { kind: "ran", code: 0, stdout: JSON.stringify(status), stderr: "" },
    });
    const probeEnvironment = () => probeTailscaleEnvironment({ platform: "linux", runCommand });
    const log = vi.fn();

    await expect.soft(probeEnvironment()).resolves.toMatchObject({
      serveStatusKnown: known,
      serveConfigured: target !== null,
      serveTargetPort: target,
    });
    await expect.soft(maybeStartTailnetObserverServer({
      ...input, log, dependencies: { ...input.dependencies, probeEnvironment },
    })).resolves.toEqual({ port });
    expect.soft(startServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port }));
    if (override !== undefined) {
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Serve targets port 46173; the configured listener port is 29999"));
    }
  });

  it.each([
    { name: "without editing the port", target: 46_173, override: undefined, edit: undefined, savedPort: 46_173, listeningPort: 46_173 },
    { name: "with an explicit port edit", target: 46_173, override: undefined, edit: 29_123, savedPort: 29_123, listeningPort: 29_123 },
    { name: "with a port edit under an environment override", target: 46_173, override: "46173", edit: 29_123, savedPort: 29_123, listeningPort: 46_173 },
    { name: "with a temporary override and no Serve route", target: null, override: "29999", edit: undefined, savedPort: 28_173, listeningPort: 29_999 },
    { name: "with a deliberate edit matching the override", target: null, override: "29999", edit: 29_999, savedPort: 29_999, listeningPort: 29_999 },
  ])("takes over an environment-only listener $name", async ({ target, override, edit, savedPort, listeningPort }) => {
    const bootPort = override === undefined ? target ?? DEFAULT_TAILNET_OBSERVER_PORT : Number(override);
    const env = {
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
      AVE_TAILNET_OBSERVER_PORT: override,
    };
    const { input, startServer } = options(env);
    const probeEnvironment = async () => ({
      ...tailscaleEnvironment(null), serveConfigured: target !== null, serveTargetPort: target,
    });
    let saved: TailnetObserverConfigFile | null = null;
    const readConfigFile = async () => saved;
    const writeConfigFile = vi.fn(async (file: TailnetObserverConfigFile) => { saved = file; });
    const runServe = vi.fn();
    const settings = createTailnetObserverConfigService({
      pairedSharingBootstrapFailed: () => false,
      env, readConfigFile, writeConfigFile, probeEnvironment, runServe,
      readOwnDeviceAdmission: async () => false,
    });

    await expect(maybeStartTailnetObserverServer({
      ...input, dependencies: { ...input.dependencies, readConfigFile, probeEnvironment },
    })).resolves.toEqual({ port: bootPort });

    const initial = await settings.snapshot();
    if (edit === undefined) expect.soft(initial.saved.port).toBe(savedPort);
    await settings.apply({
      ...initial.saved, enabled: true, authorization: APP_CAPABILITY, port: edit ?? initial.saved.port,
    });

    expect.soft(writeConfigFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: savedPort }));
    expect.soft(startServer.mock.calls.map(([config]) => config.port)).toEqual([bootPort, listeningPort]);
    await expect(settings.snapshot()).resolves.toMatchObject({
      saved: { port: savedPort },
      effective: { port: listeningPort },
      provenance: { port: override === undefined ? "file" : "env-override" },
      environment: { serveTargetPort: target },
    });
    if (override !== undefined) {
      env.AVE_TAILNET_OBSERVER_PORT = undefined;
      await expect(restartTailnetObserverServer()).resolves.toEqual({ port: savedPort });
    }
    expect(runServe).not.toHaveBeenCalled();
  });

  it("boots a portless upgrade fixture on its existing Serve target and saves the legacy port", async () => {
    const port = 46_173;
    const dir = makeTempDir();
    const namespace = {
      dir, writeJson: (name: string, value: unknown) => writeJsonAtomic(dir, name, value),
    } as FeatureNamespaceHandle;
    const legacy = { enabled: true, authorization: TAILNET_IDENTITY, webEnabled: true, webOrigin: WEB_ORIGIN, pairedSharingEnabled: true };
    await namespace.writeJson("observer.json", legacy);
    const readConfigFile = () => readTailnetObserverConfigFile(namespace);
    const probeEnvironment = () => probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": { kind: "ran", code: 0, stdout: readyStatus({ Self: { UserID: 7, DNSName: "ave.example.ts.net." } }), stderr: "" },
        "serve status --json": {
          kind: "ran", code: 0, stderr: "",
          stdout: JSON.stringify({
            Web: { "ave.example.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
          }),
        },
      }),
    });
    const { input, startServer } = options({});
    const settings = createTailnetObserverConfigService({
      pairedSharingBootstrapFailed: () => false,
      env: {}, readConfigFile,
      readOwnDeviceAdmission: async () => false,
      probeEnvironment,
    });

    await maybeStartTailnetObserverServer({
      ...input,
      tailnetPairedSharingRuntime: fakeRuntime(fakeStore()),
      dependencies: { ...input.dependencies, readConfigFile, probeEnvironment },
    });

    expect.soft(startServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port }));
    await expect.soft(settings.snapshot()).resolves.toMatchObject({
      listeningPort: port,
      saved: { port },
      provenance: { port: "file" },
      environment: { serveConfigured: true, serveTargetPort: port },
    });
    expect(JSON.parse(await readFile(join(dir, "observer.json"), "utf8"))).toEqual({ ...legacy, port });
  });

  it.each([
    { enabled: undefined, env: {} },
    { enabled: true, env: { AVE_TAILNET_OBSERVER: "0" } },
  ])("preserves disabled legacy file bytes across boot and Settings refresh (%j)", async ({ enabled, env }) => {
    const port = enabled ? 46_173 : DEFAULT_TAILNET_OBSERVER_PORT;
    const dir = makeTempDir();
    const configPath = join(dir, "observer.json");
    const namespace = {
      dir, writeJson: (name: string, value: unknown) => writeJsonAtomic(dir, name, value),
    } as FeatureNamespaceHandle;
    const original = Buffer.from(JSON.stringify({ authorization: TAILNET_IDENTITY, enabled }, null, 4) + "\r\n");
    await writeFile(configPath, original);
    const readConfigFile = () => readTailnetObserverConfigFile(namespace, env);
    const { input, startServer } = options(env);
    const settings = createTailnetObserverConfigService({
      pairedSharingBootstrapFailed: () => false,
      env,
      readConfigFile,
      writeConfigFile: file => writeTailnetObserverConfigFile(file, namespace),
      readOwnDeviceAdmission: async () => false,
      probeEnvironment: () => probeTailscaleEnvironment({
        platform: "linux",
        runCommand: async () => ({ kind: "not-found" }),
      }),
      restartListener: async () => undefined,
    });

    await expect(maybeStartTailnetObserverServer({
      ...input, dependencies: { ...input.dependencies, readConfigFile },
    })).resolves.toBeNull();
    expect(startServer).not.toHaveBeenCalled();
    expect.soft((await readFile(configPath)).equals(original)).toBe(true);

    const snapshot = await settings.snapshot();
    expect(snapshot.saved.port).toBe(port);
    expect(snapshot.effective).toMatchObject({ port, enabled: false });
    expect.soft((await readFile(configPath)).equals(original)).toBe(true);

    await settings.apply(snapshot.saved);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ port });
  });

  it("starts the listener from a file-only configuration", async () => {
    const f = options({});
    const started = await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: {
        startServer: f.startServer as never,
        readConfigFile: file({ enabled: true, authorization: APP_CAPABILITY, port: DEFAULT_TAILNET_OBSERVER_PORT }),
      },
    });

    expect(started?.port).toBe(DEFAULT_TAILNET_OBSERVER_PORT);
    expect(f.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", authorization: APP_CAPABILITY }),
    );
  });
});

// A `tailscale status --json` payload for a node that is up and signed in.
describe("Tailnet observer port state table", () => {
  const defaultPort = DEFAULT_TAILNET_OBSERVER_PORT;
  const legacyPort = 46_173;
  const overridePort = 29_999;
  const savedPort = 29_123;
  interface PortCase {
    id: string;
    file: "none" | "on" | "off" | number;
    route: "foreground" | "background" | "absent" | "failed" | "unavailable" | "unrelated";
    enable?: boolean;
    override?: number;
    priorListener?: boolean;
    occupied?: number;
    holdsDefault?: boolean;
    edit?: number;
    boot: number | null;
    draft: number;
    guided: number | "alternate" | "not-ready" | "forced-off";
  }
  const cases: PortCase[] = [
    { id: "C1 R3 E1 B1", file: "none", route: "absent", boot: null, draft: defaultPort, guided: defaultPort },
    {
      id: "C2 R3 B2", file: "none", route: "absent", enable: true, occupied: defaultPort,
      boot: defaultPort, draft: defaultPort, guided: "alternate",
    },
    { id: "C2 R5", file: "none", route: "unrelated", enable: true, boot: defaultPort, draft: defaultPort, guided: defaultPort },
    { id: "C3 R1", file: "none", route: "foreground", enable: true, boot: legacyPort, draft: legacyPort, guided: legacyPort },
    { id: "C3 R2 B3", file: "none", route: "background", boot: null, draft: legacyPort, guided: legacyPort },
    { id: "C4 R4", file: "none", route: "failed", enable: true, boot: legacyPort, draft: legacyPort, guided: legacyPort },
    { id: "C5 R4", file: "none", route: "failed", boot: null, draft: defaultPort, guided: defaultPort },
    {
      id: "C6", file: "none", route: "absent", enable: true, priorListener: true,
      boot: legacyPort, draft: legacyPort, guided: legacyPort,
    },
    { id: "C7", file: "on", route: "absent", boot: legacyPort, draft: legacyPort, guided: legacyPort },
    { id: "C7 forced OFF", file: "on", route: "absent", enable: false, boot: null, draft: legacyPort, guided: "forced-off" },
    {
      id: "C8 with occupied legacy port", file: "off", route: "absent", occupied: legacyPort,
      boot: null, draft: defaultPort, guided: defaultPort,
    },
    {
      id: "C8 with occupied default", file: "off", route: "absent", occupied: defaultPort,
      boot: null, draft: defaultPort, guided: "alternate",
    },
    { id: "C8 environment ON", file: "off", route: "absent", enable: true, boot: defaultPort, draft: defaultPort, guided: defaultPort },
    { id: "C9", file: "off", route: "foreground", boot: null, draft: legacyPort, guided: legacyPort },
    { id: "C9 environment ON", file: "off", route: "background", enable: true, boot: legacyPort, draft: legacyPort, guided: legacyPort },
    { id: "C10 ready", file: "off", route: "failed", boot: null, draft: defaultPort, guided: defaultPort },
    { id: "C10 unavailable", file: "off", route: "unavailable", boot: null, draft: defaultPort, guided: "not-ready" },
    {
      id: "C10 environment ON with occupied legacy port", file: "off", route: "failed", enable: true, occupied: legacyPort,
      boot: defaultPort, draft: defaultPort, guided: defaultPort,
    },
    {
      id: "C10 environment ON with occupied default", file: "off", route: "failed", enable: true, occupied: defaultPort,
      boot: defaultPort, draft: defaultPort, guided: "alternate",
    },
    {
      id: "C10 environment ON with unavailable node", file: "off", route: "unavailable", enable: true,
      boot: defaultPort, draft: defaultPort, guided: "not-ready",
    },
    { id: "C11", file: savedPort, route: "foreground", boot: null, draft: savedPort, guided: savedPort },
    {
      id: "C11 B4", file: defaultPort, route: "absent", enable: true, occupied: defaultPort,
      boot: defaultPort, draft: defaultPort, guided: defaultPort,
    },
    {
      id: "C12", file: "off", route: "absent", enable: true, priorListener: true,
      boot: legacyPort, draft: legacyPort, guided: legacyPort,
    },
    {
      id: "E2 B4", file: "none", route: "absent", enable: true, override: overridePort, occupied: overridePort,
      boot: overridePort, draft: defaultPort, guided: defaultPort,
    },
    {
      id: "E3", file: "none", route: "background", enable: true, override: overridePort,
      boot: overridePort, draft: legacyPort, guided: legacyPort,
    },
    {
      id: "E4", file: "none", route: "absent", enable: true, override: overridePort, edit: overridePort,
      boot: overridePort, draft: defaultPort, guided: defaultPort,
    },
    {
      id: "C2 E6 B5 listener holds the default", file: "none", route: "absent", enable: true, override: defaultPort,
      holdsDefault: true, boot: defaultPort, draft: defaultPort, guided: defaultPort,
    },
  ];

  it.each(cases.flatMap(row => (["boot", "Settings", "guided setup"] as const).map(entry => ({ ...row, entry }))))(
    "$id through $entry",
    async ({ file, route, enable, override, priorListener, occupied, holdsDefault, edit, boot, draft, guided, entry }) => {
      const dir = makeTempDir();
      const configPath = join(dir, "observer.json");
      const namespace = {
        dir, writeJson: vi.fn((name: string, value: unknown) => writeJsonAtomic(dir, name, value)),
      } as FeatureNamespaceHandle;
      const legacyFile = file === "on" || file === "off";
      const initial = file === "none" ? null : {
        authorization: TAILNET_IDENTITY,
        ...(file === "on" ? { enabled: true } : {}),
        ...(typeof file === "number" ? { port: file } : {}),
      };
      const original = initial === null ? null : JSON.stringify(initial, null, 4) + "\r\n";
      if (original !== null) await writeFile(configPath, original);
      const env: NodeJS.ProcessEnv = {
        AVE_TAILNET_OBSERVER: enable === undefined ? undefined : enable ? "1" : "0",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_OBSERVER_PORT: override?.toString(),
      };
      const readConfigFile = () => readTailnetObserverConfigFile(namespace, env);
      const writeConfigFile = vi.fn((next: TailnetObserverConfigFile) => writeTailnetObserverConfigFile(next, namespace));
      let currentRoute = priorListener ? "background" : route;
      const probeEnvironment = () => {
        const Web = {
          "desk.example-tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:" + (currentRoute === "unrelated" ? 39_000 : legacyPort) } },
          },
        };
        const serveStatus = currentRoute === "foreground" ? { Foreground: { session: { Web } } }
          : currentRoute === "background" || currentRoute === "unrelated" ? { Web } : {};
        return probeTailscaleEnvironment({
          platform: "linux",
          runCommand: runner({
            "status --json": {
              kind: "ran", code: 0, stderr: "",
              stdout: readyStatus(currentRoute === "unavailable" ? { BackendState: "Stopped" } : {}),
            },
            "serve status --json": {
              kind: "ran", code: currentRoute === "failed" ? 1 : 0, stdout: JSON.stringify(serveStatus), stderr: "",
            },
          }),
        });
      };
      const { input, startServer } = options(env);
      startServer.mockImplementation(async ({ port }) => {
        if (port === occupied) throw Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });
        return { host: "127.0.0.1", port, close: vi.fn(async () => undefined) };
      });
      const runServe = vi.fn(async () => ({ ok: true as const }));
      const settings = createTailnetObserverConfigService({
        pairedSharingBootstrapFailed: () => false, env, readConfigFile, writeConfigFile, probeEnvironment, runServe,
        readOwnDeviceAdmission: async () => false,
      });
      const assertBind = async (action: Promise<unknown>, port: number | null) => {
        if (port !== null && port === occupied) {
          await expect(action).rejects.toThrow(TAILNET_OBSERVER_PORT_BLOCKED);
          expect(getTailnetObserverRuntimeState().portBlock).toMatchObject({ port, code: "EADDRINUSE" });
        } else {
          await action;
          expect(getTailnetObserverRuntimeState().listeningPort).toBe(port);
        }
      };
      const hint = vi.spyOn(portHints, "getWindowsTailnetPortHint").mockResolvedValue(null);
      const blocker = createServer();
      try {
        if (entry === "guided setup" && (guided === "alternate" || holdsDefault)) {
          await new Promise<void>((resolve, reject) => {
            blocker.once("error", (error: NodeJS.ErrnoException) => {
              if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve();
              else reject(error);
            });
            blocker.listen({ host: "127.0.0.1", port: defaultPort, exclusive: true }, resolve);
          });
        }
        await assertBind(maybeStartTailnetObserverServer({
          ...input,
          dependencies: { ...input.dependencies, readConfigFile, probeEnvironment },
          tailnetPairedSharingRuntime: fakeRuntime(fakeStore()),
        }), boot);
        if (priorListener) {
          currentRoute = route;
          await assertBind(restartTailnetObserverServer(), boot);
        }

        const snapshot = await settings.snapshot();
        expect.soft(snapshot.saved.port).toBe(draft);
        if (file === "on" && enable !== false) {
          expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ ...initial, port: legacyPort });
        } else if (legacyFile) {
          expect(await readFile(configPath, "utf8")).toBe(original);
        }
        expect(writeConfigFile).not.toHaveBeenCalled();
        if (entry === "boot") {
          expect(runServe).not.toHaveBeenCalled();
          return;
        }
        if (entry === "Settings") {
          const chosen = edit ?? draft;
          await assertBind(settings.apply({ ...snapshot.saved, enabled: true, port: chosen }), enable === false ? null : override ?? chosen);
          expect(writeConfigFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: chosen }));
          expect(runServe).not.toHaveBeenCalled();
          return;
        }

        const result = await settings.guidedSetup();
        if (guided === "not-ready" || guided === "forced-off") {
          expect(result).toMatchObject({
            ok: false, error: guided === "not-ready" ? "tailnet-guided-setup-not-ready" : "tailnet-serve-not-listening",
          });
          expect(writeConfigFile).not.toHaveBeenCalled();
          expect(runServe).not.toHaveBeenCalled();
          return;
        }
        const writtenPort = writeConfigFile.mock.lastCall?.[0].port;
        if (guided === "alternate") {
          expect.soft(writtenPort).toEqual(expect.any(Number));
          expect.soft(writtenPort).not.toBe(defaultPort);
        } else {
          expect.soft(writtenPort).toBe(guided);
        }
        const runtimePort = override ?? writtenPort;
        if (runtimePort !== undefined && runtimePort === occupied) {
          expect(result).toMatchObject({ ok: false, error: TAILNET_OBSERVER_PORT_BLOCKED });
          expect(getTailnetObserverRuntimeState().portBlock).toMatchObject({ port: runtimePort });
          expect(runServe).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ ok: true, port: runtimePort });
          if ((route === "foreground" || route === "background") && runtimePort === legacyPort) {
            expect(runServe).not.toHaveBeenCalled();
          } else {
            expect(runServe).toHaveBeenCalledExactlyOnceWith({ cliPath: "tailscale", port: runtimePort });
          }
        }
      } finally {
        hint.mockRestore();
        if (blocker.listening) await new Promise<void>(resolve => blocker.close(() => resolve()));
      }
    },
  );
});

function readyStatus(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    BackendState: "Running",
    Self: { UserID: 7, DNSName: "desk.example-tailnet.ts.net." },
    User: { "7": { LoginName: "owner@example.com" } },
    CurrentTailnet: { Name: "example-tailnet.ts.net" },
    ...overrides,
  });
}

function runner(
  answers: Record<string, TailscaleCommandResult>,
): TailscaleCommandRunner {
  return async (_cliPath, args) =>
    answers[args.join(" ")] ?? { kind: "ran", code: 1, stdout: "", stderr: "no such command" };
}

describe("Tailscale environment probe", () => {
  it("reads the tailnet, the node name, and the login instead of asking for them", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": { kind: "ran", code: 0, stdout: readyStatus(), stderr: "" },
        "serve status --json": {
          kind: "ran",
          code: 0,
          stdout: JSON.stringify({
            Web: { "desk.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${DEFAULT_TAILNET_OBSERVER_PORT}` } } } },
          }),
          stderr: "",
        },
      }),
    });

    expect(environment.state).toBe("ready");
    expect(environment.login).toBe("owner@example.com");
    expect(environment.dnsName).toBe("desk.example-tailnet.ts.net");
    expect(environment.tailnetName).toBe("example-tailnet.ts.net");
    expect(environment.serveConfigured).toBe(true);
    expect(environment.serveTargetPort).toBe(DEFAULT_TAILNET_OBSERVER_PORT);
  });

  it("names a logged-out node instead of reporting an empty tailnet", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 0,
          stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
          stderr: "",
        },
      }),
    });

    expect(environment.state).toBe("logged-out");
    expect(environment.login).toBeNull();
    expect(environment.dnsName).toBeNull();
  });

  it("names a stopped backend separately from a signed-out one", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 0,
          stdout: JSON.stringify({ BackendState: "Stopped" }),
          stderr: "",
        },
      }),
    });

    expect(environment.state).toBe("stopped");
    expect(environment.detail).toBe("Stopped");
  });

  it("reports a node with no MagicDNS name as ready without inventing one", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 0,
          stdout: readyStatus({ Self: { UserID: 7, DNSName: "" }, CurrentTailnet: null }),
          stderr: "",
        },
        "serve status --json": { kind: "ran", code: 0, stdout: "{}", stderr: "" },
      }),
    });

    expect(environment.state).toBe("ready");
    expect(environment.dnsName).toBeNull();
    expect(environment.tailnetName).toBeNull();
    expect(tailnetWebOriginFor(environment.dnsName)).toBeNull();
  });

  it("reports an absent Tailscale as its own state, not as a stopped node", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: async () => ({ kind: "not-found" as const }),
    });

    expect(environment.state).toBe("cli-not-found");
    expect(environment.cliPath).toBeNull();
  });

  it("carries what the CLI printed when it could not answer", async () => {
    const environment = await probeTailscaleEnvironment({
      platform: "linux",
      runCommand: runner({
        "status --json": {
          kind: "ran",
          code: 1,
          stdout: "",
          stderr: "failed to connect to local backend",
        },
      }),
    });

    expect(environment.state).toBe("cli-failed");
    expect(environment.detail).toBe("failed to connect to local backend");
  });

  it("derives the web origin from the MagicDNS name", () => {
    expect(tailnetWebOriginFor("desk.example-tailnet.ts.net"))
      .toBe("https://desk.example-tailnet.ts.net");
    expect(tailnetWebOriginFor("desk.example.internal")).toBeNull();
  });
});

describe("Tailscale Serve configuration", () => {
  it("shows the command it will run, built from the argv it runs", () => {
    expect(tailscaleServeCommandText("tailscale", DEFAULT_TAILNET_OBSERVER_PORT))
      .toBe(`tailscale serve --bg --https=443 http://127.0.0.1:${DEFAULT_TAILNET_OBSERVER_PORT}`);
  });

  it("runs the command for the owner and reports success", async () => {
    const runCommand = vi.fn(async () => ({ kind: "ran" as const, code: 0, stdout: "", stderr: "" }));

    await expect(configureTailscaleServe({ cliPath: "tailscale", port: DEFAULT_TAILNET_OBSERVER_PORT, runCommand }))
      .resolves.toEqual({ ok: true });
    expect(runCommand).toHaveBeenCalledWith(
      "tailscale",
      ["serve", "--bg", "--https=443", `http://127.0.0.1:${DEFAULT_TAILNET_OBSERVER_PORT}`],
    );
  });

  it("hands back what Tailscale printed when the command fails", async () => {
    const outcome = await configureTailscaleServe({
      cliPath: "tailscale",
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      runCommand: async () => ({
        kind: "ran" as const,
        code: 1,
        stdout: "",
        stderr: "HTTPS is not enabled on this tailnet",
      }),
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "command-failed",
      output: "HTTPS is not enabled on this tailnet",
    });
  });
});

describe("Tailnet observer restart", () => {
  it("brings the listener up on a newly saved configuration without a relaunch", async () => {
    const f = options({});
    let saved: TailnetObserverConfigFile | null = null;

    await expect(maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: { startServer: f.startServer as never, readConfigFile: async () => saved },
    })).resolves.toBeNull();
    expect(f.startServer).not.toHaveBeenCalled();

    saved = { enabled: true, authorization: APP_CAPABILITY, port: 46_500 };
    const started = await restartTailnetObserverServer();

    expect(started?.port).toBe(46_500);
    expect(getTailnetObserverRuntimeState().listeningPort).toBe(46_500);
  });

  it("closes the running listener when the saved configuration turns it off", async () => {
    const f = options({});
    let saved: TailnetObserverConfigFile | null = {
      enabled: true,
      authorization: APP_CAPABILITY,
      port: DEFAULT_TAILNET_OBSERVER_PORT,
    };

    await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: { startServer: f.startServer as never, readConfigFile: async () => saved },
    });
    expect(getTailnetObserverRuntimeState().listeningPort).toBe(DEFAULT_TAILNET_OBSERVER_PORT);

    saved = null;
    await expect(restartTailnetObserverServer()).resolves.toBeNull();
    expect(getTailnetObserverRuntimeState().listeningPort).toBeNull();
  });

  it("records why a restart failed instead of leaving a half-applied listener", async () => {
    const f = options({});
    let saved: TailnetObserverConfigFile | null = null;

    await maybeStartTailnetObserverServer({
      ...f.input,
      dependencies: { startServer: f.startServer as never, readConfigFile: async () => saved },
    });

    saved = { enabled: true };
    await expect(restartTailnetObserverServer()).rejects.toThrow(
      "tailnet-observer-authorization-missing-or-invalid",
    );
    expect(getTailnetObserverRuntimeState().lastStartError)
      .toBe("tailnet-observer-authorization-missing-or-invalid");
    expect(getTailnetObserverRuntimeState().listeningPort).toBeNull();
  });
});

describe("blocked Tailnet listener ports", () => {
  it.each(["EADDRINUSE", "EACCES"] as const)("reports %s and only retries the port the owner chose", async code => {
    const port = 28_243;
    const replacementPort = port + 1;
    let file: TailnetObserverConfigFile = { enabled: true, authorization: APP_CAPABILITY, port };
    const f = options({});
    const hint = code === "EACCES" ? "excluded-range" : null;
    const getHint = vi.spyOn(portHints, "getWindowsTailnetPortHint").mockResolvedValue(hint);
    const settings = createTailnetObserverConfigService({
      pairedSharingBootstrapFailed: () => false,
      env: {},
      readConfigFile: async () => file,
      writeConfigFile: async next => { file = next; },
      readOwnDeviceAdmission: async () => false,
      probeEnvironment: async () => tailscaleEnvironment(null),
    });
    f.startServer.mockRejectedValueOnce(Object.assign(new Error("listen failed"), { code }));
    f.input.dependencies.readConfigFile = async () => file;

    try {
      await expect(maybeStartTailnetObserverServer(f.input)).rejects.toThrow(TAILNET_OBSERVER_PORT_BLOCKED);
      expect(f.startServer.mock.calls.map(([input]) => input.port)).toEqual([port]);
      await expect(settings.snapshot()).resolves.toMatchObject({
        listeningPort: null,
        lastStartError: TAILNET_OBSERVER_PORT_BLOCKED,
        portBlock: { port, code, hint },
        saved: { port },
      });
      expect(getHint).toHaveBeenCalledWith(port);

      const { saved } = await settings.snapshot();
      await settings.apply({ ...saved, port: replacementPort });
      expect(f.startServer.mock.calls.map(([input]) => input.port)).toEqual([port, replacementPort]);
      await expect(settings.snapshot()).resolves.toMatchObject({
        listeningPort: replacementPort,
        lastStartError: null,
        portBlock: null,
        saved: { port: replacementPort },
      });
    } finally {
      getHint.mockRestore();
    }
  });
});

// A namespace that lives only in this test, so nothing here reads — or writes — the admission record of whoever is running the suite.
function memoryNamespace(seed: Record<string, unknown> = {}): FeatureNamespaceHandle {
  const files = new Map<string, unknown>(Object.entries(seed));
  return {
    dir: "/nonexistent",
    readJson: async <T>(name: string, fallback: T) => (
      files.has(name) ? files.get(name) as T : fallback
    ),
    writeJson: async (name: string, value: unknown) => {
      files.set(name, value);
    },
    childDir: async () => "/nonexistent",
    createFile: refuseNamespaceFileCreation,
  };
}

const ADMISSION_FILE = "own-device-admission.json";
const OWNER_LOGIN = "owner@example.test";
const PENDING_ID = "55555555-5555-4555-8555-555555555555";
const OWN_ACTOR = ("tailnet:" + "a".repeat(64)) as TailnetShareActorId;
const OTHER_ACTOR = ("tailnet:" + "b".repeat(64)) as TailnetShareActorId;

interface FakePairing {
  id: string;
  actorId: TailnetShareActorId;
  state: "pending" | "active" | "revoked";
}

// The pairing store reduced to what admission touches. `activatePairing` and `revokePairing` behave exactly as the durable store does — including
// answering false for a pairing that is already in the target state, which is what keeps a re-entry from being audited as a second grant.
function fakeStore(initial: readonly FakePairing[] = []) {
  const pairings = initial.map((entry) => ({ ...entry }));
  const store = {
    pairings,
    withOwnerIdentityGuard: async <T>(guard: () => void, operation: () => Promise<T>): Promise<T> => { guard(); const result = await operation(); guard(); return result; },
    createInvitation: vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      code: "ave-pair-v1." + "c".repeat(43),
      expiresAt: 4_102_444_800_000,
    })),
    claimInvitation: vi.fn(async (_code: string, actorId: TailnetShareActorId) => {
      const id = "5555555" + pairings.length + "-5555-4555-8555-555555555555";
      pairings.push({ id, actorId, state: "pending" });
      return { pairingId: id, expiresAt: 123_456 };
    }),
    currentPairing: vi.fn((actorId: TailnetShareActorId) => {
      const found = pairings.find((entry) => (
        entry.actorId === actorId && entry.state !== "revoked"
      ));
      return found === undefined ? null : {
        id: found.id,
        actorFingerprint: "fingerprint-" + found.actorId.slice(-4),
        state: found.state,
        expiresAt: found.state === "pending" ? 123_456 : null,
      };
    }),
    activatePairing: vi.fn(async (id: string) => {
      const found = pairings.find((entry) => entry.id === id);
      if (found === undefined || found.state !== "pending") return false;
      found.state = "active";
      return true;
    }),
    revokePairing: vi.fn(async (id: string) => {
      const found = pairings.find((entry) => entry.id === id);
      if (found === undefined || found.state === "revoked") return false;
      found.state = "revoked";
      return true;
    }),
  };
  return store;
}

function fakeRuntime(store: ReturnType<typeof fakeStore>, logins: Record<string, TailnetShareActorId> = {
  [OWNER_LOGIN]: OWN_ACTOR,
}): TailnetPairedSharingRuntime {
  return {
    store,
    authorizer: {
      probeOwnerIdentity: async () => ({ revision: 1, ownerLogin: Object.keys(logins)[0] ?? null }), currentOwnerLogin: () => Object.keys(logins)[0] ?? null, ownerIdentityError: (login: string) => Object.keys(logins)[0] === login ? null : "tailnet-owner-identity-unavailable", actorIdFor: (login: string) => logins[login] ?? null,
      authorize: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
  } as unknown as TailnetPairedSharingRuntime;
}

// Collects the audit entries the admission path writes.
function fakeAuditLogger() {
  const entries: { sessionId: string; type: string; input?: string }[] = [];
  return {
    logger: { log: (entry: { sessionId: string; type: string; input?: string }) => {
      entries.push(entry);
    } } as unknown as AuditLogger,
    entries,
  };
}

async function deviceStatusFor(input: {
  namespace: FeatureNamespaceHandle;
  runtime: TailnetPairedSharingRuntime;
  probeLogin: string | null;
  auditLogger?: AuditLogger;
}) {
  input.runtime = { ...input.runtime, authorizer: { ...input.runtime.authorizer, currentOwnerLogin: () => input.probeLogin } };
  const f = options({
    AVE_TAILNET_OBSERVER: "1",
    AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
    AVE_TAILNET_PAIRED_SHARING: "1",
  });
  await maybeStartTailnetObserverServer({
    ...f.input,
    ...(input.auditLogger === undefined ? {} : { auditLogger: input.auditLogger }),
    dependencies: {
      ...f.input.dependencies,
      probeEnvironment: async () => tailscaleEnvironment(input.probeLogin),
      openTailnetNamespace: () => input.namespace,
    },
    tailnetPairedSharingRuntime: input.runtime,
  });
  const deviceStatus = (f.startServer.mock.calls[0]?.[0] as {
    pairing?: {
      deviceStatus?: (login: string, actorId: TailnetShareActorId, assertIdentity: () => void) => Promise<TailnetPairingDeviceStatus>;
    };
  }).pairing?.deviceStatus;
  if (deviceStatus === undefined) throw new Error("device-status-missing");
  return (login: string, actorId: TailnetShareActorId) => deviceStatus(login, actorId, () => {});
}

describe("own-device admission", () => {
  it("admits a same-account device with no approval click while it is on", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OWN_ACTOR },
    });
    const store = fakeStore();
    const audit = fakeAuditLogger();
    const deviceStatus = await deviceStatusFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
      auditLogger: audit.logger,
    });

    // `active`, not just "paired": the page is what turns this into the sentence the device reads, and an admitted device is not waiting for an approval.
    await expect(deviceStatus(OWNER_LOGIN, OWN_ACTOR))
      .resolves.toEqual({ pairing: "active", ownDevice: true });
    expect(store.pairings).toEqual([
      expect.objectContaining({ actorId: OWN_ACTOR, state: "active" }),
    ]);
    expect(audit.entries).toEqual([
      expect.objectContaining({ sessionId: "tailnet-own-device-admission", type: "approval" }),
    ]);
    expect(JSON.parse(audit.entries[0]?.input ?? "{}")).toMatchObject({ action: "granted" });

    // The waiting page reloads on a timer. A pairing that is already active is not a second grant, so it is neither re-activated nor audited again.
    await expect(deviceStatus(OWNER_LOGIN, OWN_ACTOR))
      .resolves.toEqual({ pairing: "active", ownDevice: true });
    expect(audit.entries).toHaveLength(1);
  });

  it("leaves the same device waiting for approval while it is off", async () => {
    const namespace = memoryNamespace();
    const store = fakeStore();
    const audit = fakeAuditLogger();
    const deviceStatus = await deviceStatusFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
      auditLogger: audit.logger,
    });

    await expect(deviceStatus(OWNER_LOGIN, OWN_ACTOR))
      .resolves.toEqual({ pairing: "pending", ownDevice: true });
    expect(store.pairings).toEqual([
      expect.objectContaining({ actorId: OWN_ACTOR, state: "pending" }),
    ]);
    expect(store.activatePairing).not.toHaveBeenCalled();
    expect(audit.entries).toHaveLength(0);
  });

  it("admits nobody but this desktop's own login, on or off", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OWN_ACTOR },
    });
    const store = fakeStore();
    const deviceStatus = await deviceStatusFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
    });

    await expect(deviceStatus("guest@example.test", OTHER_ACTOR))
      .resolves.toEqual({ pairing: "none", ownDevice: false });
    expect(store.createInvitation).not.toHaveBeenCalled();
    expect(store.activatePairing).not.toHaveBeenCalled();
    expect(store.pairings).toEqual([]);
  });

  it("reports what a code-redeemed device already has instead of claiming nothing", async () => {
    // Not this desktop's own account, so nothing is claimed for it — but its pairing exists, and reporting it is what stops the page asking for a second
    // code five seconds after the first one was accepted.
    const namespace = memoryNamespace();
    const store = fakeStore([{ id: PENDING_ID, actorId: OTHER_ACTOR, state: "pending" }]);
    const deviceStatus = await deviceStatusFor({
      namespace,
      runtime: fakeRuntime(store, { [OWNER_LOGIN]: OWN_ACTOR, "guest@example.test": OTHER_ACTOR }),
      probeLogin: OWNER_LOGIN,
    });

    await expect(deviceStatus("guest@example.test", OTHER_ACTOR))
      .resolves.toEqual({ pairing: "pending", ownDevice: false });

    // And once the owner approves it by hand, the same read says the approval is done and a conversation share is what is missing.
    await store.activatePairing(PENDING_ID);
    await expect(deviceStatus("guest@example.test", OTHER_ACTOR))
      .resolves.toEqual({ pairing: "active", ownDevice: false });
    expect(store.createInvitation).not.toHaveBeenCalled();
  });

  it("approves a device already waiting when the owner turns it on", async () => {
    const namespace = memoryNamespace();
    const store = fakeStore([{ id: PENDING_ID, actorId: OWN_ACTOR, state: "pending" }]);
    const audit = fakeAuditLogger();

    await setTailnetOwnDeviceAdmission(true, {
      runtime: fakeRuntime(store),
      namespace,
      auditLogger: audit.logger,
    });

    expect(store.pairings[0]).toMatchObject({ state: "active" });
    expect(await namespace.readJson(ADMISSION_FILE, null))
      .toEqual({ version: 1, admittedActorId: OWN_ACTOR });
    expect(JSON.parse(audit.entries[0]?.input ?? "{}"))
      .toMatchObject({ action: "granted", pairingId: PENDING_ID });
  });

  it("refuses to record an admission it could not identify an account for", async () => {
    const namespace = memoryNamespace();
    const store = fakeStore();

    await expect(setTailnetOwnDeviceAdmission(true, {
      runtime: fakeRuntime(store, {}),
      namespace,
    })).rejects.toThrow("tailnet-owner-identity-unavailable");
    expect(await namespace.readJson(ADMISSION_FILE, null)).toBeNull();
  });

  it("takes the granted access back when the owner turns it off", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OWN_ACTOR },
    });
    const store = fakeStore([{ id: PENDING_ID, actorId: OWN_ACTOR, state: "active" }]);
    const audit = fakeAuditLogger();

    await setTailnetOwnDeviceAdmission(false, {
      runtime: fakeRuntime(store),
      namespace,
      auditLogger: audit.logger,
    });

    expect(store.revokePairing).toHaveBeenCalledWith(PENDING_ID);
    expect(store.pairings[0]).toMatchObject({ state: "revoked" });
    expect(await namespace.readJson(ADMISSION_FILE, null))
      .toEqual({ version: 1, admittedActorId: null });
    expect(JSON.parse(audit.entries[0]?.input ?? "{}"))
      .toMatchObject({ action: "revoked", pairingId: PENDING_ID });

    // Off means off: the next request from that same device waits for approval.
    const deviceStatus = await deviceStatusFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
    });
    await expect(deviceStatus(OWNER_LOGIN, OWN_ACTOR))
      .resolves.toEqual({ pairing: "pending", ownDevice: true });
    expect(store.pairings.at(-1)).toMatchObject({ state: "pending" });
  });

  it("moves the admission with the desktop's account and revokes the old one", async () => {
    const namespace = memoryNamespace({
      [ADMISSION_FILE]: { version: 1, admittedActorId: OTHER_ACTOR },
    });
    const store = fakeStore([{ id: PENDING_ID, actorId: OTHER_ACTOR, state: "active" }]);
    const audit = fakeAuditLogger();
    const deviceStatus = await deviceStatusFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
      auditLogger: audit.logger,
    });

    await expect(deviceStatus(OWNER_LOGIN, OWN_ACTOR))
      .resolves.toEqual({ pairing: "active", ownDevice: true });
    expect(store.pairings[0]).toMatchObject({ actorId: OTHER_ACTOR, state: "revoked" });
    expect(store.pairings[1]).toMatchObject({ actorId: OWN_ACTOR, state: "active" });
    expect(await namespace.readJson(ADMISSION_FILE, null))
      .toEqual({ version: 1, admittedActorId: OWN_ACTOR });
    expect(audit.entries.map((entry) => JSON.parse(entry.input ?? "{}").action))
      .toEqual(["revoked", "granted"]);
  });

  it("reads a damaged admission record as off rather than as a grant", async () => {
    const namespace = memoryNamespace({ [ADMISSION_FILE]: { version: 9, admittedActorId: OWN_ACTOR } });
    expect(await isTailnetOwnDeviceAdmissionEnabled(namespace)).toBe(false);

    const store = fakeStore();
    const deviceStatus = await deviceStatusFor({
      namespace,
      runtime: fakeRuntime(store),
      probeLogin: OWNER_LOGIN,
    });
    await expect(deviceStatus(OWNER_LOGIN, OWN_ACTOR))
      .resolves.toEqual({ pairing: "pending", ownDevice: true });
    expect(store.activatePairing).not.toHaveBeenCalled();
  });

  it("has no admission to change without a pairing runtime", async () => {
    await expect(setTailnetOwnDeviceAdmission(true, {
      runtime: null,
      namespace: memoryNamespace(),
    })).rejects.toThrow("tailnet-own-device-admission-unavailable");
  });
});

describe("private work decision ingress", () => {
  const origin = "https://desk.example-tailnet.ts.net";
  const key = "desk.example-tailnet.ts.net:443";
  const port = DEFAULT_TAILNET_OBSERVER_PORT;
  const web = { [key]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } };
  const config = { TCP: { "443": { HTTPS: true } }, Web: web };

  it("requires the configured HTTPS host to proxy the exact listener", () => {
    expect(isPrivateServeTarget(config, origin, port)).toBe(true);
    expect(isPrivateServeTarget(config, origin, port + 1)).toBe(false);
    expect(isPrivateServeTarget(config, "https://other.example-tailnet.ts.net", port)).toBe(false);
    expect(isPrivateServeTarget({ Web: web }, origin, port)).toBe(false);
    const override = { ...web[key].Handlers, "/tailnet/v2/web": { Proxy: "http://127.0.0.1:9999" } };
    expect(isPrivateServeTarget({ ...config, Web: { [key]: { Handlers: override } } }, origin, port)).toBe(false);
    expect(isPrivateServeTarget({ ...config, Web: { [key]: { Handlers: { "/other": web[key].Handlers["/"] } } } }, origin, port)).toBe(false);
  });

  it("refuses public ingress, raw forwarding, or an additional service configuration", () => {
    expect(isPrivateServeTarget({ ...config, AllowFunnel: { [key]: true } }, origin, port)).toBe(false);
    expect(isPrivateServeTarget({ ...config, TCP: { ...config.TCP, "444": { TCPForward: `127.0.0.1:${port}` } } }, origin, port)).toBe(false);
    expect(isPrivateServeTarget({ ...config, Foreground: { other: config } }, origin, port)).toBe(false);
    expect(isPrivateServeTarget(null, origin, port)).toBe(false);
  });
});
