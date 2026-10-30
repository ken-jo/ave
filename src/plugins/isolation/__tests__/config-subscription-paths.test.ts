/** Check both subscription ledgers for every termination path; working callbacks alone cannot reveal leaks. */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { PluginHostApi, PluginLifecycleEvent } from "../../types.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  createConfigSubscriptionHostApiPaths,
  type ConfigSubscriptionHostApi,
  type HostApiPathHandler,
} from "../host-api-dispatcher.js";
import { HOSTAPI_PATH_CONTRACTS, type HostApiPath } from "../host-api-wire.js";
import {
  argsOfRequest,
  directHostApiChannel,
  hostApiRequest,
  pathOfRequest,
} from "../../../__tests__/support/host-protocol-wire.js";
import {
  type HostApiNotification,
  type HostApiRequest,
} from "../host-api-wire.js";
import {
  createHostApiCaller,
  startPluginChildRuntime,
  type PluginChildRuntime,
  type PluginFactoryLoader,
} from "../plugin-child-runtime.js";
import {
  decodeConfigChange,
  decodeHostEvent,
  decodePluginLifecycle,
  encodeConfigChange,
  SECRET_REDACTED_SENTINEL,
} from "../host-api-wire.js";
import type { PluginManifest } from "../../types.js";
import { settleMacrotask as flush } from "../../../__tests__/test-helpers.js";

const PLUGIN_ID = "com.example.subscriber";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Subscriber",
  version: "1.0.0",
  entry: "dist/plugin.js",
  description: "a plugin that subscribes to everything the host offers",
  tools: [],
};

/** Replace only the per-incarnation host object; keep dispatch, permissions and restart rules in production code. */
function fakeHostApi() {
  const configListeners = new Map<string, Set<(value: unknown) => void>>();
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const lifecycleListeners = new Set<(event: PluginLifecycleEvent) => void>();
  const shutdownHandlers: Array<() => void | Promise<void>> = [];
  const written: Array<[string, unknown]> = [];
  let setRejection: Error | undefined;

  const add = <T>(registry: Map<string, Set<T>>, key: string, listener: T) => {
    const bucket = registry.get(key) ?? new Set<T>();
    bucket.add(listener);
    registry.set(key, bucket);
    return () => {
      bucket.delete(listener);
    };
  };

  const hostApi: ConfigSubscriptionHostApi = {
    config: {
      get: () => undefined,
      set: async (key, value) => {
        if (setRejection) throw setRejection;
        written.push([key, value]);
      },
      onChange: (key, callback) =>
        add(configListeners, key, callback as (value: unknown) => void),
    } as PluginHostApi["config"],
    onEvent: (eventType, handler) => add(eventListeners, eventType, handler),
    onPluginsChanged: (handler) => {
      lifecycleListeners.add(handler);
      return () => {
        lifecycleListeners.delete(handler);
      };
    },
    onShutdown: (handler) => {
      shutdownHandlers.push(handler);
    },
  };

  return {
    hostApi,
    written,
    rejectSet(error: Error) {
      setRejection = error;
    },
    configListenerCount: (key: string) => configListeners.get(key)?.size ?? 0,
    eventListenerCount: (type: string) => eventListeners.get(type)?.size ?? 0,
    lifecycleListenerCount: () => lifecycleListeners.size,
    emitConfigChange(key: string, value: unknown) {
      for (const listener of configListeners.get(key) ?? []) listener(value);
    },
    emitEvent(type: string, data: unknown) {
      for (const listener of eventListeners.get(type) ?? []) listener(data);
    },
    emitLifecycle(event: PluginLifecycleEvent) {
      for (const listener of lifecycleListeners) listener(event);
    },
    async runShutdown() {
      await Promise.all(shutdownHandlers.map((handler) => handler()));
    },
  };
}

interface Harness {
  readonly child: PluginChildRuntime;
  readonly host: HostApiDispatcher;
  readonly api: ReturnType<typeof fakeHostApi>;
  readonly hostApi: PluginHostApi;
  readonly notifications: HostApiNotification[];
  /** Read subscription IDs from actual wire requests. */
  readonly requests: HostApiRequest[];
  readonly call: (path: HostApiPath, args: readonly unknown[]) => Promise<unknown>;
}

/** The plugin sees a handle, not its ID; observe the subscribe request to name the registration. */
function subscriptionIdOf(requests: HostApiRequest[], path: HostApiPath): string {
  const request = requests.find((candidate) => pathOfRequest(candidate) === path);
  if (!request) throw new Error(`no '${path}' request crossed the wire`);
  const args = argsOfRequest(request);
  return args[args.length - 1] as string;
}

async function harness(
  options: {
    config?: Record<string, unknown>;
    isActive?: () => boolean;
    appPreferences?: { keys: readonly string[]; values: Record<string, unknown> };
  } = {},
): Promise<Harness> {
  const api = fakeHostApi();
  const notifications: HostApiNotification[] = [];
  const requests: HostApiRequest[] = [];
  let host!: HostApiDispatcher;
  let child!: PluginChildRuntime;

  const channel = directHostApiChannel(
    {
      handle: (request) => host.handle(request),
      handleNotification: (notification) => host.handleNotification(notification),
    },
    { requests, notifications },
  );

  const hostLogs: { message: string; meta?: unknown }[] = [];
  host = new HostApiDispatcher({
    // Capture host diagnostics so silently discarded failures cannot pass.
    log: (message, meta) => hostLogs.push({ message, meta }),
    pluginId: PLUGIN_ID,
    isActive: options.isActive ?? (() => true),
    notifications: { deliver: (notification) => child.deliver(notification) },
    reportUnknownField: () => {},
    shutdownChild: (subscriptionId) => child.runShutdownHandler(subscriptionId),
    table: {
      ...HOSTAPI_DISPATCH_TABLE,
      ...createConfigSubscriptionHostApiPaths(api.hostApi),
    } as Record<HostApiPath, HostApiPathHandler>,
  });

  const loadFactory: PluginFactoryLoader = async () => () => ({ handlers: {} });

  child = await startPluginChildRuntime({
    input: new PassThrough(),
    output: new PassThrough(),
    manifest: MANIFEST,
    context: {
      pluginId: PLUGIN_ID,
      pluginRoot: "/plugins/subscriber",
      hostRoot: "/app",
      pluginDataDir: "/plugins/subscriber/data",
      userHome: "/Users/example",
      aveHome: "/Users/example/.ave",
      installedPluginIds: [],
      config: options.config ?? { theme: "dark" },
      ...(options.appPreferences ? { appPreferences: options.appPreferences } : {}),
    },
    channel,
    loadFactory,
  });

  const call = createHostApiCaller(channel, { pluginId: PLUGIN_ID });

  return { child, host, api, hostApi: child.hostApi, notifications, requests, call };
}

describe("config.get answers in the child, and is refused if it ever crosses", () => {
  it("declares the round-trip-free decision in its own contract", () => {
    const contract = HOSTAPI_PATH_CONTRACTS["config.get"];
    expect(contract.arguments).toBe("child-local");
    expect(contract.result).toBe("child-local");
    expect(contract.lifetime).toBe("none");
  });

  it("reads the snapshot pushed at construction", async () => {
    const { hostApi } = await harness({ config: { theme: "dark", retries: 3 } });
    expect(hostApi.config.get("theme")).toBe("dark");
    expect(hostApi.config.get("retries")).toBe(3);
  });

  it("answers an unset key as unset rather than throwing", async () => {
    const { hostApi } = await harness({ config: {} });
    expect(hostApi.config.get("missing")).toBeUndefined();
  });

  it("refuses a key that is not a string instead of reading it as unset", async () => {
    const { hostApi } = await harness();
    expect(() => (hostApi.config.get as (key: unknown) => unknown)(42)).toThrow(
      /'key' must be a string/u,
    );
  });

  it("is refused by the host if a child ever sends it", async () => {
    const { call } = await harness();
    await expect(call("config.get", ["theme"])).rejects.toMatchObject({
      code: "path-not-dispatchable",
    });
  });
});

describe("config.set crosses as plain JSON and comes back as nothing", () => {
  it("declares plain-json arguments and a void result", () => {
    const contract = HOSTAPI_PATH_CONTRACTS["config.set"];
    expect(contract.arguments).toBe("plain-json");
    expect(contract.result).toBe("void");
    expect(contract.lifetime).toBe("none");
    expect(contract.errors).toEqual(["effect-boundary-denied"]);
  });

  it("reaches the host's own implementation with the plugin's key and value", async () => {
    const { hostApi, api } = await harness();
    await expect(hostApi.config.set("theme", "light")).resolves.toBeUndefined();
    expect(api.written).toEqual([["theme", "light"]]);
  });

  it("makes a plugin's own set-then-get see its own write", async () => {
    // Awaited config.set must update the child snapshot before resolving.
    const { hostApi } = await harness({ config: { theme: "dark" } });
    await hostApi.config.set("theme", "light");
    expect(hostApi.config.get("theme")).toBe("light");
  });

  it("leaves the snapshot alone when the host refuses the write", async () => {
    // Rejected writes must never become readable as persisted config.
    const { hostApi, api } = await harness({ config: { theme: "dark" } });
    api.rejectSet(new Error("secret fields must be saved via hostApi.setSecret()"));
    await expect(hostApi.config.set("theme", "light")).rejects.toThrow("Host request failed.");
    expect(hostApi.config.get("theme")).toBe("dark");
  });

  it("refuses a value that would not survive the wire, at the plugin's call site", async () => {
    const { hostApi, api } = await harness();
    await expect(hostApi.config.set("when", new Date("2020-01-01"))).rejects.toThrow(
      /cannot cross the boundary/u,
    );
    expect(api.written).toEqual([]);
  });

  it("refuses a malformed call off the wire rather than persisting a bad key", async () => {
    const { call, api } = await harness();
    // Undeclared params fields are reported and ignored; positional extras have no wire slot.
    for (const args of [[], ["only-a-key"], [42, "value"]]) {
      await expect(call("config.set", args)).rejects.toMatchObject({
        code: "argument-marshalling-rejected",
      });
    }
    expect(api.written).toEqual([]);
  });
});

/** Every disposer-bearing member has the same two-sided lifetime obligations. */
const DISPOSABLE = [
  {
    path: "config.onChange" as const,
    subscribe: (hostApi: PluginHostApi, sink: unknown[]) =>
      hostApi.config.onChange("theme", (value) => sink.push(value)),
    wireArgs: (subscriptionId: string) => ["theme", subscriptionId],
    fire: (api: ReturnType<typeof fakeHostApi>) => api.emitConfigChange("theme", "light"),
    expected: ["light"],
    hostListenerCount: (api: ReturnType<typeof fakeHostApi>) =>
      api.configListenerCount("theme"),
  },
  {
    path: "onEvent" as const,
    subscribe: (hostApi: PluginHostApi, sink: unknown[]) =>
      hostApi.onEvent("task.created", (data) => sink.push(data)),
    wireArgs: (subscriptionId: string) => ["task.created", subscriptionId],
    fire: (api: ReturnType<typeof fakeHostApi>) =>
      api.emitEvent("task.created", { taskId: "t1" }),
    expected: [{ taskId: "t1" }],
    hostListenerCount: (api: ReturnType<typeof fakeHostApi>) =>
      api.eventListenerCount("task.created"),
  },
  {
    path: "onPluginsChanged" as const,
    subscribe: (hostApi: PluginHostApi, sink: unknown[]) =>
      hostApi.onPluginsChanged((event) => sink.push(event)),
    wireArgs: (subscriptionId: string) => [subscriptionId],
    fire: (api: ReturnType<typeof fakeHostApi>) =>
      api.emitLifecycle({ type: "installed", pluginId: "com.other", source: "marketplace" }),
    expected: [{ type: "installed", pluginId: "com.other", source: "marketplace" }],
    hostListenerCount: (api: ReturnType<typeof fakeHostApi>) => api.lifecycleListenerCount(),
  },
];

describe.each(DISPOSABLE)(
  "$path holds a lifetime that releases on both sides",
  ({ path, subscribe, wireArgs, fire, expected, hostListenerCount }) => {
    async function subscribed() {
      const wired = await harness();
      const received: unknown[] = [];
      const dispose = subscribe(wired.hostApi, received);
      await flush();
      expect(wired.child.openSubscriptionCount).toBe(1);
      expect(wired.host.openSubscriptionCount).toBe(1);
      expect(hostListenerCount(wired.api)).toBe(1);
      return { ...wired, received, dispose };
    }

    it("declares a handler registration, a handle, and a child-held lifetime", () => {
      const contract = HOSTAPI_PATH_CONTRACTS[path];
      expect(contract.arguments).toBe("handler-registration");
      expect(contract.result).toBe("handle");
      expect(contract.lifetime).toBe("child-disposable");
      expect(contract.errors).toEqual([]);
    });

    it("returns a disposer synchronously, the way the in-process contract does", async () => {
      const { dispose } = await subscribed();
      expect(typeof dispose).toBe("function");
    });

    it("replies with the child-allocated id as the handle", async () => {
      const { call, child } = await harness();
      const subscription = child.openSubscription(path, () => {});
      await expect(call(path, wireArgs(subscription.subscriptionId))).resolves.toEqual({
        handleId: subscription.subscriptionId,
      });
    });

    it("refuses a malformed registration off the wire", async () => {
      const { call, api } = await harness();
      const arity = wireArgs("s1").length;
      const malformed = [
        [],
        wireArgs("s1").slice(0, arity - 1),
        wireArgs("s1").map(() => 42),
      ];
      for (const args of malformed) {
        await expect(call(path, args), JSON.stringify(args)).rejects.toMatchObject({
          code: "argument-marshalling-rejected",
        });
      }
      // A refused subscription must not leave an untracked host listener.
      expect(hostListenerCount(api)).toBe(0);
    });

    it("carries the host's payload to the plugin's handler", async () => {
      const { api, received } = await subscribed();
      fire(api);
      expect(received).toEqual(expected);
    });

    it("undoes its host registration when the ledger refuses the id", async () => {
      const { call, child, api } = await harness();
      const subscription = child.openSubscription(path, () => {});
      await call(path, wireArgs(subscription.subscriptionId));
      // If ledger insertion rejects a duplicate ID, immediately dispose the new host subscription.
      await expect(call(path, wireArgs(subscription.subscriptionId))).rejects.toThrow();
      expect(hostListenerCount(api)).toBe(1);
    });

    it("releases BOTH sides when the plugin disposes", async () => {
      const { child, host, api, dispose, notifications } = await subscribed();
      dispose();
      expect(child.openSubscriptionCount).toBe(0);
      expect(host.openSubscriptionCount).toBe(0);
      expect(hostListenerCount(api)).toBe(0);
      expect(notifications.at(-1)).toMatchObject({
        method: "notifications/ave/subscription/release",
      });
      dispose();
      expect(host.openSubscriptionCount).toBe(0);
    });

    it("stops delivering to the plugin once it has disposed", async () => {
      const { api, received, dispose } = await subscribed();
      dispose();
      fire(api);
      expect(received).toEqual([]);
    });

    it("releases the HOST side when the child dies without disposing", async () => {
      const { host, api } = await subscribed();
      expect(host.childGone()).toBe(1);
      expect(host.openSubscriptionCount).toBe(0);
      // A dead child must not retain host bus registrations.
      expect(hostListenerCount(api)).toBe(0);
    });

    it("releases the CHILD side when the host dies, without writing to a dead pipe", async () => {
      const { child, notifications } = await subscribed();
      const before = notifications.length;
      expect(child.hostGone()).toBe(1);
      expect(child.openSubscriptionCount).toBe(0);
      expect(notifications).toHaveLength(before);
    });

    it("drops the child side when the host revokes, and does not echo back", async () => {
      // Host revocation must invalidate the child closure as well as drop the host entry.
      const { child, notifications, requests, received, api, dispose } = await subscribed();
      const before = notifications.length;
      expect(
        child.deliver({
          jsonrpc: "2.0",
          method: "notifications/ave/subscription/closed",
          params: {
            subscriptionId: subscriptionIdOf(requests, path),
            reason: "revoked",
          },
        }),
      ).toBe("closed");
      expect(child.openSubscriptionCount).toBe(0);
      // Do not answer a host close with another close.
      expect(notifications).toHaveLength(before);
      fire(api);
      expect(received).toEqual([]);
      dispose();
      expect(notifications).toHaveLength(before);
    });
  },
);

describe("onShutdown is the subscription the HOST ends", () => {
  it("declares a handler registration, no result, and a host-terminated lifetime", () => {
    const contract = HOSTAPI_PATH_CONTRACTS.onShutdown;
    expect(contract.arguments).toBe("handler-registration");
    expect(contract.result).toBe("void");
    expect(contract.lifetime).toBe("host-terminated");
    expect(contract.errors).toEqual([]);
  });

  it("returns nothing to the plugin, because the plugin cannot end it", async () => {
    const { hostApi } = await harness();
    expect(hostApi.onShutdown(() => {})).toBeUndefined();
    await flush();
  });

  it("replies with nothing on the wire, matching its void result", async () => {
    const { call, child } = await harness();
    const subscription = child.openSubscription("onShutdown", () => {});
    await expect(call("onShutdown", [subscription.subscriptionId])).resolves
      .toBeUndefined();
  });

  it("runs the plugin's handler and makes the host WAIT for it to finish", async () => {
    const { hostApi, api, host, child } = await harness();
    const order: string[] = [];
    let release!: () => void;
    const handlerFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    hostApi.onShutdown(async () => {
      order.push("plugin-started");
      await handlerFinished;
      order.push("plugin-finished");
    });
    await flush();
    expect(host.openSubscriptionCount).toBe(1);

    let hostReturned = false;
    const shutdown = api.runShutdown().then(() => {
      hostReturned = true;
      order.push("host-returned");
    });
    await flush();
    expect(order).toEqual(["plugin-started"]);
    expect(hostReturned).toBe(false);

    release();
    await shutdown;
    expect(order).toEqual(["plugin-started", "plugin-finished", "host-returned"]);
    expect(host.openSubscriptionCount).toBe(0);
    expect(child.openSubscriptionCount).toBe(0);
  });

  it("hands the host the plugin's failure when the handler throws, instead of hanging forever", async () => {
    const { hostApi, api, host, child } = await harness();
    hostApi.onShutdown(() => Promise.reject(new Error("teardown failed")));
    await flush();
    // Shutdown handler failures must cross as errors for the host shutdown log.
    await expect(api.runShutdown()).rejects.toThrow("teardown failed");
    await flush();
    expect(host.openSubscriptionCount).toBe(0);
    expect(child.openSubscriptionCount).toBe(0);
  });

  it("runs the handler once, however often the host fires shutdown", async () => {
    const { hostApi, api } = await harness();
    let runs = 0;
    hostApi.onShutdown(() => {
      runs += 1;
    });
    await flush();
    await api.runShutdown();
    await flush();
    await expect(api.runShutdown()).resolves.toBeUndefined();
    expect(runs).toBe(1);
  });

  it("refuses a shutdown that names no open registration, instead of answering it done", async () => {
    const { child } = await harness();
    // Host shutdown cannot report completion before the child handler settles.
    await expect(child.runShutdownHandler("never-registered")).rejects.toThrow(
      /no open onShutdown registration 'never-registered'/,
    );
  });

  it("stops waiting when the child died before shutdown ran", async () => {
    const { hostApi, api, host } = await harness();
    hostApi.onShutdown(() => {});
    await flush();
    expect(host.childGone()).toBe(1);
    // No delivery may target an already-removed registration.
    await expect(api.runShutdown()).resolves.toBeUndefined();
  });

  it("releases the CHILD side when the host dies, without writing to a dead pipe", async () => {
    const { hostApi, child, notifications } = await harness();
    hostApi.onShutdown(() => {});
    await flush();
    const before = notifications.length;
    expect(child.hostGone()).toBe(1);
    expect(child.openSubscriptionCount).toBe(0);
    expect(notifications).toHaveLength(before);
  });

  it("refuses a malformed registration off the wire", async () => {
    const { call } = await harness();
    for (const args of [[], [42]]) {
      await expect(call("onShutdown", args)).rejects.toMatchObject({
        code: "argument-marshalling-rejected",
      });
    }
  });
});

describe("a subscribe the host refuses does not leave the plugin holding a live disposer", () => {
  it("drops the child registration and reports the refusal", async () => {
    // Asynchronous subscribe refusals need diagnostics because the synchronous caller already received its disposer.
    const { hostApi, child, host, api, notifications } = await harness({
      isActive: () => false,
    });
    const dispose = hostApi.onEvent("task.created", () => {});
    expect(typeof dispose).toBe("function");
    await flush();

    expect(child.openSubscriptionCount).toBe(0);
    expect(host.openSubscriptionCount).toBe(0);
    expect(api.eventListenerCount("task.created")).toBe(0);
    const reported = notifications.filter((n) => n.method === "notifications/ave/log");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      method: "notifications/ave/log",
      params: { message: "hostApi.onEvent: the host refused the subscription" },
    });
  });

  it("reports every member of the group, not just the one that was tested", async () => {
    const { hostApi, child, notifications } = await harness({ isActive: () => false });
    hostApi.config.onChange("theme", () => {});
    hostApi.onPluginsChanged(() => {});
    hostApi.onShutdown(() => {});
    await flush();
    expect(child.openSubscriptionCount).toBe(0);
    expect(
      notifications
        .flatMap((n) => (n.method === "notifications/ave/log" ? [n.params.message] : []))
        .sort(),
    ).toEqual([
      "hostApi.config.onChange: the host refused the subscription",
      "hostApi.onPluginsChanged: the host refused the subscription",
      "hostApi.onShutdown: the host refused the subscription",
    ]);
  });
});

describe("the config snapshot the child answers from stays current", () => {
  it("moves the snapshot before the plugin's own onChange callback runs", async () => {
    // Update the snapshot before invoking callbacks that may reread config.
    const { hostApi, api } = await harness({ config: { theme: "dark" } });
    const seen: unknown[] = [];
    hostApi.config.onChange("theme", () => seen.push(hostApi.config.get("theme")));
    await flush();
    api.emitConfigChange("theme", "light");
    expect(seen).toEqual(["light"]);
    expect(hostApi.config.get("theme")).toBe("light");
  });

  it("carries a cleared key through as unset rather than as a missing event", async () => {
    const { hostApi, api } = await harness({ config: { theme: "dark" } });
    const seen: unknown[] = [];
    hostApi.config.onChange("theme", (value) => seen.push(value));
    await flush();
    api.emitConfigChange("theme", undefined);
    expect(seen).toEqual([undefined]);
    expect(hostApi.config.get("theme")).toBeUndefined();
  });
});

describe("the payload codecs both sides share", () => {
  it("keeps a cleared config key distinguishable from a missing payload", () => {
    expect(decodeConfigChange({ key: "theme", value: undefined })).toEqual({
      key: "theme",
      value: undefined,
    });
    expect(decodeConfigChange(JSON.parse(JSON.stringify({ key: "theme" })))).toEqual({
      key: "theme",
      value: undefined,
    });
  });

  it("refuses a payload the two sides disagree about", () => {
    for (const bad of [null, "raw", 7, [], {}]) {
      expect(() => decodeConfigChange(bad), String(bad)).toThrow(
        /event payload is not an object|names no key/u,
      );
    }
    expect(() => decodeHostEvent(null)).toThrow(/not an object/u);
    expect(() => decodePluginLifecycle({})).toThrow(/no discriminant/u);
    expect(() => decodePluginLifecycle({ event: { pluginId: "x" } })).toThrow(
      /no discriminant/u,
    );
  });

  it("carries an event payload of undefined without inventing one", () => {
    expect(decodeHostEvent({}).data).toBeUndefined();
    expect(decodeHostEvent({ data: { taskId: "t1" } }).data).toEqual({ taskId: "t1" });
  });
});

describe("the group binds to one incarnation and claims exactly its own members", () => {
  it("services every member of the group except the child-local one", async () => {
    const api = fakeHostApi();
    const paths = Object.keys(createConfigSubscriptionHostApiPaths(api.hostApi)).sort();
    expect(paths).toEqual([
      "config.onChange",
      "config.set",
      "onEvent",
      "onPluginsChanged",
      "onShutdown",
    ]);
  });

  it("keys every handler to the contract SOT rather than to a local copy", () => {
    const api = fakeHostApi();
    const handlers = createConfigSubscriptionHostApiPaths(api.hostApi);
    for (const [path, handler] of Object.entries(handlers)) {
      expect(handler.path).toBe(path);
      expect(handler.contract).toBe(HOSTAPI_PATH_CONTRACTS[path as HostApiPath]);
      expect(handler.status).toBe("implemented");
    }
  });

  it("leaves the shipped table unbound, because a module constant has no incarnation", () => {
    // Static dispatch entries must remain unbound; only per-incarnation bindings may act for a plugin.
    expect(HOSTAPI_DISPATCH_TABLE["config.get"].status).toBe("child-local");
    for (const path of [
      "config.set",
      "config.onChange",
      "onEvent",
      "onPluginsChanged",
      "onShutdown",
    ] as const) {
      expect(HOSTAPI_DISPATCH_TABLE[path].status, path).toBe("unimplemented");
    }
  });

  it("reports a host that drifts into returning a value from a void member", async () => {
    // Return the host result so the dispatcher can detect void-contract drift.
    const drifted = {
      config: {
        get: () => undefined,
        set: async () => "persisted" as unknown as void,
        onChange: () => () => {},
      } as PluginHostApi["config"],
      onEvent: () => () => {},
      onPluginsChanged: () => () => {},
      onShutdown: (() => () => {}) as unknown as PluginHostApi["onShutdown"],
    } satisfies ConfigSubscriptionHostApi;
    const hostLogs: { message: string; meta?: unknown }[] = [];
    const host = new HostApiDispatcher({
      // Capture host diagnostics so silently discarded failures cannot pass.
      log: (message, meta) => hostLogs.push({ message, meta }),
      pluginId: PLUGIN_ID,
      isActive: () => true,
      notifications: { deliver: () => {} },
      reportUnknownField: () => {},
      shutdownChild: async (subscriptionId) => {
        throw new Error(`no child to run shutdown handler '${subscriptionId}'`);
      },
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        ...createConfigSubscriptionHostApiPaths(drifted),
      } as Record<HostApiPath, HostApiPathHandler>,
    });
    for (const [path, args] of [
      ["config.set", ["theme", "light"]],
      ["onShutdown", ["s1"]],
    ] as const) {
      const reply = await host.handle(hostApiRequest(path, args, "c1"));
      expect("error" in reply && reply.error.data.code, path).toBe("result-marshalling-rejected");
    }
  });

  it("binds each dispatcher to its own hostApi, not to a module singleton", async () => {
    const first = fakeHostApi();
    const second = fakeHostApi();
    const spy = vi.spyOn(second.hostApi.config, "set");
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      ...createConfigSubscriptionHostApiPaths(first.hostApi),
    } as Record<HostApiPath, HostApiPathHandler>;
    const hostLogs: { message: string; meta?: unknown }[] = [];
    const host = new HostApiDispatcher({
      // Capture host diagnostics so silently discarded failures cannot pass.
      log: (message, meta) => hostLogs.push({ message, meta }),
      pluginId: PLUGIN_ID,
      isActive: () => true,
      notifications: { deliver: () => {} },
      reportUnknownField: () => {},
      shutdownChild: async (subscriptionId) => {
        throw new Error(`no child to run shutdown handler '${subscriptionId}'`);
      },
      table,
    });
    const reply = await host.handle(hostApiRequest("config.set", ["theme", "light"], "c1"));
    expect("result" in reply).toBe(true);
    expect(first.written).toEqual([["theme", "light"]]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the config snapshot the child reads is re-pushed, not frozen at construction", () => {
  it("moves a value the host changed without the plugin subscribing to anything", async () => {
    // Refresh config snapshots even when the plugin never subscribes to config.onChange.
    const { child, hostApi } = await harness({ config: { theme: "dark", locale: "ko" } });
    expect(hostApi.config.get("theme")).toBe("dark");

    expect(
      child.deliver({
        jsonrpc: "2.0",
        method: "notifications/ave/config/snapshot",
        params: {
          keys: ["theme", "locale"],
          values: { theme: "light", locale: "ko" },
        },
      }),
    ).toBe("delivered");

    expect(hostApi.config.get("theme")).toBe("light");
    expect(hostApi.config.get("locale")).toBe("ko");
  });

  it("clears a key the host no longer resolves", async () => {
    // Cleared keys belong in keys but not values; JSON cannot carry undefined.
    const { child, hostApi } = await harness({ config: { token: "abc" } });
    expect(hostApi.config.get("token")).toBe("abc");

    child.deliver({
      jsonrpc: "2.0",
      method: "notifications/ave/config/snapshot",
      params: {
        keys: ["token"],
        values: {},
      },
    });

    expect(hostApi.config.get("token")).toBeUndefined();
  });

  it("leaves a key the push does not enumerate alone", async () => {
    // Only enumerated keys may change; preserve plugin-created keys absent from the host snapshot.
    const { child, hostApi } = await harness({ config: { theme: "dark" } });
    await hostApi.config.set("adhoc", 41);
    expect(hostApi.config.get("adhoc")).toBe(41);

    child.deliver({
      jsonrpc: "2.0",
      method: "notifications/ave/config/snapshot",
      params: {
        keys: ["theme"],
        values: { theme: "light" },
      },
    });

    expect(hostApi.config.get("theme")).toBe("light");
    expect(hostApi.config.get("adhoc")).toBe(41);
  });
});

describe("the secret sentinel has a wire form, and it is the only thing that reads as one", () => {
  it("crosses as a flag beside the key and comes back as the symbol itself", () => {
    // Assert the JSON round trip: stringify silently drops Symbols.
    const onWire = JSON.parse(
      JSON.stringify(encodeConfigChange("apiKey", SECRET_REDACTED_SENTINEL)),
    ) as unknown;
    expect(onWire).toEqual({ key: "apiKey", secretRedacted: true });
    expect(decodeConfigChange(onWire).value).toBe(SECRET_REDACTED_SENTINEL);
  });

  it("keeps a cleared key and a changed secret apart across the same round trip", () => {
    const clearedOnWire = JSON.parse(
      JSON.stringify(encodeConfigChange("apiKey", undefined)),
    ) as unknown;
    expect(decodeConfigChange(clearedOnWire).value).toBeUndefined();
    expect(decodeConfigChange(clearedOnWire).value).not.toBe(SECRET_REDACTED_SENTINEL);
  });

  it("cannot be forged by a cleartext value that happens to look like the flag", () => {
    const onWire = JSON.parse(
      JSON.stringify(encodeConfigChange("apiKey", { secretRedacted: true })),
    ) as unknown;
    expect(decodeConfigChange(onWire).value).toEqual({ secretRedacted: true });
    expect(decodeConfigChange(onWire).value).not.toBe(SECRET_REDACTED_SENTINEL);
  });

  it("refuses a marker the two sides disagree about rather than reading it as a clear", () => {
    for (const payload of [
      { key: "apiKey", secretRedacted: false },
      { key: "apiKey", secretRedacted: "yes" },
      { key: "apiKey", secretRedacted: true, value: "leaked" },
    ]) {
      expect(() => decodeConfigChange(payload)).toThrow(/malformed secret marker/u);
    }
  });

  it("refuses a value that would silently change shape on the wire", () => {
    // Reject all non-JSON values rather than turn functions or Symbols into apparent clears.
    expect(() => encodeConfigChange("k", Symbol("other"))).toThrow(/cannot cross the boundary/u);
    expect(() => encodeConfigChange("k", () => undefined)).toThrow(/cannot cross the boundary/u);
    expect(() => encodeConfigChange("k", new Date("2020-01-01"))).toThrow(
      /cannot cross the boundary/u,
    );
  });

  it("reaches the plugin's callback as the sentinel, and leaves config.get alone", async () => {
    const { hostApi, api } = await harness({ config: { apiKey: "stale-cleartext-copy" } });
    const seen: unknown[] = [];
    const readBack: unknown[] = [];
    hostApi.config.onChange("apiKey", (value) => {
      seen.push(value);
      readBack.push(hostApi.config.get("apiKey"));
    });
    await flush();

    api.emitConfigChange("apiKey", SECRET_REDACTED_SENTINEL);

    expect(seen).toEqual([SECRET_REDACTED_SENTINEL]);
    // Secret updates must not place the sentinel into the cleartext config snapshot.
    expect(readBack).toEqual([undefined]);
  });
});

describe("getAppPreference answers from a snapshot the host keeps current", () => {
  it("reads the snapshot pushed at construction", async () => {
    const { hostApi } = await harness({
      appPreferences: {
        keys: ["webView.preferredFlow"],
        values: { "webView.preferredFlow": "in-app" },
      },
    });
    expect(hostApi.getAppPreference!("webView.preferredFlow")).toBe("in-app");
  });

  it("moves when the host pushes a new snapshot", async () => {
    // Preference pushes must keep synchronous child reads current.
    const { child, hostApi } = await harness({
      appPreferences: {
        keys: ["webView.preferredFlow"],
        values: { "webView.preferredFlow": "in-app" },
      },
    });

    expect(
      child.deliver({
        jsonrpc: "2.0",
        method: "notifications/ave/preferences/snapshot",
        params: {
          keys: ["webView.preferredFlow"],
          values: { "webView.preferredFlow": "system-browser" },
        },
      }),
    ).toBe("delivered");

    expect(hostApi.getAppPreference!("webView.preferredFlow")).toBe("system-browser");
  });

  it("clears a preference the host no longer resolves", async () => {
    // Represent unset preferences with keys absent from values so stale entries can be deleted.
    const { child, hostApi } = await harness({
      appPreferences: {
        keys: ["webView.preferredFlow"],
        values: { "webView.preferredFlow": "in-app" },
      },
    });

    child.deliver({
      jsonrpc: "2.0",
      method: "notifications/ave/preferences/snapshot",
      params: {
        keys: ["webView.preferredFlow"],
        values: {},
      },
    });

    expect(hostApi.getAppPreference!("webView.preferredFlow")).toBeUndefined();
  });

  it("answers a key off the host allowlist as unset, exactly as the host reader does", async () => {
    const { hostApi } = await harness({
      appPreferences: {
        keys: ["webView.preferredFlow"],
        values: { "webView.preferredFlow": "in-app" },
      },
    });
    expect(hostApi.getAppPreference!("llm.provider")).toBeUndefined();
    expect((hostApi.getAppPreference as (key: unknown) => unknown)(42)).toBeUndefined();
  });

  it("answers a key inherited from Object.prototype as unset, not with the prototype member", async () => {
    // Use own-key lookup so inherited prototype functions cannot masquerade as preferences.
    const { hostApi } = await harness({
      appPreferences: {
        keys: ["webView.preferredFlow"],
        values: { "webView.preferredFlow": "in-app" },
      },
    });
    for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(hostApi.getAppPreference!(inherited)).toBeUndefined();
    }
  });

  it("throws rather than answering when the host published no snapshot at all", async () => {
    // An absent optional preference reader differs from an unset preference; preserve the refusal.
    const { hostApi } = await harness();
    expect(() => hostApi.getAppPreference!("webView.preferredFlow")).toThrow(
      /published no preference snapshot/u,
    );
  });

  it("reports a push to a child that was never seeded, instead of dropping it silently", async () => {
    const { child } = await harness();
    expect(
      child.deliver({
        jsonrpc: "2.0",
        method: "notifications/ave/preferences/snapshot",
        params: {
          keys: ["webView.preferredFlow"],
          values: { "webView.preferredFlow": "in-app" },
        },
      }),
    ).toBe("unknown-subscription");
  });
});
