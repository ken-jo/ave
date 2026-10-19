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
 * The protocol cases open the session the factory opens once its child
 * exists — `openPluginProtocolSession` over the paired link, with a table
 * bound to a literal envelope — so no spawn is involved. The two refusals the
 * factory makes BEFORE any spawn are exercised on the factory itself, with the
 * module where confinement begins recording its calls.
 *
 * What the confinement half is worth is NOT provable here, and is deliberately
 * not claimed here — `confined-plugin-child.test.ts` spawns a real process for
 * that, because a test that asserts "we called `spawnConfinedChild`" proves
 * wiring and calls it protection.
 */
import { describe, expect, it, vi } from "vitest";

/** Every spawn the factory asked for; the refusal cases expect none. */
const spawnConfinedChild = vi.hoisted(() => vi.fn());
vi.mock("../../../permissions/confined-child.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../permissions/confined-child.js")>()),
  spawnConfinedChild,
}));

/**
 * Whether the OS sandbox reads as live. Off, as in every test process, unless a
 * case turns it on; while it is on, ASRT's shared-config registrations are
 * no-ops here, because the spawn they precede is recorded rather than run.
 */
const sandbox = vi.hoisted(() => ({ active: false }));
vi.mock("../../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../permissions/asrt-sandbox.js")>()),
  isAsrtSandboxActive: () => sandbox.active,
  isPluginWorkerConfinementActive: () => sandbox.active,
  registerWorkerUnixSocketDir: async () => undefined,
  unregisterWorkerUnixSocketDir: async () => undefined,
  cleanupAsrtSandboxAfterCommand: async () => undefined,
}));

/**
 * The Windows holder grant, recorded rather than made: what was asked for, in
 * what order against the spawn, and a way to report the holder lost. Nothing
 * here touches an ACL; `windows-acl-grant-holder.test.ts` and the my-window
 * measurement own that.
 */
const windowsGrant = vi.hoisted(() => ({
  calls: [] as Array<{ label: string; allowRead: readonly string[]; allowWrite: readonly string[] }>,
  events: [] as string[],
  lost: [] as Array<(reason: Error) => void>,
  alive: true,
}));
vi.mock("../../../permissions/windows-acl-grant-holder.js", () => ({
  holdWindowsFilesystemGrant: async (opts: { label: string; allowRead: readonly string[]; allowWrite: readonly string[] }) => {
    windowsGrant.calls.push(opts);
    windowsGrant.events.push("grant");
    return {
      assertAlive: () => {
        if (!windowsGrant.alive) throw new Error("holder gone");
      },
      onLost: (listener: (reason: Error) => void) => void windowsGrant.lost.push(listener),
      // Idempotent, as the real one is: every way the child ends calls it.
      release: () => {
        if (windowsGrant.events.at(-1) !== "release") windowsGrant.events.push("release");
      },
    };
  },
}));

/**
 * A POSIX-shaped throwaway HOME for the cases that pretend to be Windows: the
 * real one would build a `win32` path off a POSIX temp dir and create it
 * relative to the cwd.
 */
const fakeSandboxHome = vi.hoisted(() => ({ on: false }));
vi.mock("../../../permissions/sandbox-process-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/sandbox-process-home.js")>();
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    ...actual,
    createSandboxProcessHome: (...args: Parameters<typeof actual.createSandboxProcessHome>) => {
      if (!fakeSandboxHome.on) return actual.createSandboxProcessHome(...args);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "oop-fake-sandbox-home-"));
      return { path: home, env: { HOME: home }, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
    },
  };
});

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
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { spawn as spawnProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginHostApi,
  PluginManifest,
  PluginRuntimeContext,
  RuntimePlugin,
} from "../../types.js";
import { servePluginChild } from "../plugin-child-main.js";
import { createOutOfProcessPluginFactory, PluginSandboxGrantError } from "../out-of-process-plugin.js";
import { createBoundHostApiDispatchTable } from "../bound-host-api-table.js";
import {
  acceptHostOverLoopback,
  CHILD_LOOPBACK_TRANSPORT_ARG,
  connectToAnnouncedChild,
  encodeChildEnv,
  parseChildLaunchArgs,
} from "../child-loopback-link.js";
import { openPluginProtocolSession } from "../plugin-protocol-session.js";
import type { ChildLink } from "../plugin-child-transport.js";
import {
  FRAME_BYTES_MAX,
  HOSTAPI_PATH_CONTRACTS,
  IncompatibleHostProtocolError,
  type HostApiPath,
} from "../host-api-wire.js";
import { PLUGIN_INSTANCE_METHODS } from "../plugin-instance-wire.js";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { buildSafeChildEnv } from "../../../tools/safe-env.js";
import { createSandboxProcessHome } from "../../../permissions/sandbox-process-home.js";
import { ProcessEntryUnconfinedError } from "../../process-entry.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";

const PLUGIN_ID = "sampleassistant";
const EMPTY_SCHEMA = { type: "object", properties: {} } as const;

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Sample Assistant",
  version: "0.10.14",
  entry: "dist/hostPlugin.js",
  requires: { hostProtocol: "3" },
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
    getInstalledPluginIds: vi.fn(() => ["sampleassistant", "meeting"]),
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
function pairedChild(): {
  child: { link: ChildLink };
  kill: (reason: string) => void;
  sendAsChild: (frame: Record<string, unknown>) => void;
} {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const service = servePluginChild(hostToChild, childToHost);
  const goneHandlers: Array<(reason: string) => void> = [];
  const link: ChildLink = {
    input: childToHost,
    output: hostToChild,
    terminate: () => service.hostGone(),
    onGone: (handler) => goneHandlers.push(handler),
    // No process, so nothing can fault.
    onFault: () => undefined,
  };
  return {
    child: { link },
    kill: (reason) => {
      service.hostGone();
      for (const handler of goneHandlers) handler(reason);
    },
    sendAsChild: (frame) => { childToHost.write(`${JSON.stringify(frame)}\n`); },
  };
}

function hostContext(
  hostApi: PluginHostApi,
  overrides: Partial<PluginRuntimeContext> = {},
): PluginRuntimeContext {
  return {
    pluginId: PLUGIN_ID,
    pluginRoot: "/plugins/sampleassistant",
    hostRoot: "/app",
    pluginDataDir: "/plugins/sampleassistant/data",
    pluginSocketDir: "/plugins/sampleassistant/sockets",
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
  read: ["/plugins/sampleassistant", "/plugins/sampleassistant/data"],
  write: ["/plugins/sampleassistant/data"],
};

/**
 * What the factory does once its child exists: open the protocol session over
 * the child's link, with a table bound to the context's hostApi and to
 * {@link CONFINEMENT}. Shaped like a `RuntimePluginFactory` so a case reads
 * the same as the factory case it replaces.
 */
function sessionFactory(spec: {
  readonly manifest: PluginManifest;
  readonly entryPath: string;
  readonly link: ChildLink;
  readonly auditLog?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
}): (context: PluginRuntimeContext) => Promise<RuntimePlugin> {
  return async (context) => {
    const session = await openPluginProtocolSession({
      pluginId: spec.manifest.id,
      manifest: spec.manifest,
      hostProtocolVersion: "3",
      link: spec.link,
      context,
      entryPath: spec.entryPath,
      table: createBoundHostApiDispatchTable(context.hostApi, CONFINEMENT),
      ...(spec.auditLog ? { auditLog: spec.auditLog } : {}),
      onClosed: async () => undefined,
    });
    return session.instance;
  };
}

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
  it("records bounded dispatcher refusals through the runtime audit sink", async () => {
    const { dir, entryPath } = writePluginModule();
    const auditLog = vi.fn();
    const paired = pairedChild();
    try {
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: paired.child.link,
        auditLog,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      for (let index = 0; index < 220; index += 1) {
        paired.sendAsChild({
          jsonrpc: "2.0", id: `flood-${index}`,
          method: "ave/host/hasRoutineBySource", params: { source: "nightly" },
        });
      }
      for (let turn = 0; turn < 10 && auditLog.mock.calls.length === 0; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(auditLog).toHaveBeenCalledWith("warn", "plugin_rate_limited", expect.objectContaining({
        pluginId: PLUGIN_ID,
        method: "hasRoutineBySource",
        code: "rate-limited",
        count: 1,
        summary: false,
      }));
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invokes a declared tool end to end and returns the plugin's own value", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const { child } = pairedChild();
    try {
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
        installed: ["sampleassistant", "meeting"],
        pluginDataDir: "/plugins/sampleassistant/data",
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
    const factory = sessionFactory({
      manifest: MANIFEST,
      entryPath: join(tmpdir(), "never-imported.mjs"),
      link: { ...child.link, output },
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
      const factory = sessionFactory({
        manifest: {
          ...MANIFEST,
          configSchema: { type: "object", properties: { domains: { type: "array" } } },
        } as PluginManifest,
        entryPath,
        link: child.link,
      });
      const instance = await factory(hostContext(hostApi));
      const before = (await instance.handlers.pilot_echo!()) as {
        configuredDomains: unknown;
      };
      expect(before.configuredDomains).toEqual(["portal.example.com"]);

      hostApi.setHostConfig("domains", ["ave.agent-connector.ai"]);

      const after = (await instance.handlers.pilot_echo!()) as {
        configuredDomains: unknown;
      };
      expect(after.configuredDomains).toEqual(["ave.agent-connector.ai"]);
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
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
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
    const factory = sessionFactory({
      manifest: {
        ...MANIFEST,
        tools: TOOLS.map((name) => ({ name, description: name, inputSchema: EMPTY_SCHEMA })),
      },
      entryPath,
      link: { ...child.link, terminate },
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

/** Write `source` as a plugin module and return where it is. */
function writeModule(prefix: string, source: string): { dir: string; entryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const entryPath = join(dir, "plugin.mjs");
  writeFileSync(entryPath, source, "utf-8");
  return { dir, entryPath };
}

/** Every frame the host writes to `link`, decoded as the child decodes it. */
function hostFrames(link: ChildLink): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  link.output.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  return frames;
}

/**
 * A child written by hand: it answers `construct` with `result` and nothing
 * else, which is how a plugin that speaks the protocol itself would answer.
 */
function scriptedChild(result: Record<string, unknown>): {
  child: { link: ChildLink };
  terminated: () => string | undefined;
} {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  hostToChild.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.method === PLUGIN_INSTANCE_METHODS.construct) {
        childToHost.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
      }
    }
  });
  let terminated: string | undefined;
  return {
    child: {
      link: {
        input: childToHost,
        output: hostToChild,
        terminate: (reason) => {
          terminated = reason;
        },
        onGone: () => undefined,
        onFault: () => undefined,
      },
    },
    terminated: () => terminated,
  };
}

const CONSTRUCTED = {
  implementedToolNames: [],
  servesUiResources: false,
  lifecycleHooks: [],
} as const;

/**
 * Real, writable roots for the refusal cases, so a factory that skipped its
 * protocol check would get as far as the spawn — and be recorded there —
 * instead of failing earlier on a root it cannot create.
 */
function spawnableRoots(): { context: Partial<PluginRuntimeContext>; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), "oop-plugin-refusal-"));
  return {
    context: { pluginRoot: root, pluginDataDir: join(root, "data"), pluginSocketDir: join(root, "data", "sockets") },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("construct negotiates the host protocol", () => {
  it("refuses an undeclared protocol before spawning a child", async () => {
    const roots = spawnableRoots();
    spawnConfinedChild.mockClear();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: { ...MANIFEST, requires: undefined },
        launch: { kind: "entry", entryPath: join(tmpdir(), "never-imported.mjs") },
      });
      await expect(factory(hostContext(fakeHostApi(), roots.context))).rejects.toMatchObject({
        detail: { declared: null },
      });
      expect(spawnConfinedChild).not.toHaveBeenCalled();
    } finally {
      roots.remove();
    }
  });

  it("refuses a declared version this host does not serve, before anything is spawned", async () => {
    const roots = spawnableRoots();
    spawnConfinedChild.mockClear();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: { ...MANIFEST, requires: { hostProtocol: "2" } },
        launch: { kind: "entry", entryPath: join(tmpdir(), "never-imported.mjs") },
      });
      const refused = factory(hostContext(fakeHostApi(), roots.context));
      await expect(refused).rejects.toBeInstanceOf(IncompatibleHostProtocolError);
      await expect(refused).rejects.toMatchObject({ detail: { declared: "2" } });
      expect(spawnConfinedChild).not.toHaveBeenCalled();
    } finally {
      roots.remove();
    }
  });

  it("speaks the declared version, and advertises the members the bound table implements", async () => {
    const { dir, entryPath } = writePluginModule();
    const { child } = pairedChild();
    const sent = hostFrames(child.link);
    // A host build without the optional `hostFetch` member.
    const hostApi = fakeHostApi();
    delete (hostApi as { hostFetch?: unknown }).hostFetch;
    try {
      const factory = sessionFactory({
        manifest: { ...MANIFEST, requires: { hostProtocol: "3" } },
        entryPath,
        link: child.link,
      });
      const instance = await factory(hostContext(hostApi));
      const construct = sent.find((frame) => frame.method === PLUGIN_INSTANCE_METHODS.construct);
      const { hostProtocol } = construct?.params as {
        hostProtocol: { version: string; capabilities: string[] };
      };
      expect(hostProtocol.version).toBe("3");
      // Read off the table the dispatcher serves: advertised is answered, and
      // a member this build lacks is not advertised.
      expect(hostProtocol.capabilities).toContain("ave/host/callLlm");
      expect(hostProtocol.capabilities).not.toContain("ave/host/hostFetch");
      // Child-local members never cross, so they are not capabilities.
      expect(hostProtocol.capabilities).not.toContain("ave/host/config/get");
      expect(hostProtocol.capabilities).toEqual([...hostProtocol.capabilities].sort());
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a child that requires a method this host did not advertise, and ends it", async () => {
    const hostApi = fakeHostApi();
    delete (hostApi as { hostFetch?: unknown }).hostFetch;
    const { child, terminated } = scriptedChild({
      ...CONSTRUCTED,
      pluginProtocol: { requires: ["ave/host/callLlm", "ave/host/hostFetch"] },
    });
    const factory = sessionFactory({
      manifest: MANIFEST,
      entryPath: join(tmpdir(), "never-imported.mjs"),
      link: child.link,
    });
    const refused = factory(hostContext(hostApi));
    await expect(refused).rejects.toBeInstanceOf(IncompatibleHostProtocolError);
    await expect(refused).rejects.toMatchObject({
      detail: { missingCapabilities: ["ave/host/hostFetch"] },
    });
    expect(terminated()).toMatch(/startup failed/);
  });

  it("accepts the same requirement from a host that serves it", async () => {
    const { child, terminated } = scriptedChild({
      ...CONSTRUCTED,
      pluginProtocol: { requires: ["ave/host/hostFetch"] },
    });
    const factory = sessionFactory({
      manifest: MANIFEST,
      entryPath: join(tmpdir(), "never-imported.mjs"),
      link: child.link,
    });
    const instance = await factory(hostContext(fakeHostApi()));
    expect(terminated()).toBeUndefined();
    expect(typeof instance.stop).toBe("function");
  });

  it("fails a construct reply with no pluginProtocol, rather than reading it as requiring nothing", async () => {
    const { child, terminated } = scriptedChild({ ...CONSTRUCTED });
    const factory = sessionFactory({
      manifest: MANIFEST,
      entryPath: join(tmpdir(), "never-imported.mjs"),
      link: child.link,
    });
    await expect(factory(hostContext(fakeHostApi()))).rejects.toThrow(
      /construct answered no pluginProtocol\.requires list/,
    );
    expect(terminated()).toMatch(/startup failed/);
  });
});

/**
 * The two launches, as the spawn receives them (docs/design/plugin-hostapi-protocol.md
 * §9.7 P3, decision 36). Recorded, not run: what a real wrap does with them is
 * `confined-plugin-child.test.ts`'s.
 */
describe("the factory's launch reaches the spawn as decided", () => {
  const PROCESS_MANIFEST: PluginManifest = {
    id: "process-kit",
    name: "Process Kit",
    version: "1.0.0",
    process: { command: "./bin/plugin", args: ["--x=1"], env: { SMOKE_VENDOR_DIR: "${PLUGIN_ROOT}/vendor" } },
    requires: { minAppVersion: "0.13.0", hostProtocol: "3" },
    description: "a process entry whose spawn is recorded",
    tools: [],
  };

  function processLaunch(root: string) {
    return {
      kind: "process" as const,
      command: join(root, "bin", "plugin"),
      args: ["--x=1"],
      env: {
        SMOKE_VENDOR_DIR: join(root, "vendor"),
        PLUGIN_ROOT: root,
        PLUGIN_DATA: join(root, "data"),
      },
    };
  }

  async function attempt(
    launch: Parameters<typeof createOutOfProcessPluginFactory>[0]["launch"],
    manifest: PluginManifest,
    roots: ReturnType<typeof spawnableRoots>,
  ): Promise<unknown> {
    const factory = createOutOfProcessPluginFactory({ manifest, launch });
    return Promise.resolve(factory(hostContext(fakeHostApi(), roots.context))).then(() => undefined, (error: unknown) => error);
  }

  // The two POSIX launch cases below do not run on Windows: there a process
  // launch is refused before any of this, which is asserted on every platform,
  // Windows included, by "refuses a process launch on Windows even with the
  // sandbox on" below.
  it.skipIf(process.platform === "win32")(
    "spawns /usr/bin/env inside the wrap with the declared pairs, then the host-owned pair, then the command",
    async () => {
      const roots = spawnableRoots();
      const root = roots.context.pluginRoot!;
      spawnConfinedChild.mockClear();
      sandbox.active = true;
      const sandboxHomeKeys = (() => {
        const home = createSandboxProcessHome();
        try {
          return Object.keys(home.env).sort();
        } finally {
          home.cleanup();
        }
      })();
      try {
        await attempt(processLaunch(root), PROCESS_MANIFEST, roots);
        expect(spawnConfinedChild).toHaveBeenCalledTimes(1);
        const spec = spawnConfinedChild.mock.calls[0]![0] as {
          command: string;
          args: string[];
          baseEnv: NodeJS.ProcessEnv;
          extraEnv: Record<string, string>;
        };
        expect(spec.command).toBe("/usr/bin/env");
        expect(spec.args).toEqual([
          `SMOKE_VENDOR_DIR=${join(root, "vendor")}`,
          `PLUGIN_ROOT=${root}`,
          `PLUGIN_DATA=${join(root, "data")}`,
          join(root, "bin", "plugin"),
          "--x=1",
        ]);
        // No manifest byte reaches the wrapper's environment: the outer shell
        // reads its own environment before the sandbox command runs.
        expect(spec.baseEnv).toEqual(buildSafeChildEnv());
        expect(Object.keys(spec.extraEnv).sort()).toEqual(sandboxHomeKeys);
        // Every other plugin's directories are refused, and the child's own —
        // its root and data directory — are the re-allows inside that deny.
        const reach = spawnConfinedChild.mock.calls[0]![0] as {
          grantMode: string;
          denyPluginsRoot?: boolean;
          allowRead: string[];
        };
        expect(reach.grantMode).toBe("allow-list");
        expect(reach.denyPluginsRoot).toBe(true);
        expect(reach.allowRead).toEqual(expect.arrayContaining([root, join(root, "data")]));
        for (const name of ["SMOKE_VENDOR_DIR", "PLUGIN_ROOT", "PLUGIN_DATA", "ELECTRON_RUN_AS_NODE"]) {
          expect(spec.baseEnv).not.toHaveProperty(name);
          expect(spec.extraEnv).not.toHaveProperty(name);
        }
      } finally {
        sandbox.active = false;
        roots.remove();
      }
    },
  );

  it("refuses a process launch with the sandbox off before anything is spawned", async () => {
    const roots = spawnableRoots();
    spawnConfinedChild.mockClear();
    try {
      const refused = await attempt(processLaunch(roots.context.pluginRoot!), PROCESS_MANIFEST, roots);
      expect(refused).toBeInstanceOf(ProcessEntryUnconfinedError);
      expect(refused).toMatchObject({ code: "process-entry-unconfined" });
      expect(spawnConfinedChild).not.toHaveBeenCalled();
    } finally {
      roots.remove();
    }
  });

  it("refuses a process launch on Windows even with the sandbox on, before anything is spawned", async () => {
    const roots = spawnableRoots();
    spawnConfinedChild.mockClear();
    sandbox.active = true;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const refused = await attempt(processLaunch(roots.context.pluginRoot!), PROCESS_MANIFEST, roots);
      expect(refused).toBeInstanceOf(ProcessEntryUnconfinedError);
      expect(spawnConfinedChild).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
      sandbox.active = false;
      roots.remove();
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a resolved command path containing '=' before the spawn, naming the path",
    async () => {
      const roots = spawnableRoots();
      const root = join(roots.context.pluginRoot!, "a=b");
      spawnConfinedChild.mockClear();
      sandbox.active = true;
      try {
        const refused = await attempt(processLaunch(root), PROCESS_MANIFEST, roots);
        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).message).toContain(`'${join(root, "bin", "plugin")}' contains '='`);
        expect(spawnConfinedChild).not.toHaveBeenCalled();
      } finally {
        sandbox.active = false;
        roots.remove();
      }
    },
  );

  it("keeps an entry launch on the reference runtime, as Node", async () => {
    const roots = spawnableRoots();
    spawnConfinedChild.mockClear();
    try {
      await attempt({ kind: "entry", entryPath: join(tmpdir(), "never-imported.mjs") }, MANIFEST, roots);
      expect(spawnConfinedChild).toHaveBeenCalledTimes(1);
      const spec = spawnConfinedChild.mock.calls[0]![0] as { command: string; baseEnv: NodeJS.ProcessEnv };
      expect(spec.command).toBe(process.execPath);
      expect(spec.baseEnv.ELECTRON_RUN_AS_NODE).toBe("1");
    } finally {
      roots.remove();
    }
  });
});

/**
 * Windows: `srt-win exec` takes denies only, so the child's own directories
 * are an ACL grant to the shared `srt-sandbox` account, held against a holder
 * process for exactly the child's lifetime (§9.8 A2, decision 64). These cases
 * pin the wiring — what is granted, that it precedes the spawn, that every way
 * the child ends releases it, that a lost holder stops the child, and that a
 * grant reaching a neighbour is refused. Whether the ACL then admits the child
 * is the my-window measurement's question, not this file's.
 */
describe("on Windows a confined child holds a grant on its own directories for exactly its lifetime", () => {
  type FakeChild = EventEmitter & {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };

  function fakeChild(opts: { readonly pid?: number } = { pid: 4242 }): FakeChild {
    const { pid } = opts;
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    });
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      setImmediate(() => end(child, null, signal));
      return true;
    });
    return child;
  }

  function end(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  }

  /**
   * An `<AVE_HOME>` laid out as production lays it out: the child runs from
   * its generation under `plugins/.cache/<id>/` and keeps its data, sockets and
   * worker run dir under `plugins/<id>/`.
   */
  function aveLayout(pluginRootFor: (pluginsRoot: string) => string = (p) => join(p, ".cache", PLUGIN_ID, "g1")) {
    const home = mkdtempSync(join(tmpdir(), "oop-win-grant-"));
    const pluginsRoot = join(home, "plugins");
    const own = join(pluginsRoot, PLUGIN_ID);
    const context: Partial<PluginRuntimeContext> = {
      pluginRoot: pluginRootFor(pluginsRoot),
      pluginDataDir: join(own, "data"),
      pluginSocketDir: join(own, "sockets"),
    };
    return { home, pluginsRoot, own, context };
  }

  async function asWindows(
    layout: ReturnType<typeof aveLayout>,
    run: () => Promise<void>,
    opts: { readonly sandboxActive?: boolean } = {},
  ): Promise<void> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const previousHome = process.env.AVE_HOME;
    windowsGrant.calls.length = 0;
    windowsGrant.events.length = 0;
    windowsGrant.lost.length = 0;
    windowsGrant.alive = true;
    spawnConfinedChild.mockReset();
    sandbox.active = opts.sandboxActive ?? true;
    fakeSandboxHome.on = true;
    process.env.AVE_HOME = layout.home;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await run();
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (previousHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previousHome;
      fakeSandboxHome.on = false;
      sandbox.active = false;
      spawnConfinedChild.mockReset();
      rmSync(layout.home, { recursive: true, force: true });
    }
  }

  function construct(layout: ReturnType<typeof aveLayout>): Promise<unknown> {
    const factory = createOutOfProcessPluginFactory({
      manifest: MANIFEST,
      launch: { kind: "entry", entryPath: join(tmpdir(), "never-imported.mjs") },
    });
    return Promise.resolve(factory(hostContext(fakeHostApi(), layout.context))).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("grants the envelope and the throwaway HOME before the spawn, and releases it when the child exits", async () => {
    const layout = aveLayout();
    await asWindows(layout, async () => {
      spawnConfinedChild.mockImplementation(async () => {
        windowsGrant.events.push("spawn");
        const child = fakeChild();
        setImmediate(() => end(child, 1, null));
        return { child, confinement: "windows-srt" };
      });
      const outcome = await construct(layout);
      expect(outcome).toBeInstanceOf(Error);
      expect(windowsGrant.calls).toHaveLength(1);
      const grant = windowsGrant.calls[0]!;
      expect(grant.label).toBe(`plugin-child:${PLUGIN_ID}:asrt-win-acl`);
      const { pluginRoot, pluginDataDir } = layout.context;
      const sockets = join(layout.own, "sockets");
      const run = join(layout.own, "run");
      const home = grant.allowRead.at(-1)!;
      expect(home).toContain("oop-fake-sandbox-home-");
      expect([...grant.allowRead].sort()).toEqual([pluginRoot, pluginDataDir, sockets, run, home].sort());
      // Write is the envelope's write and the HOME: never the generation, and
      // never the worker run dir the host binds into.
      expect([...grant.allowWrite].sort()).toEqual([pluginDataDir, sockets, home].sort());
      expect(windowsGrant.events).toEqual(["grant", "spawn", "release"]);
    });
  });

  it("grants only the outermost envelope roots: a root nested in another is never named to the ACL", async () => {
    // A runtime root that holds `data/`, `sockets/` and `run/` makes those three
    // nested read roots. Each is a path below a root the grant already covers by
    // inheritance, and naming one would stamp the ACE on whatever that path
    // resolves to at grant time — which, for anything below a root a previous
    // child could write, need not be the directory the host made.
    const layout = aveLayout((pluginsRoot) => join(pluginsRoot, PLUGIN_ID));
    await asWindows(layout, async () => {
      spawnConfinedChild.mockImplementation(async () => {
        const child = fakeChild();
        setImmediate(() => end(child, 1, null));
        return { child, confinement: "windows-srt" };
      });
      const outcome = await construct(layout);
      expect(outcome).toBeInstanceOf(Error);
      expect(windowsGrant.calls).toHaveLength(1);
      const grant = windowsGrant.calls[0]!;
      const home = grant.allowRead.at(-1)!;
      expect(home).toContain("oop-fake-sandbox-home-");
      expect(grant.allowRead).toEqual([layout.own, home]);
      expect(grant.allowWrite).toEqual([layout.context.pluginDataDir, join(layout.own, "sockets"), home]);
    });
  });

  it("releases the grant when the spawn fails after it was taken, and the spawn is gated on the holder", async () => {
    const layout = aveLayout();
    await asWindows(layout, async () => {
      spawnConfinedChild.mockImplementation(async (spec: { assertStillValid?: () => void }) => {
        windowsGrant.events.push("spawn");
        spec.assertStillValid?.();
        windowsGrant.alive = false;
        spec.assertStillValid?.();
        throw new Error("unreachable: the holder check above throws");
      });
      const outcome = await construct(layout);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("holder gone");
      expect(windowsGrant.events).toEqual(["grant", "spawn", "release"]);
    });
  });

  it("releases the grant when the spawn produced no process", async () => {
    const layout = aveLayout();
    await asWindows(layout, async () => {
      spawnConfinedChild.mockImplementation(async () => {
        windowsGrant.events.push("spawn");
        const child = fakeChild({});
        setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
        return { child, confinement: "windows-srt" };
      });
      const outcome = await construct(layout);
      expect(outcome).toBeInstanceOf(Error);
      expect(windowsGrant.events).toEqual(["grant", "spawn", "release"]);
    });
  });

  it("stops the child when its holder is lost, and the exit then releases the grant", async () => {
    const layout = aveLayout();
    let spawned: FakeChild | undefined;
    await asWindows(layout, async () => {
      spawnConfinedChild.mockImplementation(async () => {
        windowsGrant.events.push("spawn");
        spawned = fakeChild();
        setImmediate(() => {
          for (const listener of windowsGrant.lost) listener(new Error("holder exited"));
        });
        return { child: spawned, confinement: "windows-srt" };
      });
      const outcome = await construct(layout);
      expect(outcome).toBeInstanceOf(Error);
      expect(spawned!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(windowsGrant.events).toEqual(["grant", "spawn", "release"]);
    });
  });

  it("refuses a grant that reaches a neighbour's directory, before anything is granted or spawned", async () => {
    const layout = aveLayout((pluginsRoot) => join(pluginsRoot, "neighbour"));
    await asWindows(layout, async () => {
      const outcome = await construct(layout);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("refusing a Windows grant beyond the plugin's own roots");
      expect((outcome as Error).message).toContain(join(layout.pluginsRoot, "neighbour"));
      expect(windowsGrant.calls).toHaveLength(0);
      expect(spawnConfinedChild).not.toHaveBeenCalled();
    });
  });

  it("makes no grant with the sandbox off: the child is not confined, so there is no account to grant", async () => {
    const layout = aveLayout();
    await asWindows(
      layout,
      async () => {
        spawnConfinedChild.mockImplementation(async () => {
          const child = fakeChild();
          setImmediate(() => end(child, 1, null));
          return { child, confinement: "unconfined" };
        });
        await construct(layout);
        expect(spawnConfinedChild).toHaveBeenCalledTimes(1);
        expect(windowsGrant.calls).toHaveLength(0);
      },
      { sandboxActive: false },
    );
  });

  /**
   * The sandboxed Windows channel (`child-loopback-link.ts`): the fake child
   * runs the REAL child half — `acceptHostOverLoopback` announcing on the
   * fake's stdout, then `servePluginChild` over the accepted socket — so the
   * host's half is exercised against what the child actually does. Whether
   * srt-win admits the connection is the my-window measurement's question.
   */
  function loopbackChild(opts: { readonly onAnnounce?: (port: number) => void } = {}) {
    return async (spec: { args: string[] }) => {
      windowsGrant.events.push("spawn");
      const child = fakeChild();
      const entryAt = spec.args.indexOf(spec.args.find((arg) => !arg.startsWith("--"))!);
      const mode = parseChildLaunchArgs(spec.args.slice(entryAt + 1));
      if (mode.transport !== "loopback") throw new Error("expected the loopback launch");
      void acceptHostOverLoopback({
        announce: (line) => {
          opts.onAnnounce?.(Number(line.split(" ")[1]));
          child.stdout.write(line);
        },
        acceptTimeoutMs: 5_000,
        handshakeTimeoutMs: 5_000,
      }).then((socket) => {
        const service = servePluginChild(socket, socket);
        socket.resume();
        socket.on("close", () => {
          service.hostGone();
          end(child, 0, null);
        });
      }, () => end(child, 1, null));
      return { child, confinement: "windows-srt" };
    };
  }

  it("launches through cmd with ELECTRON_RUN_AS_NODE on the line, the symlink flags, and its environment as one argument", async () => {
    const layout = aveLayout();
    await asWindows(layout, async () => {
      spawnConfinedChild.mockImplementation(async () => {
        const child = fakeChild();
        setImmediate(() => end(child, 1, null));
        return { child, confinement: "windows-srt" };
      });
      await construct(layout);
      const spec = spawnConfinedChild.mock.calls[0]![0] as {
        command: string;
        args: string[];
        windowsShell?: string;
        windowsCommandLineEnv?: Record<string, string>;
        extraEnv: Record<string, string>;
      };
      expect(spec.command).toBe(process.execPath);
      expect(spec.windowsShell).toBe("cmd");
      expect(spec.windowsCommandLineEnv).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
      expect(spec.args.slice(0, 2)).toEqual(["--preserve-symlinks", "--preserve-symlinks-main"]);
      expect(spec.args[3]).toBe(CHILD_LOOPBACK_TRANSPORT_ARG);
      const mode = parseChildLaunchArgs(spec.args.slice(3));
      if (mode.transport !== "loopback") throw new Error("expected the loopback launch");
      // The throwaway HOME the wrap could not deliver travels in the argument;
      // what srt-win sets itself, or only the command line can carry, does not.
      expect(mode.env.HOME).toBe(spec.extraEnv.HOME);
      for (const name of ["PATH", "PATHEXT", "TMPDIR", "ELECTRON_RUN_AS_NODE"]) {
        expect(mode.env).not.toHaveProperty(name);
      }
    });
  });

  it("serves a tool call over the authenticated loopback channel, then stops, releases, and leaves no listener", async () => {
    const layout = aveLayout();
    const { dir, entryPath } = writePluginModule();
    let port = 0;
    try {
      await asWindows(layout, async () => {
        spawnConfinedChild.mockImplementation(loopbackChild({ onAnnounce: (announced) => (port = announced) }));
        const factory = createOutOfProcessPluginFactory({ manifest: MANIFEST, launch: { kind: "entry", entryPath } });
        const instance = await factory(hostContext(fakeHostApi(), layout.context));
        const echoed = (await instance.handlers.pilot_echo!({ text: "over loopback" })) as { payload: unknown };
        expect(echoed.payload).toEqual({ text: "over loopback" });
        await instance.stop?.();
        await vi.waitFor(() => expect(windowsGrant.events).toEqual(["grant", "spawn", "release"]));
        expect(port).toBeGreaterThan(0);
        const refused = await new Promise<string>((resolve) => {
          const probe = connect({ host: "127.0.0.1", port });
          probe.once("connect", () => {
            probe.destroy();
            resolve("connected");
          });
          probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
        });
        expect(refused).toBe("ECONNREFUSED");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a child whose stdout says anything before its announce, ends it, and releases the grant", async () => {
    const layout = aveLayout();
    await asWindows(layout, async () => {
      let spawned: FakeChild | undefined;
      spawnConfinedChild.mockImplementation(async () => {
        windowsGrant.events.push("spawn");
        spawned = fakeChild();
        setImmediate(() => spawned!.stdout.write("AVE-CHILD-LISTEN 1 not-a-nonce\n"));
        return { child: spawned, confinement: "windows-srt" };
      });
      const outcome = await construct(layout);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("something other than its announce");
      expect(spawned!.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.waitFor(() => expect(windowsGrant.events).toEqual(["grant", "spawn", "release"]));
    });
  });

  /**
   * A child that runs the real child half and serves the plugin, but whose
   * process is dead — `when` says how far its death got: `"before-return"`
   * exits and emits `exit` before the launch hands it back; `"at-accept"` has
   * its exit code set the moment it accepts the host, its `exit` not yet
   * delivered. Either way its listener and channel stay up, as a process tree
   * that outlives the one the host watches would leave them.
   */
  function deadLoopbackChild(when: "before-return" | "at-accept", served: { count: number }) {
    return async (spec: { args: string[] }) => {
      windowsGrant.events.push("spawn");
      const child = fakeChild();
      const entryAt = spec.args.indexOf(spec.args.find((arg) => !arg.startsWith("--"))!);
      const mode = parseChildLaunchArgs(spec.args.slice(entryAt + 1));
      if (mode.transport !== "loopback") throw new Error("expected the loopback launch");
      void acceptHostOverLoopback({
        announce: (line) => child.stdout.write(line),
        acceptTimeoutMs: 5_000,
        handshakeTimeoutMs: 5_000,
      }).then((socket) => {
        if (when === "at-accept") {
          child.exitCode = 3;
          setTimeout(() => {
            child.exitCode = null;
            end(child, 3, null);
          }, 150);
        }
        served.count += 1;
        servePluginChild(socket, socket);
        socket.resume();
      }, () => undefined);
      if (when === "before-return") end(child, 3, null);
      return { child, confinement: "windows-srt" };
    };
  }

  it.each(["before-return", "at-accept"] as const)(
    "does not serve a plugin from a child that is already dead (%s): the load fails with its exit and the grant is released",
    async (when) => {
      const layout = aveLayout();
      const { dir, entryPath } = writePluginModule();
      const served = { count: 0 };
      try {
        await asWindows(layout, async () => {
          spawnConfinedChild.mockImplementation(deadLoopbackChild(when, served));
          const factory = createOutOfProcessPluginFactory({ manifest: MANIFEST, launch: { kind: "entry", entryPath } });
          const outcome = await Promise.resolve(factory(hostContext(fakeHostApi(), layout.context))).then(
            () => "constructed",
            (error: unknown) => error,
          );
          expect(outcome).toBeInstanceOf(Error);
          expect((outcome as Error).message).toContain(`${PLUGIN_ID}: child exited code=3`);
          await vi.waitFor(() => expect(windowsGrant.events).toEqual(["grant", "spawn", "release"]));
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("refuses a sandboxed Windows launch that came back unwrapped", async () => {
    const layout = aveLayout();
    await asWindows(layout, async () => {
      spawnConfinedChild.mockImplementation(async () => ({ child: fakeChild(), confinement: "unconfined" }));
      const outcome = await construct(layout);
      expect((outcome as Error).message).toContain("came back 'unconfined', not 'windows-srt'");
    });
  });

  it("runs the real child entry over loopback: the argument's environment applies, stdin's end is not the host leaving, and the channel's end is", async () => {
    // The production child, as a real process from the same binary, launched
    // the way the sandboxed Windows spawn launches it — minus srt-win, which
    // this host does not have. Its stdin ends at once, as srt-win's does.
    const dir = mkdtempSync(join(tmpdir(), "oop-loopback-real-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(
      entryPath,
      `export const createPlugin = async () => ({
  handlers: { probe_env: async () => process.env.CHILD_ENV_PROBE ?? null },
});
`,
    );
    const child = spawnProcess(
      process.execPath,
      [pluginChildEntryPath(), CHILD_LOOPBACK_TRANSPORT_ARG, encodeChildEnv({ CHILD_ENV_PROBE: "from the argument" })],
      { env: { ...buildSafeChildEnv(), ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin!.end();
    const exited = new Promise<string>((resolve) => child.once("exit", (code) => resolve(`code=${String(code)}`)));
    try {
      const socket = await connectToAnnouncedChild({ stdout: child.stdout!, exited, timeoutMs: 20_000 });
      // Windows resets a loopback connection whose peer exits; the production
      // link logs that, and so must this one rather than throw it.
      socket.on("error", () => undefined);
      const link: ChildLink = {
        input: socket,
        output: socket,
        terminate: () => socket.destroy(),
        onGone: (handler) => void exited.then(handler),
        onFault: () => undefined,
      };
      const manifest: PluginManifest = {
        ...MANIFEST,
        tools: [{ name: "probe_env", description: "read the child's environment", inputSchema: EMPTY_SCHEMA }],
      };
      const instance = await sessionFactory({ manifest, entryPath, link })(hostContext(fakeHostApi()));
      await expect(instance.handlers.probe_env!()).resolves.toBe("from the argument");
      socket.end();
      await expect(exited).resolves.toBe("code=0");
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("makes no ACL grant off Windows, where the wrap carries the allow-list", async () => {
    const layout = aveLayout();
    const previousHome = process.env.AVE_HOME;
    windowsGrant.calls.length = 0;
    spawnConfinedChild.mockReset();
    spawnConfinedChild.mockImplementation(async () => {
      const child = fakeChild();
      setImmediate(() => end(child, 1, null));
      return { child, confinement: "wrapped" };
    });
    sandbox.active = true;
    process.env.AVE_HOME = layout.home;
    try {
      await construct(layout);
      expect(spawnConfinedChild).toHaveBeenCalledTimes(1);
      expect(windowsGrant.calls).toHaveLength(0);
    } finally {
      sandbox.active = false;
      if (previousHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previousHome;
      spawnConfinedChild.mockReset();
      rmSync(layout.home, { recursive: true, force: true });
    }
  });
});

/**
 * The way out for a `userChosenDirectory` value stored as `~/…` (§9.8 A1, "The
 * resolver's guidance"; decision 54). The host expands `~` nowhere, so the
 * grant is refused at spawn and the plugin does not load; the refusal names
 * the one action that helps, and both ways out load. A restart invokes the
 * factory again with the incarnation's config, which is what the second and
 * third invocations below are. The spawn is the real one, unwrapped as the
 * sandbox reads off here, so "loads" means a child answered a tool call.
 */
describe("a stored '~/…' directory value: refused with guidance, and both ways out load", () => {
  it("fails construction with no child, then loads from an approved absolute path, then with the value cleared", async () => {
    const actual = await vi.importActual<typeof import("../../../permissions/confined-child.js")>(
      "../../../permissions/confined-child.js",
    );
    const root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "oop-tilde-"));
    const previousHome = process.env.AVE_HOME;
    const home = join(root, "home");
    const approved = join(root, "approved");
    const pluginRoot = join(home, "plugins", "tilde-cache");
    const pluginDataDir = join(pluginRoot, "data");
    mkdirSync(home, { recursive: true });
    mkdirSync(approved, { recursive: true });
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [approved] } }));
    const entryPath = join(pluginRoot, "plugin.mjs");
    writeFileSync(
      entryPath,
      `export default async function createPlugin(context) {
  return { handlers: { cache_where: async () => context.hostApi.config.get("dataDirectory") ?? null } };
}
`,
      "utf-8",
    );
    const manifest: PluginManifest = {
      id: "tilde-cache",
      name: "Tilde Cache",
      version: "1.0.0",
      entry: "plugin.mjs",
      requires: { hostProtocol: "3" },
      description: "keeps a cache in a directory the user chooses",
      sandbox: { write: [{ kind: "userChosenDirectory", configKey: "dataDirectory", why: "where the cache is written" }] },
      tools: [{ name: "cache_where", description: "name the cache directory", inputSchema: EMPTY_SCHEMA }],
    };
    const confinements: string[] = [];
    const factory = createOutOfProcessPluginFactory({
      manifest,
      childEntryPath: pluginChildEntryPath(),
      launch: { kind: "entry", entryPath },
      onChildSpawned: (confinement) => confinements.push(confinement),
    });
    const hostApi = fakeHostApi();
    // The stored value as both halves of an incarnation hold it: the host's
    // `config.get`, which the envelope derivation reads, and the construction
    // snapshot the child is given.
    const storeAndContext = (dataDirectory: string): PluginRuntimeContext => {
      hostApi.setHostConfig("dataDirectory", dataDirectory);
      return hostContext(hostApi, {
        pluginId: manifest.id,
        pluginRoot,
        pluginDataDir,
        pluginSocketDir: join(pluginDataDir, "sockets"),
        config: { dataDirectory },
      });
    };
    process.env.AVE_HOME = home;
    spawnConfinedChild.mockReset();
    spawnConfinedChild.mockImplementation(actual.spawnConfinedChild);
    const loaded: RuntimePlugin[] = [];
    try {
      const refused = await Promise.resolve(factory(storeAndContext("~/ave-git-cache"))).then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(PluginSandboxGrantError);
      expect((refused as Error).message).toBe(
        "[out-of-process-plugin] tilde-cache: cannot widen the child's envelope for config key 'dataDirectory': "
          + "'~/ave-git-cache' is not an absolute path — the host cannot resolve a relative value, because "
          + "the directory it would be relative to is the plugin's to choose; "
          + "enter an approved absolute directory for 'dataDirectory', or clear the setting",
      );
      expect(spawnConfinedChild).not.toHaveBeenCalled();
      expect(confinements).toEqual([]);

      const fromApproved = await factory(storeAndContext(approved));
      loaded.push(fromApproved);
      await expect(fromApproved.handlers.cache_where!()).resolves.toBe(approved);
      expect(spawnConfinedChild).toHaveBeenCalledTimes(1);
      await fromApproved.stop?.();
      loaded.length = 0;

      const cleared = await factory(storeAndContext(""));
      loaded.push(cleared);
      await expect(cleared.handlers.cache_where!()).resolves.toBe("");
      expect(spawnConfinedChild).toHaveBeenCalledTimes(2);
      // The approved value was granted to its child; with the value cleared no
      // grant was asked for, so the approved directory is not writable.
      const writes = spawnConfinedChild.mock.calls.map(([spec]) => (spec as { allowWrite?: readonly string[] }).allowWrite ?? []);
      expect(writes[0]).toContain(approved);
      expect(writes[1]).not.toContain(approved);
      expect(confinements).toEqual(["unconfined", "unconfined"]);
    } finally {
      for (const instance of loaded) await instance.stop?.();
      spawnConfinedChild.mockReset();
      if (previousHome === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a ui:// card is MCP resources/read", () => {
  const CARD = "ui://sampleassistant/card";

  it("reads the card through the child's MCP server when the manifest declares it", async () => {
    const { dir, entryPath } = writeModule(
      "oop-plugin-card-",
      "export const createPlugin = async () => ({\n"
        + "  handlers: {},\n"
        + "  readUiResource: async (uri) => `<p>${uri}</p>`,\n"
        + "});\n",
    );
    const { child } = pairedChild();
    const sent = hostFrames(child.link);
    try {
      const factory = sessionFactory({
        manifest: { ...MANIFEST, uiResources: [{ uri: CARD }] },
        entryPath,
        link: child.link,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      await expect(instance.readUiResource?.(CARD)).resolves.toBe(`<p>${CARD}</p>`);
      expect(sent.some((frame) => frame.method === "resources/read")).toBe(true);
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offers no read when the manifest declares no card, even if the plugin has the hook", async () => {
    const { dir, entryPath } = writeModule(
      "oop-plugin-nocard-",
      "export const createPlugin = async () => ({\n"
        + "  handlers: {},\n"
        + "  readUiResource: async (uri) => `<p>${uri}</p>`,\n"
        + "});\n",
    );
    const { child } = pairedChild();
    try {
      const factory = sessionFactory({
        manifest: MANIFEST,
        entryPath,
        link: child.link,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      // The child's server would refuse the read, so the host is not handed a
      // hook that can only fail.
      expect(instance.readUiResource).toBeUndefined();
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("onShutdown runs through ave/instance/shutdown", () => {
  /** A plugin whose shutdown handler finishes only when `pilot_echo` releases it. */
  const HELD_SHUTDOWN = `export const createPlugin = async (context) => {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  context.hostApi.onShutdown(async () => { await released; });
  return { handlers: { pilot_echo: async () => { release(); return {}; } } };
};
`;

  async function constructHeld(): Promise<{
    dir: string;
    instance: RuntimePlugin;
    runShutdown: () => Promise<void>;
    terminate: ReturnType<typeof vi.fn>;
  }> {
    const { dir, entryPath } = writeModule("oop-plugin-shutdown-", HELD_SHUTDOWN);
    const { child } = pairedChild();
    const terminate = vi.fn(child.link.terminate);
    const hostApi = fakeHostApi();
    const factory = sessionFactory({
      manifest: MANIFEST,
      entryPath,
      link: { ...child.link, terminate },
    });
    const instance = await factory(hostContext(hostApi));
    await vi.waitFor(() => expect(hostApi.onShutdown).toHaveBeenCalledTimes(1));
    const handler = vi.mocked(hostApi.onShutdown).mock.calls[0]![0];
    return { dir, instance, runShutdown: async () => await handler(), terminate };
  }

  it("makes the host wait for the plugin's handler to finish", async () => {
    const { dir, instance, runShutdown } = await constructHeld();
    try {
      let finished = false;
      const shutdown = runShutdown().then(() => {
        finished = true;
      });
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(finished).toBe(false);
      await instance.handlers.pilot_echo!({});
      await shutdown;
      expect(finished).toBe(true);
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills the child whose handler overruns the shutdown bound, after the runner's timeout", async () => {
    const { dir, instance, runShutdown, terminate } = await constructHeld();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { pluginShutdownHandlerMs, pluginShutdownKillGraceMs } = TOOL_TIMEOUT_POLICY;
      let settled = false;
      const shutdown = runShutdown().finally(() => {
        settled = true;
      });
      const outcome = expect(shutdown).rejects.toThrow(
        `exceeded ${String(pluginShutdownHandlerMs + pluginShutdownKillGraceMs)}ms`,
      );
      // The host's shutdown runner times the handler out at this bound. The
      // child must still be alive and the request still open here, or the
      // transport's error would race the runner's for the report.
      await vi.advanceTimersByTimeAsync(pluginShutdownHandlerMs);
      expect(settled).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(pluginShutdownKillGraceMs);
      await outcome;
      expect(terminate).toHaveBeenCalledTimes(1);
      // The transport is closed with it, so nothing else waits on this child.
      await expect(instance.handlers.pilot_echo!({})).rejects.toThrow(
        /'ave\/instance\/shutdown' timed out/,
      );
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
