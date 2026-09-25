/**
 * The isolated arm, end to end.
 *
 * The child here is the REAL child — `servePluginChild`, the real
 * `startPluginChildRuntime`, the real `PluginMcpServer`, the real
 * `importPluginFactory` importing a real module off disk — driven over
 * in-memory paired streams instead of a pipe. That is the same substitution
 * `stdio-server-loop`'s own tests make, and it is the only one: everything
 * above the two `PassThrough`s is production code, including the dispatch table
 * assembled from the four group factories.
 *
 * What the confinement half is worth is NOT provable here, and is deliberately
 * not claimed here — `confined-plugin-child.test.ts` spawns a real process for
 * that, because a test that asserts "we called `spawnConfinedChild`" proves
 * wiring and calls it protection.
 */
import { describe, expect, it, vi } from "vitest";

/** What the host transport warned, for the cases that assert a notification was dropped. */
const transportWarnings = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      if (name !== "plugin-child-transport") return logger;
      return Object.assign(Object.create(logger) as typeof logger, {
        warn: (...args: unknown[]) => void transportWarnings.push(args),
      });
    },
  };
});
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext } from "../../types.js";
import { servePluginChild } from "../plugin-child-main.js";
import {
  createBoundHostApiDispatchTable,
  createOutOfProcessPluginFactory,
  type ConfinedPluginChild,
} from "../out-of-process-plugin.js";
import type { ChildLink } from "../plugin-child-transport.js";
import { FRAME_BYTES_MAX, HOSTAPI_PATH_CONTRACTS, type HostApiPath } from "../host-api-wire.js";

const PLUGIN_ID = "vega-helper";
const EMPTY_SCHEMA = { type: "object", properties: {} } as const;

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Vega Helper",
  version: "0.10.14",
  entry: "dist/hostPlugin.js",
  description: "the pilot plugin, served out of process",
  tools: [
    { name: "pilot_echo", description: "echo a payload back", inputSchema: EMPTY_SCHEMA },
    {
      name: "pilot_reach_host",
      description: "call the host and return what it said",
      inputSchema: EMPTY_SCHEMA,
    },
    { name: "pilot_throw", description: "throw from the handler", inputSchema: EMPTY_SCHEMA },
    {
      name: "pilot_undeclared_handler",
      description: "declared, never implemented",
      inputSchema: EMPTY_SCHEMA,
    },
  ],
};

/**
 * A plugin module written to disk, because the child imports one for real.
 *
 * A fake `loadFactory` would skip the exact thing the child had to be changed
 * to make possible: reaching `importPluginFactory` without dragging Electron
 * in. Importing a module off disk is the assertion.
 */
function writePluginModule(): { dir: string; entryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "oop-plugin-"));
  const entryPath = join(dir, "plugin.mjs");
  writeFileSync(
    entryPath,
    `export const createPlugin = async (context) => {
  const seen = [];
  context.hostApi.onEvent("host:ping", (data) => seen.push(data));
  return {
    handlers: {
      pilot_echo: async (payload) => ({
        payload: payload ?? null,
        payloadWasAbsent: payload === undefined,
        installed: context.hostApi.getInstalledPluginIds(),
        pluginDataDir: context.pluginDataDir,
        configuredDomains: context.hostApi.config.get("domains") ?? null,
      }),
      pilot_reach_host: async () => await context.hostApi.callLlm("say hello"),
      pilot_throw: async () => { throw new Error("the handler exploded"); },
    },
    start: async () => { context.hostApi.emitEvent("pilot:started", { ok: true }); },
    stop: async () => { context.hostApi.logEvent("info", "pilot:stopped"); },
  };
};
`,
    "utf-8",
  );
  return { dir, entryPath };
}

/** Every hostApi member the pilot reaches, plus the ones the harness asserts on. */
function fakeHostApi(): PluginHostApi & {
  emitted: Array<[string, unknown]>;
  logged: Array<[string, string]>;
  /** Write a config key and fire the bus, as the real `config.set` path does. */
  setHostConfig: (key: string, value: unknown) => void;
} {
  const emitted: Array<[string, unknown]> = [];
  const logged: Array<[string, string]> = [];
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  // The plugin's resolved config, and the every-key wildcard the real change
  // bus publishes. The host's own snapshot watcher subscribes to `"*"`, so a
  // fake whose `onChange` ignored its callback would make that watcher
  // untestable — and a watcher nothing drives is a watcher nothing proves.
  const configValues = new Map<string, unknown>([["domains", ["portal.example.com"]]]);
  const configListeners = new Map<string, Set<(value: unknown) => void>>();
  const hostApi = {
    emitted,
    logged,
    storage: {
      resolve: (...segments: string[]) => segments.join("/"),
      read: vi.fn(),
      readText: vi.fn(),
      readJson: vi.fn(),
      list: vi.fn(),
      exists: vi.fn(),
      write: vi.fn(),
      writeJson: vi.fn(),
      rm: vi.fn(),
      mkdir: vi.fn(),
      writeEncrypted: vi.fn(),
      readEncrypted: vi.fn(),
    },
    config: {
      get: vi.fn((key: string) => configValues.get(key)),
      set: vi.fn(async () => undefined),
      onChange: vi.fn((key: string, callback: (value: unknown) => void) => {
        let set = configListeners.get(key);
        if (!set) {
          set = new Set();
          configListeners.set(key, set);
        }
        set.add(callback);
        return () => set?.delete(callback);
      }),
    },
    setHostConfig: (key: string, value: unknown) => {
      if (value === undefined) configValues.delete(key);
      else configValues.set(key, value);
      for (const listener of configListeners.get("*") ?? []) listener(value);
    },
    agentApproval: { request: vi.fn(), respond: vi.fn() },
    getSecret: vi.fn(),
    getInstalledPluginIds: vi.fn(() => ["vega-helper", "meeting"]),
    hasRoutineBySource: vi.fn(async () => false),
    getAppPreference: vi.fn(),
    probePrivateHost: vi.fn(),
    resolveApiKey: vi.fn(),
    emitEvent: vi.fn((type: string, data?: unknown) => {
      emitted.push([type, data]);
    }),
    onEvent: vi.fn((type: string, handler: (data: unknown) => void) => {
      let set = eventHandlers.get(type);
      if (!set) {
        set = new Set();
        eventHandlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    }),
    onPluginsChanged: vi.fn(() => () => undefined),
    onShutdown: vi.fn(),
    logEvent: vi.fn((level: string, message: string) => {
      logged.push([level, message]);
    }),
    callLlm: vi.fn(async () => "the host answered"),
    hostFetch: vi.fn(),
    spawnWorker: vi.fn(),
    openExternalUrl: vi.fn(),
    openAuthWindow: vi.fn(),
    openAuthPartitionViewer: vi.fn(),
    clearAuthPartition: vi.fn(),
    triggerConversation: vi.fn(async () => ({ accepted: true })),
  } as unknown as PluginHostApi & {
    emitted: Array<[string, unknown]>;
    logged: Array<[string, string]>;
    setHostConfig: (key: string, value: unknown) => void;
  };
  return hostApi;
}

/** A child served over paired streams, with the host's end of the link. */
function pairedChild(): { child: ConfinedPluginChild; kill: (reason: string) => void } {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const service = servePluginChild(hostToChild, childToHost);
  const goneHandlers: Array<(reason: string) => void> = [];
  const link: ChildLink = {
    input: childToHost,
    output: hostToChild,
    terminate: () => service.hostGone(),
    onGone: (handler) => goneHandlers.push(handler),
  };
  return {
    child: { link },
    kill: (reason) => {
      service.hostGone();
      for (const handler of goneHandlers) handler(reason);
    },
  };
}

function hostContext(
  hostApi: PluginHostApi,
  overrides: Partial<PluginRuntimeContext> = {},
): PluginRuntimeContext {
  return {
    pluginId: PLUGIN_ID,
    pluginRoot: "/plugins/vega-helper",
    hostRoot: "/app",
    pluginDataDir: "/plugins/vega-helper/data",
    pluginSocketDir: "/plugins/vega-helper/sockets",
    userHome: "/Users/example",
    aveHome: "/Users/example/.ave",
    config: { domains: ["portal.example.com"] },
    log: () => undefined,
    hostApi,
    ...overrides,
  };
}

/** The child's own filesystem envelope, as the production factory derives it. */
const CONFINEMENT = {
  read: ["/plugins/vega-helper", "/plugins/vega-helper/data"],
  write: ["/plugins/vega-helper/data"],
};

describe("the dispatch table, assembled from the four group factories", () => {
  it("binds every member the contract says the host answers", () => {
    const table = createBoundHostApiDispatchTable(fakeHostApi(), CONFINEMENT);
    const unbound = (Object.keys(table) as HostApiPath[]).filter(
      (path) => table[path].status === "unimplemented",
    );
    expect(unbound).toEqual([]);
  });

  it("leaves the child-local members refusing, rather than servicing them", () => {
    const table = createBoundHostApiDispatchTable(fakeHostApi(), CONFINEMENT);
    const childLocal = (Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]).filter(
      (path) => HOSTAPI_PATH_CONTRACTS[path].result === "child-local",
    );
    expect(childLocal.length).toBeGreaterThan(0);
    for (const path of childLocal) {
      expect(table[path].status, path).toBe("child-local");
    }
  });
});

describe("the pilot, out of process", () => {
  it("invokes a declared tool end to end and returns the plugin's own value", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));

      // Only the declared tools the plugin actually implements become handlers,
      // which is the same set `buildMethodMap` derives in-process.
      expect(Object.keys(instance.handlers).sort()).toEqual([
        "pilot_echo",
        "pilot_reach_host",
        "pilot_throw",
      ]);

      const echoed = await instance.handlers.pilot_echo!({ text: "hi" });
      // A STRUCTURED value, not its JSON text: the boundary carries the raw
      // result, so an object stays an object and a string stays a string.
      expect(echoed).toEqual({
        payload: { text: "hi" },
        payloadWasAbsent: false,
        installed: ["vega-helper", "meeting"],
        pluginDataDir: "/plugins/vega-helper/data",
        configuredDomains: ["portal.example.com"],
      });
      // An absent payload stays absent across the boundary. MCP carries an
      // object, so `{}` would arrive where the plugin expects nothing — and
      // several plugins branch on exactly that difference.
      const bare = (await instance.handlers.pilot_echo!()) as { payloadWasAbsent: boolean };
      expect(bare.payloadWasAbsent).toBe(true);

      // A payload that cannot be an arguments object is refused, not coerced.
      await expect(instance.handlers.pilot_echo!("not-an-object")).rejects.toThrow(
        /payload must be an object or absent/,
      );
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries a hostApi call from the child to the bound incarnation and back", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      await expect(instance.handlers.pilot_reach_host!()).resolves.toBe(
        "the host answered",
      );
      // The bound instance, not a fresh one: the effect recorder and the effect
      // gate wrap THIS object in production, so a boundary bound to any other
      // would record nothing.
      // An options object and not `undefined`: `callLlm`'s handler always
      // rebuilds one host-side from the declared fields, and it always carries
      // the request's own cancellation signal, which the wire never does.
      expect(hostApi.callLlm).toHaveBeenCalledWith("say hello", {
        signal: expect.any(AbortSignal),
      });
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs start() and stop() in the child and lets the plugin's effects reach the host", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      await instance.start?.();
      expect(hostApi.emitted).toContainEqual(["pilot:started", { ok: true }]);
      await instance.stop?.();
      expect(hostApi.logged).toContainEqual(["info", "pilot:stopped"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose a hook the plugin does not implement, but always exposes stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oop-plugin-bare-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(
      entryPath,
      "export const createPlugin = async () => ({ handlers: {} });\n",
      "utf-8",
    );
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      expect(instance.start).toBeUndefined();
      expect(instance.onPublished).toBeUndefined();
      expect(instance.readUiResource).toBeUndefined();
      // stop is the host's only hand on the child's lifetime, so it is present
      // even when the plugin implements none.
      expect(typeof instance.stop).toBe("function");
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a throwing handler as a rejection carrying the plugin's message", async () => {
    const { dir, entryPath } = writePluginModule();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      await expect(instance.handlers.pilot_throw!()).rejects.toThrow(
        "the handler exploded",
      );
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a child that dies is a failed plugin, never a hung host", () => {
  it("rejects a call in flight when the child goes away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oop-plugin-hang-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(
      entryPath,
      `export const createPlugin = async () => ({
  handlers: { pilot_echo: () => new Promise(() => {}) },
});
`,
      "utf-8",
    );
    const { child, kill } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      const inFlight = instance.handlers.pilot_echo!({});
      kill("child crashed");
      await expect(inFlight).rejects.toThrow(/child crashed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the factory when the child cannot construct the plugin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oop-plugin-noexport-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(entryPath, "export const notAFactory = 1;\n", "utf-8");
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      await expect(factory(hostContext(fakeHostApi()))).rejects.toThrow(
        /exports no plugin factory/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the factory when the child dies before it answers construct", async () => {
    const { child, kill } = pairedChild();
    // Dies the instant `construct` is written, which is the shape a spawn that
    // fails on exec takes: the host has sent its first request and there is
    // nobody left to answer it.
    const output = new PassThrough();
    output.once("data", () => kill("child exited during startup"));
    const factory = createOutOfProcessPluginFactory({
      manifest: MANIFEST,
      entryPath: join(tmpdir(), "never-imported.mjs"),
      connect: async () => ({ link: { ...child.link, output } }),
    });
    await expect(factory(hostContext(fakeHostApi()))).rejects.toThrow(
      /child exited during startup/,
    );
  });

  it("releases the host-side subscriptions the dead child opened", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const unsubscribe = vi.fn();
    (hostApi.onEvent as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => unsubscribe,
    );
    const { child, kill } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      // The plugin subscribed in its factory body; the round trip that opens
      // the host half is not awaited by the contract, so settle it first.
      await instance.handlers.pilot_echo!({});
      expect(hostApi.onEvent).toHaveBeenCalledWith("host:ping", expect.any(Function));
      expect(unsubscribe).not.toHaveBeenCalled();

      kill("child crashed");
      // The host-side registration is undone even though the child never sent
      // a release — case 2 of the four ways a two-sided lifetime ends.
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the host keeps the child's config snapshot current", () => {
  it("re-pushes after a change, so config.get stops answering with the construction value", async () => {
    // `config.get` is answered in the child from a pushed snapshot. Without a
    // re-push it answers with whatever the key held when the plugin started —
    // for the life of the process, with nothing reporting the divergence. The
    // plugin below subscribes to NOTHING: the member has to be current whether
    // or not it ever called `config.onChange`.
    const { dir, entryPath } = writePluginModule();
    try {
      const hostApi = fakeHostApi();
      const { child } = pairedChild();
      const factory = createOutOfProcessPluginFactory({
        manifest: {
          ...MANIFEST,
          configSchema: { type: "object", properties: { domains: { type: "array" } } },
        } as PluginManifest,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      const before = (await instance.handlers.pilot_echo!()) as {
        configuredDomains: unknown;
      };
      expect(before.configuredDomains).toEqual(["portal.example.com"]);

      hostApi.setHostConfig("domains", ["former-site.invalid"]);

      const after = (await instance.handlers.pilot_echo!()) as {
        configuredDomains: unknown;
      };
      expect(after.configuredDomains).toEqual(["former-site.invalid"]);
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops watching when the incarnation ends", async () => {
    // The watcher is the host's own subscription, not one the plugin opened, so
    // nothing else releases it. A watcher outliving the incarnation would write
    // into a closed transport on the next settings edit.
    const { dir, entryPath } = writePluginModule();
    try {
      const hostApi = fakeHostApi();
      const { child } = pairedChild();
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      expect(hostApi.config.onChange).toHaveBeenCalledWith("*", expect.any(Function));
      await instance.stop?.();
      expect(() => hostApi.setHostConfig("domains", ["after-stop"])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a message too large to frame fails its call, not the channel", () => {
  // Past `FRAME_BYTES_MAX` (about 44 MB) but plain JSON, which no byte-payload
  // limit reaches. Before the writer checked the bound, each of these ended the
  // channel at the other end's reader and took every pending call with it.
  const MiB = 1024 * 1024;
  const TOOLS = ["big_result", "read_big_file", "write_big_json", "echo", "events_seen", "log_big"];
  const MODULE = `export const createPlugin = async (context) => {
  const refusal = (error) => ({ name: error.name, code: error.code ?? null });
  const seen = [];
  context.hostApi.onEvent("board.changed", (data) => seen.push(data));
  return {
    handlers: {
      events_seen: async () => ({ seen }),
      // A log line the child cannot frame. context.log never throws in-process.
      log_big: async () => {
        context.log("a large log line", { blob: "x".repeat(46 * ${MiB}) });
        return { logged: true };
      },
      // Crosses twice — text content and raw result — so about 46 MB.
      big_result: async () => "x".repeat(23 * ${MiB}),
      read_big_file: async () => {
        try {
          return { length: (await context.hostApi.storage.readText("big.txt")).length };
        } catch (error) {
          return refusal(error);
        }
      },
      write_big_json: async () => {
        try {
          await context.hostApi.storage.writeJson("big.json", { blob: "x".repeat(46 * ${MiB}) });
          return { written: true };
        } catch (error) {
          return refusal(error);
        }
      },
      echo: async (payload) => ({ echoed: payload ?? null }),
    },
  };
};
`;

  async function construct(hostApi: PluginHostApi) {
    const dir = mkdtempSync(join(tmpdir(), "oop-plugin-oversize-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(entryPath, MODULE, "utf-8");
    const { child } = pairedChild();
    const terminate = vi.fn(child.link.terminate);
    const factory = createOutOfProcessPluginFactory({
      manifest: {
        ...MANIFEST,
        tools: TOOLS.map((name) => ({ name, description: name, inputSchema: EMPTY_SCHEMA })),
      },
      entryPath,
      connect: async () => ({ link: { ...child.link, terminate } }),
    });
    const instance = await factory(hostContext(hostApi));
    return { dir, instance, terminate };
  }

  it("drops a host notification too large to frame, names it in the host log, and delivers the next", async () => {
    const hostApi = fakeHostApi();
    const { dir, instance, terminate } = await construct(hostApi);
    try {
      await vi.waitFor(() => expect(hostApi.onEvent).toHaveBeenCalledWith("board.changed", expect.any(Function)));
      const deliver = vi.mocked(hostApi.onEvent).mock.calls.find(([type]) => type === "board.changed")![1];
      transportWarnings.length = 0;
      // The host's event bus calls this like any listener; it must not throw.
      expect(() => deliver({ blob: "x".repeat(46 * MiB) })).not.toThrow();
      deliver({ small: true });
      await vi.waitFor(async () =>
        expect(await instance.handlers.events_seen!()).toEqual({ seen: [{ small: true }] }));
      expect(transportWarnings).toHaveLength(1);
      expect(transportWarnings[0]![0]).toMatchObject({
        pluginId: PLUGIN_ID,
        method: "notifications/ave/subscription",
        subscriptionId: expect.any(String),
        byteLength: expect.any(Number),
        limit: FRAME_BYTES_MAX,
      });
      expect(terminate).not.toHaveBeenCalled();
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a plugin's log line too large to frame without throwing into the plugin", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { dir, instance, terminate } = await construct(fakeHostApi());
    try {
      await expect(instance.handlers.log_big!()).resolves.toEqual({ logged: true });
      const reported = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.startsWith("[plugin-child] dropped a notification too large to frame"));
      expect(reported).toHaveLength(1);
      expect(JSON.parse(reported[0]!.slice(reported[0]!.indexOf("{")))).toMatchObject({
        pluginId: PLUGIN_ID,
        method: "notifications/ave/log",
        limit: FRAME_BYTES_MAX,
      });
      await expect(instance.handlers.echo!()).resolves.toEqual({ echoed: null });
      expect(terminate).not.toHaveBeenCalled();
      await instance.stop?.();
    } finally {
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a tool result too large to frame, and the plugin keeps serving", async () => {
    const { dir, instance, terminate } = await construct(fakeHostApi());
    try {
      await expect(instance.handlers.big_result!()).rejects.toMatchObject({
        boundaryCode: "payload-too-large",
      });
      await expect(instance.handlers.echo!({ still: "alive" })).resolves.toEqual({
        echoed: { still: "alive" },
      });
      expect(terminate).not.toHaveBeenCalled();
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a host reply too large to frame to the plugin that asked, and the plugin keeps serving", async () => {
    const hostApi = fakeHostApi();
    vi.mocked(hostApi.storage.readText).mockResolvedValue("x".repeat(46 * MiB));
    const { dir, instance, terminate } = await construct(hostApi);
    try {
      await expect(instance.handlers.read_big_file!()).resolves.toEqual({
        name: "HostApiBoundaryError",
        code: "payload-too-large",
      });
      await expect(instance.handlers.echo!()).resolves.toEqual({ echoed: null });
      expect(terminate).not.toHaveBeenCalled();
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a plugin's request too large to frame before it is written", async () => {
    const hostApi = fakeHostApi();
    const { dir, instance, terminate } = await construct(hostApi);
    try {
      await expect(instance.handlers.write_big_json!()).resolves.toEqual({
        name: "HostApiBoundaryError",
        code: "payload-too-large",
      });
      expect(hostApi.storage.writeJson).not.toHaveBeenCalled();
      await expect(instance.handlers.echo!()).resolves.toEqual({ echoed: null });
      expect(terminate).not.toHaveBeenCalled();
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a host request too large to frame to the host caller", async () => {
    const { dir, instance, terminate } = await construct(fakeHostApi());
    try {
      await expect(instance.handlers.echo!({ blob: "x".repeat(46 * MiB) })).rejects.toMatchObject({
        name: "HostApiBoundaryError",
        code: "payload-too-large",
      });
      await expect(instance.handlers.echo!()).resolves.toEqual({ echoed: null });
      expect(terminate).not.toHaveBeenCalled();
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
