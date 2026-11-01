/** Record golden frames through the real host session and child runtime; review snapshot changes as wire changes. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { PassThrough, Writable, type Readable } from "node:stream";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PluginManifest, RuntimePlugin } from "../../types.js";
import { flattenAgentPluginsManifest } from "../../public-contract.js";
import { resolveProcessLaunch } from "../../process-entry.js";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { EffectBoundaryDeniedError } from "../../../permissions/effect-enforcement.js";
import { ManifestIntegrityError } from "../../../permissions/manifest-integrity.js";
import { PluginRuntimeDetachedOperationError } from "../../runtime/detached-operation.js";
import { CredentialLeaseError } from "../../secret-access/credential-lease-registry.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
} from "../../public-contract.js";
import { servePluginChild } from "../plugin-child-main.js";
import type { ChildLink } from "../plugin-child-transport.js";
import {
  FRAME_BYTES_MAX,
  HOST_API_WIRE_ERROR_CODES,
  HOST_PROTOCOL_NOTIFICATIONS,
  HOSTAPI_PATH_CONTRACTS,
  IncompatibleHostProtocolError,
  WIRE_BYTES_MAX,
  hostApiMethodOf,
  type HostApiPath,
  type HostApiWireErrorCode,
} from "../host-api-wire.js";
import { PLUGIN_INSTANCE_METHODS } from "../plugin-instance-wire.js";
import type {
  ValidationHost,
  ValidationHostOverrides,
} from "../../validate/validation-host.js";
import { createRecordingHost } from "./host-protocol-recording-host.js";
import { openValidationSession } from "../../validate/validation-session.js";
import { createValidationChildLink } from "../../validate/validation-child-link.js";
import { buildSafeChildEnv } from "../../../tools/safe-env.js";
import { goldenFiles } from "./host-protocol-golden-files.js";
import { settle } from "./stream-turns.js";
import { installPythonSmoke, reportSmoke } from "./python-smoke-harness.js";
import { repositoryRoot } from "./child-entry-bundle.js";

const GOLDEN_ROOT = fileURLToPath(new URL("./fixtures/host-protocol/4/", import.meta.url));
const INVOKER_ENTRY = join(GOLDEN_ROOT, "invoker.mjs");

type Frame = Record<string, unknown>;

interface RecordedFrame {
  readonly from: "host" | "child";
  readonly frame: Frame;
}

/** The transcript must call every surveyed wire member; child-local methods produce no frames. */
const PLUGIN_SURVEY: Readonly<Record<string, readonly HostApiPath[]>> = {
  "sampleassistant": [
    "onEvent",
    "onPluginsChanged",
    "config.onChange",
    "config.set",
    "hasRoutineBySource",
    "callLlm",
    "triggerConversation",
  ],
  "samplemail": [
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
  "sampleportal": ["probePrivateHost", "openAuthWindow", "getAuthPartitionCookies", "spawnWorker"],
};

const INVOKER_MANIFEST: PluginManifest = {
  id: "golden-invoker",
  name: "Golden Invoker",
  version: "1.0.0",
  entry: "invoker.mjs",
  requires: { hostProtocol: "4" },
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
  // Isolate AVE_HOME so recordings never resolve the user profile.
  previousAveHome = process.env.AVE_HOME;
  aveHomeRoot = mkdtempSync(join(tmpdir(), "host-protocol-golden-"));
  process.env.AVE_HOME = join(aveHomeRoot, ".ave");
});

afterAll(() => {
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(aveHomeRoot, { recursive: true, force: true });
});

function tap(stream: Readable, from: RecordedFrame["from"], frames: RecordedFrame[]): void {
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  stream.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) frames.push({ from, frame });
  });
}

interface Session {
  readonly instance: RuntimePlugin;
  readonly frames: RecordedFrame[];
  sendAsChild(frame: Frame): void;
}

async function openSession(
  manifest: PluginManifest,
  entryPath: string,
  host: ValidationHost,
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
    onFault: () => undefined,
  };
  const { instance } = await openValidationSession({
    manifest,
    host,
    link,
    entryPath,
    pluginRoot: `/plugins/${manifest.id}`,
    pluginDataDir: `/plugins/${manifest.id}/data`,
  });
  await settle();
  return {
    instance,
    frames,
    sendAsChild: (frame) => void childToHost.write(`${JSON.stringify(frame)}\n`),
  };
}

const TRANSCRIPT_ID = /\bworker_\d+\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Normalize root spellings and separators below the root for portable goldens. */
function goldenPath(text: string): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf(GOLDEN_ROOT); at !== -1; at = text.indexOf(GOLDEN_ROOT, from)) {
    const rest = text.slice(at + GOLDEN_ROOT.length).match(/^[^\s"'`]*/)![0];
    out += `${text.slice(from, at)}<golden>/${rest.replaceAll("\\", "/")}`;
    from = at + GOLDEN_ROOT.length + rest.length;
  }
  return out + text.slice(from);
}

/** Sort keys and replace opaque IDs and checkout roots deterministically. */
function canonicalise(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") {
    const pathed = goldenPath(value);
    // Test alternate drive casing and separators below the normalized root.
    if (/<golden>\/[^\s"'`]*\\/.test(pathed) || /fixtures[\\/]host-protocol[\\/]1[\\/]/.test(pathed)) {
      throw new Error(`a golden kept a checkout path: ${pathed}`);
    }
    return pathed
      .replace(TRANSCRIPT_ID, (id) => {
        const key = id.toLowerCase();
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

/** Decode nested JSON strings when searching transcripts for path leaks, including escaped Unicode. */
function decodedStrings(transcript: string): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      out.push(value);
      const text = value.trim();
      if (depth < 4 && /^[[{"]/.test(text)) {
        let inner: unknown;
        try {
          inner = JSON.parse(text);
        } catch {
          return;
        }
        visit(inner, depth + 1);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        visit(key, depth);
        visit(item, depth);
      }
    }
  };
  for (const line of transcript.split("\n")) if (line !== "") visit(JSON.parse(line), 0);
  return out;
}

/** Match root boundaries rather than substrings; ambiguous matches must fail loudly. */
const ROOT_END = String.raw`(?=$|[\\/\s"'\x60,;:!?)\]}>]|\.(?:\s|$))`;

/** Find path leaks in decoded carried strings, including nested JSON and escaped spellings. */
function keptRoot(root: string, carried: readonly string[]): string | undefined {
  const bare = root.length > 1 ? root.replace(/[/\\]+$/, "") : root;
  const jsonEscaped = (text: string) => JSON.stringify(text).slice(1, -1);
  const asciiEscaped = (text: string) =>
    jsonEscaped(text).replace(/[\u0080-\uffff]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const forms = new Set([bare, pathToFileURL(bare).pathname].flatMap((text) => [text, jsonEscaped(text), asciiEscaped(text)]));
  const patterns = [...forms].map((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}_.-])${escaped}${ROOT_END}`, "u");
  });
  return carried.find((text) => patterns.some((pattern) => pattern.test(text)));
}

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

const WIRE_PATHS = (Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]).filter(
  (path) => HOSTAPI_PATH_CONTRACTS[path].result !== "child-local",
);

const methodGoldenFile = (method: string): string => join(GOLDEN_ROOT, "methods", `${method}.json`);

/** Prefix error goldens with code- so manifest discovery does not parse error names as plugin documents. */
const errorGoldenName = (code: HostApiWireErrorCode): string => `errors/code-${code}.json`;

/** Cache shared recordings but start them independently under test filters. */
function once<T>(record: () => Promise<T>): () => Promise<T> {
  let recording: Promise<T> | undefined;
  return () => (recording ??= record());
}

const recordInvokerConversation = once(async (): Promise<RecordedFrame[]> => {
  const host = createRecordingHost();
  const session = await openSession(INVOKER_MANIFEST, INVOKER_ENTRY, host);
  const { instance, frames } = session;

  await instance.start?.();
  await instance.onPublished?.();
  for (const path of WIRE_PATHS) {
    const outcome = (await instance.handlers.invoke_member!({ path })) as { error?: unknown };
    // Method goldens must record successful replies; error goldens cover refusals.
    expect(outcome.error, path).toBeUndefined();
  }
  await instance.handlers.write_log!();
  host.fireAll();
  await settle();
  await instance.handlers.dispose_all!();
  await settle();
  // Run onShutdown before stopping, matching host shutdown order.
  await host.runShutdown();
  await settle();
  await instance.stop?.();
  await settle();
  return frames;
});

describe("one request/response pair per method", () => {
  it("covers every ave/host method and every ave/instance method, and nothing else", async () => {
    const frames = await recordInvokerConversation();

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

interface ErrorTrigger {
  readonly trigger: string;
  readonly overrides?: ValidationHostOverrides;
  /** Retire the incarnation before dispatching this request. */
  readonly afterStop?: boolean;
  readonly provoke: (session: Session) => Promise<RecordedFrame>;
}

function throughStub(path: HostApiPath): ErrorTrigger["provoke"] {
  return async (session) => {
    await session.instance.handlers.invoke_member!({ path });
    return lastRequest(session.frames, hostApiMethodOf(path));
  };
}

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
  "rate-limited": {
    trigger: "the in-flight ceiling was exhausted before the host method ran",
    provoke: async (session) => {
      for (let index = 0; index < 220; index += 1) {
        session.sendAsChild({
          jsonrpc: "2.0", id: `budget-${index}`,
          method: "ave/host/hasRoutineBySource", params: { source: "nightly" },
        });
      }
      await settle();
      return lastRequest(session.frames, "ave/host/hasRoutineBySource");
    },
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
  "credential-conflict": {
    trigger: "a malformed credential selector",
    provoke: byHand("ave/host/hostFetch", { input: "https://example.com", init: { auth: { token: "x" } } }),
  },
  "lease-unavailable": {
    trigger: "a lease that is no longer live",
    overrides: { hostFetch: throwing(() => new CredentialLeaseError("lease-unavailable", { stage: "before-send" })) },
    provoke: throughStub("hostFetch"),
  },
  "lease-audience-denied": {
    trigger: "a URL outside the credential audience",
    overrides: { hostFetch: throwing(() => new CredentialLeaseError("lease-audience-denied", { origin: "https://example.com", hop: 0 })) },
    provoke: throughStub("hostFetch"),
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

type ErrorTriggerCode = keyof typeof ERROR_TRIGGERS;

const recordErrorConversation = Object.fromEntries(
  Object.entries(ERROR_TRIGGERS).map(([code, { overrides, afterStop, provoke }]) => [
    code,
    once(async () => {
      const host = createRecordingHost(overrides);
      const session = await openSession(INVOKER_MANIFEST, INVOKER_ENTRY, host);
      if (afterStop) await session.instance.stop?.();
      const request = await provoke(session);
      const response = await replyTo(session.frames, request);
      if (!afterStop) await session.instance.stop?.();
      await settle();
      return { request, response, frames: session.frames };
    }),
  ]),
) as Record<
  ErrorTriggerCode,
  () => Promise<{ request: RecordedFrame; response: RecordedFrame; frames: RecordedFrame[] }>
>;

describe("one reply per error code", () => {
  it("has a trigger for every code in the closed set", () => {
    expect([...Object.keys(ERROR_TRIGGERS), "protocol-version-mismatch"].sort()).toEqual(
      [...HOST_API_WIRE_ERROR_CODES].sort(),
    );
  });

  for (const [code, { trigger }] of Object.entries(ERROR_TRIGGERS)) {
    it(code, async () => {
      const { request, response } = await recordErrorConversation[code as ErrorTriggerCode]();

      const error = (response.frame as { error?: { code: number; data?: { code?: string } } }).error;
      expect(error?.data?.code).toBe(code);
      // Use standard JSON-RPC codes where defined and host-protocol codes otherwise.
      expect(error?.code).toBe(code === "path-unknown" ? -32601 : -32000);
      await expect(
        goldenJson({ trigger, request: request.frame, response: response.frame }),
      ).toMatchFileSnapshot(join(GOLDEN_ROOT, "methods", errorGoldenName(code as HostApiWireErrorCode)));
    });
  }

  it("protocol-version-mismatch", async () => {
    // Only construct carries the version; its mismatch reply is child-owned.
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

const recordCancelledConversation = once(async () => {
  let hostSignal: AbortSignal | undefined;
  const host = createRecordingHost({
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
  return { session, outcome, hostSignal: () => hostSignal };
});

describe("a cancelled request", () => {
  it("is aborted host-side and answered as the plugin's own abort would be", async () => {
    const { session, outcome, hostSignal: signal } = await recordCancelledConversation();
    const hostSignal = signal();

    // Assert host cancellation and the wire AbortError identity.
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
  // Notification goldens reuse actual conversations and must also start independently under filters.
  const recordedForNotifications: RecordedFrame[] = [];
  beforeAll(async () => {
    recordedForNotifications.push(...(await recordInvokerConversation()));
    for (const code of Object.keys(ERROR_TRIGGERS) as ErrorTriggerCode[]) {
      recordedForNotifications.push(...(await recordErrorConversation[code]()).frames);
    }
    recordedForNotifications.push(...(await recordCancelledConversation()).session.frames);
  });

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

describe("a process launch's construct", () => {
  it("carries the process manifest and the resolved command path", async () => {
    const dir = join(GOLDEN_ROOT, "launches", "process");
    const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")));
    // Record the host construct frame with the reference runtime; real process pipes are measured separately.
    const dataDir = join(aveHomeRoot, "process-launch-data");
    mkdirSync(dataDir, { recursive: true });
    const launch = resolveProcessLaunch(manifest, dir, dataDir);
    expect(launch.command).toBe(realpathSync(join(dir, "bin", "plugin.mjs")));
    const entryPath = join(dir, "bin", "plugin.mjs");

    const session = await openSession(manifest, entryPath, createRecordingHost());
    const request = lastRequest(session.frames, PLUGIN_INSTANCE_METHODS.construct);
    const response = await replyTo(session.frames, request);
    await session.instance.stop?.();
    await settle();

    const params = request.frame.params as { entryPath: string; manifest: Record<string, unknown> };
    expect(params.entryPath).toBe(entryPath);
    expect(params.manifest).toHaveProperty("process");
    expect(params.manifest).not.toHaveProperty("entry");
    expect(response.frame).toHaveProperty("result");
    await expect(
      goldenJson({ request: request.frame, response: response.frame }),
    ).toMatchFileSnapshot(join(dir, "construct.json"));
  });
});

describe("a golden reads the same on every machine", () => {
  it("preserves opaque worker identity equality without changing request ids or payloads", () => {
    const first = "01234567-89ab-4cde-8123-456789abcdef";
    const canonical = JSON.parse(goldenJson([
      { id: first, result: null },
      { id: 42, result: { handleId: "worker_42" } },
      { id: 43, result: { handleId: "worker_43" } },
      { params: { subscriptionId: "worker_42", payload: { code: 42, chunk: "worker_count" } } },
      { params: { subscriptionId: "worker_43" } },
    ]));
    expect(canonical).toEqual([
      { id: "<uuid-1>", result: null },
      { id: 42, result: { handleId: "<uuid-2>" } },
      { id: 43, result: { handleId: "<uuid-3>" } },
      { params: { subscriptionId: "<uuid-2>", payload: { code: 42, chunk: "worker_count" } } },
      { params: { subscriptionId: "<uuid-3>" } },
    ]);
  });

  it("records a path under the golden root with `/`, whatever separator the platform used", () => {
    expect(goldenPath(`${GOLDEN_ROOT}plugins\\sampleportal\\entry.mjs`)).toBe("<golden>/plugins/sampleportal/entry.mjs");
    expect(goldenPath(`${GOLDEN_ROOT}plugins/sampleportal/entry.mjs`)).toBe("<golden>/plugins/sampleportal/entry.mjs");
    expect(goldenPath(`cannot load ${GOLDEN_ROOT}invoker.mjs: gone`)).toBe("cannot load <golden>/invoker.mjs: gone");
    // Backslashes outside the root are content and must survive normalization.
    expect(goldenPath("a\\b")).toBe("a\\b");
  });
});

describe("one conversation per installed plugin's surface", () => {
  it.each([
    ["meeting", /speaks host protocol 2; this app serves 3, 4/],
    ["local-indexer", /does not declare a host protocol/],
  ] as const)("refuses an old %s bundle before its child connects", async (pluginId, refusal) => {
    const dir = join(GOLDEN_ROOT, "old-bundles", pluginId);
    const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")));
    // A throwing entry and a write-refusing link prove old protocols fail before import or child traffic.
    const written: unknown[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk);
        callback(new Error("a frame was written to an old child"));
      },
    });
    const link: ChildLink = {
      input: new PassThrough(),
      output,
      terminate: () => undefined,
      onGone: () => undefined,
      onFault: () => undefined,
    };
    const refused = openValidationSession({
      manifest,
      host: createRecordingHost(),
      link,
      entryPath: join(dir, "entry.mjs"),
      pluginRoot: `/plugins/${pluginId}`,
      pluginDataDir: `/plugins/${pluginId}/data`,
    });
    await expect(refused).rejects.toBeInstanceOf(IncompatibleHostProtocolError);
    await expect(refused).rejects.toThrow(refusal);
    expect(written).toEqual([]);
  });

  for (const [pluginId, survey] of Object.entries(PLUGIN_SURVEY)) {
    it(pluginId, async () => {
      const dir = join(GOLDEN_ROOT, "plugins", pluginId);
      const manifest = flattenAgentPluginsManifest(
        JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")),
      );
      expect(manifest.id).toBe(pluginId);
      const host = createRecordingHost();
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

/** Record the cross-language smoke over real unconfined pipes; reject leaked temporary and checkout paths. */
describe.runIf(process.platform !== "win32")("the python smoke's conversation, over real pipes", () => {
  const PYTHON_SMOKE_GOLDEN = join(GOLDEN_ROOT, "plugins", "python-smoke", "expected.jsonl");
  let templateRoot: string;

  beforeAll(() => {
    templateRoot = installPythonSmoke(join(aveHomeRoot, "python-template"));
  });

  function copyPythonFixture(root: string): void {
    cpSync(templateRoot, root, { recursive: true, preserveTimestamps: true });
  }

  const spellings = (path: string): string[] => [...new Set([path, realpathSync(path)])];

  /** Normalize measured peak RSS in child logs while retaining raw values for assertions. */
  function measureRuMaxrss(frames: RecordedFrame[]): number[] {
    const measured: number[] = [];
    for (const recorded of frames) {
      const { frame } = recorded;
      if (recorded.from !== "child" || frame.method !== HOST_PROTOCOL_NOTIFICATIONS.log) continue;
      const meta = (frame.params as { meta?: Record<string, unknown> } | undefined)?.meta;
      if (meta && typeof meta.ruMaxrss === "number") {
        measured.push(meta.ruMaxrss);
        meta.ruMaxrss = "<measured>";
      }
    }
    return measured;
  }

  function replaceRoots(value: unknown, replacements: ReadonlyArray<readonly [string, string]>): unknown {
    if (typeof value === "string") {
      return replacements.reduce((text, [spelling, placeholder]) => text.replaceAll(spelling, placeholder), value);
    }
    if (Array.isArray(value)) return value.map((entry) => replaceRoots(entry, replacements));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, replaceRoots(entry, replacements)]),
      );
    }
    return value;
  }

  interface PythonRecording {
    readonly transcript: string;
    /** Peak RSS units differ: bytes on macOS, KiB on Linux. */
    readonly ruMaxrssBytes: number;
  }

  async function recordPythonConversation(): Promise<PythonRecording> {
    const pluginRoot = mkdtempSync(join(tmpdir(), "python-smoke-plugin-"));
    const pluginDataDir = mkdtempSync(join(tmpdir(), "python-smoke-data-"));
    try {
      // Each recording owns fresh roots and a child while reusing verified dependencies.
      copyPythonFixture(pluginRoot);
      const manifest = flattenAgentPluginsManifest(
        JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf-8")),
      );
      const launch = resolveProcessLaunch(manifest, pluginRoot, pluginDataDir);
      let stderr = "";
      const child = spawn(launch.command, [...launch.args], {
        env: buildSafeChildEnv({ ...launch.env }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const { link, record } = createValidationChildLink(child);
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
      const frames: RecordedFrame[] = [];
      // Observe frames on the validator-owned pass-through before piping to stdin.
      tap(link.output as PassThrough, "host", frames);
      tap(link.input, "child", frames);
      const host = createRecordingHost();
      try {
        const session = await openValidationSession({
          manifest,
          host,
          link,
          entryPath: launch.command,
          pluginRoot,
          pluginDataDir,
        });
        await session.instance.start!();
        await session.channel.requestMcp("server/discover", {});
        await session.channel.requestMcp("tools/list", {});
        expect(await session.instance.handlers.echo!({ said: "hello" })).toEqual({ echoed: { said: "hello" } });
        await session.instance.stop!();
      } catch (error) {
        // If session setup never reaches teardown, the fixture must end its child exactly once.
        link.terminate("the python smoke's recording failed");
        throw new Error(`the python smoke failed: ${String(error)}\nits stderr:\n${stderr}`, { cause: error });
      } finally {
        await record.exited;
        await record.stdoutEnded;
      }

      const measured = measureRuMaxrss(frames);
      expect(measured, "one stop log carries the child's ru_maxrss").toHaveLength(1);
      const ruMaxrssBytes = process.platform === "darwin" ? measured[0]! : measured[0]! * 1024;
      const replacements = [
        ...spellings(pluginRoot).map((spelling) => [spelling, "<plugin-root>"] as const),
        ...spellings(pluginDataDir).map((spelling) => [spelling, "<plugin-data>"] as const),
        [host.roots.hostRoot, "<host-root>"] as const,
        [host.roots.userHome, "<user-home>"] as const,
        [host.roots.aveHome, "<ave-home>"] as const,
      ].sort(([a], [b]) => b.length - a.length);
      const transcript = goldenJsonl(
        frames.map((recorded) => replaceRoots(recorded, replacements) as RecordedFrame),
      );
      const carried = decodedStrings(transcript);
      for (const leftover of [...spellings(tmpdir()), repositoryRoot()]) {
        const kept = keptRoot(leftover, carried);
        if (kept !== undefined) {
          throw new Error(`the python smoke's golden kept a machine path: ${leftover} (in ${JSON.stringify(kept.slice(0, 200))})`);
        }
      }
      return { transcript, ruMaxrssBytes };
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(pluginDataDir, { recursive: true, force: true });
    }
  }

  it("is the committed golden, recorded twice in independently allocated roots", async () => {
    // Await both recording cleanups even after failure before removing the shared template.
    const [firstResult, secondResult] = await Promise.allSettled([
      recordPythonConversation(),
      recordPythonConversation(),
    ]);
    if (firstResult.status === "rejected") throw firstResult.reason;
    if (secondResult.status === "rejected") throw secondResult.reason;
    const first = firstResult.value;
    const second = secondResult.value;
    reportSmoke("measurement", {
      platform: process.platform,
      ruMaxrssBytes: [first.ruMaxrssBytes, second.ruMaxrssBytes],
    });
    expect(second.transcript).toBe(first.transcript);
    await expect(first.transcript).toMatchFileSnapshot(PYTHON_SMOKE_GOLDEN);

    const recorded = first.transcript.trim().split("\n").map((line) => JSON.parse(line) as RecordedFrame);
    const methods = recorded.filter(({ frame }) => "id" in frame && "method" in frame).map(({ frame }) => frame.method);
    expect(methods).toEqual(expect.arrayContaining(["server/discover", "tools/list", "tools/call"]));
    for (const { from, frame } of recorded) {
      if (from !== "host" || !["server/discover", "tools/list", "tools/call"].includes(String(frame.method))) continue;
      // Every request needs metadata; only nested host calls carry an invocation token back.
      expect((frame.params as { _meta?: unknown })._meta).toEqual({
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        ...(frame.method === "tools/call" ? { "ave/invocation": expect.stringMatching(/^<uuid-\d+>$/u) } : {}),
      });
      const reply = recorded.find((candidate) => candidate.from === "child" && candidate.frame.id === frame.id);
      expect(reply?.frame, String(frame.method)).toHaveProperty("result");
    }
  }, 600_000);

  it("answers -32602 itself to an MCP request that lacks either metadata key, and serves one that has both", async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), "python-smoke-plugin-"));
    const pluginDataDir = mkdtempSync(join(tmpdir(), "python-smoke-data-"));
    try {
      copyPythonFixture(pluginRoot);
      const manifest = flattenAgentPluginsManifest(
        JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf-8")),
      );
      const launch = resolveProcessLaunch(manifest, pluginRoot, pluginDataDir);
      // Hand-build frames to test missing metadata because production requestMcp always stamps it.
      const child = spawn(launch.command, [...launch.args], {
        env: buildSafeChildEnv({ ...launch.env }),
        stdio: ["pipe", "pipe", "inherit"],
      });
      const replies = new Map<unknown, Frame>();
      const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
      let allAnswered!: () => void;
      const answered = new Promise<void>((resolve) => {
        allAnswered = resolve;
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) replies.set(frame.id, frame);
        if (replies.size === 4) allAnswered();
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const call = (id: string, meta?: Record<string, unknown>): string =>
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "echo", arguments: { said: id }, ...(meta ? { _meta: meta } : {}) },
        })}\n`;
      const version = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
      const capabilities = { "io.modelcontextprotocol/clientCapabilities": {} };
      child.stdin!.write(call("bare"));
      child.stdin!.write(call("version-only", version));
      child.stdin!.write(call("capabilities-only", capabilities));
      child.stdin!.write(call("both", { ...version, ...capabilities }));
      // End stdin only after all replies; the plugin abandons in-flight work when input closes.
      await answered;
      child.stdin!.end();
      await exited;

      for (const id of ["bare", "version-only", "capabilities-only"]) {
        expect((replies.get(id) as { error?: { code?: number } } | undefined)?.error?.code, id).toBe(-32602);
      }
      expect(replies.get("both")).toMatchObject({
        result: { _meta: { "ave/rawResult": { echoed: { said: "both" } } }, isError: false },
      });
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(pluginDataDir, { recursive: true, force: true });
    }
  }, 600_000);
});
