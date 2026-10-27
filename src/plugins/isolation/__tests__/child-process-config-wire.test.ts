/** Exercise config delivery across a real JSON process boundary; in-memory sharing cannot prove marshalling. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEntry, childBundleDir, repositoryRoot } from "./child-entry-bundle.js";
import { aveHome } from "../../../shared/ave-home.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import { derivePluginChildEnvelope } from "../out-of-process-plugin.js";
import { createBoundHostApiDispatchTable } from "../bound-host-api-table.js";
import { openPluginProtocolSession } from "../plugin-protocol-session.js";
import type { ChildLink } from "../plugin-child-transport.js";
import { SECRET_REDACTED_SENTINEL } from "../host-api-wire.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
  _resetPluginConfigChangeBus,
} from "../../config-change-bus.js";
import {
  buildAppPreferenceReader,
  publishAppPreferenceChange,
  HOST_PUBLIC_PREFERENCE_KEYS,
  _resetAppPreferencePublisher,
} from "../../../boot/steps/plugin-runtime/app-preference.js";
import type { SettingsService, WebViewPreferredFlow } from "../../../data/settings-store.js";
import { resolvePluginSocketDir } from "../../plugin-storage-layout.js";

const PLUGIN_ID = "sampleassistant";

interface RecordedChange {
  readonly isSentinel: boolean;
  readonly kind: string;
  readonly description: string | null;
  readonly plainValue: string | null;
  /** Read config.get inside the callback to verify snapshot ordering. */
  readonly configGet: string;
}

interface PreferenceProbe {
  readonly preferredFlow: string | null;
  readonly offAllowlist: string | null;
  /** Use typeof to expose inherited functions that cannot themselves cross JSON. */
  readonly inheritedKind: string;
  readonly constructorKind: string;
}

let temporaryRoot: string | undefined;
const spawnedChildren = new Set<ChildProcess>();

const CHILD_BUNDLE_CACHE = "plugin-child-config-wire";

/** Hold import long enough to receive a construction-window push, below the construct deadline. */
const CONSTRUCT_WINDOW_MS = 1_200;

/** Resolve the sentinel with Symbol.for as separately bundled plugins do; delay import to exercise construction-window pushes. */
function writePluginEntry(root: string, importDelayMs = 0): string {
  const entryPath = join(root, "plugin.mjs");
  writeFileSync(
    entryPath,
    `${importDelayMs > 0 ? `await new Promise((settle) => setTimeout(settle, ${importDelayMs}));\n` : ""}const SENTINEL = Symbol.for("ave.config.secret.redacted");
const describe = (value) => (typeof value === "symbol" ? "SYMBOL:" + value.description : JSON.stringify(value ?? null));
export const createPlugin = async (context) => {
  const api = context.hostApi;
  const changes = [];
  api.config.onChange("apiKey", (value) => {
    changes.push({
      isSentinel: value === SENTINEL,
      kind: typeof value,
      description: typeof value === "symbol" ? (value.description ?? null) : null,
      plainValue: typeof value === "symbol" ? null : (value ?? null),
      // Read INSIDE the callback, before any later snapshot push can arrive:
      // this is what the plugin would see if the sentinel had been written into
      // the child's config snapshot.
      configGet: describe(api.config.get("apiKey")),
    });
  });
  return {
    handlers: {
      probe_changes: async () => changes,
      probe_preference: async () => ({
        preferredFlow: api.getAppPreference("webView.preferredFlow") ?? null,
        offAllowlist: api.getAppPreference("llm.provider") ?? null,
        // Keys the snapshot object inherits rather than owns. A bare index
        // answers these with Object.prototype's functions; the host reader
        // answers undefined, because they are not on the allowlist.
        inheritedKind: typeof api.getAppPreference("toString"),
        constructorKind: typeof api.getAppPreference("constructor"),
      }),
    },
  };
};
`,
    "utf-8",
  );
  return entryPath;
}

const MANIFEST = {
  id: PLUGIN_ID,
  name: "Sample Assistant",
  version: "0.10.14",
  requires: { hostProtocol: "4" },
  entry: "plugin.mjs",
  description: "reports what crossed the boundary",
  tools: [
    {
      name: "probe_changes",
      description: "every config.onChange delivery this plugin received",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "probe_preference",
      description: "the host preferences as they read right now",
      inputSchema: { type: "object", properties: {} },
    },
  ],
} as PluginManifest;

function spawnPlainChild(childEntryPath: string): ChildLink {
  const child = spawn(process.execPath, [childEntryPath], {
    stdio: ["pipe", "pipe", "pipe"],
    // Set ELECTRON_RUN_AS_NODE so the executable acts as Node and exposes no main-process API.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  spawnedChildren.add(child);
  child.once("exit", () => spawnedChildren.delete(child));
  if (!child.stdin || !child.stdout) {
    child.kill("SIGKILL");
    throw new Error("the spawned child has no pipes");
  }
  // A fault with a live PID is not exit; only terminal exit or spawn-without-process means gone.
  const hasProcess = (): boolean => typeof child.pid === "number" && child.pid > 0;
  return {
    input: child.stdout,
    output: child.stdin,
    terminate: () => child.kill("SIGTERM"),
    onGone: (handler) => {
      child.once("exit", (code, signal) =>
        handler(`child exited code=${String(code)} signal=${String(signal)}`),
      );
      child.on("error", (error: Error) => {
        if (!hasProcess()) handler(`child error: ${error.message}`);
      });
    },
    onFault: (handler) => {
      child.on("error", (error: Error) => {
        if (hasProcess()) handler(`child fault: ${error.message}`);
      });
    },
  };
}

/** Use a real unconfined child to isolate marshalling from sandbox availability. */
function plainSessionFactory(spec: {
  readonly manifest: PluginManifest;
  readonly entryPath: string;
  readonly childEntryPath: string;
}): (context: PluginRuntimeContext) => Promise<RuntimePlugin> {
  return async (context) => {
    const envelope = derivePluginChildEnvelope({
      pluginId: spec.manifest.id,
      pluginRoot: context.pluginRoot,
      pluginDataDir: context.pluginDataDir,
      configValue: (key) => context.hostApi.config.get(key),
    });
    const session = await openPluginProtocolSession({
      pluginId: spec.manifest.id,
      manifest: spec.manifest,
      hostProtocolVersion: "4",
      link: spawnPlainChild(spec.childEntryPath),
      context,
      entryPath: spec.entryPath,
      table: createBoundHostApiDispatchTable(context.hostApi, envelope),
      onClosed: async () => undefined,
    });
    return session.instance;
  };
}

function fakeSettingsService(initial: WebViewPreferredFlow): {
  service: SettingsService;
  set: (flow: WebViewPreferredFlow) => void;
} {
  let flow = initial;
  return {
    service: {
      get: (key: string) => (key === "webView" ? { preferredFlow: flow } : undefined),
    } as unknown as SettingsService,
    set: (next) => {
      flow = next;
    },
  };
}

/** Bind only exercised members to the real config bus and preference reader. */
function hostApiFor(
  settingsService: SettingsService,
  options: {
    /** Count snapshot reads at the first allowlisted key so adding keys does not change the fault ordinal. */
    readonly throwOnPreferenceSnapshot?: number;
  } = {},
): {
  hostApi: PluginHostApi;
  subscribedKeys: Set<string>;
  configWatchers: Array<{ key: string; released: boolean }>;
} {
  const subscribedKeys = new Set<string>();
  const configWatchers: Array<{ key: string; released: boolean }> = [];
  const readPreference = buildAppPreferenceReader(settingsService, { warn: () => undefined });
  let snapshotReads = 0;
  const hostApi = {
    getInstalledPluginIds: () => [PLUGIN_ID],
    onPluginsChanged: () => () => undefined,
    getAppPreference: (key: string) => {
      if (key === HOST_PUBLIC_PREFERENCE_KEYS[0]) snapshotReads += 1;
      if (options.throwOnPreferenceSnapshot === snapshotReads) {
        throw new Error("hostApi.getAppPreference belongs to a retired generation");
      }
      return readPreference(PLUGIN_ID, key);
    },
    config: {
      // Secrets are absent from cleartext snapshots; changes carry only the sentinel.
      get: () => undefined,
      set: async () => undefined,
      onChange: (key: string, callback: (value: unknown) => void) => {
        subscribedKeys.add(key);
        const unsubscribe = subscribePluginConfigChange(PLUGIN_ID, key, (_changedKey, value) => {
          callback(value);
        });
        const watcher = { key, released: false };
        configWatchers.push(watcher);
        return () => {
          watcher.released = true;
          unsubscribe();
        };
      },
    },
  } as unknown as PluginHostApi;
  return { hostApi, subscribedKeys, configWatchers };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function readChanges(instance: RuntimePlugin): Promise<RecordedChange[]> {
  return (await instance.handlers.probe_changes!()) as RecordedChange[];
}

beforeEach(() => {
  _resetPluginConfigChangeBus();
  _resetAppPreferencePublisher();
  temporaryRoot = mkdtempSync(join(tmpdir(), "child-config-wire-"));
});

afterEach(() => {
  for (const child of spawnedChildren) child.kill("SIGKILL");
  spawnedChildren.clear();
  _resetPluginConfigChangeBus();
  _resetAppPreferencePublisher();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
  rmSync(childBundleDir(CHILD_BUNDLE_CACHE), { recursive: true, force: true });
});

describe("the config values a plugin reads, across a real child process", () => {
  it(
    "carries the secret sentinel, keeps it out of the config snapshot, and still reports a real clear",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service } = fakeSettingsService("in-app");
      const { hostApi, subscribedKeys } = hostApiFor(service);
      const factory = plainSessionFactory({
        manifest: MANIFEST,
        entryPath: writePluginEntry(root),
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        aveHome: aveHome(),
        // A secret update must delete stray cleartext copies without storing the sentinel.
        config: { apiKey: "stale-cleartext-copy" },
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);
      try {
        // Observe host subscription readiness because the synchronous child contract cannot await its round trip.
        await waitFor(() => subscribedKeys.has("apiKey"), "the host to adopt the subscription");

        // Notification and tool request share an ordered pipe; stale reads must fail rather than pass after polling.
        emitPluginConfigChange(PLUGIN_ID, "apiKey", SECRET_REDACTED_SENTINEL);
        const afterSecret = await readChanges(instance);
        expect(afterSecret).toHaveLength(1);

        // A secret change must remain distinct from an undefined cleared key.
        expect(afterSecret[0]!.isSentinel).toBe(true);
        expect(afterSecret[0]!.kind).toBe("symbol");
        expect(afterSecret[0]!.description).toBe("ave.config.secret.redacted");
        // Sentinels are notifications, never config values.
        expect(afterSecret[0]!.configGet).toBe("null");

        // A real clear must remain distinguishable from a secret change.
        emitPluginConfigChange(PLUGIN_ID, "apiKey", undefined);
        const afterClear = await readChanges(instance);
        expect(afterClear).toHaveLength(2);
        expect(afterClear[1]!.isSentinel).toBe(false);
        expect(afterClear[1]!.kind).toBe("undefined");

        emitPluginConfigChange(PLUGIN_ID, "apiKey", "plain-text");
        const afterPlain = await readChanges(instance);
        expect(afterPlain).toHaveLength(3);
        expect(afterPlain[2]!.isSentinel).toBe(false);
        expect(afterPlain[2]!.plainValue).toBe("plain-text");
      } finally {
        await instance.stop?.();
      }
    },
    180_000,
  );

  it(
    "answers getAppPreference from a snapshot the host keeps current",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service, set } = fakeSettingsService("in-app");
      const { hostApi } = hostApiFor(service);
      const factory = plainSessionFactory({
        manifest: MANIFEST,
        entryPath: writePluginEntry(root),
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
      });
      const instance = await factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        aveHome: aveHome(),
        config: {},
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);
      try {
        const seeded = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(seeded.preferredFlow).toBe("in-app");
        // Non-allowlisted preferences must stay absent from the snapshot.
        expect(seeded.offAllowlist).toBeNull();
        // Inherited keys must return undefined just as the host allowlist reader does.
        expect(seeded.inheritedKind).toBe("undefined");
        expect(seeded.constructorKind).toBe("undefined");

        // Preference reads must follow host changes for the lifetime of the child.
        set("system-browser");
        publishAppPreferenceChange(service);
        // Notification and next request share an ordered pipe; stale preferences must fail without polling.
        const afterChange = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(afterChange.preferredFlow).toBe("system-browser");

        // Unchanged readable settings must not announce a preference change.
        publishAppPreferenceChange(service);
        const afterNoop = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(afterNoop.preferredFlow).toBe("system-browser");
      } finally {
        await instance.stop?.();
      }
    },
    180_000,
  );

  it(
    "answers with a preference that moved while the child was still constructing",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service, set } = fakeSettingsService("in-app");
      const { hostApi } = hostApiFor(service);
      const factory = plainSessionFactory({
        manifest: MANIFEST,
        entryPath: writePluginEntry(root, CONSTRUCT_WINDOW_MS),
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
      });
      const constructing = factory({
        pluginId: PLUGIN_ID,
        pluginRoot: root,
        hostRoot: repositoryRoot(),
        pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        aveHome: aveHome(),
        config: {},
        log: () => undefined,
        hostApi,
      } as PluginRuntimeContext);

      // The push arrives before runtime construction and cannot yet be applied.
      await new Promise((settle) => setTimeout(settle, CONSTRUCT_WINDOW_MS / 4));
      set("system-browser");
      publishAppPreferenceChange(service);

      const instance = await constructing;
      try {
        // Repush once construct resolves; no later change event will repeat a value that already moved.
        const probed = (await instance.handlers.probe_preference!()) as PreferenceProbe;
        expect(probed.preferredFlow).toBe("system-browser");
      } finally {
        await instance.stop?.();
      }
    },
    180_000,
  );

  it(
    "kills the child and releases the host watchers when a step after construct throws",
    async () => {
      const root = temporaryRoot!;
      const pluginDataDir = join(root, "data");
      mkdirSync(pluginDataDir, { recursive: true });
      const { service } = fakeSettingsService("in-app");
      // Fail the post-construct push, after the child exists.
      const { hostApi, configWatchers } = hostApiFor(service, { throwOnPreferenceSnapshot: 2 });
      const factory = plainSessionFactory({
        manifest: MANIFEST,
        entryPath: writePluginEntry(root),
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
      });
      const before = new Set(spawnedChildren);

      await expect(
        factory({
          pluginId: PLUGIN_ID,
          pluginRoot: root,
          hostRoot: repositoryRoot(),
          pluginDataDir,
        pluginSocketDir: resolvePluginSocketDir(pluginDataDir),
        userHome: homedir(),
        aveHome: aveHome(),
          config: {},
          log: () => undefined,
          hostApi,
        } as PluginRuntimeContext),
      ).rejects.toThrow(/retired generation/);

      const spawned = [...spawnedChildren].filter((child) => !before.has(child));
      expect(spawned).toHaveLength(1);
      // A post-construct push failure must close the child, transport and every bus subscription.
      await waitFor(() => spawned[0]!.exitCode !== null || spawned[0]!.signalCode !== null,
        "the abandoned child to exit");
      // Release both the host snapshot watcher and the plugin-created subscription.
      expect(configWatchers.map((watcher) => watcher.key).sort()).toEqual(["*", "apiKey"]);
      expect(configWatchers.every((watcher) => watcher.released)).toBe(true);
    },
    180_000,
  );
});
