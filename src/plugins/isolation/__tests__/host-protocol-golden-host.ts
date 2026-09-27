/**
 * The host a golden transcript is recorded against.
 *
 * Every member answers the same value every time, and nothing it pushes happens
 * unless the recording asks for it, so a transcript is a function of the plugin
 * module alone. The ONE seam is this object: the dispatcher, the dispatch
 * table, the transport and the child runtime on either side of it are the
 * production ones, so a transcript that changes is the wire that changed.
 *
 * Shared by `host-protocol-golden.test.ts`, which records over paired streams,
 * and `confined-plugin-child.test.ts`, which runs a fixture through a real
 * confined child — the second is only evidence about the first if both talk to
 * the same host. `host-protocol-schema-parity.test.ts` reads the recordings
 * through {@link goldenFiles}, so it walks the same files the recorder wrote.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AudioCaptureEnd,
  AudioCaptureFrame,
  PluginHostApi,
  PluginLifecycleEvent,
  SpawnedPluginWorker,
} from "../../public-contract.js";

/**
 * Members the recording replaces, by dotted hostApi path. `undefined` removes
 * one, which is how a host build without an optional member is spelled.
 */
export type GoldenHostOverrides = Readonly<
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

/** What each host-side registration is handed when the recording fires it. */
const FIRED_EVENT_DATA = { fired: "by the golden host" } as const;
const FIRED_PLUGINS_CHANGE: PluginLifecycleEvent = {
  type: "installed",
  pluginId: "golden-neighbour",
  source: "marketplace",
};

type Listener<T> = (value: T) => void;

export interface GoldenHost {
  /** The object the dispatch table binds. */
  readonly api: PluginHostApi;
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
 * Build the golden host. `overrides` replaces members by path — a missing
 * member is spelled `undefined`, a failing one throws — so an error golden is
 * the same host with one answer changed.
 */
export function createGoldenHost(overrides: GoldenHostOverrides = {}): GoldenHost {
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

  const fakeWorker = (spec: { workerId: string }): SpawnedPluginWorker => {
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
    getInstalledPluginIds: () => ["orion-api", "local-indexer", "meeting", "lyra-mail", "vega-helper"],
    onPluginsChanged: (handler: Listener<PluginLifecycleEvent>) =>
      register(pluginsChangedListeners, handler, () => handler(FIRED_PLUGINS_CHANGE)),
    getSecret: async () => "the-stored-secret",
    resolveApiKey: async () => ({
      ok: true as const,
      vendor: "openai",
      bearer: () => "sk-golden-bearer",
      baseUrl: "https://api.example.com/v1",
      release: () => undefined,
    }),
    callLlm: async () => "the host answered",
    hostFetch: async () =>
      new Response("pong", { status: 200, headers: { "content-type": "text/plain" } }),
    logEvent: (level: string, message: string, data?: unknown) =>
      void logged.push([level, message, data]),
    onShutdown: (handler: () => void | Promise<void>) => void shutdownHandlers.push(handler),
    spawnWorker: async (spec: { workerId: string }) => fakeWorker(spec),
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
    if (!(member in owner)) throw new Error(`the golden host has no member '${path}'`);
    owner[member] = replacement;
  }

  return {
    api,
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
 * Every golden file under `dir`, relative to it and `/`-separated on every
 * platform: the names are built from segments rather than by `relative`, which
 * answers with `\` on Windows.
 */
export function goldenFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const named = `${prefix}${name}`;
      if (statSync(full).isDirectory()) walk(full, `${named}/`);
      else out.push(named);
    }
  };
  walk(dir, "");
  return out.sort();
}
