vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

/** Exercise service marshalling through real child and host components, including bytes that cannot survive UTF-8. */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EffectBoundaryDeniedError } from "../../../permissions/effect-enforcement.js";
import type {
  PluginHostApi,
  PluginManifest,
  SpawnedPluginWorker,
} from "../../types.js";
import type { PluginRuntimeContext } from "../../public-contract.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  createServiceHostApiPaths,
  type DelegatedWorkerConfinement,
} from "../host-api-dispatcher.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  PluginHostApiError,
  SERVICE_HOSTAPI_PATHS,
  WIRE_BYTES_MAX,
  type HostApiNotification,
  type HostApiReply,
  type HostApiRequest,
  type WireHttpResponse,
  type WireRequestInit,
} from "../host-api-wire.js";
import {
  startPluginChildRuntime,
  type PluginChildRuntime,
} from "../plugin-child-runtime.js";
import {
  argsOfRequest,
  directHostApiChannel,
  pathOfRequest,
} from "../../../__tests__/support/host-protocol-wire.js";

const PLUGIN_ID = "com.example.service";
const PLUGIN_ROOT = "/plugins/service";
const PLUGIN_DATA_DIR = "/plugins/service/data";
/** Host-directory widening is read-only; delegated grants must consume the derived envelope unchanged. */
const WIDENED_READ_ROOT = "/host/runtime";

/** Delegated workers must stay inside the same read/write envelope as their plugin child. */
const CONFINEMENT: DelegatedWorkerConfinement = {
  read: [PLUGIN_ROOT, PLUGIN_DATA_DIR, WIDENED_READ_ROOT],
  write: [PLUGIN_DATA_DIR],
};

const HOSTILE_BYTES = new Uint8Array([0x00, 0x80, 0xff, 0xfe, 0x41, 0xc3, 0x28]);

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Service",
  version: "1.0.0",
  entry: "dist/plugin.js",
  description: "an isolated plugin exercising the service-reaching members",
  tools: [],
};

function makeFakeWorker(): SpawnedPluginWorker & {
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly stopped: () => number;
} {
  const stdout: ((chunk: string) => void)[] = [];
  const stderr: ((chunk: string) => void)[] = [];
  const exit: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = [];
  let stops = 0;
  return {
    socketPath: "/run/worker.sock",
    pid: 4242,
    stop: () => {
      stops += 1;
    },
    onStdout: (listener) => void stdout.push(listener),
    onStderr: (listener) => void stderr.push(listener),
    onExit: (listener) => void exit.push(listener),
    emitStdout: (chunk) => stdout.forEach((listener) => listener(chunk)),
    emitStderr: (chunk) => stderr.forEach((listener) => listener(chunk)),
    emitExit: (code, signal) => exit.forEach((listener) => listener({ code, signal })),
    stopped: () => stops,
  };
}

interface ServiceHarness {
  readonly child: PluginChildRuntime;
  readonly host: HostApiDispatcher;
  readonly api: PluginHostApi;
  readonly requests: HostApiRequest[];
  readonly notifications: HostApiNotification[];
  readonly pushed: HostApiNotification[];
  readonly replies: HostApiReply[];
  /** Assert host-received logs separately from sent notifications; sending alone cannot prove delivery. */
  readonly hostLogs: { message: string; meta?: unknown }[];
  readonly pluginContext: PluginRuntimeContext;
  readonly killChild: () => number;
}

/** Replace only hostApi; every hop between it and the plugin call remains production code. */
async function createServiceHarness(
  hostApi: Partial<PluginHostApi> = {},
  manifest: PluginManifest = MANIFEST,
  onMalformedCredentialSelector?: () => void,
): Promise<ServiceHarness> {
  const requests: HostApiRequest[] = [];
  const notifications: HostApiNotification[] = [];
  const pushed: HostApiNotification[] = [];
  const replies: HostApiReply[] = [];
  let pluginContext: PluginRuntimeContext | undefined;
  let host!: HostApiDispatcher;
  let child!: PluginChildRuntime;

  const channel = directHostApiChannel(
    {
      handle: async (request) => {
        const reply = await host.handle(request);
        replies.push(reply);
        return reply;
      },
      handleNotification: (notification) => host.handleNotification(notification),
    },
    { requests, notifications },
  );

  const api = hostApi as PluginHostApi;
  const hostLogs: { message: string; meta?: unknown }[] = [];
  host = new HostApiDispatcher({
    // Capture host diagnostics so silently discarded failures cannot pass.
    log: (message, meta) => hostLogs.push({ message, meta }),
    pluginId: PLUGIN_ID,
    isActive: () => true,
    reportUnknownField: () => {},
    shutdownChild: (subscriptionId) => child.runShutdownHandler(subscriptionId),
    notifications: {
      deliver: (notification) => {
        pushed.push(notification);
        child.deliver(notification);
      },
    },
    // Compose bound entries over the static table only where the child incarnation is owned.
    table: {
      ...HOSTAPI_DISPATCH_TABLE,
      ...createServiceHostApiPaths(api, CONFINEMENT, onMalformedCredentialSelector),
    },
  });

  child = await startPluginChildRuntime({
    input: new PassThrough(),
    output: new PassThrough(),
    manifest,
    context: {
      pluginId: PLUGIN_ID,
      pluginRoot: PLUGIN_ROOT,
      hostRoot: "/app",
      pluginDataDir: PLUGIN_DATA_DIR,
      userHome: "/Users/example",
      aveHome: "/Users/example/.ave",
      installedPluginIds: [],
    },
    channel,
    loadFactory: async () => (runtimeContext) => {
      pluginContext = runtimeContext;
      return { handlers: {} };
    },
  });

  if (!pluginContext) throw new Error("the child never called the plugin factory");

  return {
    child,
    host,
    api,
    requests,
    notifications,
    pushed,
    replies,
    hostLogs,
    pluginContext,
    killChild: () => host.childGone(),
  };
}

function wireArg<T>(harness: ServiceHarness, path: string, index: number): T {
  const request = harness.requests.find((candidate) => pathOfRequest(candidate) === path);
  expect(request, `no '${path}' request was sent`).toBeDefined();
  return argsOfRequest(request!)[index] as T;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Require exactly one failure diagnostic; duplicate and missing reports both mislead operators. */
function detachedLog(harness: ServiceHarness): { message: string; meta?: unknown } {
  const logs = harness.notifications.flatMap((notification) =>
    notification.method === "notifications/ave/log" ? [notification.params] : [],
  );
  expect(logs).toHaveLength(1);
  return logs[0];
}

describe("this group implements exactly the members left after the other three", () => {
  it("binds every service-reaching member, and only against a real hostApi", () => {
    const optional = { resolveApiKey: () => {}, hostFetch: () => {}, spawnWorker: () => {} };
    const bound = createServiceHostApiPaths(optional as unknown as PluginHostApi, CONFINEMENT);
    expect(Object.keys(bound).sort()).toEqual([...SERVICE_HOSTAPI_PATHS].sort());
    for (const path of SERVICE_HOSTAPI_PATHS) {
      expect(bound[path].status).toBe("implemented");
      expect(bound[path].contract).toBe(HOSTAPI_PATH_CONTRACTS[path]);
      // Keep the shipped table unbound; a static handler cannot act for one incarnation.
      expect(HOSTAPI_DISPATCH_TABLE[path].status).toBe("unimplemented");
    }
  });

  it("decides an optional member at bind time, so construct never advertises one it lacks", () => {
    // Advertise only members the bound dispatcher can actually serve.
    const bound = createServiceHostApiPaths({} as PluginHostApi, CONFINEMENT);
    const unbound = SERVICE_HOSTAPI_PATHS.filter((path) => bound[path].status === "unimplemented");
    expect(unbound.sort()).toEqual(["hostFetch", "resolveApiKey", "spawnWorker"]);
  });

  it("cancels an abort-bearing member per request, so only the lease outlives its reply", () => {
    // Request cancellation ends with the reply; key leases alone require a lifetime that survives it.
    expect(HOSTAPI_PATH_CONTRACTS.hostFetch.lifetime).toBe("none");
    expect(HOSTAPI_PATH_CONTRACTS.callLlm.lifetime).toBe("none");
    expect(HOSTAPI_PATH_CONTRACTS.resolveApiKey.lifetime).toBe("child-disposable");
    for (const path of ["hostFetch", "callLlm", "resolveApiKey"] as const) {
      expect(HOSTAPI_PATH_CONTRACTS[path].arguments, path).toBe("encoded");
    }
  });
});

describe("getSecret crosses as plain data and leaves the gate host-side", () => {
  it("returns the host's answer, including the null a denied read produces", async () => {
    const getSecret = vi.fn(async (key: string) => (key === "granted" ? "s3cret" : null));
    const harness = await createServiceHarness({ getSecret });
    await expect(harness.child.hostApi.getSecret("granted")).resolves.toBe("s3cret");
    // A denied secret is null, not a boundary-invented throw or undefined.
    await expect(harness.child.hostApi.getSecret("other")).resolves.toBeNull();
    expect(getSecret).toHaveBeenNthCalledWith(1, "granted");
    expect(getSecret).toHaveBeenNthCalledWith(2, "other");
  });

  it("does not re-decide the four-tier gate at the boundary", async () => {
    // Validate boundary types without copying the host secret allowlist.
    const getSecret = vi.fn(async () => "granted-anyway");
    const harness = await createServiceHarness({ getSecret });
    await expect(
      harness.child.hostApi.getSecret("some.other.plugin.apiKey"),
    ).resolves.toBe("granted-anyway");
  });

  it("refuses a key that is not a string", async () => {
    const getSecret = vi.fn(async () => null);
    const harness = await createServiceHarness({ getSecret });
    await expect(
      (harness.child.hostApi.getSecret as unknown as (k: unknown) => Promise<string>)(42),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe("hasRoutineBySource and probePrivateHost cross as plain data", () => {
  it("carries the boolean both members return", async () => {
    const harness = await createServiceHarness({
      hasRoutineBySource: vi.fn(async (source: string) => source.endsWith(":nightly")),
      probePrivateHost: vi.fn(async () => true),
    });
    await expect(
      harness.child.hostApi.hasRoutineBySource(`suggestion:${PLUGIN_ID}:nightly`),
    ).resolves.toBe(true);
    await expect(harness.child.hostApi.hasRoutineBySource("other")).resolves.toBe(false);
    await expect(harness.child.hostApi.probePrivateHost("intranet.corp")).resolves.toBe(
      true,
    );
  });

  it("carries the optional timeout and refuses a non-numeric one", async () => {
    const probePrivateHost = vi.fn(async () => false);
    const harness = await createServiceHarness({ probePrivateHost });
    await harness.child.hostApi.probePrivateHost("intranet.corp", { timeoutMs: 250 });
    expect(probePrivateHost).toHaveBeenCalledWith("intranet.corp", { timeoutMs: 250 });
    await expect(
      harness.child.hostApi.probePrivateHost("intranet.corp", {
        timeoutMs: "soon" as unknown as number,
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
  });

  it("omits the options object entirely when the plugin omitted it", async () => {
    // Omitted and explicit trailing undefined options must make the same call.
    const probePrivateHost = vi.fn(async () => false);
    const harness = await createServiceHarness({ probePrivateHost });
    await harness.child.hostApi.probePrivateHost("intranet.corp");
    expect(probePrivateHost).toHaveBeenCalledWith("intranet.corp");
  });
});

describe("hostFetch carries bytes a text codec would corrupt", () => {
  it("reconstructs the body byte-for-byte, tagged base64 on the wire", async () => {
    const hostFetch = vi.fn(
      async () =>
        new Response(HOSTILE_BYTES, {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/octet-stream", "x-trace": "abc" },
        }),
    );
    const harness = await createServiceHarness({ hostFetch });
    const response = await harness.child.hostApi.hostFetch!("https://example.test/a");
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-trace")).toBe("abc");
    const received = new Uint8Array(await response.arrayBuffer());
    expect([...received]).toEqual([...HOSTILE_BYTES]);
  });

  it("does not let a Buffer body round-trip into { type: 'Buffer' }", async () => {
    // Assert byte identity and type: Buffer.toJSON succeeds while changing both.
    let reply: unknown;
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(Buffer.from(HOSTILE_BYTES)),
    });
    const original = harness.host.handle.bind(harness.host);
    vi.spyOn(harness.host, "handle").mockImplementation(async (request) => {
      const result = await original(request);
      if ("result" in result) reply = result.result;
      return result;
    });
    const response = await harness.child.hostApi.hostFetch!("https://example.test/a");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...HOSTILE_BYTES]);
    const wire = reply as WireHttpResponse;
    expect(wire.body.encoding).toBe("base64");
    expect(wire.body).not.toHaveProperty("type");
    expect(Buffer.from(wire.body.data, "base64").equals(Buffer.from(HOSTILE_BYTES))).toBe(
      true,
    );
  });

  it("reduces init to JSON: headers as entries, body tagged, URL as a string", async () => {
    const hostFetch = vi.fn(async () => new Response(new Uint8Array(0)));
    const harness = await createServiceHarness({ hostFetch });
    await harness.child.hostApi.hostFetch!(new URL("https://example.test/b?q=1"), {
      method: "POST",
      headers: new Headers({ "x-a": "1" }),
      body: HOSTILE_BYTES,
      redirect: "error",
    });
    const wire = wireArg<WireRequestInit>(harness, "hostFetch", 1);
    expect(wireArg<string>(harness, "hostFetch", 0)).toBe("https://example.test/b?q=1");
    expect(wire.headers).toEqual([["x-a", "1"]]);
    expect(wire.body?.encoding).toBe("base64");
    expect(wire.method).toBe("POST");
    const [, init] = hostFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-a")).toBe("1");
    expect([...(init.body as Uint8Array)]).toEqual([...HOSTILE_BYTES]);
    expect(init.redirect).toBe("error");
  });

  it("keeps a text body text rather than re-encoding it as bytes", async () => {
    // Keep text bodies tagged as text because fetch derives a different default content type.
    const hostFetch = vi.fn(async () => new Response(new Uint8Array(0)));
    const harness = await createServiceHarness({ hostFetch });
    await harness.child.hostApi.hostFetch!("https://example.test/c", {
      method: "POST",
      body: '{"a":1}',
    });
    expect(wireArg<WireRequestInit>(harness, "hostFetch", 1).body).toEqual({
      encoding: "utf8",
      data: '{"a":1}',
    });
    expect(
      (hostFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body,
    ).toBe('{"a":1}');
  });

  it("serializes FormData within the complete 16 MiB body budget", async () => {
    const hostFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const harness = await createServiceHarness({ hostFetch });
    const form = new FormData();
    form.append("model", "sample-model");
    form.append("file", new File([new Uint8Array([0, 255, 1])], "voice.wav", { type: "audio/wav" }));
    await harness.child.hostApi.hostFetch!("https://example.test/upload", { method: "POST", body: form });
    const wire = wireArg<WireRequestInit>(harness, "hostFetch", 1);
    const contentType = new Headers(wire.headers?.map(([key, value]) => [key, value])).get("content-type");
    expect(contentType).toMatch(/^multipart\/form-data; boundary=ave-/);
    const [, init] = hostFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = init.body as Uint8Array;
    expect(Buffer.from(body).includes(Buffer.from([0, 255, 1]))).toBe(true);
    expect(Buffer.from(body).toString("latin1")).toContain('filename="voice.wav"');
    expect(Buffer.from(body).toString("latin1")).toContain("Content-Type: audio/wav");
  });

  it("refuses an oversized multipart body before dispatch", async () => {
    const hostFetch = vi.fn(async () => new Response(null));
    const harness = await createServiceHarness({ hostFetch });
    const form = new FormData();
    form.append("file", new File([new Uint8Array(16 * 1024 * 1024)], "large.bin"));
    await expect(harness.child.hostApi.hostFetch!("https://example.test/upload", { body: form }))
      .rejects.toMatchObject({ code: "payload-too-large" });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("forwards only a validated auth selector to the host", async () => {
    const hostFetch = vi.fn(async () => new Response(null));
    const harness = await createServiceHarness({ hostFetch });
    await harness.child.hostApi.hostFetch!("https://example.test/a", { auth: { lease: "lease_test" } });
    expect(wireArg<WireRequestInit>(harness, "hostFetch", 1).auth).toEqual({ lease: "lease_test" });
    expect((hostFetch.mock.calls[0] as unknown as [string, { auth: unknown }])[1].auth).toEqual({ lease: "lease_test" });
    await expect(harness.child.hostApi.hostFetch!("https://example.test/a", { auth: { lease: 1 } } as never))
      .rejects.toMatchObject({ code: "credential-conflict" });
  });

  it("audits a malformed selector rejected by the host wire decoder", async () => {
    const hostFetch = vi.fn(async () => new Response(null));
    const onMalformedCredentialSelector = vi.fn();
    const harness = await createServiceHarness({ hostFetch }, MANIFEST, onMalformedCredentialSelector);
    const reply = await harness.host.handle({
      jsonrpc: "2.0", id: "malformed-auth", method: "ave/host/hostFetch",
      params: { input: "https://example.test/a", init: { auth: { lease: 7 } } },
    });
    expect(reply).toMatchObject({ error: { data: { code: "credential-conflict" } } });
    expect(onMalformedCredentialSelector).toHaveBeenCalledOnce();
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("refuses a stream body instead of quietly buffering it", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array(0)),
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await expect(
      harness.child.hostApi.hostFetch!("https://example.test/d", {
        method: "POST",
        body: stream,
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
  });

  it("refuses an init field the boundary does not carry", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array(0)),
    });
    await expect(
      harness.child.hostApi.hostFetch!("https://example.test/e", {
        window: null,
      } as RequestInit),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
  });

  it.each([204, 205, 304])(
    "reconstructs status %i without a platform TypeError",
    async (status) => {
      // All null-body statuses must reconstruct without an empty byte body.
      const harness = await createServiceHarness({
        hostFetch: async () => new Response(null, { status }),
      });
      const response = await harness.child.hostApi.hostFetch!("https://example.test/f");
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    },
  );

  it("still carries a body on a status that allows one", async () => {
    // The null-body rule must not erase ordinary success bodies.
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
    });
    const response = await harness.child.hostApi.hostFetch!("https://example.test/f2");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9]);
  });

  it("throws rather than truncates a body over the boundary ceiling", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () =>
        new Response(new Uint8Array(8), {
          // Reject declared oversized bodies before allocation.
          headers: { "content-length": String(WIRE_BYTES_MAX + 1) },
        }),
    });
    await expect(
      harness.child.hostApi.hostFetch!("https://example.test/g"),
    ).rejects.toMatchObject({ code: "payload-too-large" });
  });

  // Cancel refused body streams so upstream sockets do not remain open until collection.
  describe("cancels the upstream body it refuses", () => {
    function endlessBody(): { body: ReadableStream<Uint8Array>; cancelled: Promise<unknown>; pulledBytes: () => number } {
      let pulled = 0;
      let onCancel!: (reason: unknown) => void;
      const cancelled = new Promise<unknown>((resolveCancel) => { onCancel = resolveCancel; });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1024 * 1024;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel(reason) {
          onCancel(reason);
        },
      });
      return { body, cancelled, pulledBytes: () => pulled };
    }
    const within = <T,>(promise: Promise<T>) =>
      Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("body was never cancelled")), 2_000))]);

    it("when the running total crosses the ceiling", async () => {
      const upstream = endlessBody();
      const harness = await createServiceHarness({ hostFetch: async () => new Response(upstream.body) });

      await expect(harness.child.hostApi.hostFetch!("https://example.test/endless"))
        .rejects.toMatchObject({ code: "payload-too-large" });

      await expect(within(upstream.cancelled)).resolves.toMatchObject({ code: "payload-too-large" });
      expect(upstream.pulledBytes()).toBeLessThanOrEqual(WIRE_BYTES_MAX + 2 * 1024 * 1024);
    });

    it("when content-length alone refuses it, before a byte is read", async () => {
      const upstream = endlessBody();
      const harness = await createServiceHarness({
        hostFetch: async () => new Response(upstream.body, {
          headers: { "content-length": String(WIRE_BYTES_MAX + 1) },
        }),
      });

      await expect(harness.child.hostApi.hostFetch!("https://example.test/declared"))
        .rejects.toMatchObject({ code: "payload-too-large" });

      await expect(within(upstream.cancelled)).resolves.toMatchObject({ code: "payload-too-large" });
    });
  });

  // Oversized bodies refuse whole; range slices below the ceiling must round-trip intact.
  it("refuses a body above the ceiling whole and carries it intact as Range slices", async () => {
    const resource = new Uint8Array(WIRE_BYTES_MAX * 2 + 12_345);
    for (let i = 0; i < resource.byteLength; i += 1) resource[i] = (i * 31 + (i >>> 13)) & 0xff;
    const hostFetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init?.headers).get("range") ?? "");
      if (!match) {
        return new Response(resource.slice(), { headers: { "content-length": String(resource.byteLength) } });
      }
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), resource.byteLength - 1);
      return new Response(resource.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${resource.byteLength}` },
      });
    });
    const harness = await createServiceHarness({ hostFetch });

    await expect(harness.child.hostApi.hostFetch!("https://example.test/asset"))
      .rejects.toMatchObject({ code: "payload-too-large" });

    const slice = WIRE_BYTES_MAX / 2;
    const received: Uint8Array[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const response = await harness.child.hostApi.hostFetch!("https://example.test/asset", {
        headers: { range: `bytes=${offset}-${offset + slice - 1}` },
      });
      expect(response.status).toBe(206);
      const [, start, end, size] = /^bytes (\d+)-(\d+)\/(\d+)$/u
        .exec(response.headers.get("content-range") ?? "") ?? [];
      expect(Number(start)).toBe(offset);
      total = Number(size);
      received.push(new Uint8Array(await response.arrayBuffer()));
      offset = Number(end) + 1;
    }
    expect(Buffer.compare(Buffer.concat(received), Buffer.from(resource))).toBe(0);
    expect(received.length).toBe(5);
  });

  it("replies with the contract's effect-boundary-denied code", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => {
        throw new EffectBoundaryDeniedError(PLUGIN_ID, "hostFetch", "https://x.test", "denied");
      },
    });
    const error = await harness.child.hostApi
      .hostFetch!("https://example.test/h")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginHostApiError);
    expect(error).toMatchObject({
      code: "effect-boundary-denied",
      name: "EffectBoundaryDeniedError",
    });
    expect(HOSTAPI_PATH_CONTRACTS.hostFetch.errors).toContain("effect-boundary-denied");
  });

  it("answers path-not-implemented on a host build without the member", async () => {
    const harness = await createServiceHarness({});
    await expect(
      // A total child stub must produce a boundary refusal rather than an unrelated missing-function TypeError.
      (harness.child.hostApi as unknown as { hostFetch: (u: string) => Promise<Response> })
        .hostFetch("https://example.test/i"),
    ).rejects.toMatchObject({ code: "path-not-implemented" });
  });

  it("aborts the host's fetch and releases the channel on both sides", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      hostFetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          hostSignal = init?.signal ?? undefined;
          hostSignal?.addEventListener("abort", () => reject(hostSignal?.reason));
        }),
    });
    const controller = new AbortController();
    const pending = harness.child.hostApi.hostFetch!("https://example.test/j", {
      signal: controller.signal,
    });
    await settle();
    expect(hostSignal?.aborted).toBe(false);
    controller.abort(new Error("plugin gave up"));
    await expect(pending).rejects.toBeTruthy();
    // Assert the host signal aborted; local promise rejection alone cannot prove cancellation.
    expect(hostSignal?.aborted).toBe(true);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("leaves no registration behind after a call that simply settles", async () => {
    const harness = await createServiceHarness({
      hostFetch: async () => new Response(new Uint8Array([1, 2, 3])),
    });
    const controller = new AbortController();
    await harness.child.hostApi.hostFetch!("https://example.test/k", {
      signal: controller.signal,
    });
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });
});

describe("callLlm carries plain data, and a signal cancels the request", () => {
  it("returns the host's string and forwards the declared options", async () => {
    const callLlm = vi.fn(async () => "an answer");
    const harness = await createServiceHarness({ callLlm });
    await expect(
      harness.child.hostApi.callLlm("hello", { maxTokens: 32, systemPrompt: "be terse" }),
    ).resolves.toBe("an answer");
    // Every request gets a host cancellation signal even if the plugin supplies none.
    expect(callLlm).toHaveBeenCalledWith("hello", {
      maxTokens: 32,
      systemPrompt: "be terse",
      signal: expect.any(AbortSignal),
    });
  });

  it("leaves the signal off the wire and hands the host a real signal of its own", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      callLlm: async (_prompt, opts) => {
        hostSignal = opts?.signal;
        return "ok";
      },
    });
    const controller = new AbortController();
    await harness.child.hostApi.callLlm("hi", { signal: controller.signal });
    const wire = wireArg<Record<string, unknown>>(harness, "callLlm", 1);
    expect(wire).toEqual({});
    // Signals stay process-local; cancellation names the host controller by request ID.
    expect(hostSignal).toBeInstanceOf(AbortSignal);
    expect(hostSignal).not.toBe(controller.signal);
  });

  it("aborts the host's generation mid-call", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      callLlm: (_prompt, opts) =>
        new Promise((_resolve, reject) => {
          hostSignal = opts?.signal;
          hostSignal?.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const controller = new AbortController();
    const pending = harness.child.hostApi.callLlm("write an essay", {
      signal: controller.signal,
    });
    await settle();
    expect(hostSignal?.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(hostSignal?.aborted).toBe(true);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("rejects immediately on an already-aborted signal, without a round trip", async () => {
    const callLlm = vi.fn(async () => "never");
    const harness = await createServiceHarness({ callLlm });
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(
      harness.child.hostApi.callLlm("hi", { signal: controller.signal }),
    ).rejects.toThrow(/already gone/u);
    expect(callLlm).not.toHaveBeenCalled();
    expect(harness.requests).toHaveLength(0);
  });

  it("replies with the contract's effect-boundary-denied code", async () => {
    const harness = await createServiceHarness({
      callLlm: async () => {
        throw new EffectBoundaryDeniedError(PLUGIN_ID, "callLlm", undefined, "headless");
      },
    });
    await expect(harness.child.hostApi.callLlm("hi")).rejects.toMatchObject({
      code: "effect-boundary-denied",
    });
    expect(HOSTAPI_PATH_CONTRACTS.callLlm.errors).toContain("effect-boundary-denied");
  });
});

describe("resolveApiKey crosses as an opaque lease", () => {
  it("releases the same host registration without sending key bytes", async () => {
    const release = vi.fn(async () => {});
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({
        ok: true,
        vendor: "openai",
        baseUrl: "https://api.example.test",
        exposure: "lease" as const,
        leaseId: "lease_test",
        onClosed: () => () => {},
        release,
      }),
    });
    const result = await harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vendor).toBe("openai");
    expect(result.baseUrl).toBe("https://api.example.test");
    expect(result.exposure).toBe("lease");
    if (result.exposure !== "lease") return;
    expect(result.leaseId).toBe("lease_test");
    expect(harness.host.openSubscriptionCount).toBe(1);

    await result.release();
    await settle();
    // Release both the child registration and host lease.
    expect(release).toHaveBeenCalledTimes(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain("sk-live");
  });

  it("copies a reviewed raw result once and releases its registration", async () => {
    const release = vi.fn(async () => {});
    const raw = Object.defineProperties({
      ok: true as const, exposure: "raw" as const, vendor: "openai",
      key: "synthetic-secret", release,
    }, {
      handleId: { value: "raw_test" },
      onClosed: { value: () => () => {} },
    });
    const harness = await createServiceHarness({ resolveApiKey: async () => raw });
    const result = await harness.child.hostApi.resolveApiKey!({ purpose: "llm", exposure: "raw" });
    expect(result).toMatchObject({ ok: true, exposure: "raw", key: "synthetic-secret" });
    expect(harness.host.openSubscriptionCount).toBe(1);
    if (!result.ok) throw new Error("raw result missing");
    await result.release();
    await settle();
    expect(release).toHaveBeenCalledOnce();
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("carries a denial without opening a lease", async () => {
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({ ok: false, reason: "not-whitelisted" }),
    });
    const result = await harness.child.hostApi.resolveApiKey!({ purpose: "stt" });
    expect(result).toEqual({ ok: false, reason: "not-whitelisted" });
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("orders a closure raised during adoption after the reply and replays it to a late listener", async () => {
    const release = vi.fn(async () => {});
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({
        ok: true, exposure: "lease" as const, vendor: "openai", leaseId: "lease_closed_during_adoption",
        onClosed: (listener) => { listener("revoked"); return () => {}; },
        release,
      }),
    });
    const result = await harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    if (!result.ok || result.exposure !== "lease") throw new Error("expected lease");
    const onClosed = vi.fn();
    result.onClosed(onClosed);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onClosed).toHaveBeenCalledExactlyOnceWith("revoked");
    expect(harness.replies.find((reply) => reply.id !== null)).toBeDefined();
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the host lease when the child dies holding it", async () => {
    const release = vi.fn(async () => {});
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({
        ok: true,
        vendor: "anthropic",
        exposure: "lease" as const,
        leaseId: "lease_child_dies",
        onClosed: () => () => {},
        release,
      }),
    });
    await harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    expect(harness.host.openSubscriptionCount).toBe(1);
    expect(harness.killChild()).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("drops the credential when the child dies while the resolve is in flight", async () => {
    const release = vi.fn(async () => {});
    let admit!: () => void;
    const harness = await createServiceHarness({
      resolveApiKey: () =>
        new Promise((resolve) => {
          admit = () =>
            resolve({ ok: true, vendor: "openai", exposure: "lease", leaseId: "lease_pending", onClosed: () => () => {}, release });
        }),
    });
    const pending = harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    await settle();
    // Release credentials arriving after child death instead of replying with an ownerless live lease.
    harness.killChild();
    admit();
    await expect(pending).rejects.toMatchObject({ code: "plugin-inactive" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("refuses a purpose the host does not define", async () => {
    const resolveApiKey = vi.fn();
    const harness = await createServiceHarness({ resolveApiKey });
    await expect(
      harness.child.hostApi.resolveApiKey!({
        purpose: "mining" as "llm",
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("leaves the signal off the wire and cancels by request instead", async () => {
    let hostSignal: AbortSignal | undefined;
    const harness = await createServiceHarness({
      resolveApiKey: async (opts) => {
        hostSignal = opts.signal;
        return { ok: false, reason: "aborted" };
      },
    });
    const controller = new AbortController();
    await harness.child.hostApi.resolveApiKey!({ purpose: "llm", signal: controller.signal });
    expect(wireArg<Record<string, unknown>>(harness, "resolveApiKey", 0)).toEqual({
      purpose: "llm",
    });
    expect(hostSignal).toBeInstanceOf(AbortSignal);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });
});

describe("context.log reaches the host and is not merely sent", () => {
  it("delivers the plugin's own log line, meta and all, to the host sink", async () => {
    const harness = await createServiceHarness();

    harness.pluginContext.log("worker exited before becoming healthy", { code: 1 });
    harness.pluginContext.log("no meta on this one");
    await settle();

    expect(harness.hostLogs).toEqual([
      { message: "worker exited before becoming healthy", meta: { code: 1 } },
      { message: "no meta on this one", meta: undefined },
    ]);
  });

  it("is not satisfied by the child having sent the notification", async () => {
    // Assert received host logs as well as child-sent notifications.
    const harness = await createServiceHarness();

    harness.pluginContext.log("sent and received are different claims");
    await settle();

    const sent = harness.notifications.filter((n) => n.method === "notifications/ave/log");
    expect(sent).toHaveLength(1);
    expect(harness.hostLogs).toHaveLength(sent.length);
  });

  it("carries a worker's forwarded stderr all the way to the host", async () => {
    // Drive worker stderr through context.log to verify every forwarding hop reaches the host.
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({
      spawnWorker: async () => worker as unknown as SpawnedPluginWorker,
    });

    const handle = await harness.pluginContext.hostApi.spawnWorker!({
      workerId: "control",
      command: "/usr/bin/true",
      args: [],
    });
    handle.onStderr((chunk) => harness.pluginContext.log(`[stderr] ${chunk.trim()}`));
    await settle();

    worker.emitStderr("ModuleNotFoundError: No module named 'lancedb'\n");
    await settle();

    expect(harness.hostLogs.map((line) => line.message)).toContain(
      "[stderr] ModuleNotFoundError: No module named 'lancedb'",
    );
  });
});

describe("spawnWorker crosses as an id, never as a live handle", () => {
  it("preserves lifecycle events delivered before the spawn reply continuation", async () => {
    const worker = makeFakeWorker();
    const eagerWorker: SpawnedPluginWorker = {
      socketPath: worker.socketPath,
      pid: worker.pid,
      stop: worker.stop,
      onStdout: (listener) => listener("already written"),
      onStderr: (listener) => listener("already warned"),
      onExit: (listener) => listener({ code: 0, signal: null }),
    };
    const harness = await createServiceHarness({ spawnWorker: async () => eagerWorker });

    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "short-lived",
      command: "/bin/true",
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    handle.onStderr((chunk) => stderr.push(chunk));
    handle.onExit((info) => exits.push(info));

    expect(stdout).toEqual(["already written"]);
    expect(stderr).toEqual(["already warned"]);
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it.each([
    ["events", Array.from({ length: 257 }, () => "")],
    ["bytes", ["x".repeat(512 * 1024 + 1)]],
  ])("rejects and releases a worker whose handoff exceeds its %s bound", async (_kind, chunks) => {
    const worker = makeFakeWorker();
    const eagerWorker: SpawnedPluginWorker = {
      socketPath: worker.socketPath,
      pid: worker.pid,
      stop: worker.stop,
      onStdout: (listener) => {
        for (const chunk of chunks) listener(chunk);
      },
      onStderr: () => {},
      onExit: () => {},
    };
    const harness = await createServiceHarness({ spawnWorker: async () => eagerWorker });

    await expect(harness.child.hostApi.spawnWorker!({
      workerId: "noisy-startup",
      command: "/bin/true",
    })).rejects.toMatchObject({ code: "payload-too-large" });
    expect(worker.stopped()).toBe(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("drops unlistened live output after handoff without changing exit status", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "unlistened-after-reply",
      command: "/bin/true",
    });
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    handle.onExit((info) => exits.push(info));
    for (let index = 0; index < 300; index += 1) worker.emitStdout("unlistened");
    const stdout: string[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    expect(stdout).toEqual([]);
    expect(worker.stopped()).toBe(0);
    expect(exits).toEqual([]);
    worker.emitStdout("listened");
    worker.emitExit(9, null);
    expect(stdout).toEqual(["listened"]);
    expect(exits).toEqual([{ code: 9, signal: null }]);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("drops unknown worker events without retaining ownerless state", async () => {
    const harness = await createServiceHarness();
    for (let index = 0; index < 300; index += 1) {
      expect(harness.child.deliver({
        jsonrpc: "2.0",
        method: "notifications/ave/subscription",
        params: { subscriptionId: `worker_unknown_${index}`, payload: { kind: "stdout", chunk: "queued" } },
      })).toBe("unknown-subscription");
    }
    expect(harness.child.openSubscriptionCount).toBe(0);
    expect(harness.child.hostGone()).toBe(0);
  });

  it("releases the host handle when worker listener setup fails", async () => {
    const worker = makeFakeWorker();
    const brokenWorker: SpawnedPluginWorker = {
      socketPath: worker.socketPath,
      pid: worker.pid,
      stop: worker.stop,
      onStdout: () => {
        throw new Error("pre-listener output overflow");
      },
      onStderr: worker.onStderr,
      onExit: worker.onExit,
    };
    const harness = await createServiceHarness({ spawnWorker: async () => brokenWorker });

    await expect(harness.child.hostApi.spawnWorker!({
      workerId: "listener-setup-failure",
      command: "/bin/true",
    })).rejects.toMatchObject({ code: "host-internal" });
    expect(worker.stopped()).toBe(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("clears captured output and both ledgers after rejected setup and ignores late frames", async () => {
    const worker = makeFakeWorker();
    let rejected = true;
    const harness = await createServiceHarness({ spawnWorker: async () => rejected ? {
      ...worker,
      onStdout: (listener) => listener("captured before rejection"),
      onStderr: () => { throw new Error("listener setup failed"); },
    } : worker });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(harness.child.hostApi.spawnWorker!({ workerId: "rejected", command: "/bin/true" })).rejects.toMatchObject({ code: "host-internal" });
      const request = harness.requests.at(-1)!;
      expect(harness.child.deliver({ jsonrpc: "2.0", method: "notifications/ave/subscription", params: {
        subscriptionId: `worker_${request.id}`, payload: { kind: "stdout", chunk: "late" },
      } })).toBe("unknown-subscription");
      expect(harness.child.openSubscriptionCount).toBe(0);
      expect(harness.host.openSubscriptionCount).toBe(0);
    }
    rejected = false;
    const handle = await harness.child.hostApi.spawnWorker!({ workerId: "valid", command: "/bin/true" });
    const stdout: string[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    worker.emitStdout("valid output");
    expect(stdout).toEqual(["valid output"]);
    handle.stop();
  });

  it("releases and clears both queues when a captured-output listener throws", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => ({
      ...worker,
      onStdout: (listener) => { listener("first"); listener("second"); },
      onStderr: (listener) => listener("warning"),
    }) });
    const handle = await harness.child.hostApi.spawnWorker!({ workerId: "throwing-listener", command: "/bin/true" });
    const failure = new Error("listener failed");
    const listener = vi.fn(() => { throw failure; });
    expect(() => handle.onStdout(listener)).toThrow(failure);
    expect(listener).toHaveBeenCalledTimes(1);
    const stderr = vi.fn();
    handle.onStderr(stderr);
    expect(stderr).not.toHaveBeenCalled();
    expect(worker.stopped()).toBe(1);
    expect(harness.child.openSubscriptionCount).toBe(0);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("clears pre-listener output when the plugin stops the worker", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => ({
      ...worker,
      onStdout: (listener) => { worker.onStdout(listener); listener("discard on stop"); },
    }) });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "stopped-before-listening",
      command: "/bin/true",
    });

    handle.stop();
    const stdout: string[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));

    expect(stdout).toEqual([]);
    expect(worker.stopped()).toBe(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("gives the plugin a handle whose methods are local", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/usr/bin/python3",
    });
    expect(handle.socketPath).toBe("/run/worker.sock");
    expect(handle.pid).toBe(4242);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    handle.onStderr((chunk) => stderr.push(chunk));
    handle.onExit((info) => exits.push(info));

    worker.emitStdout("indexed 3");
    worker.emitStderr("warn: slow");
    await settle();
    expect(stdout).toEqual(["indexed 3"]);
    expect(stderr).toEqual(["warn: slow"]);
  });

  it("sends the spec through unchanged and keeps the process host-side", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/usr/bin/python3",
      args: ["-u", "worker.py"],
      udsArgName: { env: "AVE_CONTROL_SOCKET" },
    });
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "indexer",
      command: "/usr/bin/python3",
      args: ["-u", "worker.py"],
      udsArgName: { env: "AVE_CONTROL_SOCKET" },
    });
    // Return only IDs and scalars; live process handles remain host-owned.
    const request = harness.requests.find((request) => pathOfRequest(request) === "spawnWorker")!;
    const reply = harness.replies.find((reply) => reply.id === request.id)!;
    expect("result" in reply).toBe(true);
    if (!("result" in reply)) return;
    expect(Object.keys(reply.result as object).sort()).toEqual([
      "handleId",
      "pid",
      "socketPath",
    ]);
  });

  it("delivers exit once and releases both sides", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
    handle.onExit((info) => exits.push(info));
    expect(harness.host.openSubscriptionCount).toBe(1);

    worker.emitExit(0, null);
    await settle();
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(harness.host.openSubscriptionCount).toBe(0);
    // The host owns exit and closes both registrations from one decision.
    expect(harness.child.openSubscriptionCount).toBe(0);
    // Never signal an already-reaped worker PID; it may have been reused.
    expect(worker.stopped()).toBe(0);
  });

  it("stops the host-owned process when the plugin calls stop()", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    handle.stop();
    await settle();
    expect(worker.stopped()).toBe(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(harness.child.openSubscriptionCount).toBe(0);
  });

  it("stops the process when the child dies still holding the handle", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    expect(harness.killChild()).toBe(1);
    expect(worker.stopped()).toBe(1);
  });

  it("stops a worker created after the child went away during spawn", async () => {
    const worker = makeFakeWorker();
    let completeSpawn!: (value: SpawnedPluginWorker) => void;
    const spawn = new Promise<SpawnedPluginWorker>((resolve) => { completeSpawn = resolve; });
    const harness = await createServiceHarness({ spawnWorker: async () => spawn });
    const pending = harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    const reservationCount = () => (harness.host as unknown as { pendingSubscriptionCount: number })
      .pendingSubscriptionCount;
    expect(reservationCount()).toBe(1);
    expect(harness.killChild()).toBe(0);
    expect(reservationCount()).toBe(0);
    completeSpawn(worker);
    await expect(pending).rejects.toMatchObject({ code: "host-internal" });
    expect(worker.stopped()).toBe(1);
    expect(harness.host.openSubscriptionCount).toBe(0);
    expect(reservationCount()).toBe(0);
  });

  it("drops worker output produced after the handle was released", async () => {
    // Ignore events arriving after release while a worker pipe drains.
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    const stdout: string[] = [];
    handle.onStdout((chunk) => stdout.push(chunk));
    handle.stop();
    await settle();
    expect(() => worker.emitStdout("late")).not.toThrow();
    await settle();
    expect(stdout).toEqual([]);
  });

  it("replies with the contract's effect-boundary-denied code", async () => {
    const harness = await createServiceHarness({
      spawnWorker: async () => {
        throw new EffectBoundaryDeniedError(PLUGIN_ID, "spawnWorker", "indexer", "denied");
      },
    });
    await expect(
      harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(HOSTAPI_PATH_CONTRACTS.spawnWorker.errors).toContain("effect-boundary-denied");
  });
});

describe("emitEvent keeps its synchronous throw and its host-side authority", () => {
  it("throws in the child, before any round trip, on an undeclared event", async () => {
    const emit = vi.fn();
    const harness = await createServiceHarness({ emitEvent: emit });
    expect(() => harness.child.hostApi.emitEvent("audit.tampered")).toThrow(
      /not allowed to emit undeclared event/u,
    );
    expect(harness.requests).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("reaches the host — which re-decides and writes the denial audit", async () => {
    const emit = vi.fn();
    const harness = await createServiceHarness({ emitEvent: emit });
    expect(harness.child.hostApi.emitEvent("demo.ping", { n: 1 })).toBeUndefined();
    await settle();
    expect(emit).toHaveBeenCalledWith("demo.ping", { n: 1 });
  });

  it("reports a host refusal through the log channel instead of dropping it", async () => {
    // Fire-and-forget emit refusals need diagnostics without unhandled rejection.
    const harness = await createServiceHarness({
      emitEvent: () => {
        throw new Error("host says no");
      },
    });
    harness.child.hostApi.emitEvent("demo.ping");
    await settle();
    expect(detachedLog(harness)).toMatchObject({
      message: "hostApi.emitEvent failed after returning",
      meta: { error: "Host request failed." },
    });
  });
});

describe("a void-declared member that drifts is refused, not absorbed", () => {
  it("surfaces the dispatcher's void check when the host returns a value", async () => {
    // Return host results unchanged so void-contract checks can detect drift.
    const harness = await createServiceHarness({
      emitEvent: (() => "surprise") as unknown as PluginHostApi["emitEvent"],
    });
    harness.child.hostApi.emitEvent("demo.ping");
    await settle();
    expect(detachedLog(harness).meta).toMatchObject({
      error: expect.stringContaining("declares no result but returned one") as string,
    });
  });
});

describe("logEvent crosses as plain data", () => {
  it("forwards the level, message and data", async () => {
    const logEvent = vi.fn();
    const harness = await createServiceHarness({ logEvent });
    expect(harness.child.hostApi.logEvent("warn", "slow", { ms: 900 })).toBeUndefined();
    await settle();
    expect(logEvent).toHaveBeenCalledWith("warn", "slow", { ms: 900 });
  });

  it("refuses a level outside the declared three", async () => {
    const logEvent = vi.fn();
    const harness = await createServiceHarness({ logEvent });
    harness.child.hostApi.logEvent("trace" as "info", "noisy");
    await settle();
    expect(logEvent).not.toHaveBeenCalled();
    expect(detachedLog(harness).message).toBe("hostApi.logEvent failed after returning");
  });
});

function handleIdOf(harness: ServiceHarness, path: string): string {
  const index = harness.requests.findIndex((request) => pathOfRequest(request) === path);
  expect(index, `no '${path}' request was sent`).toBeGreaterThanOrEqual(0);
  const reply = harness.replies[index];
  expect(reply !== undefined && "result" in reply, `'${path}' did not succeed`).toBe(true);
  return (reply as { result: { handleId: string } }).result.handleId;
}

function closures(harness: ServiceHarness): { subscriptionId: string; reason: string }[] {
  return harness.pushed.flatMap((notification) =>
    notification.method === "notifications/ave/subscription/closed"
      ? [{ ...notification.params }]
      : [],
  );
}

describe("a delegated worker cannot reach further than the plugin process itself", () => {
  it.runIf(process.platform !== "win32")("passes grants that lie inside the child's own envelope straight through", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/usr/bin/python3",
      allowReadPaths: [`${PLUGIN_ROOT}/runtime`, PLUGIN_DATA_DIR],
      allowWritePaths: [`${PLUGIN_DATA_DIR}/index`],
    });
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "indexer",
      command: "/usr/bin/python3",
      allowReadPaths: [`${PLUGIN_ROOT}/runtime`, PLUGIN_DATA_DIR],
      allowWritePaths: [`${PLUGIN_DATA_DIR}/index`],
    });
  });

  it("on Windows, grants the envelope root that holds each path, never a path the plugin can re-point", async () => {
    // Windows grants must name the containing envelope root, never child-controlled linked descendants.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await harness.child.hostApi.spawnWorker!({
        workerId: "ffmpeg",
        command: "/usr/bin/ffmpeg",
        allowReadPaths: [`${PLUGIN_ROOT}/runtime`, `${PLUGIN_DATA_DIR}/link/in.m4a`, WIDENED_READ_ROOT],
        allowWritePaths: [`${PLUGIN_DATA_DIR}/link/segments`, `${PLUGIN_DATA_DIR}/index`],
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "ffmpeg",
      command: "/usr/bin/ffmpeg",
      allowReadPaths: [PLUGIN_ROOT, WIDENED_READ_ROOT],
      allowWritePaths: [PLUGIN_DATA_DIR],
    });
  });

  it("on Windows, admits and maps a case-variant spelling of an envelope root as that root", async () => {
    // Use canonical case-folded containment so alternate Windows spelling cannot create a separate grant.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await harness.child.hostApi.spawnWorker!({
        workerId: "ffmpeg",
        command: "/usr/bin/ffmpeg",
        allowWritePaths: [`${PLUGIN_ROOT}/DATA/work`],
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "ffmpeg",
      command: "/usr/bin/ffmpeg",
      allowWritePaths: [PLUGIN_DATA_DIR],
    });
  });

  it("refuses a write grant outside the jail, and never reaches the supervisor", async () => {
    // A delegation refusal must occur before spawning anything.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "escape",
        command: "/bin/sh",
        allowWritePaths: ["/"],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a read grant outside every root the child holds", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "peek",
        command: "/usr/bin/python3",
        allowReadPaths: ["/etc"],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("admits a read grant inside a root the HOST widened the child with", async () => {
    // Host-widened envelope roots are delegable without a second allowlist.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: `${WIDENED_READ_ROOT}/venv/bin/python`,
      allowReadPaths: [`${WIDENED_READ_ROOT}/venv/bin/python`],
    });
    expect(spawnWorker).toHaveBeenCalledWith({
      workerId: "indexer",
      command: `${WIDENED_READ_ROOT}/venv/bin/python`,
      // Windows grants name the envelope root containing the requested path.
      allowReadPaths: [process.platform === "win32" ? WIDENED_READ_ROOT : `${WIDENED_READ_ROOT}/venv/bin/python`],
    });
  });

  it("does not let a widened READ root become writable through a worker", async () => {
    // Read-only host-directory widening must not become a writable delegated grant.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "rewrite-runtime",
        command: "/bin/sh",
        allowWritePaths: [`${WIDENED_READ_ROOT}/venv`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("does not let the plugin's own runtime root become writable through a worker", async () => {
    // A writable child subdirectory never grants its siblings under the readable package root.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "rewrite-bundle",
        command: "/bin/sh",
        allowWritePaths: [`${PLUGIN_ROOT}/dist`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a sibling of the widened root, not merely its string prefix", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "near-miss",
        command: "/usr/bin/python3",
        allowReadPaths: [`${WIDENED_READ_ROOT}-elsewhere`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("compares what a grant MEANS, not what it says", async () => {
    // Resolve traversal before containment; a string prefix can still name an outside path.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "traverse",
        command: "/bin/sh",
        allowWritePaths: [`${PLUGIN_DATA_DIR}/../../../etc`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a sibling directory whose name merely starts with the jail's", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "prefix",
        command: "/bin/sh",
        allowWritePaths: [`${PLUGIN_DATA_DIR}-elsewhere`],
      }),
    ).rejects.toMatchObject({ code: "effect-boundary-denied" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a relative grant rather than resolving it against the host's cwd", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "relative",
        command: "/bin/sh",
        allowWritePaths: ["data"],
      }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a spec field the boundary does not decode", async () => {
    // New grant-shaped fields must be decoded before reaching the supervisor.
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({
        workerId: "future",
        command: "/bin/sh",
        allowNetworkTo: ["*"],
      } as never),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("refuses a spec whose command is not a string", async () => {
    const spawnWorker = vi.fn(async () => makeFakeWorker());
    const harness = await createServiceHarness({ spawnWorker });
    await expect(
      harness.child.hostApi.spawnWorker!({ workerId: "typed", command: 7 } as never),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(spawnWorker).not.toHaveBeenCalled();
  });
});

describe("a host-side revocation reaches the child", () => {
  it("tells the child when the host releases a registration it still holds", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    const handleId = handleIdOf(harness, "spawnWorker");
    expect(closures(harness)).toEqual([]);

    worker.emitExit(0, null);
    await settle();

    // Host revocation must send subscription-closed to the child.
    expect(closures(harness)).toEqual([{ subscriptionId: handleId, reason: "revoked" }]);
  });

  it("does not echo a close the child asked for", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    const handle = await harness.child.hostApi.spawnWorker!({
      workerId: "indexer",
      command: "/bin/true",
    });
    handle.stop();
    await settle();
    expect(closures(harness)).toEqual([]);
  });

  it("does not write to a child that is already gone", async () => {
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    expect(harness.killChild()).toBe(1);
    await settle();
    expect(closures(harness)).toEqual([]);
  });

  it("says nothing about a cancellable request, which the child holds no registration for", async () => {
    const controller = new AbortController();
    const harness = await createServiceHarness({ callLlm: async () => "answered" });
    await harness.child.hostApi.callLlm("hello", { signal: controller.signal });
    await settle();
    // Settled request controllers open no child registration and need no close notification.
    expect(closures(harness)).toEqual([]);
    expect(harness.host.openSubscriptionCount).toBe(0);
  });

  it("refuses to cancel a subscription through the cancellation mechanism", async () => {
    // Cancellation names a request, never a worker-handle ID.
    const worker = makeFakeWorker();
    const harness = await createServiceHarness({ spawnWorker: async () => worker });
    await harness.child.hostApi.spawnWorker!({ workerId: "indexer", command: "/bin/true" });
    const handleId = handleIdOf(harness, "spawnWorker");
    harness.host.handleNotification({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: handleId, reason: "not a request" },
    });
    await settle();
    expect(harness.host.openSubscriptionCount).toBe(1);
    expect(worker.stopped()).toBe(0);
    expect(closures(harness)).toEqual([]);
  });
});

describe("a revoked key lease closes in the child", () => {
  it("notifies listeners when the host takes the lease back", async () => {
    const release = vi.fn(async () => {});
    const harness = await createServiceHarness({
      resolveApiKey: async () => ({
        ok: true as const,
        vendor: "openai" as const,
        exposure: "lease" as const,
        leaseId: "lease_revoke",
        onClosed: () => () => {},
        release,
      }),
    });
    const lease = await harness.child.hostApi.resolveApiKey!({ purpose: "llm" });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    if (lease.exposure !== "lease") return;
    const onClosed = vi.fn();
    lease.onClosed(onClosed);

    const handleId = handleIdOf(harness, "resolveApiKey");
    harness.child.deliver({
      jsonrpc: "2.0",
      method: "notifications/ave/subscription/closed",
      params: {
        subscriptionId: handleId,
        reason: "revoked",
      },
    });

    // Host revocation must clear the child credential closure.
    expect(onClosed).toHaveBeenCalledWith("revoked");
  });
});

describe("startAudioCapture crosses as an id, and the PCM survives the wire", () => {
  function makeFakeCapture(opened = { microphone: true, systemAudio: true }) {
    const frames: ((frame: { seq: number; pcm: Uint8Array; peak: number }) => void)[] = [];
    const ends: ((end: { reason: string; detail?: string }) => void)[] = [];
    const stop = vi.fn(async () => {});
    return {
      captureId: "capture-1",
      opened,
      stop,
      onFrame: (listener: (frame: { seq: number; pcm: Uint8Array; peak: number }) => void) => {
        frames.push(listener);
        return () => {};
      },
      onEnd: (listener: (end: { reason: string; detail?: string }) => void) => {
        ends.push(listener);
        return () => {};
      },
      emitFrame: (frame: { seq: number; pcm: Uint8Array; peak: number }) => {
        for (const listener of frames) listener(frame);
      },
      emitEnd: (end: { reason: string; detail?: string }) => {
        for (const listener of ends) listener(end);
      },
    };
  }

  it("delivers bytes no text codec could round-trip", async () => {
    const capture = makeFakeCapture();
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000,
      frameMs: 200,
      microphone: true,
      systemAudio: true,
    });

    const got: Uint8Array[] = [];
    handle.onFrame((frame) => got.push(frame.pcm));
    // Exercise non-UTF-8 audio bytes; corrupting NUL also corrupts int16 silence.
    const pcm = new Uint8Array([0x00, 0x00, 0x80, 0xff, 0xfe, 0x7f]);
    capture.emitFrame({ seq: 0, pcm, peak: 0.5 });
    await settle();

    expect(got).toHaveLength(1);
    expect(Array.from(got[0]!)).toEqual(Array.from(pcm));
  });

  it("carries seq and peak alongside the bytes", async () => {
    const capture = makeFakeCapture();
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: false,
    });
    const seen: { seq: number; peak: number }[] = [];
    handle.onFrame(({ seq, peak }) => seen.push({ seq, peak }));

    capture.emitFrame({ seq: 7, pcm: new Uint8Array([1, 2]), peak: 0.25 });
    await settle();

    // Preserve sequence numbers so plugins can detect lost frames.
    expect(seen).toEqual([{ seq: 7, peak: 0.25 }]);
  });

  it("reports what actually opened, and hands over an id rather than the capture", async () => {
    const capture = makeFakeCapture({ microphone: true, systemAudio: false });
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: true,
    });

    expect(handle.opened).toEqual({ microphone: true, systemAudio: false });

    const reply = await harness.host.handle(
      harness.requests.find((request) => pathOfRequest(request) === "startAudioCapture")!,
    );
    expect("result" in reply).toBe(true);
    if (!("result" in reply)) return;
    // Return only capture data and IDs; never live media objects or functions.
    expect(Object.keys(reply.result as object).sort()).toEqual([
      "captureId",
      "handleId",
      "opened",
    ]);
  });

  it("delivers the end once, with the reason the host gave", async () => {
    const capture = makeFakeCapture();
    const harness = await createServiceHarness({
      startAudioCapture: async () => capture,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.startAudioCapture({
      sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: false,
    });
    const ends: { reason: string; detail?: string }[] = [];
    handle.onEnd((end) => ends.push(end));

    capture.emitEnd({ reason: "sources-lost", detail: "microphone track ended" });
    await settle();

    // Preserve capture end reasons so source loss cannot appear as an intentional stop.
    expect(ends).toEqual([{ reason: "sources-lost", detail: "microphone track ended" }]);
  });
});

describe("attachFloatingPanel crosses as a receipt, and the detach reason survives", () => {
  function makeFakePanel(height = 180) {
    const listeners: ((reason: string) => void)[] = [];
    const detach = vi.fn(async () => {});
    const resize = vi.fn(async (next: number) => Math.min(next, 300));
    return {
      panelId: "panel-1",
      height,
      detach,
      resize,
      onDetached: (listener: (reason: string) => void) => { listeners.push(listener); },
      fire: (reason: string) => { for (const listener of listeners) listener(reason); },
      listenerCount: () => listeners.length,
    };
  }

  it("hands over an id rather than the panel", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({
      extensionId: "some-card",
      height: 240,
    });

    // Return the applied height after clamping, not the requested height.
    expect(handle.height).toBe(180);

    const index = harness.requests.findIndex((request) => pathOfRequest(request) === "attachFloatingPanel");
    const reply = harness.replies[index];
    expect("result" in reply).toBe(true);
    if (!("result" in reply)) return;
    for (const value of Object.values(reply.result as Record<string, unknown>)) {
      expect(typeof value).not.toBe("function");
    }
  });

  it("resizes through its own path and returns what the host applied", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
      resizeFloatingPanel: async (_id: string, next: number) => Math.min(next, 300),
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });

    // Resize is a separately addressed path because handle methods cannot cross the wire.
    expect(await handle.resize(900)).toBe(300);
    expect(handle.height).toBe(300);
    expect(
      harness.requests.some((request) => pathOfRequest(request) === "resizeFloatingPanel"),
    ).toBe(true);
  });

  it("detaches the host-side slot when the child releases its receipt", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });

    await handle.detach();
    await settle();

    // Disposing the subscription must actually detach the visible slot.
    expect(panel.detach).toHaveBeenCalledTimes(1);
  });

  it("delivers the reason the host gave, once", async () => {
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });
    const reasons: string[] = [];
    handle.onDetached((reason) => reasons.push(reason));

    panel.fire("user-closed");
    panel.fire("user-closed");
    await settle();

    expect(reasons).toEqual(["user-closed"]);
  });

  it("tells a late subscriber the real reason, not a fabricated one", async () => {
    // Replay the actual detach reason across the subscribe microtask gap so user closure cannot be mistaken for plugin-requested teardown.
    const panel = makeFakePanel();
    const harness = await createServiceHarness({
      attachFloatingPanel: async () => panel,
    } as unknown as Partial<PluginHostApi>);
    const handle = await harness.child.hostApi.attachFloatingPanel({ extensionId: "some-card" });

    panel.fire("renderer-gone");
    await settle();

    const late: string[] = [];
    handle.onDetached((reason) => late.push(reason));
    expect(late).toEqual(["renderer-gone"]);
  });
});
