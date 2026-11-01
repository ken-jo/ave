import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { frameMessage } from "../../../mcp/stdio-framing.js";
import { nextFramedMessage } from "../../../mcp/__tests__/test-helpers.js";
import { servePluginChild } from "../plugin-child-main.js";
import { PendingCallTable } from "../child-stream-multiplex.js";
import { HOST_PROTOCOL_CURRENT_VERSION, hostApiMethodOf, type HostApiChannel } from "../host-api-wire.js";
import type { PluginChildRuntime } from "../plugin-child-runtime.js";

const observed = vi.hoisted(() => ({
  channel: undefined as HostApiChannel | undefined,
  runtime: undefined as PluginChildRuntime | undefined,
}));

vi.mock("../plugin-child-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin-child-runtime.js")>();
  return {
    ...actual,
    startPluginChildRuntime: async (options: Parameters<typeof actual.startPluginChildRuntime>[0]) => {
      observed.channel = options.channel;
      observed.runtime = await actual.startPluginChildRuntime({
        ...options,
        loadFactory: async () => () => ({ handlers: {} }),
      });
      return observed.runtime;
    },
  };
});

afterEach(() => vi.restoreAllMocks());

async function constructedChild() {
  const input = new PassThrough();
  const output = new PassThrough();
  const service = servePluginChild(input, output);
  const reply = nextFramedMessage(output);
  input.write(frameMessage({
    jsonrpc: "2.0", id: "construct", method: "ave/instance/construct",
    params: {
      hostProtocol: { version: HOST_PROTOCOL_CURRENT_VERSION, capabilities: [] },
      manifest: { id: "channel-probe", name: "Channel probe", version: "1.0.0", entry: "entry.mjs", description: "Channel lifecycle", tools: [] },
      context: { pluginId: "channel-probe", pluginRoot: "/plugins/channel-probe", hostRoot: "/app", pluginDataDir: "/plugins/channel-probe/data", userHome: "/Users/example", aveHome: "/Users/example/.ave", installedPluginIds: [] },
      entryPath: "/plugins/channel-probe/entry.mjs", declaredToolNames: [],
    },
  }));
  expect(await reply).toHaveProperty("result");
  return { input, output, service, runtime: observed.runtime!, channel: observed.channel! };
}

describe("worker request preregistration on the framed channel", () => {
  it("replays reply, output, exit and close decoded from one input chunk", async () => {
    const { input, output, service, runtime } = await constructedChild();
    const requestFrame = nextFramedMessage(output);
    const pending = runtime.hostApi.spawnWorker!({ workerId: "quick", command: "/bin/true" });
    const request = await requestFrame;
    const subscriptionId = `worker_${request.id}`;
    expect(runtime.openSubscriptionCount).toBe(1);
    const notification = (payload: unknown) => ({ jsonrpc: "2.0", method: "notifications/ave/subscription", params: { subscriptionId, payload } });
    input.write(Buffer.concat([
      frameMessage({ jsonrpc: "2.0", id: request.id, result: { handleId: subscriptionId, socketPath: null, pid: 4242 } }),
      frameMessage(notification({ kind: "stdout", chunk: "final result" })),
      frameMessage(notification({ kind: "stderr", chunk: "final warning" })),
      frameMessage(notification({ kind: "exit", code: 7, signal: null })),
      frameMessage({ jsonrpc: "2.0", method: "notifications/ave/subscription/closed", params: { subscriptionId, reason: "revoked" } }),
    ]));
    const handle = await pending;
    const stdout: string[] = [], stderr: string[] = [], exits: unknown[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    handle.onStderr((chunk) => stderr.push(chunk));
    handle.onExit((info) => exits.push(info));
    expect(stdout).toEqual(["final result"]);
    expect(stderr).toEqual(["final warning"]);
    expect(exits).toEqual([{ code: 7, signal: null }]);
    expect(runtime.openSubscriptionCount).toBe(0);
    service.hostGone();
  });

  it("removes a pending reply when preregistration throws and writes no request", async () => {
    const { output, service, channel } = await constructedChild();
    const registered = vi.spyOn(PendingCallTable.prototype, "register");
    const write = vi.spyOn(output, "write");
    const failure = new Error("registration refused");
    await expect(channel.call(hostApiMethodOf("spawnWorker"), {}, () => { throw failure; })).rejects.toBe(failure);
    expect(write).not.toHaveBeenCalled();
    expect(registered.mock.contexts).toHaveLength(1);
    const pendingReplies = registered.mock.contexts[0] as PendingCallTable<unknown>;
    expect(pendingReplies).toBeInstanceOf(PendingCallTable);
    expect(pendingReplies.openCount).toBe(0);
    service.hostGone();
  });
});
