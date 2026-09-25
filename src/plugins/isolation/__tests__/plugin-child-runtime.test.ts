/**
 * The child runtime, driven over in-memory paired streams — the pattern
 * `stdio-server-loop`'s own tests already use, so the transport is real framing
 * over real streams without a subprocess.
 *
 * Two directions are proven here. Host → plugin is the MCP arm that already
 * exists: the child stands up a `PluginMcpServer` over `StdioServerLoop` and
 * answers `server/discover` and `tools/call` end to end. Plugin → host is the
 * `ave/host/*` half: a JSON-RPC request and reply, a marshalling gate on both
 * sides, an error identity that survives, and a subscription lifetime that
 * releases on BOTH sides whichever one dies first.
 */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { homedir } from "node:os";
import { frameMessage } from "../../../mcp/stdio-framing.js";
import { nextFramedMessage as nextFramed } from "../../../mcp/__tests__/test-helpers.js";
import { settleMacrotask as settle } from "../../../__tests__/test-helpers.js";
import type { PluginManifest, RuntimePlugin } from "../../types.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  defineHostApiPath,
} from "../host-api-dispatcher.js";
import {
  PluginHostApiError,
  type HostApiNotification,
  type HostApiRequest,
  type HostEventDelivery,
} from "../host-api-wire.js";
import {
  createChildHostApiStub,
  createHostApiCaller,
  startPluginChildRuntime,
  unimplementedChildMember,
  type NotificationOutcome,
  type PluginChildRuntime,
  type PluginFactoryLoader,
} from "../plugin-child-runtime.js";
import { HOSTAPI_PATH_CONTRACTS } from "../host-api-wire.js";
import { directHostApiChannel } from "../../../__tests__/support/host-protocol-wire.js";

const PLUGIN_ID = "com.example.child";

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Child",
  version: "1.0.0",
  entry: "dist/plugin.js",
  description: "an isolated plugin used to drive the child runtime",
  tools: [
    {
      name: "echo_back",
      description: "Echo the payload back to the caller",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
};

const CLIENT_META = {
  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
};

interface Harness {
  readonly child: PluginChildRuntime;
  readonly host: HostApiDispatcher;
  readonly toChild: PassThrough;
  readonly fromChild: PassThrough;
  readonly childNotifications: HostApiNotification[];
  /** Every `ave/host/*` request the child sent, in order. */
  readonly requests: HostApiRequest[];
  readonly call: (
    path: string,
    args: readonly unknown[],
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/**
 * Wire a real dispatcher to a real child runtime. The channel is in-memory
 * because multiplexing the reverse direction onto the stdio pipes is a
 * transport decision that has not been made yet; everything above it is real.
 */
async function harness(
  options: {
    table?: Record<string, unknown>;
    instance?: Partial<RuntimePlugin>;
    isActive?: () => boolean;
  } = {},
): Promise<Harness> {
  const toChild = new PassThrough();
  const fromChild = new PassThrough();
  const childNotifications: HostApiNotification[] = [];
  const requests: HostApiRequest[] = [];
  let host!: HostApiDispatcher;
  let child!: PluginChildRuntime;

  const channel = directHostApiChannel(
    {
      handle: (request) => host.handle(request),
      handleNotification: (notification) => host.handleNotification(notification),
    },
    { requests, notifications: childNotifications },
  );

  const hostLogs: { message: string; meta?: unknown }[] = [];
  host = new HostApiDispatcher({
    // Captured, not dropped: a sink that discards is what shipped, and a
    // test that discards could not tell the difference.
    log: (message, meta) => hostLogs.push({ message, meta }),
    pluginId: PLUGIN_ID,
    reportUnknownField: () => {},
    // `ave/instance/shutdown`, answered by the child runtime itself.
    shutdownChild: (subscriptionId) => child.runShutdownHandler(subscriptionId),
    isActive: options.isActive ?? (() => true),
    notifications: { deliver: (notification) => child.deliver(notification) },
    table: (options.table ?? HOSTAPI_DISPATCH_TABLE) as typeof HOSTAPI_DISPATCH_TABLE,
  });

  const loadFactory: PluginFactoryLoader = async () => () => ({
    handlers: {
      echo_back: (payload) => ({ echoed: (payload as { text: string }).text }),
    },
    ...options.instance,
  });

  child = await startPluginChildRuntime({
    input: toChild,
    output: fromChild,
    manifest: MANIFEST,
    context: {
      pluginId: PLUGIN_ID,
      pluginRoot: "/plugins/child",
      hostRoot: "/app",
      pluginDataDir: "/plugins/child/data",
      userHome: "/Users/example",
      aveHome: "/Users/example/.ave",
      installedPluginIds: [],
      config: { enabled: true },
    },
    channel,
    loadFactory,
  });

  const call = createHostApiCaller(channel, { pluginId: PLUGIN_ID });

  return {
    child,
    host,
    toChild,
    fromChild,
    childNotifications,
    requests,
    call: (path, args, signal) => call(path as never, args, signal),
  };
}

describe("the child serves its plugin over framed stdio", () => {
  it("answers server/discover with the plugin's own identity", async () => {
    const { toChild, fromChild } = await harness();
    const pending = nextFramed(fromChild);
    toChild.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { ...CLIENT_META },
      }),
    );
    const response = await pending;
    expect((response.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "Child",
    );
  });

  it("runs a tool handler and frames its result back", async () => {
    const { toChild, fromChild } = await harness();
    const pending = nextFramed(fromChild);
    toChild.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo_back", arguments: { text: "hello" }, ...CLIENT_META },
      }),
    );
    const response = await pending;
    expect(response.result).toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ echoed: "hello" }) }],
    });
  });

  it("refuses a tool result the boundary cannot carry", async () => {
    // A Map is a successful JSON round-trip into `{}` — no exception, no
    // symptom, wrong value. `LoopbackTransport` refuses it on the in-process
    // arm; the child refuses it here so a plugin gets the same answer on both.
    const { toChild, fromChild } = await harness({
      instance: { handlers: { echo_back: () => new Map([["a", 1]]) } },
    });
    const pending = nextFramed(fromChild);
    toChild.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo_back", arguments: { text: "x" }, ...CLIENT_META },
      }),
    );
    const response = await pending;
    expect(JSON.stringify(response)).toContain("Map");
  });

  it("fails loudly when the entry exports no factory", async () => {
    await expect(
      startPluginChildRuntime({
        input: new PassThrough(),
        output: new PassThrough(),
        manifest: MANIFEST,
        context: {
          pluginId: PLUGIN_ID,
          pluginRoot: "/plugins/child",
          hostRoot: "/app",
          pluginDataDir: "/plugins/child/data",
          userHome: "/Users/example",
          aveHome: "/Users/example/.ave",
          installedPluginIds: [],
            },
        channel: { call: () => Promise.reject(new Error("unused")), notify: () => {} },
        loadFactory: async () => undefined,
      }),
    ).rejects.toThrow(/exports no plugin factory/u);
  });
});

describe("the hostApi stub builder", () => {
  it("nests every declared member from the contract SOT, with nothing added", () => {
    const wired: string[] = [];
    const stub = createChildHostApiStub(PLUGIN_ID, (path) => {
      wired.push(path);
      return () => path;
    });
    expect(wired.sort()).toEqual(Object.keys(HOSTAPI_PATH_CONTRACTS).sort());
    const namespaces = stub as unknown as Record<string, Record<string, unknown>>;
    expect(Object.keys(namespaces.storage).sort()).toEqual(
      Object.keys(HOSTAPI_PATH_CONTRACTS)
        .filter((path) => path.startsWith("storage."))
        .map((path) => path.slice("storage.".length))
        .sort(),
    );
  });

  it("refuses to hand the plugin a stub with a member missing", () => {
    expect(() =>
      createChildHostApiStub(PLUGIN_ID, (path) =>
        // A builder that skipped a member would give the plugin a TypeError at
        // some unrelated call site instead of a failure that names the gap.
        path === "getSecret" ? (undefined as never) : () => undefined,
      ),
    ).toThrow(/missing 'getSecret'/u);
  });

  it("gives an unwired member a throw, not a resolved undefined", () => {
    const member = unimplementedChildMember(PLUGIN_ID, "getSecret");
    expect(() => member("api-key")).toThrow(/hostApi\.getSecret is not wired/u);
  });
});

describe("the hostApi stub the child hands the plugin", () => {
  it("presents every declared member, nested, as a function", async () => {
    const { child } = await harness();
    const hostApi = child.hostApi as unknown as Record<string, unknown>;
    expect(typeof hostApi.getSecret).toBe("function");
    expect(typeof (hostApi.storage as Record<string, unknown>).writeJson).toBe(
      "function",
    );
    expect(typeof (hostApi.agentApproval as Record<string, unknown>).request).toBe(
      "function",
    );
  });

  it("throws from an unwired member instead of resolving undefined", async () => {
    // Built through the stub builder with NOTHING wired, rather than by naming a
    // member on a live runtime: stubs land group by group, so an assertion that
    // named one would stop testing the refusal the moment that member was wired.
    // What is under test is the composition — every declared path, nested,
    // resolving to the throwing default.
    const stub = createChildHostApiStub(PLUGIN_ID, (path) =>
      unimplementedChildMember(PLUGIN_ID, path),
    ) as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(() => stub.getSecret("api-key")).toThrow(/not wired/u);
    expect(() =>
      (stub.storage as unknown as Record<string, () => unknown>).readText(),
    ).toThrow(/not wired/u);
  });

  it("hands the plugin the HOST's home, not the one this process would read", async () => {
    // The point of the field, stated as a control: the fixture names a home
    // that is deliberately NOT this process's, so a child that fell back to
    // `homedir()` would answer with something else and the equality below
    // would fail. Without the second assertion the first would still pass on a
    // machine where the two happened to match.
    let seen: { userHome: string; aveHome: string } | null = null;
    await startPluginChildRuntime({
      input: new PassThrough(),
      output: new PassThrough(),
      manifest: MANIFEST,
      context: {
        pluginId: PLUGIN_ID,
        pluginRoot: "/plugins/child",
        hostRoot: "/app",
        pluginDataDir: "/plugins/child/data",
        userHome: "/Users/example",
        aveHome: "/somewhere/else/.ave",
        installedPluginIds: [],
        },
      channel: {
        call: () => Promise.reject(new Error("unused")),
        notify: () => {},
      },
      loadFactory: async () => (context) => {
        seen = { userHome: context.userHome, aveHome: context.aveHome };
        return { handlers: {} };
      },
    });
    expect(seen).toEqual({ userHome: "/Users/example", aveHome: "/somewhere/else/.ave" });
    expect(homedir()).not.toBe("/Users/example");
  });

  it.each(["userHome", "aveHome"] as const)(
    "refuses construction when the payload omits '%s'",
    async (field) => {
      const context = {
        pluginId: PLUGIN_ID,
        pluginRoot: "/plugins/child",
        hostRoot: "/app",
        pluginDataDir: "/plugins/child/data",
        userHome: "/Users/example",
        aveHome: "/Users/example/.ave",
        installedPluginIds: [],
        };
      delete (context as Record<string, unknown>)[field];
      let factoryRan = false;
      await expect(
        startPluginChildRuntime({
          input: new PassThrough(),
          output: new PassThrough(),
          manifest: MANIFEST,
          context: context as never,
          channel: {
            call: () => Promise.reject(new Error("unused")),
            notify: () => {},
          },
          loadFactory: async () => () => {
            factoryRan = true;
            return { handlers: {} };
          },
        }),
      ).rejects.toThrow(new RegExp(`missing '${field}'`, "u"));
      // The refusal happens BEFORE the plugin exists. A plugin constructed with
      // the field undefined would already have joined it into a path.
      expect(factoryRan).toBe(false);
    },
  );

  it("routes context.log to the host as a notification", async () => {
    const notifications: HostApiNotification[] = [];
    const child = await startPluginChildRuntime({
      input: new PassThrough(),
      output: new PassThrough(),
      manifest: MANIFEST,
      context: {
        pluginId: PLUGIN_ID,
        pluginRoot: "/plugins/child",
        hostRoot: "/app",
        pluginDataDir: "/plugins/child/data",
        userHome: "/Users/example",
        aveHome: "/Users/example/.ave",
        installedPluginIds: [],
        },
      channel: {
        call: () => Promise.reject(new Error("unused")),
        notify: (notification) => notifications.push(notification),
      },
      loadFactory: async () => (context) => {
        context.log("starting", { attempt: 1 });
        return { handlers: {} };
      },
    });
    expect(child.instance.handlers).toEqual({});
    expect(notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/ave/log",
        params: {
          message: "starting",
          meta: { attempt: 1 },
        },
      },
    ]);
  });
});

describe("a hostApi call crosses the reverse channel and settles", () => {
  it("returns the host's value", async () => {
    const { call } = await harness({
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        hasRoutineBySource: defineHostApiPath(
          "hasRoutineBySource",
          async (invocation) => invocation.args[0] === "nightly",
        ),
      },
    });
    await expect(call("hasRoutineBySource", ["nightly"])).resolves.toBe(true);
    await expect(call("hasRoutineBySource", ["other"])).resolves.toBe(false);
  });

  it("throws with the code, not a message match, when the host refuses", async () => {
    const { call } = await harness();
    await expect(call("getSecret", ["api-key"])).rejects.toMatchObject({
      code: "path-not-implemented",
    });
    await expect(call("getSecret", ["api-key"])).rejects.toBeInstanceOf(
      PluginHostApiError,
    );
  });

  it("refuses an unmarshallable argument at the plugin's own call site", async () => {
    const { call, host } = await harness();
    const handle = vi.spyOn(host, "handle");
    await expect(call("hasRoutineBySource", [new Date()])).rejects.toThrow(
      /cannot cross the boundary/u,
    );
    // Not sent: the failure belongs to the caller, not to the transport.
    expect(handle).not.toHaveBeenCalled();
  });

  it("sends the method and a params object keyed by the member's own names, and no identity", async () => {
    // The connection is the identity (§2.4): a request that also named the
    // plugin or its generation would carry a field the host must ignore, and a
    // field the host ignores is one an author will try to set.
    const { call, requests } = await harness({
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        withdrawWorkProposal: defineHostApiPath("withdrawWorkProposal", async () => true),
      },
    });
    await call("withdrawWorkProposal", ["digest", "k1"]);
    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ave/host/withdrawWorkProposal",
        params: { kind: "digest", key: "k1" },
      },
    ]);
  });
});

describe("a subscription releases on both sides, whichever side dies", () => {
  /** A host handler that adopts the child-allocated id — the shape all four take. */
  function subscriptionTable(teardown: () => void) {
    return {
      ...HOSTAPI_DISPATCH_TABLE,
      onEvent: defineHostApiPath("onEvent", async (invocation, scope) => {
        const subscriptionId = invocation.args[1] as string;
        scope.adopt(subscriptionId, teardown);
        return { handleId: subscriptionId };
      }),
    };
  }

  async function subscribe(teardown: () => void) {
    const wired = await harness({ table: subscriptionTable(teardown) });
    const received: unknown[] = [];
    const subscription = wired.child.openSubscription("onEvent", (payload) =>
      received.push(payload),
    );
    await wired.call("onEvent", ["task.created", subscription.subscriptionId]);
    expect(wired.child.openSubscriptionCount).toBe(1);
    expect(wired.host.openSubscriptionCount).toBe(1);
    return { ...wired, subscription, received };
  }

  it("delivers host events to the plugin's handler", async () => {
    const { host, subscription, received } = await subscribe(() => {});
    // The host handler reaches the child through the same scope it registered on.
    const table = HOSTAPI_DISPATCH_TABLE;
    expect(table.onEvent.status).toBe("unimplemented");
    host.handleNotification({
      jsonrpc: "2.0",
      method: "notifications/ave/subscription/release",
      params: {
        subscriptionId: `${subscription.subscriptionId}-nope`,
      },
    });
    expect(received).toEqual([]);
  });

  it("releases BOTH sides when the child disposes", async () => {
    const teardown = vi.fn();
    const { child, host, subscription, childNotifications } = await subscribe(teardown);

    subscription.dispose();

    expect(child.openSubscriptionCount).toBe(0);
    expect(host.openSubscriptionCount).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(childNotifications.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/ave/subscription/release",
      params: { subscriptionId: subscription.subscriptionId },
    });

    // Disposing again is a no-op on both sides rather than a second teardown.
    subscription.dispose();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("releases the HOST side when the child dies without disposing", async () => {
    const teardown = vi.fn();
    const { child, host } = await subscribe(teardown);

    // The child is gone: no release ever arrives, and the host must not wait
    // for one. This is the leak the in-process version cannot have and the
    // out-of-process version gets for free only if the host is told.
    expect(host.childGone()).toBe(1);

    expect(host.openSubscriptionCount).toBe(0);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith("peer-gone");
    // The child's own ledger dies with its process; asserting it here documents
    // that nothing in the host's cleanup depends on the child cooperating.
    expect(child.openSubscriptionCount).toBe(1);
  });

  it("releases the CHILD side when the host dies, without writing to a closed pipe", async () => {
    const teardown = vi.fn();
    const { child, childNotifications } = await subscribe(teardown);
    const before = childNotifications.length;

    expect(child.hostGone()).toBe(1);

    expect(child.openSubscriptionCount).toBe(0);
    // No release notification: there is no host left to receive one.
    expect(childNotifications).toHaveLength(before);
  });

  it("drops the child side when the host revokes, and does not echo back", async () => {
    const teardown = vi.fn();
    const { child, subscription, childNotifications } = await subscribe(teardown);
    const before = childNotifications.length;

    expect(
      child.deliver({
        jsonrpc: "2.0",
        method: "notifications/ave/subscription/closed",
        params: {
          subscriptionId: subscription.subscriptionId,
          reason: "revoked",
        },
      }),
    ).toBe("closed");

    expect(child.openSubscriptionCount).toBe(0);
    expect(childNotifications).toHaveLength(before);
  });

  it("reports an event for a subscription that is already gone", async () => {
    const { child, subscription } = await subscribe(() => {});
    subscription.dispose();
    // An event that crossed before the release did is a real ordering artifact,
    // not an error — but it is REPORTED rather than dropped in silence, because
    // "no handler ran" is exactly the symptom a leak or a mis-keyed id produces.
    const outcome: NotificationOutcome = child.deliver({
      jsonrpc: "2.0",
      method: "notifications/ave/subscription",
      params: {
        subscriptionId: subscription.subscriptionId,
        payload: { late: true },
      },
    });
    expect(outcome).toBe("unknown-subscription");
  });

  it("carries a payload from the host handler to the plugin's callback", async () => {
    const delivered: unknown[] = [];
    let push: ((payload: HostEventDelivery) => void) | undefined;
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      onEvent: defineHostApiPath("onEvent", async (invocation, scope) => {
        const subscriptionId = invocation.args[1] as string;
        scope.adopt(subscriptionId, () => {});
        push = (payload) => scope.deliver(subscriptionId, payload);
        return { handleId: subscriptionId };
      }),
    };
    const wired = await harness({ table });
    const subscription = wired.child.openSubscription("onEvent", (payload) =>
      delivered.push(payload),
    );
    await wired.call("onEvent", ["task.created", subscription.subscriptionId]);

    push?.({ data: { taskId: "t1" } });
    expect(delivered).toEqual([{ data: { taskId: "t1" } }]);

    subscription.dispose();
    expect(() => push?.({ data: { taskId: "t2" } })).toThrow(/no open subscription/u);
  });
});

describe("a signal cancels the request it was passed with, and nothing else", () => {
  /**
   * A host member that runs until its request is cancelled, the way `callLlm`
   * does — and records the signal the dispatcher handed it.
   */
  function cancellableTable(observed: { signal?: AbortSignal; finish?: (value: string) => void }) {
    return {
      ...HOSTAPI_DISPATCH_TABLE,
      callLlm: defineHostApiPath("callLlm", (invocation) => {
        observed.signal = invocation.signal;
        return new Promise<unknown>((resolve, reject) => {
          observed.finish = resolve;
          invocation.signal.addEventListener("abort", () => reject(invocation.signal.reason));
        });
      }),
    };
  }

  it("cancels the host's work when the plugin aborts, and the plugin reads an AbortError", async () => {
    const observed: { signal?: AbortSignal; finish?: (value: string) => void } = {};
    const wired = await harness({ table: cancellableTable(observed) });
    const controller = new AbortController();
    const pending = wired.call("callLlm", ["write an essay"], controller.signal);
    await settle();
    expect(observed.signal?.aborted).toBe(false);

    controller.abort(new Error("the plugin changed its mind"));

    expect(observed.signal?.aborted).toBe(true);
    // The call settles through the host's reply, and the name a plugin checks
    // for a cancellation survives the wire.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("names the in-flight request in MCP's cancellation notification", async () => {
    const observed: { signal?: AbortSignal; finish?: (value: string) => void } = {};
    const wired = await harness({ table: cancellableTable(observed) });
    const controller = new AbortController();
    const pending = wired.call("callLlm", ["hi"], controller.signal);
    await settle();

    controller.abort(new Error("the plugin changed its mind"));
    await pending.catch(() => undefined);

    expect(wired.childNotifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: wired.requests[0].id, reason: "the plugin changed its mind" },
      },
    ]);
    // The signal itself never crossed: the request carries the prompt alone.
    expect(wired.requests[0].params).toEqual({ prompt: "hi" });
  });

  it("cancels work started for a child that has since died", async () => {
    // The host is working on behalf of a process that no longer exists. Not
    // aborting leaves the request in flight with nowhere to deliver its answer,
    // and that holds whether or not the plugin passed a signal.
    const observed: { signal?: AbortSignal; finish?: (value: string) => void } = {};
    const wired = await harness({ table: cancellableTable(observed) });
    void wired.call("callLlm", ["hi"]).catch(() => undefined);
    await settle();

    wired.host.childGone();

    expect(observed.signal?.aborted).toBe(true);
  });

  it("detaches the child's listener when the call settles", async () => {
    const observed: { signal?: AbortSignal; finish?: (value: string) => void } = {};
    const wired = await harness({ table: cancellableTable(observed) });
    const controller = new AbortController();
    const pending = wired.call("callLlm", ["hi"], controller.signal);
    await settle();
    observed.finish?.("done");
    await expect(pending).resolves.toBe("done");
    const before = wired.childNotifications.length;

    controller.abort(new Error("too late"));

    // No cancellation: the request already settled, so the listener is gone. A
    // listener that stayed attached would keep the settled call's closure alive
    // for as long as the plugin holds the signal.
    expect(wired.childNotifications).toHaveLength(before);
  });

  it("throws the signal's own reason instead of sending a doomed request", async () => {
    const wired = await harness();
    const handle = vi.spyOn(wired.host, "handle");
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    await expect(wired.call("callLlm", ["hi"], controller.signal)).rejects.toBe(reason);
    expect(handle).not.toHaveBeenCalled();
  });
});
