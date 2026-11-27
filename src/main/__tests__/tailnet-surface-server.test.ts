async function runGuardedOwnerOperation<T>(guard: () => void, operation: () => Promise<T>): Promise<T> { guard(); const result = await operation(); guard(); return result; }
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import * as listenerPortPolicy from "../../permissions/tailnet-listener-policy.js";
import * as portHints from "../tailnet-port-hint.js";
import type { ConversationSurfaceRuntime } from "../../engine/conversation-surface-runtime.js";
import type { TailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import { writeJsonAtomic, type FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { resolveTailnetObserverApply } from "../tailnet-observer-apply.js";
import { createTailnetObserverConfigService } from "../tailnet-observer-config-service.js";
import type { TailnetShareActorId } from "../tailnet-pairing-share-store.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { TailnetPairingDeviceStatus } from "../../api/tailnet-surface-server.js";
import {
  IMPLICIT_TAILNET_OBSERVER_PORT,
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

vi.mock(import("node:net"), async importOriginal => {
  const net = await importOriginal();
  return { ...net, createServer: vi.fn(net.createServer) as typeof net.createServer };
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
  const namespace = memoryNamespace();
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
        openTailnetNamespace: () => namespace,
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
      const accepted = options({
        AVE_TAILNET_OBSERVER: "1",
        AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV,
        AVE_TAILNET_OBSERVER_PORT: String(port),
      });
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
        await expect.soft(service.apply({ ...saved, enabled })).resolves.toMatchObject({ restartNeeded: enabled });
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
      port: IMPLICIT_TAILNET_OBSERVER_PORT,
      authorization: APP_CAPABILITY,
      controllerEnabled: false,
      pairedSharingEnabled: false,
    });

    // Identity mode is a first-class choice, not the absence of one: it has to be named as explicitly as the capability it replaces.
    expect(resolveTailnetObserverConfig({
      AVE_TAILNET_OBSERVER: "1",
      AVE_TAILNET_OBSERVER_AUTHORIZATION: "tailnet-identity",
    })).toEqual({
      port: IMPLICIT_TAILNET_OBSERVER_PORT,
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
    })).resolves.toEqual({ port: IMPLICIT_TAILNET_OBSERVER_PORT });

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
    })).resolves.toEqual({ port: IMPLICIT_TAILNET_OBSERVER_PORT });

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

const PORT_INPUTS = [
  { name: "I1 fileless and off", file: null, env: {}, boot: null, draft: 28_173, probes: [28_173] },
  { name: "I2 fileless and env enabled", file: null, env: { AVE_TAILNET_OBSERVER: "1" }, boot: 46_173, draft: 46_173, probes: [] },
  { name: "I3 portless and saved on", file: { enabled: true }, env: {}, boot: 46_173, draft: 46_173, probes: [] },
  { name: "I4 portless and saved off", file: {}, env: {}, boot: null, draft: 28_173, probes: [28_173] },
  { name: "I5 portless and env enabled", file: {}, env: { AVE_TAILNET_OBSERVER: "1" }, boot: 46_173, draft: 46_173, probes: [] },
  { name: "I6 explicit port", file: { enabled: true, port: 29_123 }, env: {}, boot: 29_123, draft: 29_123, probes: [] },
  { name: "environment disabled", file: { enabled: true }, env: { AVE_TAILNET_OBSERVER: "0" }, boot: null, draft: 46_173, probes: [] },
  {
    name: "environment port override",
    file: { enabled: true, port: 29_123 },
    env: { AVE_TAILNET_OBSERVER_PORT: "29999" },
    boot: 29_999,
    draft: 29_123,
    probes: [29_123],
  },
  {
    name: "fileless with environment port override",
    file: null,
    env: { AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_PORT: "29999" },
    boot: 29_999,
    draft: 46_173,
    probes: [46_173],
  },
] satisfies {
  name: string;
  file: TailnetObserverConfigFile | null;
  env: NodeJS.ProcessEnv;
  boot: number | null;
  draft: number;
  probes: number[];
}[];

function settingsForPortTest(
  initialFile: TailnetObserverConfigFile | null,
  env: NodeJS.ProcessEnv,
  initialListener: number | null,
  steps: (number | string)[],
  initialServePort = initialListener,
) {
  let file = initialFile;
  let listeningPort = initialListener;
  let servePort = initialServePort;
  const bootEnv = { AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV, ...env };
  const readConfigFile = async () => file;
  const writeConfigFile = vi.fn(async (next: TailnetObserverConfigFile) => {
    steps.push("write");
    file = next;
  });
  const runServe = vi.fn(async ({ port }: { port: number }) => {
    steps.push("serve");
    servePort = port;
    return { ok: true as const };
  });
  const settings = createTailnetObserverConfigService({
    pairedSharingBootstrapFailed: () => false,
    env: bootEnv,
    readConfigFile,
    writeConfigFile,
    restartListener: async () => {
      steps.push("restart");
      const { config } = await loadTailnetObserverConfig({ env: bootEnv, readConfigFile });
      listeningPort = config?.port ?? null;
    },
    runtimeState: () => ({ listeningPort, activeConfig: null, lastStartError: null, portBlock: null }),
    probeEnvironment: async () => ({
      ...tailscaleEnvironment(null),
      dnsName: "desk.example-tailnet.ts.net",
      serveConfigured: servePort !== null,
      serveTargetPort: servePort,
    }),
    readOwnDeviceAdmission: async () => false,
    runServe,
  });
  return { settings, writeConfigFile, runServe, readConfigFile };
}

function recordPortProbes(steps: (number | string)[], answers: ReadonlyMap<number, number | null>) {
  vi.mocked(createServer).mockImplementation(() => {
    const probe = new EventEmitter();
    let boundPort = 0;
    return Object.assign(probe, {
      listen: ({ port }: { port: number }, onListening: () => void) => {
        steps.push(port);
        const answer = answers.has(port) ? answers.get(port) : port;
        if (answer == null) queueMicrotask(() => probe.emit("error", new Error("Port in use")));
        else {
          boundPort = answer;
          queueMicrotask(onListening);
        }
      },
      address: () => ({ port: boundPort }),
      close: (done: () => void) => done(),
    }) as unknown as Server;
  });
}

describe.each(["win32", "darwin", "linux"] as const)("Tailnet observer port state table on %s", platform => {
  it.each(PORT_INPUTS)("boots without writing or probing Serve for $name", async ({ file, env, boot }) => {
    const dir = await makeTempDir();
    const path = join(dir, "observer.json");
    const original = file === null ? null : `${JSON.stringify({ ...file, authorization: APP_CAPABILITY }, null, 2)}\n`;
    if (original !== null) await writeFile(path, original);

    const namespace = {
      ...memoryNamespace(),
      dir,
      writeJson: vi.fn((name: string, value: unknown) => writeJsonAtomic(dir, name, value)),
    };
    const openTailnetNamespace = vi.fn(() => namespace);
    const probeEnvironment = vi.fn(async () => tailscaleEnvironment(null));
    const { input, startServer } = options({ AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV, ...env });
    const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const policy = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
    try {
      const result = await maybeStartTailnetObserverServer({
        ...input,
        dependencies: {
          ...input.dependencies,
          readConfigFile: () => readTailnetObserverConfigFile(namespace),
          openTailnetNamespace,
          probeEnvironment,
        },
      });

      expect.soft(result).toEqual(boot === null ? null : { port: boot });
      expect.soft(startServer.mock.calls.map(([request]) => request.port)).toEqual(boot === null ? [] : [boot]);
      expect.soft(openTailnetNamespace).not.toHaveBeenCalled();
      expect.soft(namespace.writeJson).not.toHaveBeenCalled();
      expect.soft(probeEnvironment).not.toHaveBeenCalled();
      if (original === null) await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      policy.mockRestore();
      host.mockRestore();
    }
  });

  it.each(PORT_INPUTS)("uses the Settings draft and persists its port for $name", async ({ file, env, draft }) => {
    const steps: (number | string)[] = [];
    const initial = file === null ? null : { ...file, authorization: APP_CAPABILITY };
    const policy = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
    const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    try {
      const { settings, writeConfigFile } = settingsForPortTest(initial, env, null, steps);
      const { saved } = await settings.snapshot();
      expect(saved.port).toBe(draft);
      expect(writeConfigFile).not.toHaveBeenCalled();
      await settings.apply({ ...saved, pairedSharingEnabled: true });
      expect(writeConfigFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: draft, pairedSharingEnabled: true }));
      await expect(settings.snapshot()).resolves.toMatchObject({ saved: { port: draft }, provenance: { port: env.AVE_TAILNET_OBSERVER_PORT ? "env-override" : "file" } });
    } finally {
      host.mockRestore();
      policy.mockRestore();
    }
  });

  it.each(PORT_INPUTS)("uses the guided choice for $name", async ({ file, env, boot, draft, probes }) => {
    const steps: (number | string)[] = [];
    const initial = file === null ? null : { ...file, authorization: APP_CAPABILITY };
    const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const assertAllowed = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
    const policy = vi.spyOn(listenerPortPolicy, "readTailnetListenerPortPolicy").mockResolvedValue(() => true);
    recordPortProbes(steps, new Map());
    try {
      const initialServe = env.AVE_TAILNET_OBSERVER_PORT ? draft : boot;
      const { settings, writeConfigFile, runServe } = settingsForPortTest(initial, env, boot, steps, initialServe);
      const result = await settings.guidedSetup();
      if (env.AVE_TAILNET_OBSERVER === "0") {
        expect(result).toMatchObject({ ok: false, error: "tailnet-serve-not-listening" });
        expect(steps).toEqual([]);
        return;
      }

      const active = env.AVE_TAILNET_OBSERVER_PORT ? boot : draft;
      expect(result).toMatchObject({ ok: true, port: active });
      expect(writeConfigFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: draft }));
      if (active === initialServe) {
        expect(runServe).not.toHaveBeenCalled();
        expect(steps).toEqual([...probes, "write", "restart"]);
      } else {
        expect(runServe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: active }));
        expect(steps).toEqual([...probes, "write", "restart", "serve"]);
      }
    } finally {
      vi.mocked(createServer).mockReset();
      assertAllowed.mockRestore();
      policy.mockRestore();
      host.mockRestore();
    }
  });

  it.each([
    { name: "I1 new default blocked", file: null, env: {}, blocked: [28_173], probes: [28_173, 0], port: 30_001 },
    { name: "I4 new default blocked", file: {}, env: {}, blocked: [28_173], probes: [28_173, 0], port: 30_001 },
    { name: "I2 implicit port blocked", file: null, env: { AVE_TAILNET_OBSERVER: "1" }, blocked: [46_173], probes: [46_173, 28_173], port: 28_173 },
    { name: "I5 implicit port blocked", file: {}, env: { AVE_TAILNET_OBSERVER: "1" }, blocked: [46_173], probes: [46_173, 28_173], port: 28_173 },
    { name: "I6 saved port blocked", file: { port: 29_123 }, env: {}, blocked: [29_123], probes: [29_123, 28_173], port: 28_173 },
    { name: "implicit port disallowed", file: null, env: { AVE_TAILNET_OBSERVER: "1" }, blocked: [], probes: [28_173], port: 28_173 },
    { name: "ephemeral port disallowed", file: null, env: {}, blocked: [28_173], probes: [28_173, 0, 1024], port: 1024 },
    { name: "ephemeral bind refused", file: null, env: {}, blocked: [28_173, 0], probes: [28_173, 0], port: null },
  ] satisfies {
    name: string;
    file: TailnetObserverConfigFile | null;
    env: NodeJS.ProcessEnv;
    blocked: number[];
    probes: number[];
    port: number | null;
  }[])("chooses before writing when $name", async ({ name, file, env, blocked, probes, port }) => {
    const steps: (number | string)[] = [];
    const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const assertAllowed = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
    const policy = vi.spyOn(listenerPortPolicy, "readTailnetListenerPortPolicy").mockResolvedValue(
      candidate => candidate !== (name === "ephemeral port disallowed" ? 30_001 : name === "implicit port disallowed" ? 46_173 : null),
    );
    const answers = new Map<number, number | null>([[0, 30_001]]);
    for (const held of blocked) answers.set(held, null);
    recordPortProbes(steps, answers);
    try {
      const { settings, writeConfigFile, runServe } = settingsForPortTest(file, env, null, steps, blocked[0]);
      const result = await settings.guidedSetup();
      if (port === null) {
        expect(result).toMatchObject({ ok: false, error: "tailnet-guided-setup-port-unavailable" });
        expect(steps).toEqual(probes);
        return;
      }

      expect(result).toMatchObject({ ok: true, port });
      expect(writeConfigFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port }));
      expect(runServe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port }));
      expect(steps).toEqual([...probes, "write", "restart", "serve"]);
    } finally {
      vi.mocked(createServer).mockReset();
      assertAllowed.mockRestore();
      policy.mockRestore();
      host.mockRestore();
    }
  });

  it.each([
    { name: "I2 fileless", file: null },
    { name: "I5 portless and saved off", file: { enabled: false } },
  ])("saves a replacement for the next launch after a blocked $name bind", async ({ file }) => {
    const env = { AVE_TAILNET_OBSERVER: "1", AVE_TAILNET_OBSERVER_AUTHORIZATION: CAPABILITY_ENV };
    const steps: (number | string)[] = [];
    const { readConfigFile, writeConfigFile } = settingsForPortTest(file, env, null, steps);
    const { input, startServer } = options(env);
    input.dependencies.readConfigFile = readConfigFile;
    startServer.mockRejectedValueOnce(Object.assign(new Error("Port in use"), { code: "EADDRINUSE" }));
    const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const policy = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
    const hint = vi.spyOn(portHints, "getWindowsTailnetPortHint").mockResolvedValue(null);
    const settings = createTailnetObserverConfigService({
      env, readConfigFile, writeConfigFile,
      pairedSharingBootstrapFailed: () => false,
      readOwnDeviceAdmission: async () => false,
      probeEnvironment: async () => tailscaleEnvironment(null),
    });
    try {
      await expect(maybeStartTailnetObserverServer(input)).rejects.toThrow(TAILNET_OBSERVER_PORT_BLOCKED);
      const { saved } = await settings.snapshot();

      await expect.soft(settings.apply({ ...saved, port: 28_173 })).resolves.toEqual({ outcome: "restart-needed", restartNeeded: true });
      expect.soft(steps).toEqual(["write"]);
      expect.soft(startServer.mock.calls.map(([request]) => request.port)).toEqual([46_173]);
      await expect.soft(settings.snapshot()).resolves.toMatchObject({
        saved: { enabled: false, port: 28_173 },
        listeningPort: null,
        lastStartError: TAILNET_OBSERVER_PORT_BLOCKED,
        portBlock: { port: 46_173, code: "EADDRINUSE" },
      });

      await stopTailnetObserverServer();
      resetTailnetObserverServerForTests();
      await expect(maybeStartTailnetObserverServer(input)).resolves.toEqual({ port: 28_173 });
      await expect(settings.snapshot()).resolves.toMatchObject({
        listeningPort: 28_173,
        lastStartError: null,
        portBlock: null,
      });
    } finally {
      hint.mockRestore();
      policy.mockRestore();
      host.mockRestore();
    }
  });

  it("manually enables I4 on 28173 while 46173 is blocked", async () => {
    const steps: (number | string)[] = [];
    const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const policy = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
    const { input, startServer } = options({});
    startServer.mockImplementation(async ({ port }) => {
      if (port === 46_173) throw Object.assign(new Error("Port in use"), { code: "EADDRINUSE" });
      return { host: "127.0.0.1", port, close: vi.fn(async () => undefined) };
    });
    try {
      const { readConfigFile, writeConfigFile } = settingsForPortTest({ authorization: APP_CAPABILITY }, {}, null, steps);
      await maybeStartTailnetObserverServer({ ...input, dependencies: { ...input.dependencies, readConfigFile } });
      const settings = createTailnetObserverConfigService({
        pairedSharingBootstrapFailed: () => false,
        env: {},
        readConfigFile,
        writeConfigFile,
        readOwnDeviceAdmission: async () => false,
        probeEnvironment: async () => tailscaleEnvironment(null),
      });
      const { saved } = await settings.snapshot();
      await settings.apply({ ...saved, enabled: true });
      expect(writeConfigFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: 28_173 }));
      expect(startServer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: 28_173 }));
    } finally {
      policy.mockRestore();
      host.mockRestore();
    }
  });
});

// A `tailscale status --json` payload for a node that is up and signed in.
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

const APPLY_PORT = DEFAULT_TAILNET_OBSERVER_PORT;
const OTHER_PORT = APPLY_PORT + 1;

const applyRows = [
  { row: "A01", savedEnabled: false, enableOverride: undefined, effectivePort: null, boundPort: null, outcome: "observer-off", restartNeeded: false, clearsBlock: true },
  { row: "A02", savedEnabled: false, enableOverride: undefined, effectivePort: null, boundPort: OTHER_PORT, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A03", savedEnabled: false, enableOverride: false, effectivePort: null, boundPort: null, outcome: "observer-off", restartNeeded: false, clearsBlock: true },
  { row: "A04", savedEnabled: false, enableOverride: false, effectivePort: null, boundPort: OTHER_PORT, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A05", savedEnabled: false, enableOverride: true, effectivePort: APPLY_PORT, boundPort: null, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A06", savedEnabled: false, enableOverride: true, effectivePort: APPLY_PORT, boundPort: APPLY_PORT, outcome: "saved", restartNeeded: false, clearsBlock: false },
  { row: "A07", savedEnabled: false, enableOverride: true, effectivePort: APPLY_PORT, boundPort: OTHER_PORT, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A08", savedEnabled: true, enableOverride: undefined, effectivePort: APPLY_PORT, boundPort: null, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A09", savedEnabled: true, enableOverride: undefined, effectivePort: APPLY_PORT, boundPort: APPLY_PORT, outcome: "applied", restartNeeded: false, clearsBlock: false },
  { row: "A10", savedEnabled: true, enableOverride: undefined, effectivePort: APPLY_PORT, boundPort: OTHER_PORT, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A11", savedEnabled: true, enableOverride: false, effectivePort: null, boundPort: null, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A12", savedEnabled: true, enableOverride: false, effectivePort: null, boundPort: OTHER_PORT, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A13", savedEnabled: true, enableOverride: true, effectivePort: APPLY_PORT, boundPort: null, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
  { row: "A14", savedEnabled: true, enableOverride: true, effectivePort: APPLY_PORT, boundPort: APPLY_PORT, outcome: "applied", restartNeeded: false, clearsBlock: false },
  { row: "A15", savedEnabled: true, enableOverride: true, effectivePort: APPLY_PORT, boundPort: OTHER_PORT, outcome: "restart-needed", restartNeeded: true, clearsBlock: false },
] as const;

describe.each(["win32", "darwin", "linux"] as const)("Tailnet observer Apply on %s", platform => {
  it.each(applyRows.flatMap(row => [false, true].map(hasPriorBlock => ({ ...row, hasPriorBlock }))))(
    "resolves $row (prior block: $hasPriorBlock)",
    async ({ savedEnabled, enableOverride, effectivePort, boundPort, outcome, restartNeeded, clearsBlock, hasPriorBlock }) => {
      const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const policy = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
      const env = enableOverride === undefined ? {} : { AVE_TAILNET_OBSERVER: enableOverride ? "1" : "0" };
      const priorBlock = hasPriorBlock ? { port: OTHER_PORT, code: "EADDRINUSE" as const, hint: null } : null;
      const restartListener = vi.fn(async () => undefined);
      const settings = createTailnetObserverConfigService({
        env,
        pairedSharingBootstrapFailed: () => false,
        writeConfigFile: async () => undefined,
        readOwnDeviceAdmission: async () => false,
        probeEnvironment: async () => tailscaleEnvironment(null),
        runtimeState: () => ({ listeningPort: boundPort, activeConfig: null, lastStartError: null, portBlock: priorBlock }),
        restartListener,
      });

      try {
        const proposal = {
          enabled: savedEnabled, authorization: TAILNET_IDENTITY, port: APPLY_PORT,
          controllerEnabled: false, pairedSharingEnabled: false, webEnabled: false, webOrigin: "",
        };
        const result = await settings.apply(proposal);
        expect.soft(result.restartNeeded).toBe(restartNeeded);
        expect.soft(result).toMatchObject({ outcome });
        if (enableOverride === true && !savedEnabled) expect.soft(restartListener).not.toHaveBeenCalled();

        expect(resolveTailnetObserverApply(savedEnabled, enableOverride, effectivePort, boundPort, priorBlock))
          .toEqual({ status: { outcome, restartNeeded }, portBlock: clearsBlock ? null : priorBlock });
      } finally {
        policy.mockRestore();
        host.mockRestore();
      }
    },
  );

  it("preserves a failed bind through save-only overrides and clears it when the observer is saved off", async () => {
    const env: NodeJS.ProcessEnv = {};
    let file: TailnetObserverConfigFile | null = null;
    const readConfigFile = async () => file;
    const { input, startServer } = options(env);
    input.dependencies.readConfigFile = readConfigFile;
    const host = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const policy = vi.spyOn(listenerPortPolicy, "assertTailnetListenerPortAllowed").mockResolvedValue(undefined);
    const hint = vi.spyOn(portHints, "getWindowsTailnetPortHint").mockResolvedValue(null);
    const settings = createTailnetObserverConfigService({
      env,
      pairedSharingBootstrapFailed: () => false,
      readConfigFile,
      writeConfigFile: async next => { file = next; },
      readOwnDeviceAdmission: async () => false,
      probeEnvironment: async () => tailscaleEnvironment(null),
    });
    startServer.mockRejectedValueOnce(Object.assign(new Error("Port in use"), { code: "EADDRINUSE" }));
    const blocked = {
      listeningPort: null,
      portBlock: { port: OTHER_PORT, code: "EADDRINUSE", hint: null },
      lastStartError: TAILNET_OBSERVER_PORT_BLOCKED,
    };

    try {
      await expect(maybeStartTailnetObserverServer(input)).resolves.toBeNull();
      const { saved } = await settings.snapshot();
      const enabled = { ...saved, enabled: true, port: OTHER_PORT };
      await expect.soft(settings.apply(enabled)).resolves.toMatchObject({ restartNeeded: true });
      await expect.soft(settings.snapshot()).resolves.toMatchObject(blocked);

      env.AVE_TAILNET_OBSERVER = "0";
      await expect.soft(settings.apply({ ...enabled, port: APPLY_PORT })).resolves.toMatchObject({ restartNeeded: true });
      await expect.soft(settings.snapshot()).resolves.toMatchObject(blocked);

      env.AVE_TAILNET_OBSERVER = "1";
      await expect.soft(settings.apply({ ...enabled, enabled: false, port: APPLY_PORT })).resolves.toMatchObject({ restartNeeded: true });
      await expect.soft(settings.snapshot()).resolves.toMatchObject(blocked);
      expect.soft(startServer.mock.calls.map(([request]) => request.port)).toEqual([OTHER_PORT]);

      delete env.AVE_TAILNET_OBSERVER;
      startServer.mockRejectedValueOnce(Object.assign(new Error("Listen failed"), { syscall: "listen" }));
      await expect(settings.apply({ ...enabled, port: APPLY_PORT })).resolves.toMatchObject({ restartNeeded: true });
      await expect(settings.snapshot()).resolves.toMatchObject({
        listeningPort: null, portBlock: blocked.portBlock, lastStartError: "tailnet-observer-start-failed",
      });

      await expect.soft(settings.apply({ ...enabled, enabled: false })).resolves.toEqual({
        outcome: "observer-off", restartNeeded: false,
      });
      await expect(settings.snapshot()).resolves.toMatchObject({ listeningPort: null, portBlock: null, lastStartError: null });
    } finally {
      hint.mockRestore();
      policy.mockRestore();
      host.mockRestore();
    }
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
