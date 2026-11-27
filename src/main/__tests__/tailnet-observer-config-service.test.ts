import { DEFAULT_TAILNET_OBSERVER_PORT, TAILNET_OBSERVER_PORT_BLOCKED } from "../../shared/tailnet-observer-config.js";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import * as sandbox from "../../permissions/asrt-sandbox.js";
import { createTailnetObserverConfigService } from "../tailnet-observer-config-service.js";
import type {
  TailnetObserverConfigFile,
  TailscaleEnvironment,
  TailscaleServeOutcome,
} from "../tailnet-surface-server.js";
import type {
  TailnetAuthorization,
  TailnetObserverConfigView,
} from "../../shared/tailnet-observer-config.js";

const CAPABILITY = "ave.example.com/cap/conversation-observer";
const DNS_NAME = "desk.example-tailnet.ts.net";
const WEB_ORIGIN = "https://" + DNS_NAME;

// A signed-in node with a MagicDNS name — the case everything else varies from.
function readyEnvironment(overrides: Partial<TailscaleEnvironment> = {}): TailscaleEnvironment {
  return {
    state: "ready",
    cliPath: "tailscale",
    login: "owner@example.com",
    dnsName: DNS_NAME,
    tailnetName: "example-tailnet.ts.net",
    serveConfigured: false,
    serveTargetPort: null,
    detail: null,
    ...overrides,
  };
}
const APP_CAPABILITY = Object.freeze({ kind: "app-capability" as const, capability: CAPABILITY });
const TAILNET_IDENTITY = Object.freeze({ kind: "tailnet-identity" as const });

function service(options: {
  file?: TailnetObserverConfigFile | null;
  readConfigFile?: () => Promise<TailnetObserverConfigFile | null>;
  env?: NodeJS.ProcessEnv;
  listeningPort?: number | null;
  activeConfig?: {
    port: number;
    authorization: TailnetAuthorization;
    controllerEnabled: boolean;
    pairedSharingEnabled: boolean;
    webOrigin?: string;
  } | null;
  lastStartError?: string | null;
  pairedSharingBootstrapFailed?: boolean;
  writeConfigFile?: (file: TailnetObserverConfigFile) => Promise<void>;
  environment?: TailscaleEnvironment;
  restartListener?: () => Promise<unknown>;
  runServe?: (input: { cliPath: string; port: number }) => Promise<TailscaleServeOutcome>;
  ownDeviceAdmission?: boolean;
  writeOwnDeviceAdmission?: (enabled: boolean) => Promise<void>;
} = {}) {
  return createTailnetObserverConfigService({
    pairedSharingBootstrapFailed: () => options.pairedSharingBootstrapFailed === true,
    readConfigFile: options.readConfigFile ?? (async () => options.file ?? null),
    writeConfigFile: options.writeConfigFile ?? (async () => undefined),
    env: options.env ?? {},
    runtimeState: () => ({
      listeningPort: options.listeningPort ?? null,
      activeConfig: options.activeConfig ?? null,
      lastStartError: options.lastStartError ?? null,
      portBlock: null,
    }),
    // The probe and the listener lifecycle are injected so this matrix stays a question about the configuration surface, not about whether the machine
    // running it happens to have Tailscale installed and a listener bound.
    probeEnvironment: async () => options.environment ?? readyEnvironment(),
    restartListener: options.restartListener ?? (async () => undefined),
    // Injected for the same reason: the admission record is real host state, and reading it would make this matrix depend on the developer's own.
    readOwnDeviceAdmission: async () => options.ownDeviceAdmission === true,
    writeOwnDeviceAdmission: options.writeOwnDeviceAdmission ?? (async () => undefined),
    ...(options.runServe === undefined ? {} : { runServe: options.runServe as never }),
  });
}

const OFF_VIEW: TailnetObserverConfigView = Object.freeze({
  enabled: false,
  authorization: TAILNET_IDENTITY,
  port: DEFAULT_TAILNET_OBSERVER_PORT,
  controllerEnabled: false,
  pairedSharingEnabled: false,
  webEnabled: false,
  webOrigin: "",
});

function enabledView(overrides: Partial<TailnetObserverConfigView> = {}): TailnetObserverConfigView {
  return { ...OFF_VIEW, enabled: true, authorization: APP_CAPABILITY, pairedSharingEnabled: true, ...overrides };
}

describe("Tailnet observer configuration service", () => {
  it.each(["apply", "guidedSetup"] as const)("round-trips the explicit default port through %s", async action => {
    const port = DEFAULT_TAILNET_OBSERVER_PORT;
    let file: TailnetObserverConfigFile = { enabled: true, authorization: TAILNET_IDENTITY, port };
    const settings = service({
      readConfigFile: async () => file,
      writeConfigFile: async next => { file = next; },
      listeningPort: port,
      environment: readyEnvironment({ serveConfigured: true, serveTargetPort: port }),
    });

    if (action === "apply") await settings.apply((await settings.snapshot()).saved);
    else await expect(settings.guidedSetup()).resolves.toMatchObject({ ok: true, port });

    expect(file.port).toBe(port);
    await expect(settings.snapshot()).resolves.toMatchObject({ saved: { port }, provenance: { port: "file" } });
  });

  it("preserves the previously saved listener port", async () => {
    const savedPort = 46_173;
    const writeConfigFile = vi.fn();
    const settings = service({
      file: { enabled: true, authorization: TAILNET_IDENTITY, port: savedPort },
      writeConfigFile,
    });

    const snapshot = await settings.snapshot();
    expect(snapshot.saved.port).toBe(savedPort);
    expect(snapshot.effective.port).toBe(savedPort);
    await settings.apply(snapshot.saved);
    expect(writeConfigFile).toHaveBeenCalledWith(expect.objectContaining({ port: savedPort }));
  });

  it("exposes the named port refusal in guided setup and keeps the saved settings editable", async () => {
    const port = OFF_VIEW.port;
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const range = vi.spyOn(sandbox, "getWindowsProxyPortRange").mockReturnValue([port, port]);
    const error = "tailnet-observer-port-confined-worker-range";
    const writeConfigFile = vi.fn();
    try {
      const settings = service({ file: { enabled: true, authorization: TAILNET_IDENTITY, port }, lastStartError: error, writeConfigFile });
      await expect(settings.guidedSetup()).resolves.toEqual({ ok: false, error, output: null });
      await expect(settings.apply(enabledView({ port }))).rejects.toThrow(error);
      expect(writeConfigFile).not.toHaveBeenCalled();
      await expect(settings.snapshot()).resolves.toMatchObject({ saved: { port }, lastStartError: error });
    } finally {
      range.mockRestore();
      platform.mockRestore();
    }
  });

  it("reports a never-configured observer as off, not as missing", async () => {
    const snapshot = await service().snapshot();

    expect(snapshot.saved).toEqual(OFF_VIEW);
    expect(snapshot.effective.enabled).toBe(false);
    expect(snapshot.listeningPort).toBeNull();
    expect(snapshot.configFileError).toBeNull();
  });

  it("separates what is saved from what the environment makes effective", async () => {
    const snapshot = await service({
      file: { enabled: true, authorization: APP_CAPABILITY, port: 46_500 },
      env: { AVE_TAILNET_OBSERVER_PORT: "47000" },
    }).snapshot();

    expect(snapshot.saved.port).toBe(46_500);
    expect(snapshot.effective.port).toBe(47_000);
    expect(snapshot.provenance.port).toBe("env-override");
  });

  it("surfaces the boot failure a log line used to be the only record of", async () => {
    const snapshot = await service({
      lastStartError: "tailnet-web-origin-missing-or-invalid",
      pairedSharingBootstrapFailed: true,
    }).snapshot();

    expect(snapshot.lastStartError).toBe("tailnet-web-origin-missing-or-invalid");
    expect(snapshot.pairedSharingBootstrapFailed).toBe(true);
  });

  it("persists only what was chosen, not the negatives", async () => {
    const writeConfigFile = vi.fn(async () => undefined);
    await service({ writeConfigFile }).apply(enabledView());

    expect(writeConfigFile).toHaveBeenCalledWith({
      enabled: true,
      authorization: APP_CAPABILITY,
      port: DEFAULT_TAILNET_OBSERVER_PORT,
      pairedSharingEnabled: true,
    });
  });

  describe("web origin derivation", () => {
    it("puts the probed MagicDNS name in the snapshot instead of asking for it", async () => {
      const snapshot = await service().snapshot();

      expect(snapshot.environment.dnsName).toBe(DNS_NAME);
      expect(snapshot.derivedWebOrigin).toBe(WEB_ORIGIN);
    });

    it("persists the derived origin and ignores whatever the proposal carried", async () => {
      const writeConfigFile = vi.fn(async () => undefined);
      await service({ writeConfigFile }).apply(enabledView({ webEnabled: true, webOrigin: "https://someone-typed-this.ts.net" }));

      expect(writeConfigFile).toHaveBeenCalledWith(expect.objectContaining({
        webEnabled: true,
        webOrigin: WEB_ORIGIN,
      }));
    });

    it("refuses the web surface when there is no name to derive an origin from", async () => {
      const writeConfigFile = vi.fn(async () => undefined);
      const surface = service({
        writeConfigFile,
        environment: readyEnvironment({ dnsName: null }),
      });

      expect((await surface.snapshot()).derivedWebOrigin).toBeNull();
      await expect(surface.apply(enabledView({ webEnabled: true, webOrigin: "" }))).rejects.toThrow("tailnet-web-origin-underivable");
      expect(writeConfigFile).not.toHaveBeenCalled();
    });
  });

  describe("a damaged configuration file", () => {
    const damaged = async (): Promise<TailnetObserverConfigFile | null> => {
      throw new Error("tailnet-observer-config-file-invalid");
    };

    it("names the damage and still produces a saveable snapshot", async () => {
      const snapshot = await service({ readConfigFile: damaged }).snapshot();

      // The whole point: a draft exists, so Save is reachable. This used to throw, leaving the section with a Refresh button and no way forward.
      expect(snapshot.configFileError).toBe("tailnet-observer-config-file-invalid");
      expect(snapshot.saved).toEqual(OFF_VIEW);
      expect(snapshot.effective.enabled).toBe(false);
    });

    it("reports an unreadable file distinctly from an unparseable one", async () => {
      const snapshot = await service({
        readConfigFile: async () => {
          throw new Error("tailnet-observer-config-file-unreadable");
        },
      }).snapshot();

      expect(snapshot.configFileError).toBe("tailnet-observer-config-file-unreadable");
    });

    it("does not echo a failure that is not one of its own codes", async () => {
      const snapshot = await service({
        readConfigFile: async () => {
          throw new Error("EACCES: permission denied, open '/home/example/tailnet/observer.json'");
        },
      }).snapshot();

      expect(snapshot.configFileError).toBe("tailnet-observer-config-file-unreadable");
    });

    it("lets a save write over the damaged bytes", async () => {
      const writeConfigFile = vi.fn(async () => undefined);
      await service({ readConfigFile: damaged, writeConfigFile }).apply(OFF_VIEW);

      // Not `{}` any more: the boundary has no implicit default, so a file that named none would be invalid the moment the listener is enabled. Starting over
      // therefore writes the default boundary out explicitly.
      expect(writeConfigFile).toHaveBeenCalledWith({ authorization: TAILNET_IDENTITY, port: DEFAULT_TAILNET_OBSERVER_PORT });
    });
  });

  describe("applying without a relaunch", () => {
    it("restarts the listener after the file is written", async () => {
      const order: string[] = [];
      await service({
        writeConfigFile: async () => { order.push("write"); },
        restartListener: async () => { order.push("restart"); },
      }).apply(OFF_VIEW);

      expect(order).toEqual(["write", "restart"]);
    });

    it("surfaces a restart failure rather than reporting a save that did nothing", async () => {
      await expect(service({
        restartListener: async () => {
          throw new Error("tailnet-observer-authorization-missing-or-invalid");
        },
      }).apply(OFF_VIEW)).rejects.toThrow("tailnet-observer-authorization-missing-or-invalid");
    });
  });

  describe("configuring Tailscale Serve", () => {
    it("offers the exact command for the port the listener actually bound", async () => {
      const snapshot = await service({ listeningPort: 46_500 }).snapshot();

      expect(snapshot.serveCommand)
        .toBe("tailscale serve --bg --https=443 http://127.0.0.1:46500");
    });

    it("offers no command while nothing is listening", async () => {
      expect((await service().snapshot()).serveCommand).toBeNull();
    });

    it("runs it for the listening port and hands back the reachable URL", async () => {
      const runServe = vi.fn(async () => ({ ok: true as const }));
      const result = await service({ listeningPort: 46_500, runServe }).configureServe();

      expect(runServe).toHaveBeenCalledWith({ cliPath: "tailscale", port: 46_500 });
      expect(result).toEqual({ ok: true, url: WEB_ORIGIN + "/" });
    });

    it("refuses before running anything when no listener is up", async () => {
      const runServe = vi.fn(async () => ({ ok: true as const }));
      const result = await service({ runServe }).configureServe();

      expect(result).toEqual({ ok: false, error: "tailnet-serve-not-listening", output: null });
      expect(runServe).not.toHaveBeenCalled();
    });

    it("refuses when Tailscale is not signed in, and says which state it is in", async () => {
      const runServe = vi.fn(async () => ({ ok: true as const }));
      const result = await service({
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
        environment: readyEnvironment({ state: "logged-out" }),
        runServe,
      }).configureServe();

      expect(result).toEqual({
        ok: false,
        error: "tailnet-serve-tailscale-logged-out",
        output: null,
      });
      expect(runServe).not.toHaveBeenCalled();
    });

    it("refuses when there is no MagicDNS name to serve", async () => {
      const result = await service({
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
        environment: readyEnvironment({ dnsName: null }),
        runServe: async () => ({ ok: true as const }),
      }).configureServe();

      expect(result).toEqual({
        ok: false,
        error: "tailnet-serve-magic-dns-missing",
        output: null,
      });
    });

    it("carries what Tailscale printed when the command fails", async () => {
      const result = await service({
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
        runServe: async () => ({
          ok: false as const,
          reason: "command-failed" as const,
          output: "HTTPS is not enabled on this tailnet",
        }),
      }).configureServe();

      expect(result).toEqual({
        ok: false,
        error: "tailnet-serve-command-failed",
        output: "HTTPS is not enabled on this tailnet",
      });
    });
  });
  describe("guided setup", () => {
    it("refuses every environment state but ready, and writes nothing", async () => {
      const writeConfigFile = vi.fn(async () => undefined);
      const result = await service({
        writeConfigFile,
        environment: readyEnvironment({ state: "logged-out" }),
      }).guidedSetup();

      expect(result).toEqual({ ok: false, error: "tailnet-guided-setup-not-ready", output: null });
      expect(writeConfigFile).not.toHaveBeenCalled();
    });

    it("writes the recommended configuration and restarts before running Serve", async () => {
      const order: string[] = [];
      const writeConfigFile = vi.fn(async () => { order.push("write"); });
      const runServe = vi.fn(async () => { order.push("serve"); return { ok: true as const }; });
      const result = await service({
        writeConfigFile,
        restartListener: async () => { order.push("restart"); },
        runServe,
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
      }).guidedSetup();

      expect(order).toEqual(["write", "restart", "serve"]);
      expect(writeConfigFile).toHaveBeenCalledWith({
        enabled: true,
        authorization: TAILNET_IDENTITY,
        port: DEFAULT_TAILNET_OBSERVER_PORT,
        pairedSharingEnabled: true,
        webEnabled: true,
        webOrigin: WEB_ORIGIN,
      });
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        port: DEFAULT_TAILNET_OBSERVER_PORT,
        serve: "configured",
        webOrigin: WEB_ORIGIN,
      }));
    });

    it("keeps a saved port this process is already listening on", async () => {
      const writeConfigFile = vi.fn(async () => undefined);
      const result = await service({
        file: { port: 46_500 },
        listeningPort: 46_500,
        writeConfigFile,
        runServe: async () => ({ ok: true as const }),
      }).guidedSetup();

      expect(writeConfigFile).toHaveBeenCalledWith(expect.objectContaining({ port: 46_500 }));
      expect(result).toEqual(expect.objectContaining({ ok: true, port: 46_500 }));
    });

    it("keeps the saved port and leaves Serve alone when the bind is blocked", async () => {
      const blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = blocker.address();
        if (address === null || typeof address === "string") throw new Error("Missing port");
        const { port } = address;
        const writeConfigFile = vi.fn(async () => undefined);
        const runServe = vi.fn();
        const result = await service({
          file: { port },
          writeConfigFile,
          runServe,
          restartListener: async () => { throw new Error(TAILNET_OBSERVER_PORT_BLOCKED); },
        }).guidedSetup();

        expect(result).toEqual({ ok: false, error: TAILNET_OBSERVER_PORT_BLOCKED, output: null });
        expect(writeConfigFile).toHaveBeenCalledOnce();
        expect(writeConfigFile).toHaveBeenCalledWith(expect.objectContaining({ port }));
        expect(runServe).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>(resolve => blocker.close(() => resolve()));
      }
    });

    it("leaves Serve alone when it already forwards to this exact port", async () => {
      const runServe = vi.fn(async () => ({ ok: true as const }));
      const result = await service({
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
        environment: readyEnvironment({ serveConfigured: true, serveTargetPort: DEFAULT_TAILNET_OBSERVER_PORT }),
        runServe,
      }).guidedSetup();

      expect(runServe).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ ok: true, serve: "already-configured" }));
    });

    it("re-runs Serve when it forwards somewhere else", async () => {
      const runServe = vi.fn(async () => ({ ok: true as const }));
      const result = await service({
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
        environment: readyEnvironment({ serveConfigured: true, serveTargetPort: 45_000 }),
        runServe,
      }).guidedSetup();

      expect(runServe).toHaveBeenCalledWith({ cliPath: "tailscale", port: DEFAULT_TAILNET_OBSERVER_PORT });
      expect(result).toEqual(expect.objectContaining({ ok: true, serve: "configured" }));
    });

    it("hands back the resolver's own code when the restart refuses", async () => {
      const result = await service({
        restartListener: async () => {
          throw new Error("tailnet-paired-sharing-runtime-unavailable");
        },
      }).guidedSetup();

      expect(result).toEqual({
        ok: false,
        error: "tailnet-paired-sharing-runtime-unavailable",
        output: null,
      });
    });

    it("does not echo a failure that is not one of its own codes", async () => {
      const result = await service({
        writeConfigFile: async () => {
          throw new Error("EACCES: permission denied, open '/home/example/tailnet/observer.json'");
        },
      }).guidedSetup();

      expect(result).toEqual({ ok: false, error: "tailnet-observer-write-failed", output: null });
    });

    it("reports a Serve failure instead of claiming the setup finished", async () => {
      const result = await service({
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
        runServe: async () => ({
          ok: false as const,
          reason: "command-failed" as const,
          output: "HTTPS is not enabled on this tailnet",
        }),
      }).guidedSetup();

      // Tailscale's own sentence survives: the message for this code says its output is below, and the certificate case cannot be acted on without it.
      expect(result).toEqual({
        ok: false,
        error: "tailnet-serve-command-failed",
        output: "HTTPS is not enabled on this tailnet",
      });
    });

    it("writes over a damaged file rather than refusing to set up", async () => {
      const writeConfigFile = vi.fn(async () => undefined);
      const result = await service({
        readConfigFile: async () => {
          throw new Error("tailnet-observer-config-file-invalid");
        },
        writeConfigFile,
        listeningPort: DEFAULT_TAILNET_OBSERVER_PORT,
        runServe: async () => ({ ok: true as const }),
      }).guidedSetup();

      expect(result.ok).toBe(true);
      expect(writeConfigFile).toHaveBeenCalled();
    });
  });

  describe("own-device admission", () => {
    it("reports whether this desktop's own devices skip the approval click", async () => {
      await expect(service().snapshot()).resolves.toMatchObject({ ownDeviceAdmission: false });
      await expect(service({ ownDeviceAdmission: true }).snapshot())
        .resolves.toMatchObject({ ownDeviceAdmission: true });
    });

    it("passes the direction to the host and never restarts the listener for it", async () => {
      const writeOwnDeviceAdmission = vi.fn(async () => undefined);
      const restartListener = vi.fn(async () => undefined);
      const target = service({ writeOwnDeviceAdmission, restartListener });

      await target.setOwnDeviceAdmission(true);
      await target.setOwnDeviceAdmission(false);

      expect(writeOwnDeviceAdmission.mock.calls).toEqual([[true], [false]]);
      // A live remote must not be dropped to change who may skip an approval.
      expect(restartListener).not.toHaveBeenCalled();
    });
  });
});
