/** Validation uses scripted host answers and the base envelope; it must never read user settings or apply declared grants. */
import type {
  AudioCaptureEnd,
  AudioCaptureFrame,
  PluginHostApi,
  SpawnedPluginWorker,
  PluginWorkerControl,
  PluginWorkerExitInfo,
  WorkerControlRequestHandler,
} from "../../../plugins/public-contract.js";
import type { DelegatedWorkerConfinement } from "../../../plugins/isolation/host-api-dispatcher.js";
import { derivePluginChildEnvelope } from "../../../plugins/isolation/out-of-process-plugin.js";

/** Override by dotted path; undefined represents an unavailable optional member. */
export type ValidationHostOverrides = Readonly<
  Record<string, ((...args: never[]) => unknown) | undefined>
>;

const INITIAL_CONFIG: ReadonlyArray<readonly [string, unknown]> = [
  ["osNotificationsEnabled", true],
  ["environment", "external"],
  ["realtimeWatch", true],
  ["summaryLengthTier", "standard"],
  ["keepaliveIntervalMs", 60_000],
  ["region", "north"],
];

/** Keep scripted payloads stable because golden transcripts include them. */
const FIRED_EVENT_DATA = { fired: "by the golden host" } as const;

type Listener<T> = (value: T) => void;

/** Use fixed synthetic host roots so golden construct frames remain machine-independent. */
interface ValidationHostRoots {
  readonly hostRoot: string;
  readonly userHome: string;
  readonly aveHome: string;
}

const VALIDATION_HOST_ROOTS: ValidationHostRoots = {
  hostRoot: "/app",
  userHome: "/validation/user",
  aveHome: "/validation/user/.ave",
};

export interface ValidationHost {
  readonly api: PluginHostApi;
  readonly roots: ValidationHostRoots;
  /** Deliver scripted registrations once in registration order for deterministic transcripts. */
  fireAll(): void;
  readonly emitted: Array<readonly [string, unknown]>;
}

/** Override only the intended member so failure cases keep every other scripted answer identical. */
export function createValidationHost(overrides: ValidationHostOverrides = {}): ValidationHost {
  const emitted: Array<readonly [string, unknown]> = [];
  const config = new Map<string, unknown>(INITIAL_CONFIG);
  const configListeners: Array<{ key: string; listener: Listener<unknown> }> = [];
  const firing: Array<() => void> = [];

  const register = <T>(listeners: Set<Listener<T>>, listener: Listener<T>, fire: () => void) => {
    listeners.add(listener);
    firing.push(() => {
      if (listeners.has(listener)) fire();
    });
    return () => void listeners.delete(listener);
  };

  const scriptedWorker = (spec: { workerId: string; control: PluginWorkerControl }): SpawnedPluginWorker => {
    const stdout: Array<Listener<string>> = [];
    const stderr: Array<Listener<string>> = [];
    const exit: Array<Listener<PluginWorkerExitInfo>> = [];
    const notifications: Array<(method: string, params: unknown) => void> = [];
    let requestHandler: WorkerControlRequestHandler | undefined;
    firing.push(() => {
      const rest = (): void => {
        for (const listener of stdout) listener(`${spec.workerId} ready\n`);
        for (const listener of stderr) listener(`${spec.workerId} warming up\n`);
        for (const listener of notifications) listener("ready", { workerId: spec.workerId });
        for (const listener of exit) listener({ code: 0, signal: null, reason: "exited" });
      };
      if (!requestHandler) return rest();
      // A stdio-control worker asks its plugin for egress it may not perform itself, and exits only after the answer.
      void Promise.resolve()
        .then(() => requestHandler!("egress_fetch", { url: "https://example.com/model" }, new AbortController().signal))
        .catch(() => undefined)
        .then(rest);
    });
    const base = {
      pid: 4242,
      stop: () => undefined,
      onStderr: (listener: Listener<string>) => void stderr.push(listener),
      onExit: (listener: Listener<PluginWorkerExitInfo>) => void exit.push(listener),
    };
    if (spec.control === "output-only-v1") {
      return { ...base, control: "output-only-v1", onStdout: (listener) => void stdout.push(listener) };
    }
    return {
      ...base,
      control: "stdio-control-v1",
      request: async (method, params) => ({ echoed: method, params: params ?? null }),
      notify: async () => undefined,
      onRequest: (handler) => {
        requestHandler = handler;
      },
      onNotification: (listener) => void notifications.push(listener),
    };
  };

  const eventListeners = new Set<Listener<unknown>>();

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
        // Push snapshot changes inside set before its reply.
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
    onEvent: (type: string, handler: Listener<unknown>) => {
      if (type !== "host.theme.changed") {
        throw new Error("Validation plugins may subscribe only to host.theme.changed");
      }
      return register(eventListeners, handler, () => handler(FIRED_EVENT_DATA));
    },
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
    spawnWorker: async (spec: { workerId: string; control: PluginWorkerControl }) => scriptedWorker(spec),
    openAuthWindow: async (options: { returnFinalUrl?: boolean }) => {
      const cookies = [{ name: "session", value: "cookie-value", domain: "login.example.com" }];
      return options.returnFinalUrl
        ? { cookies, finalUrl: "https://login.example.com/done?state=ok" }
        : cookies;
    },
    authRedirect: {
      open: async () => ({ handle: "redirect-1", redirectUri: "http://127.0.0.1:43110/callback", state: "the-state" }),
      wait: async () => ({ code: "the-auth-code", state: "the-state" }),
      close: async () => undefined,
    },
    pickFolders: async () => ({ canceled: false, folders: ["/validation/user/Documents"] }),
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
        detach: async () => undefined,
        onDetached: (listener: Listener<string>) => void detached.push(listener),
      };
    },
    openAuthPartitionViewer: async () => undefined,
    clearAuthPartition: async () => undefined,
    getAuthPartitionCookies: async (opts: { urls: string[] }) =>
      opts.urls.map((url) => ({ url, cookies: [{ name: "session", value: "cookie-value" }] })),
    openExternalUrl: async () => undefined,
    probePrivateHost: async () => true,
    triggerConversation: async (spec: { source: string }) => ({
      accepted: true,
      source: spec.source,
      eventId: "event-1",
    }),
    hasRoutineBySource: async () => false,
    raiseAlert: async () => ({
      status: "raised" as const,
      alertId: "golden-alert-id",
      delivered: { card: true, osNotification: false, toast: false },
    }),
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
    emitted,
    fireAll: () => {
      for (const fire of firing.splice(0)) fire();
    },
  };
}

/** Derive only the base envelope with no sandbox input; declared grants remain unmeasured. */
export function validationConfinement(
  pluginId: string,
  pluginRoot: string,
  pluginDataDir: string,
): DelegatedWorkerConfinement {
  return derivePluginChildEnvelope({
    pluginId,
    pluginRoot,
    pluginDataDir,
    // Without sandbox input no directory grant may read config; any read is a contract violation.
    configValue: (key) => {
      throw new Error(`[validation-host] the base envelope reads no config, asked for '${key}'`);
    },
  });
}
