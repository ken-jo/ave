/** Exercise config delivery across a real JSON process boundary; in-memory sharing cannot prove marshalling. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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


let temporaryRoot: string | undefined;
const spawnedChildren = new Set<ChildProcess>();

const CHILD_BUNDLE_CACHE = "plugin-child-config-wire";

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
  requires: { hostProtocol: "5" },
  entry: "plugin.mjs",
  description: "reports what crossed the boundary",
  tools: [
    {
      name: "probe_changes",
      description: "every config.onChange delivery this plugin received",
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
      hostProtocolVersion: "5",
      link: spawnPlainChild(spec.childEntryPath),
      context,
      entryPath: spec.entryPath,
      table: createBoundHostApiDispatchTable(context.hostApi, envelope),
      onClosed: async () => undefined,
    });
    return session.instance;
  };
}

/** Bind exercised members to the real config bus. */
function hostApiFor(): {
  hostApi: PluginHostApi;
  subscribedKeys: Set<string>;
  configWatchers: Array<{ key: string; released: boolean }>;
} {
  const subscribedKeys = new Set<string>();
  const configWatchers: Array<{ key: string; released: boolean }> = [];
  const hostApi = {
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
  temporaryRoot = mkdtempSync(join(tmpdir(), "child-config-wire-"));
});

afterEach(() => {
  for (const child of spawnedChildren) child.kill("SIGKILL");
  spawnedChildren.clear();
  _resetPluginConfigChangeBus();
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
      const { hostApi, subscribedKeys } = hostApiFor();
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

  it("lets a real child finish asynchronous stdin EOF cleanup", async () => {
    const root = temporaryRoot!;
    const marker = join(root, "eof-cleanup.txt");
    const entryPath = join(root, "eof-plugin.mjs");
    writeFileSync(entryPath, `import { writeFileSync } from "node:fs";
export const createPlugin = async () => {
  process.stdin.on("end", () => {
    setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "cleaned"), 25);
  });
  return { handlers: {} };
};
`);
    const { hostApi } = hostApiFor();
    const factory = plainSessionFactory({
      manifest: { ...MANIFEST, tools: [] }, entryPath,
      childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
    });
    const instance = await factory({
      pluginId: PLUGIN_ID, pluginRoot: root, hostRoot: repositoryRoot(),
      pluginDataDir: root, pluginSocketDir: resolvePluginSocketDir(root),
      userHome: homedir(), aveHome: aveHome(), config: {}, hostApi,
    });
    await instance.stop!();
    expect(readFileSync(marker, "utf8")).toBe("cleaned");
  }, 180_000);

});
