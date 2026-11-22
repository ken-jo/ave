/** Exercise config delivery across a real JSON process boundary; in-memory sharing cannot prove marshalling. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { buildChildEntry, childBundleDir, repositoryRoot } from "./child-entry-bundle.js";
import { aveHome } from "../../../shared/ave-home.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import { derivePluginChildEnvelope } from "../out-of-process-plugin.js";
import { createBoundHostApiDispatchTable } from "../bound-host-api-table.js";
import { openPluginProtocolSession } from "../plugin-protocol-session.js";
import type { ChildLink } from "../plugin-child-transport.js";
import { CHILD_LOOPBACK_TRANSPORT_ARG, CHILD_PRIVATE_STDIO_TRANSPORT_ARG, connectToAnnouncedChild, encodeChildEnv } from "../child-loopback-link.js";
import { OUTBOUND_QUEUE_BYTES_MAX } from "../child-stream-multiplex.js";
import { pacePluginChildInput, PLUGIN_CHILD_INPUT_FD } from "../plugin-child-credit.js";
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

async function spawnPlainChild(
  childEntryPath: string,
  canTerminate = true,
  transport = "stdio",
): Promise<ChildLink & { disconnect(): void }> {
  const args = transport === "loopback" ? [CHILD_LOOPBACK_TRANSPORT_ARG, encodeChildEnv({})]
    : transport === "stdio" ? [CHILD_PRIVATE_STDIO_TRANSPORT_ARG] : [];
  const child = spawn(process.execPath, [childEntryPath, ...args], {
    stdio: [transport === "native stdio" ? "pipe" : "ignore", "pipe", "pipe",
      ...(transport === "stdio" ? ["pipe" as const] : [])],
    // Set ELECTRON_RUN_AS_NODE so the executable acts as Node and exposes no main-process API.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  spawnedChildren.add(child);
  child.once("exit", () => spawnedChildren.delete(child));
  const pipe = transport === "stdio" ? child.stdio[PLUGIN_CHILD_INPUT_FD] : child.stdin;
  if (!child.stdout || (transport !== "loopback" && !(pipe instanceof Writable))) {
    child.kill("SIGKILL");
    throw new Error("the spawned child has no pipes");
  }
  // A fault with a live PID is not exit; only terminal exit or spawn-without-process means gone.
  const hasProcess = (): boolean => typeof child.pid === "number" && child.pid > 0;
  const socket = transport === "loopback" ? await connectToAnnouncedChild({
    stdout: child.stdout,
    exited: new Promise((resolve) => child.once("exit", () => resolve("test child exited"))),
    timeoutMs: 10_000,
  }) : undefined;
  const rawOutput = socket ?? pipe as Writable;
  return {
    ...pacePluginChildInput(socket ?? child.stdout, rawOutput),
    disconnect: () => rawOutput.end(),
    terminate: () => { if (canTerminate) child.kill("SIGTERM"); },
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
  readonly link?: ChildLink;
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
      link: spec.link ?? await spawnPlainChild(spec.childEntryPath),
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

  it.each(["stdio", "loopback", "native stdio"])("exposes only %s stdin observation", async (transport) => {
    const root = temporaryRoot;
    if (!root) throw new Error("missing plugin fixture directory");
    const marker = join(root, "stdin-end.txt");
    const entryPath = join(root, "stdin-observer.mjs");
    writeFileSync(entryPath, `import { readSync, writeSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
export const createPlugin = async () => {
  const view = process.stdin;
  let read = null;
  let writeIsInert = null;
  if (${JSON.stringify(transport)} !== "native stdio") {
    read = readSync(0, Buffer.alloc(1));
    try {
      writeIsInert = writeSync(0, "inert") === 5;
    } catch (error) {
      writeIsInert = error.code === "EBADF";
    }
  }
  const previousWrite = view.write;
  const writeReplaced = Reflect.set(view, "write", () => { throw new Error("wrong destination"); });
  if (writeReplaced) Reflect.set(view, "write", previousWrite);
  const destinationReplaced = Reflect.defineProperty(process, "stdin", { value: {} });
  let ownerReached = false;
  const previousPost = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...args) {
    ownerReached = true;
    return Reflect.apply(previousPost, this, args);
  };
  let seen = false;
  view.once("data", (chunk) => {
    seen = chunk.includes("stdin-observation");
    chunk.fill(0);
  });
  view.on("end", () => {
    setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "ended"), 25);
  });
  return { handlers: { probe_changes: () => ({
    read, writeIsInert, writeReplaced, destinationReplaced, ownerReached,
    seen, writable: typeof view.write, fd: typeof view.fd,
  }) } };
};
`);
    const { hostApi } = hostApiFor();
    const childEntryPath = await buildChildEntry(CHILD_BUNDLE_CACHE);
    const link = await spawnPlainChild(childEntryPath, false, transport);
    const instance = await plainSessionFactory({ manifest: MANIFEST, entryPath, childEntryPath, link })({
      pluginId: PLUGIN_ID, pluginRoot: root, hostRoot: repositoryRoot(),
      pluginDataDir: root, pluginSocketDir: resolvePluginSocketDir(root),
      userHome: homedir(), aveHome: aveHome(), config: {}, hostApi,
    });
    await new Promise<void>((resolve, reject) =>
      link.output.write('{"jsonrpc":"2.0","method":"notifications/stdin-observation","params":{}}\n', (error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    expect(await instance.handlers.probe_changes!()).toEqual({
      read: transport === "native stdio" ? null : 0,
      writeIsInert: transport === "native stdio" ? null : true,
      writeReplaced: false, destinationReplaced: false,
      ownerReached: false, seen: true, writable: "undefined", fd: "undefined",
    });
    await instance.stop?.();
    expect(readFileSync(marker, "utf8")).toBe("ended");
  }, 180_000);

  it.each([
    ["stdio", "an interval"],
    ["stdio", "a blocked event loop"],
    ["loopback", "an interval"],
    ["loopback", "a blocked event loop"],
    ["native stdio", "an interval"],
    ["native stdio", "a blocked event loop"],
  ])(
    "exits after %s host loss with %s",
    async (transport, pluginWork) => {
      const root = temporaryRoot;
      if (!root) throw new Error("missing plugin fixture directory");
      const entryPath = join(root, "pipe-loss-plugin.mjs");
      writeFileSync(entryPath, `import { writeSync } from "node:fs";
export const createPlugin = async () => ({
  handlers: {},
  start: () => {
    writeSync(2, "plugin started\\n");
    if (${JSON.stringify(pluginWork)} === "an interval") {
      setInterval(() => {}, 100);
    } else {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500);
      writeSync(2, "plugin resumed\\n");
    }
  },
});
`);
      const { hostApi } = hostApiFor();
      const childEntryPath = await buildChildEntry(CHILD_BUNDLE_CACHE);
      const link = await spawnPlainChild(childEntryPath, false, transport);
      const factory = plainSessionFactory({
        manifest: { ...MANIFEST, tools: [] }, entryPath, childEntryPath, link,
      });
      const instance = await factory({
        pluginId: PLUGIN_ID, pluginRoot: root, hostRoot: repositoryRoot(),
        pluginDataDir: root, pluginSocketDir: resolvePluginSocketDir(root),
        userHome: homedir(), aveHome: aveHome(), config: {}, hostApi,
      });
      const child = [...spawnedChildren][0];
      if (!child?.stderr || !instance.start) {
        throw new Error("missing plugin pipes or start hook");
      }
      const { stderr } = child;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      let diagnostics = "";
      const started = new Promise<void>((resolve) => {
        stderr.on("data", (chunk: Buffer) => {
          diagnostics += chunk.toString();
          if (diagnostics.includes("plugin started\n")) resolve();
        });
      });
      void instance.start().catch(() => undefined);
      await started;
      if (pluginWork === "a blocked event loop") {
        link.output.write(Buffer.alloc(1024 * 1024, 0x20));
        expect(link.output.writableLength).toBeGreaterThan(0);
      }
      link.disconnect();

      // This unconfined link never sends a signal on pipe closure.
      expect(await exited).toEqual(process.platform === "win32"
        ? { code: 1, signal: null }
        : { code: null, signal: "SIGKILL" });
      expect(diagnostics).not.toContain("plugin resumed");
    },
    180_000,
  );

  it.each(["stdio", "loopback"])("paces %s while stalled and delivers beyond the previous queue bound in order", async (transport) => {
    const root = temporaryRoot;
    if (!root) throw new Error("missing plugin fixture directory");
    const entryPath = join(root, "pressure-plugin.mjs");
    const frame = Buffer.alloc(1024 * 1024, 0x20);
    const frameCount = Math.ceil(OUTBOUND_QUEUE_BYTES_MAX / frame.length) + 2;
    const totalBytes = frame.length * frameCount;
    const marker = join(root, "pressure-digest.txt");
    writeFileSync(entryPath, `import { writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
export const createPlugin = async () => ({
  handlers: {},
  start: () => {
    const hash = createHash("sha256");
    let received = 0;
    process.stdin.on("data", (chunk) => {
      hash.update(chunk);
      received += chunk.length;
      if (received === ${totalBytes}) writeFileSync(${JSON.stringify(marker)}, hash.digest("hex"));
    });
    writeSync(2, "plugin stalled\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500);
  },
});
`);
    const { hostApi } = hostApiFor();
    const childEntryPath = await buildChildEntry(CHILD_BUNDLE_CACHE);
    const link = await spawnPlainChild(childEntryPath, false, transport);
    const instance = await plainSessionFactory({ manifest: { ...MANIFEST, tools: [] }, entryPath, childEntryPath, link })({
      pluginId: PLUGIN_ID, pluginRoot: root, hostRoot: repositoryRoot(),
      pluginDataDir: root, pluginSocketDir: resolvePluginSocketDir(root),
      userHome: homedir(), aveHome: aveHome(), config: {}, hostApi,
    });
    const child = [...spawnedChildren][0];
    if (!child?.stderr) throw new Error("missing child diagnostics");
    let diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
    void instance.start().catch(() => undefined);
    await waitFor(() => diagnostics.includes("plugin stalled\n"), "the plugin stall");
    const expected = createHash("sha256");
    let completed = 0;
    const transfer = (async () => {
      for (let index = 0; index < frameCount; index += 1) {
        const prefix = JSON.stringify({ jsonrpc: "2.0", method: "notifications/pressure", params: { index } });
        frame.fill(0x20);
        frame.write(prefix);
        frame[frame.length - 1] = 0x0a;
        expected.update(frame);
        await new Promise<void>((resolve, reject) => link.output.write(frame, (error) => {
          if (error) reject(error);
          else resolve();
        }));
        completed += 1;
      }
    })();
    const result = transfer.then(() => undefined, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completed).toBe(0);
    expect(await result).toBeUndefined();
    await waitFor(() => {
      try {
        return readFileSync(marker, "utf8").length === 64;
      } catch {
        return false;
      }
    }, "the digest of all frames");
    expect(readFileSync(marker, "utf8")).toBe(expected.digest("hex"));
    await instance.stop?.();
  }, 180_000);
});
