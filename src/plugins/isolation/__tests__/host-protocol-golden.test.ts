/**
 * The host protocol, pinned frame by frame.
 *
 * Every golden here is recorded over the REAL stack: `servePluginChild` and the
 * real child runtime on one side, `createOutOfProcessPluginFactory` with the
 * dispatch table assembled from the group factories on the other, joined by two
 * in-memory `PassThrough`s — the substitution `out-of-process-plugin.test.ts`
 * makes, and the only one. The host answers from `createGoldenHost`, so a
 * transcript is a function of the plugin module, and a transcript that changes
 * is the wire that changed (plugin-hostapi-protocol.md §10.1).
 *
 * Three kinds, under `fixtures/host-protocol/1/`:
 *
 *  - `methods/<method>.json`: the request one call puts on the wire and the
 *    reply it gets, for every `ave/host/*` and `ave/instance/*` method, and
 *    `methods/errors/<code>.json` for every code of the closed error set.
 *  - `notifications/<name>.json`: one frame per notification kind (§3.4).
 *  - `plugins/<id>/expected.jsonl`: the whole conversation for one installed
 *    plugin's surface (§9.2), in the order it crossed.
 *
 * Frames are compared after canonical key ordering and id normalisation: a
 * UUID becomes `<uuid-N>` by first appearance, so a transcript does not change
 * because a random id did. Regenerate with `-u` after a deliberate wire change
 * and read the diff — it IS the protocol change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PassThrough, type Readable } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import { flattenAgentPluginsManifest } from "../../public-contract.js";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { EffectBoundaryDeniedError } from "../../../permissions/effect-enforcement.js";
import { ManifestIntegrityError } from "../../../permissions/manifest-integrity.js";
import { PluginRuntimeDetachedOperationError } from "../../runtime/detached-operation.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
} from "../../public-contract.js";
import { servePluginChild } from "../plugin-child-main.js";
import { createOutOfProcessPluginFactory } from "../out-of-process-plugin.js";
import type { ChildLink } from "../plugin-child-transport.js";
import {
  FRAME_BYTES_MAX,
  HOST_API_WIRE_ERROR_CODES,
  HOST_PROTOCOL_NOTIFICATIONS,
  HOSTAPI_PATH_CONTRACTS,
  WIRE_BYTES_MAX,
  hostApiMethodOf,
  type HostApiPath,
  type HostApiWireErrorCode,
} from "../host-api-wire.js";
import { PLUGIN_INSTANCE_METHODS } from "../plugin-instance-wire.js";
import { createGoldenHost, type GoldenHost, type GoldenHostOverrides } from "./host-protocol-golden-host.js";

const GOLDEN_ROOT = fileURLToPath(new URL("./fixtures/host-protocol/1/", import.meta.url));
const INVOKER_ENTRY = join(GOLDEN_ROOT, "invoker.mjs");

type Frame = Record<string, unknown>;

/** One frame as it crossed, and which end wrote it. */
interface RecordedFrame {
  readonly from: "host" | "child";
  readonly frame: Frame;
}

/**
 * The `ave/host/*` members each fixture calls — the §9.2 survey. The
 * transcript is held to this set as well as to its snapshot, so a fixture that
 * stopped calling a member fails on the set rather than on a diff a reviewer
 * might accept. Child-local members (`config.get`, `getInstalledPluginIds`)
 * are answered without a round trip and so are not here.
 */
const PLUGIN_SURVEY: Readonly<Record<string, readonly HostApiPath[]>> = {
  "vega-helper": [
    "onEvent",
    "onPluginsChanged",
    "config.onChange",
    "config.set",
    "hasRoutineBySource",
    "callLlm",
    "triggerConversation",
  ],
  "lyra-mail": [
    "authRedirect.open",
    "authRedirect.wait",
    "authRedirect.close",
    "openAuthWindow",
    "openAuthPartitionViewer",
    "storage.writeEncrypted",
    "storage.readEncrypted",
    "probePrivateHost",
    "clearAuthPartition",
  ],
  "local-indexer": ["pickFolders", "resolveMappedDriveRoot", "resolveApiKey", "spawnWorker"],
  meeting: ["resolveApiKey", "attachFloatingPanel", "startAudioCapture", "spawnWorker", "callLlm"],
  "orion-api": ["probePrivateHost", "openAuthWindow", "getAuthPartitionCookies", "spawnWorker"],
};

const INVOKER_MANIFEST: PluginManifest = {
  id: "golden-invoker",
  name: "Golden Invoker",
  version: "1.0.0",
  entry: "invoker.mjs",
  description: "calls one hostApi member per tool call, so each method's golden is one pair",
  tools: ["invoke_member", "invoke_cancelled", "write_log", "dispose_all"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  })),
};

let aveHomeRoot: string;
let previousAveHome: string | undefined;

beforeAll(() => {
  // The envelope derivation reads `AVE_HOME` for the host-owned rows of the
  // one plugin that has them; a recording must never resolve the real one.
  previousAveHome = process.env.AVE_HOME;
  aveHomeRoot = mkdtempSync(join(tmpdir(), "host-protocol-golden-"));
  process.env.AVE_HOME = join(aveHomeRoot, ".ave");
});

afterAll(() => {
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(aveHomeRoot, { recursive: true, force: true });
});

/** Let the notification hops and queued replies drain. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Record every frame written to `stream`, decoded exactly as its reader decodes it. */
function tap(stream: Readable, from: RecordedFrame["from"], frames: RecordedFrame[]): void {
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  stream.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) frames.push({ from, frame });
  });
}

function hostContext(manifest: PluginManifest, host: GoldenHost): PluginRuntimeContext {
  const pluginId = manifest.id;
  // The resolved config the runtime hands a plugin, read from the same host the
  // later snapshots are read from, so construction and re-push agree.
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(manifest.configSchema?.properties ?? {})) {
    const value = host.api.config.get(key);
    if (value !== undefined) config[key] = value;
  }
  return {
    pluginId,
    pluginRoot: `/plugins/${pluginId}`,
    hostRoot: "/app",
    pluginDataDir: `/plugins/${pluginId}/data`,
    pluginSocketDir: `/plugins/${pluginId}/sockets`,
    userHome: "/Users/example",
    aveHome: "/Users/example/.ave",
    config,
    log: () => undefined,
    hostApi: host.api,
  };
}

interface Session {
  readonly instance: RuntimePlugin;
  readonly frames: RecordedFrame[];
  /** Write a frame onto the child's stdout, as a child that built it by hand would. */
  sendAsChild(frame: Frame): void;
}

/** A plugin constructed over the real stack, with both directions recorded. */
async function openSession(
  manifest: PluginManifest,
  entryPath: string,
  host: GoldenHost,
): Promise<Session> {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const frames: RecordedFrame[] = [];
  tap(hostToChild, "host", frames);
  tap(childToHost, "child", frames);
  const service = servePluginChild(hostToChild, childToHost);
  const link: ChildLink = {
    input: childToHost,
    output: hostToChild,
    terminate: () => service.hostGone(),
    onGone: () => undefined,
  };
  const factory = createOutOfProcessPluginFactory({
    manifest,
    entryPath,
    connect: async () => ({ link }),
  });
  const instance = await factory(hostContext(manifest, host));
  await settle();
  return {
    instance,
    frames,
    sendAsChild: (frame) => void childToHost.write(`${JSON.stringify(frame)}\n`),
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Canonical JSON: keys sorted at every depth, every UUID replaced by
 * `<uuid-N>` in order of first appearance across the whole golden, and the
 * checkout's own path replaced, so a golden reads the same on every machine.
 */
function canonicalise(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(GOLDEN_ROOT, "<golden>/")
      .replace(UUID, (uuid) => {
        const key = uuid.toLowerCase();
        if (!ids.has(key)) ids.set(key, `<uuid-${ids.size + 1}>`);
        return ids.get(key)!;
      });
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalise(entry, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalise((value as Record<string, unknown>)[key], ids)]),
    );
  }
  return value;
}

function goldenJson(value: unknown): string {
  return `${JSON.stringify(canonicalise(value, new Map()), null, 2)}\n`;
}

function goldenJsonl(frames: readonly RecordedFrame[]): string {
  const ids = new Map<string, string>();
  return frames.map((recorded) => `${JSON.stringify(canonicalise(recorded, ids))}\n`).join("");
}

/** The reply to `id` from the other end, waiting for it if it has not crossed yet. */
async function replyTo(
  frames: readonly RecordedFrame[],
  request: RecordedFrame,
): Promise<RecordedFrame> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const reply = frames.find(
      (candidate) =>
        candidate.from !== request.from
        && candidate.frame.id === request.frame.id
        && !("method" in candidate.frame),
    );
    if (reply) return reply;
    await settle();
  }
  throw new Error(`no reply to ${String(request.frame.method)} (${String(request.frame.id)})`);
}

function lastRequest(frames: readonly RecordedFrame[], method: string): RecordedFrame {
  const found = frames.findLast((recorded) => recorded.frame.method === method && "id" in recorded.frame);
  if (!found) throw new Error(`no '${method}' request crossed`);
  return found;
}

/** Every golden file under `dir`, relative to it. */
function goldenFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/** The members a plugin reaches over the wire: not child-local, so each is a method. */
const WIRE_PATHS = (Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]).filter(
  (path) => HOSTAPI_PATH_CONTRACTS[path].result !== "child-local",
);

const methodGoldenFile = (method: string): string => join(GOLDEN_ROOT, "methods", `${method}.json`);

/**
 * `code-` in front because `vitest.globalSetup.ts` schema-checks every JSON file
 * under `__tests__` whose name starts with `plugin` or `manifest` as a plugin
 * manifest, and four codes do.
 */
const errorGoldenName = (code: HostApiWireErrorCode): string => `errors/code-${code}.json`;

/** Every frame the invoker session recorded, kept for the notification goldens. */
const recordedForNotifications: RecordedFrame[] = [];

describe("one request/response pair per method", () => {
  it("covers every ave/host method and every ave/instance method, and nothing else", async () => {
    const host = createGoldenHost();
    const session = await openSession(INVOKER_MANIFEST, INVOKER_ENTRY, host);
    const { instance, frames } = session;

    await instance.start?.();
    await instance.onPublished?.();
    await instance.readUiResource?.("ui://golden-invoker/card");
    for (const path of WIRE_PATHS) {
      const outcome = (await instance.handlers.invoke_member!({ path })) as { error?: unknown };
      // A pair whose reply is an error would pin a refusal as the method's
      // shape; the error goldens below are where refusals belong.
      expect(outcome.error, path).toBeUndefined();
    }
    await instance.handlers.write_log!();
    host.fireAll();
    await settle();
    await instance.handlers.dispose_all!();
    await settle();
    await instance.stop?.();
    await settle();
    recordedForNotifications.push(...frames);

    const methods = [
      ...WIRE_PATHS.map((path) => hostApiMethodOf(path)),
      ...Object.values(PLUGIN_INSTANCE_METHODS),
    ];
    for (const method of methods) {
      const request = lastRequest(frames, method);
      const response = await replyTo(frames, request);
      expect("error" in response.frame, method).toBe(false);
      await expect(
        goldenJson({ request: request.frame, response: response.frame }),
      ).toMatchFileSnapshot(methodGoldenFile(method));
    }

    const expected = [
      ...methods.map((method) => `${method}.json`),
      ...HOST_API_WIRE_ERROR_CODES.map((code) => errorGoldenName(code)),
    ].sort();
    expect(goldenFiles(join(GOLDEN_ROOT, "methods"))).toEqual(expected);
  });
});

/** How one error code is provoked, over the same real stack. */
interface ErrorTrigger {
  /** What the golden records as the reason this reply was sent. */
  readonly trigger: string;
  readonly overrides?: GoldenHostOverrides;
  /** Stop the incarnation first, so the request arrives at a host that retired it. */
  readonly afterStop?: boolean;
  /** Produce the request whose reply is the golden, and return it. */
  readonly provoke: (session: Session) => Promise<RecordedFrame>;
}

/** Call one member through the invoker and return the request it sent. */
function throughStub(path: HostApiPath): ErrorTrigger["provoke"] {
  return async (session) => {
    await session.instance.handlers.invoke_member!({ path });
    return lastRequest(session.frames, hostApiMethodOf(path));
  };
}

/** Send a request no stub would build, and return it. */
function byHand(method: string, params: unknown): ErrorTrigger["provoke"] {
  return async (session) => {
    session.sendAsChild({ jsonrpc: "2.0", id: "hand-built", method, params });
    await settle();
    return lastRequest(session.frames, method);
  };
}

const throwing = (error: () => Error) => () => {
  throw error();
};

const ERROR_TRIGGERS: Readonly<Record<Exclude<HostApiWireErrorCode, "protocol-version-mismatch">, ErrorTrigger>> = {
  "plugin-inactive": {
    trigger: "a request that arrives after the host stopped the incarnation",
    afterStop: true,
    provoke: byHand("ave/host/getSecret", { key: "service.token" }),
  },
  "path-unknown": {
    trigger: "a method no hostApi member is spelled as",
    provoke: byHand("ave/host/noSuchMember", {}),
  },
  "path-not-dispatchable": {
    trigger: "a child-local member sent as a request",
    provoke: byHand("ave/host/config/get", { key: "region" }),
  },
  "path-not-implemented": {
    trigger: "a host build without the optional hostFetch member",
    overrides: { hostFetch: undefined },
    provoke: throughStub("hostFetch"),
  },
  "argument-marshalling-rejected": {
    trigger: "params sent as an array instead of an object",
    provoke: byHand("ave/host/getSecret", ["service.token"]),
  },
  "result-marshalling-rejected": {
    trigger: "a void member whose host implementation returned a value",
    overrides: { openExternalUrl: async () => "opened" },
    provoke: throughStub("openExternalUrl"),
  },
  "payload-too-large": {
    trigger: "a hostFetch response body one byte over the boundary limit",
    overrides: { hostFetch: async () => new Response(new Uint8Array(WIRE_BYTES_MAX + 1)) },
    provoke: throughStub("hostFetch"),
  },
  "subscription-unknown": {
    trigger: "a host event bus that delivers to a listener before its registration is adopted",
    overrides: {
      onEvent: (_type: string, handler: (data: unknown) => void) => {
        handler({ replayed: true });
        return () => undefined;
      },
    },
    provoke: throughStub("onEvent"),
  },
  "effect-boundary-denied": {
    trigger: "the effect boundary refused the call",
    overrides: {
      openExternalUrl: throwing(
        () => new EffectBoundaryDeniedError("golden-invoker", "openExternalUrl", "https://example.com/help", "denied"),
      ),
    },
    provoke: throughStub("openExternalUrl"),
  },
  "manifest-integrity-violation": {
    trigger: "the call broke the manifest's integrity pin",
    overrides: {
      openExternalUrl: throwing(
        () => new ManifestIntegrityError("golden-invoker", "invoke_member", "openExternalUrl"),
      ),
    },
    provoke: throughStub("openExternalUrl"),
  },
  "detached-operation": {
    trigger: "the host detached the call and settles it on its own",
    overrides: {
      callLlm: throwing(
        () => new PluginRuntimeDetachedOperationError(new Error("the call outlived its turn"), Promise.resolve()),
      ),
    },
    provoke: throughStub("callLlm"),
  },
  "plugin-storage": {
    trigger: "a storage path outside the plugin's data directory",
    overrides: {
      "storage.read": throwing(
        () => new PluginStorageError("path escapes the plugin data directory", "golden-invoker", "notes/today.bin"),
      ),
    },
    provoke: throughStub("storage.read"),
  },
  "plugin-storage-encryption-unavailable": {
    trigger: "a host with no OS keychain to encrypt with",
    overrides: {
      "storage.writeEncrypted": throwing(() => new PluginStorageEncryptionUnavailableError("golden-invoker")),
    },
    provoke: throughStub("storage.writeEncrypted"),
  },
  "host-internal": {
    trigger: "a host implementation that threw something outside the closed set",
    overrides: { getSecret: throwing(() => new Error("the keychain daemon went away")) },
    provoke: throughStub("getSecret"),
  },
};

describe("one reply per error code", () => {
  it("has a trigger for every code in the closed set", () => {
    expect([...Object.keys(ERROR_TRIGGERS), "protocol-version-mismatch"].sort()).toEqual(
      [...HOST_API_WIRE_ERROR_CODES].sort(),
    );
  });

  for (const [code, { trigger, overrides, afterStop, provoke }] of Object.entries(ERROR_TRIGGERS)) {
    it(code, async () => {
      const host = createGoldenHost(overrides);
      const session = await openSession(INVOKER_MANIFEST, INVOKER_ENTRY, host);
      if (afterStop) await session.instance.stop?.();
      const request = await provoke(session);
      const response = await replyTo(session.frames, request);
      if (!afterStop) await session.instance.stop?.();
      await settle();
      recordedForNotifications.push(...session.frames);

      const error = (response.frame as { error?: { code: number; data?: { code?: string } } }).error;
      expect(error?.data?.code).toBe(code);
      // The JSON-RPC code is the standard one where one exists, and the
      // host-protocol code for everything else (§3.3).
      expect(error?.code).toBe(code === "path-unknown" ? -32601 : -32000);
      await expect(
        goldenJson({ trigger, request: request.frame, response: response.frame }),
      ).toMatchFileSnapshot(join(GOLDEN_ROOT, "methods", errorGoldenName(code as HostApiWireErrorCode)));
    });
  }

  it("protocol-version-mismatch", async () => {
    // Answered by the CHILD, to the one request that carries the version, so
    // it is recorded against the reference runtime alone.
    const hostToChild = new PassThrough();
    const childToHost = new PassThrough();
    const frames: RecordedFrame[] = [];
    tap(hostToChild, "host", frames);
    tap(childToHost, "child", frames);
    const service = servePluginChild(hostToChild, childToHost);
    hostToChild.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "construct-1",
        method: PLUGIN_INSTANCE_METHODS.construct,
        params: { hostProtocol: { version: "999" } },
      })}\n`,
    );
    const request = lastRequest(frames, PLUGIN_INSTANCE_METHODS.construct);
    const response = await replyTo(frames, request);
    service.hostGone();

    const error = (response.frame as { error?: { code: number; data?: { code?: string } } }).error;
    expect(error?.data?.code).toBe("protocol-version-mismatch");
    await expect(
      goldenJson({
        trigger: "a construct naming a host protocol version the runtime does not serve",
        request: request.frame,
        response: response.frame,
      }),
    ).toMatchFileSnapshot(join(GOLDEN_ROOT, "methods", errorGoldenName("protocol-version-mismatch")));
  });
});

describe("a cancelled request", () => {
  it("is aborted host-side and answered as the plugin's own abort would be", async () => {
    let hostSignal: AbortSignal | undefined;
    const host = createGoldenHost({
      callLlm: (_prompt: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          hostSignal = options.signal;
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }),
    });
    const session = await openSession(INVOKER_MANIFEST, INVOKER_ENTRY, host);
    const outcome = (await session.instance.handlers.invoke_cancelled!()) as {
      error?: { name: string };
    };
    await session.instance.stop?.();
    await settle();
    recordedForNotifications.push(...session.frames);

    // The host's controller for THAT request aborted, and the reply carries
    // the name a plugin checks for, so `name === "AbortError"` holds across
    // the wire as it does in-process.
    expect(hostSignal?.aborted).toBe(true);
    expect(outcome.error?.name).toBe("AbortError");
    const request = lastRequest(session.frames, hostApiMethodOf("callLlm"));
    const cancelled = session.frames.find(
      (recorded) => recorded.frame.method === HOST_PROTOCOL_NOTIFICATIONS.cancelled,
    );
    expect(cancelled?.from).toBe("child");
    expect((cancelled?.frame.params as { requestId?: unknown }).requestId).toBe(request.frame.id);
  });
});

describe("one frame per notification kind", () => {
  // Drawn from the frames the two describes above recorded, so a notification
  // golden is a frame that really crossed in a recorded conversation rather
  // than one assembled here.
  for (const method of Object.values(HOST_PROTOCOL_NOTIFICATIONS)) {
    it(method, async () => {
      const recorded = recordedForNotifications.find((candidate) => candidate.frame.method === method);
      expect(recorded, `no '${method}' crossed in the recorded conversations`).toBeDefined();
      expect("id" in recorded!.frame).toBe(false);
      await expect(goldenJson(recorded)).toMatchFileSnapshot(join(GOLDEN_ROOT, `${method}.json`));
    });
  }

  it("has a golden for each kind and no other", () => {
    expect(goldenFiles(join(GOLDEN_ROOT, "notifications"))).toEqual(
      Object.values(HOST_PROTOCOL_NOTIFICATIONS)
        .map((method) => `${method.slice("notifications/".length)}.json`)
        .sort(),
    );
  });
});

describe("one conversation per installed plugin's surface", () => {
  for (const [pluginId, survey] of Object.entries(PLUGIN_SURVEY)) {
    it(pluginId, async () => {
      const dir = join(GOLDEN_ROOT, "plugins", pluginId);
      const manifest = flattenAgentPluginsManifest(
        JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")),
      );
      expect(manifest.id).toBe(pluginId);
      const host = createGoldenHost();
      const session = await openSession(manifest, join(dir, "entry.mjs"), host);
      const { instance, frames } = session;

      await instance.handlers.exercise_host!();
      host.fireAll();
      await settle();
      await instance.handlers.report_host!();
      await settle();
      await instance.stop?.();
      await settle();

      const reached = new Set(
        frames
          .filter((recorded) => recorded.from === "child" && "id" in recorded.frame)
          .map((recorded) => String(recorded.frame.method))
          .filter((method) => method.startsWith("ave/host/")),
      );
      expect([...reached].sort()).toEqual(survey.map((path) => hostApiMethodOf(path)).sort());
      await expect(goldenJsonl(frames)).toMatchFileSnapshot(join(dir, "expected.jsonl"));
    });
  }
});
