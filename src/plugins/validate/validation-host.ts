/**
 * The host a plugin is validated against, and the authority it grants
 * (`docs/design/plugin-hostapi-protocol.md` §9.7, S1).
 *
 * Every member answers the same value every time, and nothing it pushes
 * happens unless the caller asks for it, so a conversation recorded against it
 * is a function of the plugin module alone. It serves the REAL dispatch table
 * through `validation-session.ts`: the dispatcher, the transport and the child
 * runtime on either side are the production ones, and only the answers behind
 * the table are recorded rather than live.
 *
 * Shared by the validator and by the conformance suites — the golden
 * transcripts, the schema parity check and the confined-child run of a golden
 * fixture — so that each is evidence about the others: they all talk to the
 * same host.
 *
 * ITS AUTHORITY IS THE BASE ENVELOPE. {@link validationConfinement} grants the
 * plugin its own root and data directory and nothing else: the validator has
 * no user approvals to consult and must not read the user's settings, so a
 * declared `sandbox` grant is not applied here.
 */
import type {
  AudioCaptureEnd,
  AudioCaptureFrame,
  PluginHostApi,
  PluginLifecycleEvent,
  SpawnedPluginWorker,
} from "../public-contract.js";
import type { DelegatedWorkerConfinement } from "../isolation/host-api-dispatcher.js";
import { derivePluginChildEnvelope } from "../isolation/out-of-process-plugin.js";

/**
 * Members the caller replaces, by dotted hostApi path. `undefined` removes
 * one, which is how a host build without an optional member is spelled.
 */
export type ValidationHostOverrides = Readonly<
  Record<string, ((...args: never[]) => unknown) | undefined>
>;

/** The settings every fixture sees at construction, keyed as their manifests declare. */
const INITIAL_CONFIG: ReadonlyArray<readonly [string, unknown]> = [
  ["osNotificationsEnabled", true],
  ["environment", "external"],
  ["realtimeWatch", true],
  ["summaryLengthTier", "standard"],
  ["keepaliveIntervalMs", 60_000],
  ["region", "north"],
];

/**
 * What each host-side registration is handed when the caller fires it. The
 * values are part of every recorded transcript, so they do not change.
 */
const FIRED_EVENT_DATA = { fired: "by the golden host" } as const;
const FIRED_PLUGINS_CHANGE: PluginLifecycleEvent = {
  type: "installed",
  pluginId: "golden-neighbour",
  source: "marketplace",
};

type Listener<T> = (value: T) => void;

/**
 * The host-side roots a validated plugin's context names. Fixed, so the
 * construct frame does not depend on the machine the validator runs on, and
 * none of them is read: the plugin's own root and data directory are the
 * caller's.
 */
interface ValidationHostRoots {
  readonly hostRoot: string;
  readonly userHome: string;
  readonly aveHome: string;
}

const VALIDATION_HOST_ROOTS: ValidationHostRoots = {
  hostRoot: "/app",
  userHome: "/Users/example",
  aveHome: "/Users/example/.ave",
};

export interface ValidationHost {
  /** The object the dispatch table binds. */
  readonly api: PluginHostApi;
  readonly roots: ValidationHostRoots;
  /**
   * Fire every host-side registration once, in registration order: each event
   * listener, each plugins-changed listener, each worker's stdout, stderr and
   * exit, each capture's frame and end, and each panel's detach. What a
   * running host would eventually do, compressed into one deterministic step.
   */
  fireAll(): void;
  /**
   * Run every `onShutdown` handler and wait for each, as the host's shutdown
   * step does — which is what sends `ave/instance/shutdown`.
   */
  runShutdown(): Promise<void>;
  /** `logEvent` lines and `emitEvent` calls, for the cases that assert on them. */
  readonly logged: Array<readonly [string, string, unknown]>;
  readonly emitted: Array<readonly [string, unknown]>;
}

/**
 * Build the validation host. `overrides` replaces members by path — a missing
 * member is spelled `undefined`, a failing one throws — so an error case is
 * the same host with one answer changed.
 */
export function createValidationHost(overrides: ValidationHostOverrides = {}): ValidationHost {
  const logged: Array<readonly [string, string, unknown]> = [];
  const emitted: Array<readonly [string, unknown]> = [];
  const config = new Map<string, unknown>(INITIAL_CONFIG);
  const configListeners: Array<{ key: string; listener: Listener<unknown> }> = [];
  const firing: Array<() => void> = [];
  const shutdownHandlers: Array<() => void | Promise<void>> = [];

  const register = <T>(listeners: Set<Listener<T>>, listener: Listener<T>, fire: () => void) => {
    listeners.add(listener);
    firing.push(() => {
      if (listeners.has(listener)) fire();
    });
    return () => void listeners.delete(listener);
  };

  const scriptedWorker = (spec: { workerId: string }): SpawnedPluginWorker => {
    const stdout: Array<Listener<string>> = [];
    const stderr: Array<Listener<string>> = [];
    const exit: Array<Listener<{ code: number | null; signal: NodeJS.Signals | null }>> = [];
    firing.push(() => {
      for (const listener of stdout) listener(`${spec.workerId} ready\n`);
      for (const listener of stderr) listener(`${spec.workerId} warming up\n`);
      for (const listener of exit) listener({ code: 0, signal: null });
    });
    return {
      socketPath: `/run/${spec.workerId}.sock`,
      pid: 4242,
      stop: () => undefined,
      onStdout: (listener) => void stdout.push(listener),
      onStderr: (listener) => void stderr.push(listener),
      onExit: (listener) => void exit.push(listener),
    };
  };

  const eventListeners = new Set<Listener<unknown>>();
  const pluginsChangedListeners = new Set<Listener<PluginLifecycleEvent>>();

  const api = {
    storage: {
      resolve: (...segments: string[]) => segments.join("/"),
      read: async () => new Uint8Array([0x00, 0x80, 0xff]),
      readText: async () => "the stored text",
      readJson: async () => ({ stored: true }),
      list: async () => ["today.txt"],
      exists: async () => true,
      write: async () => undefined,
      writeJson: async () => undefined,
      rm: async () => undefined,
      mkdir: async () => undefined,
      writeEncrypted: async () => undefined,
      readEncrypted: async () => "the decrypted text",
    },
    config: {
      get: (key: string) => config.get(key),
      set: async (key: string, value: unknown) => {
        if (value === undefined) config.delete(key);
        else config.set(key, value);
        // Inside `set`, as the real change bus emits: the host's own snapshot
        // watcher is one of these, and the contract orders its push before
        // the `config.set` reply.
        for (const entry of [...configListeners]) {
          if (entry.key === key || entry.key === "*") entry.listener(value);
        }
      },
      onChange: (key: string, listener: Listener<unknown>) => {
        const entry = { key, listener };
        configListeners.push(entry);
        return () => {
          const index = configListeners.indexOf(entry);
          if (index !== -1) configListeners.splice(index, 1);
        };
      },
    },
    emitEvent: (type: string, data?: unknown) => void emitted.push([type, data]),
    onEvent: (_type: string, handler: Listener<unknown>) =>
      register(eventListeners, handler, () => handler(FIRED_EVENT_DATA)),
    // The member excludes the caller, and a validated plugin is validated
    // alone: no other plugin is installed beside it. A recording that needs a
    // neighbourhood supplies one through `overrides`.
    getInstalledPluginIds: () => [],
    onPluginsChanged: (handler: Listener<PluginLifecycleEvent>) =>
      register(pluginsChangedListeners, handler, () => handler(FIRED_PLUGINS_CHANGE)),
    getSecret: async () => "the-stored-secret",
    resolveApiKey: async () => ({
      ok: true as const,
      exposure: "lease" as const,
      leaseId: "lease_golden",
      vendor: "openai",
      baseUrl: "https://api.example.com/v1",
      onClosed: () => () => {},
      release: async () => {},
    }),
    callLlm: async () => "the host answered",
    hostFetch: async () =>
      new Response("pong", { status: 200, headers: { "content-type": "text/plain" } }),
    logEvent: (level: string, message: string, data?: unknown) =>
      void logged.push([level, message, data]),
    onShutdown: (handler: () => void | Promise<void>) => void shutdownHandlers.push(handler),
    spawnWorker: async (spec: { workerId: string }) => scriptedWorker(spec),
    openAuthWindow: async (options: { returnFinalUrl?: boolean }) => {
      const cookies = [{ name: "session", value: "cookie-value", domain: "login.example.com" }];
      return options.returnFinalUrl
        ? { cookies, finalUrl: "https://login.example.com/done?state=ok" }
        : cookies;
    },
    authRedirect: {
      open: async () => ({ handle: "redirect-1", redirectUri: "http://127.0.0.1:43110/callback" }),
      wait: async () => ({ code: "the-auth-code", state: "the-state" }),
      close: async () => undefined,
    },
    pickFolders: async () => ({ canceled: false, folders: ["/Users/example/Documents"] }),
    resolveMappedDriveRoot: async () => "/Volumes/share",
    listAudioInputDevices: async () => [{ deviceId: "default", label: "Built-in Microphone" }],
    startAudioCapture: async () => {
      const frames: Array<Listener<AudioCaptureFrame>> = [];
      const ends: Array<Listener<AudioCaptureEnd>> = [];
      firing.push(() => {
        for (const listener of frames) {
          listener({ seq: 0, pcm: new Uint8Array([0x00, 0x00, 0x80, 0xff]), peak: 0.5 });
        }
        for (const listener of ends) listener({ reason: "stopped" });
      });
      return {
        captureId: "capture-1",
        opened: { microphone: true, systemAudio: false },
        onFrame: (listener: Listener<AudioCaptureFrame>) => {
          frames.push(listener);
          return () => undefined;
        },
        onEnd: (listener: Listener<AudioCaptureEnd>) => {
          ends.push(listener);
          return () => undefined;
        },
        stop: async () => undefined,
      };
    },
    attachFloatingPanel: async (request: { height?: number }) => {
      const detached: Array<Listener<string>> = [];
      firing.push(() => {
        for (const listener of detached) listener("host-closed");
      });
      return {
        panelId: "panel-1",
        height: Math.min(request.height ?? 180, 300),
        resize: async (height: number) => Math.min(height, 300),
        detach: async () => undefined,
        onDetached: (listener: Listener<string>) => void detached.push(listener),
      };
    },
    resizeFloatingPanel: async (_panelId: string, height: number) => Math.min(height, 300),
    openAuthPartitionViewer: async () => undefined,
    clearAuthPartition: async () => undefined,
    getAuthPartitionCookies: async (opts: { urls: string[] }) =>
      opts.urls.map((url) => ({ url, cookies: [{ name: "session", value: "cookie-value" }] })),
    openExternalUrl: async () => undefined,
    probePrivateHost: async () => true,
    getAppPreference: (key: string) => (key === "webView.preferredFlow" ? "system" : undefined),
    triggerConversation: async (spec: { source: string }) => ({
      accepted: true,
      source: spec.source,
      eventId: "event-1",
    }),
    hasRoutineBySource: async () => false,
    proposeWork: async () => ({ status: "cap_reached" as const }),
    withdrawWorkProposal: async () => true,
    raiseAlert: async () => ({
      status: "raised" as const,
      alertId: "golden-alert-id",
      delivered: { card: true, osNotification: false, toast: false },
    }),
    withdrawAlert: async () => true,
    agentApproval: {
      request: async () => "allow-once" as const,
      respond: async () => undefined,
    },
  } as unknown as PluginHostApi;

  for (const [path, replacement] of Object.entries(overrides)) {
    const segments = path.split(".");
    let owner = api as unknown as Record<string, unknown>;
    for (const segment of segments.slice(0, -1)) {
      owner = owner[segment] as Record<string, unknown>;
    }
    const member = segments.at(-1)!;
    if (!(member in owner)) throw new Error(`the validation host has no member '${path}'`);
    owner[member] = replacement;
  }

  return {
    api,
    roots: VALIDATION_HOST_ROOTS,
    logged,
    emitted,
    fireAll: () => {
      for (const fire of firing.splice(0)) fire();
    },
    runShutdown: async () => {
      for (const handler of shutdownHandlers.splice(0)) await handler();
    },
  };
}

/**
 * The validation host's authority: the base envelope and nothing else.
 *
 * `derivePluginChildEnvelope` with NO `sandbox` input — the plugin's own root
 * and data directory, its socket directory and its worker run root. No
 * `hostDirectory` grant and no `userChosenDirectory` grant: the validator has
 * no user approvals to consult and must not read `~/.ave/settings.json`. A
 * delegated worker that asks for more is refused by the same `spawnWorker`
 * check production applies, and a declared grant is reported as not
 * exercised rather than as passed.
 */
export function validationConfinement(
  pluginId: string,
  pluginRoot: string,
  pluginDataDir: string,
): DelegatedWorkerConfinement {
  return derivePluginChildEnvelope({
    pluginId,
    pluginRoot,
    pluginDataDir,
    // Only a `userChosenDirectory` grant reads config, and with no `sandbox`
    // input there is none — so a read here is a broken contract, not a value.
    configValue: (key) => {
      throw new Error(`[validation-host] the base envelope reads no config, asked for '${key}'`);
    },
  });
}
