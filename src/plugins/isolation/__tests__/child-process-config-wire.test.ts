/** Exercise config delivery across a real JSON process boundary; in-memory sharing cannot prove marshalling. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { buildChildEntry, childBundleDir, repositoryRoot } from "./child-entry-bundle.js";
import { aveHome } from "../../../shared/ave-home.js";
import { deferred } from "../../../__tests__/support/deferred.js";
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
const stallServers = new Set<Server>();

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
): Promise<ChildLink & { disconnect(): void; rawOutput: Writable }> {
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
    rawOutput,
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

async function openStallControl() {
  const connected = deferred<Socket>();
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    server.close();
    connected.resolve(socket);
  });
  stallServers.add(server);
  server.once("close", () => stallServers.delete(server));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing stall control port");
  return { port: address.port, connected: connected.promise };
}

function stallFixture(port: number): string {
  const worker = `
const { connect } = require("node:net");
const { parentPort, workerData: { state, port } } = require("node:worker_threads");
const socket = connect(port, "127.0.0.1");
socket.on("data", (command) => {
  if (command.toString("ascii") === "B") {
    parentPort.postMessage(null);
    return;
  }
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  socket.end();
});
`;
  return `
import { Worker } from "node:worker_threads";
const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const gate = new Worker(${JSON.stringify(worker)}, { eval: true, workerData: { state, port: ${port} } });
gate.on("message", stall);
gate.unref();
function stall() {
  writeSync(2, "plugin stalled\\n");
  Atomics.wait(state, 0, 0);
  writeSync(2, "plugin resumed\\n");
}
`;
}

function observeStall(child: ChildProcess | undefined) {
  if (!child?.stderr) throw new Error("missing child diagnostics");
  const entered = deferred<void>();
  const digest = deferred<string>();
  let resumed = false;
  createInterface({ input: child.stderr }).on("line", (line) => {
    if (line === "plugin stalled") entered.resolve();
    if (line === "plugin resumed") resumed = true;
    if (line.startsWith("pressure digest ")) digest.resolve(line.slice("pressure digest ".length));
  });
  return { entered: entered.promise, digest: digest.promise, didResume: () => resumed };
}

function acknowledgeNextRawWrite(output: Writable): Promise<Error | null | undefined> {
  const accepted = deferred<Error | null | undefined>();
  const original = output.write;
  const write = original.bind(output);
  output.write = ((chunk: Buffer, done?: (error?: Error | null) => void) => {
    output.write = original;
    return write(chunk, (error) => {
      done?.(error);
      accepted.resolve(error);
    });
  }) as Writable["write"];
  return accepted.promise;
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
  for (const server of stallServers) server.close();
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
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
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
  let parserDispatchReached = false;
  const previousEmit = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function (event, ...args) {
    if (event === "data" && Buffer.isBuffer(args[0]) && args[0].includes("/onPublished")) {
      parserDispatchReached = true;
    }
    return Reflect.apply(previousEmit, this, [event, ...args]);
  };
  const previousOn = Readable.prototype.on;
  Readable.prototype.on = function (...args) { return Reflect.apply(previousOn, this, args); };
  const previousPush = Readable.prototype.push;
  Readable.prototype.push = function (chunk, ...args) {
    if (chunk?.includes("/onPublished")) parserDispatchReached = true;
    return Reflect.apply(previousPush, this, [chunk, ...args]);
  };
  let seen = false;
  view.once("data", (chunk) => {
    seen = chunk.includes("/onPublished");
    chunk.fill(0);
  });
  view.on("end", () => {
    setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "ended"), 25);
  });
  let published = false;
  return {
    onPublished() { published = true; },
    handlers: { probe_changes: () => ({
      read, writeIsInert, writeReplaced, destinationReplaced, ownerReached,
      seen, published, parserDispatchReached, writable: typeof view.write, fd: typeof view.fd,
    }) },
  };
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
    await instance.onPublished!();
    expect(await instance.handlers.probe_changes!()).toEqual({
      read: transport === "native stdio" ? null : 0,
      writeIsInert: transport === "native stdio" ? null : true,
      writeReplaced: false, destinationReplaced: false,
      ownerReached: false, seen: true, published: true, parserDispatchReached: false, writable: "undefined", fd: "undefined",
    });
    await instance.stop?.();
    expect(readFileSync(marker, "utf8")).toBe("ended");
  }, 180_000);

  it.each([
    ["stdio", "an interval"],
    ["loopback", "an interval"],
    ["native stdio", "an interval"],
    ["stdio", "a blocked hook"],
  ])(
    "exits after %s host loss with %s",
    async (transport, pluginWork) => {
      const root = temporaryRoot;
      if (!root) throw new Error("missing plugin fixture directory");
      const entryPath = join(root, "pipe-loss-plugin.mjs");
      const control = pluginWork === "a blocked hook" ? await openStallControl() : undefined;
      writeFileSync(entryPath, `import { writeSync } from "node:fs";
${control ? stallFixture(control.port) : ""}
export const createPlugin = async () => ({
  handlers: {},
  start: ${control ? "stall" : `() => {
    setInterval(() => {}, 60_000);
    writeSync(2, "plugin stalled\\n");
  }`},
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
      if (!child || !instance.start) throw new Error("missing child or start hook");
      const state = observeStall(child);
      const exited = once(child, "exit");
      const release = await control?.connected;
      void instance.start().catch(() => undefined);
      await state.entered;
      link.disconnect();

      // This unconfined link never sends a signal on pipe closure.
      try {
        expect(await exited).toEqual(process.platform === "win32" ? [1, null] : [null, "SIGKILL"]);
        expect(state.didResume()).toBe(false);
      } finally {
        release?.destroy();
      }
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
    const control = await openStallControl();
    writeFileSync(entryPath, `import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
${stallFixture(control.port)}
export const createPlugin = async () => ({
  handlers: {},
  start: () => {
    const hash = createHash("sha256");
    let received = 0;
    process.stdin.on("data", (chunk) => {
      hash.update(chunk);
      received += chunk.length;
      if (received === ${totalBytes}) writeSync(2, "pressure digest " + hash.digest("hex") + "\\n");
    });
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
    const state = observeStall([...spawnedChildren][0]);
    const release = await control.connected;
    await instance.start!();
    release.write("B");
    await state.entered;
    const expected = createHash("sha256");
    const accepted = acknowledgeNextRawWrite(link.rawOutput);
    let firstAcknowledged = false;
    const transfer = (async () => {
      for (let index = 0; index < frameCount; index += 1) {
        const prefix = JSON.stringify({ jsonrpc: "2.0", method: "notifications/pressure", params: { index } });
        frame.fill(0x20);
        frame.write(prefix);
        frame[frame.length - 1] = 0x0a;
        expected.update(frame);
        await new Promise<void>((resolve, reject) => link.output.write(frame, (error) => {
          if (error) reject(error);
          else {
            if (index === 0) firstAcknowledged = true;
            resolve();
          }
        }));
      }
    })();
    const result = transfer.then(() => undefined, (error: unknown) => error);
    try {
      expect(await accepted).toBeFalsy();
      expect(firstAcknowledged).toBe(false);
    } finally {
      release.end("R");
    }
    expect(await result).toBeUndefined();
    expect(await state.digest).toBe(expected.digest("hex"));
    await instance.stop?.();
  }, 180_000);
});
