/**
 * The host protocol, pinned frame by frame.
 *
 * Every golden here is recorded over the REAL stack: `servePluginChild` and the
 * real child runtime on one side, `openValidationSession` — the production
 * protocol session with the dispatch table assembled from the group factories
 * — on the other, joined by two in-memory `PassThrough`s, the substitution
 * `out-of-process-plugin.test.ts` makes, and the only one. The host answers
 * from `createValidationHost` — with the recorded neighbourhood supplied by
 * `createRecordingHost` — so a transcript is a function of the plugin
 * module, and a transcript that changes is the wire that changed
 * (plugin-hostapi-protocol.md §10.1).
 *
 * Four kinds, under `fixtures/host-protocol/2/`:
 *
 *  - `methods/<method>.json`: the request one call puts on the wire and the
 *    reply it gets, for every `ave/host/*` and `ave/instance/*` method, and
 *    `methods/errors/<code>.json` for every code of the closed error set.
 *  - `notifications/<name>.json`: one frame per notification kind (§3.4).
 *  - `plugins/<id>/expected.jsonl`: the whole conversation for one installed
 *    plugin's surface (§9.2), in the order it crossed.
 *  - `launches/process/construct.json`: the construct pair for a plugin whose
 *    process is its own executable (§9.7 P3, decision 33), beside the complete
 *    plugin it was recorded from.
 *  - `plugins/python-smoke/expected.jsonl`: the one conversation NOT recorded
 *    in memory. A Python process cannot run on in-memory streams, so its
 *    child is a real process on pipes the test spawns and owns (§9.7 P5).
 *
 * Frames are compared after canonical key ordering and id normalisation: a
 * UUID becomes `<uuid-N>` by first appearance, so a transcript does not change
 * because a random id did. Regenerate with `-u` after a deliberate wire change
 * and read the diff — it IS the protocol change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { PassThrough, Writable, type Readable } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

const GOLDEN_ROOT = fileURLToPath(new URL("./fixtures/host-protocol/2/", import.meta.url));
/**
 * Where the invoker's code lives. It is the one module still shared with the
 * protocol-1 fixtures; every `2/plugins/<id>` directory holds its own entry.
 */
const INVOKER_CODE_ROOT = fileURLToPath(new URL("./fixtures/host-protocol/1/", import.meta.url));
const INVOKER_ENTRY = join(INVOKER_CODE_ROOT, "invoker.mjs");

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
  requires: { hostProtocol: "2" },
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
  // The envelope derivation reads `AVE_HOME` for declared host directories;
  // a recording must never resolve the real one.
  previousAveHome = process.env.AVE_HOME;
  aveHomeRoot = mkdtempSync(join(tmpdir(), "host-protocol-golden-"));
  process.env.AVE_HOME = join(aveHomeRoot, ".ave");
});

afterAll(() => {
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(aveHomeRoot, { recursive: true, force: true });
});

/** Record every frame written to `stream`, decoded exactly as its reader decodes it. */
function tap(stream: Readable, from: RecordedFrame["from"], frames: RecordedFrame[]): void {
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  stream.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) frames.push({ from, frame });
  });
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
    // No process, so nothing can fault.
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A path under the golden root, as `<golden>/` and `/`-separated segments.
 * The separators are the platform's (`\` on Windows) only below the root,
 * which the root's replacement alone would leave behind.
 */
function goldenPath(text: string): string {
  text = text.replaceAll(INVOKER_CODE_ROOT, GOLDEN_ROOT);
  let out = "";
  let from = 0;
  for (let at = text.indexOf(GOLDEN_ROOT); at !== -1; at = text.indexOf(GOLDEN_ROOT, from)) {
    const rest = text.slice(at + GOLDEN_ROOT.length).match(/^[^\s"'`]*/)![0];
    out += `${text.slice(from, at)}<golden>/${rest.replaceAll("\\", "/")}`;
    from = at + GOLDEN_ROOT.length + rest.length;
  }
  return out + text.slice(from);
}

/**
 * Canonical JSON: keys sorted at every depth, every UUID replaced by
 * `<uuid-N>` in order of first appearance across the whole golden, and the
 * checkout's own path replaced, so a golden reads the same on every machine.
 */
function canonicalise(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") {
    const pathed = goldenPath(value);
    // Two ways a checkout leaks into a golden only it can match: a separator
    // left below the root, or the root spelled another way (a drive letter's
    // case) and so not replaced at all.
    if (/<golden>\/[^\s"'`]*\\/.test(pathed) || /fixtures[\\/]host-protocol[\\/]1[\\/]/.test(pathed)) {
      throw new Error(`a golden kept a checkout path: ${pathed}`);
    }
    return pathed
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

/**
 * Every string a transcript carries, decoded: each JSON key and string value,
 * and, where a value is itself JSON text (a tool's text content often is), the
 * strings inside that too. Checking decoded strings rather than the serialized
 * transcript is what makes the leftover-path guard independent of how a
 * plugin escaped them: JavaScript keeps non-ASCII literal, Python's
 * `json.dumps` writes `\uXXXX`, and either may nest JSON inside a string.
 */
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
          return; // prose that merely starts like JSON; already pushed as is
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

/**
 * Where a root ends when it is named: at a separator (something inside it), at
 * the end of the string, or at prose punctuation or whitespace naming the root
 * itself. Anything else that can continue a file name (`+`, `(`, a letter, a
 * dot followed by more name) makes it a sibling such as `/work/repo+backup`,
 * not the root. A space is taken as the end: `/work/repo backup` is then a
 * false positive, which fails the recording loudly rather than passing a leak.
 */
const ROOT_END = String.raw`(?=$|[\\/\s"'\x60,;:!?)\]}>]|\.(?:\s|$))`;

/**
 * The first carried string that still names `root` as a path, if any. A path,
 * not a substring: a short root such as a container's `/w` is also inside
 * `ave/host/storage/write`, so no path character may stand before it and it
 * must end at `ROOT_END`. The spellings are the root with any trailing
 * separator dropped and as a `file://` URL's path (percent-encoding `#`, `?`
 * and spaces), each also as JSON escapes it inside prose that embeds JSON:
 * literal, or ASCII-only with `\uXXXX` as Python writes it.
 */
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

/**
 * Run a recording once, however many describes need it and whichever of them
 * a filtered run (`-t`) selects: the notification goldens are drawn from the
 * same conversations the method goldens are, and must not depend on those
 * tests having run first.
 */
function once<T>(record: () => Promise<T>): () => Promise<T> {
  let recording: Promise<T> | undefined;
  return () => (recording ??= record());
}

/** The invoker calling every member and every lifecycle method once. */
const recordInvokerConversation = once(async (): Promise<RecordedFrame[]> => {
  const host = createRecordingHost();
  const session = await openSession(INVOKER_MANIFEST, INVOKER_ENTRY, host);
  const { instance, frames } = session;

  await instance.start?.();
  await instance.onPublished?.();
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
  // Before stop, as the host's shutdown step runs: the `onShutdown` the
  // invoker registered is what `ave/instance/shutdown` names.
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

/** How one error code is provoked, over the same real stack. */
interface ErrorTrigger {
  /** What the golden records as the reason this reply was sent. */
  readonly trigger: string;
  readonly overrides?: ValidationHostOverrides;
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

/** One session per error code: the request that provoked it, its reply, and every frame. */
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

/** The invoker abandoning a call in flight, which is what sends `notifications/cancelled`. */
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
  // Drawn from the conversations the describes above record, so a notification
  // golden is a frame that really crossed rather than one assembled here. The
  // recordings are shared, not re-run, and this describe starts them itself so
  // it stands alone under a filter.
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
    // The launch the factory would build from this directory: the command it
    // resolves is the path construct names. The reference runtime stands in for
    // the plugin's own program on the in-memory pair, so the golden pins what
    // the HOST sends; a real executable on pipes is P5's recording path.
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
  it("records a path under the golden root with `/`, whatever separator the platform used", () => {
    // What a Windows checkout records: the root in its own spelling, then `\`.
    expect(goldenPath(`${GOLDEN_ROOT}plugins\\sampleportal\\entry.mjs`)).toBe("<golden>/plugins/sampleportal/entry.mjs");
    expect(goldenPath(`${GOLDEN_ROOT}plugins/sampleportal/entry.mjs`)).toBe("<golden>/plugins/sampleportal/entry.mjs");
    expect(goldenPath(`cannot load ${GOLDEN_ROOT}invoker.mjs: gone`)).toBe("cannot load <golden>/invoker.mjs: gone");
    // A backslash that is not under the root is content, and stays.
    expect(goldenPath("a\\b")).toBe("a\\b");
  });
});

describe("one conversation per installed plugin's surface", () => {
  it.each(["meeting", "local-indexer"])("refuses an old %s bundle before its child connects", async (pluginId) => {
    const dir = fileURLToPath(new URL(`./fixtures/host-protocol/1/plugins/${pluginId}/`, import.meta.url));
    const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf-8")));
    // The entry beside the protocol-1 manifest throws when imported, so a
    // refusal that came after an import would surface as that throw instead.
    // A link whose child must never hear from the host: any write fails the case.
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
    await expect(refused).rejects.toThrow(/does not declare a host protocol/);
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
      // The plugin's own directory is a complete plugin: its manifest and its
      // entry, as a directory validator takes it.
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

/**
 * The Python smoke's conversation, over real pipes (§9.7 P5).
 *
 * The child is the fixture's own `bin/plugin`, spawned plainly by the test —
 * never the production factory, which would demand a live sandbox and pinned
 * provenance and is right to — on the validator's own link, and attached to
 * `openValidationSession`. Two rules beyond `canonicalise`, each keyed to one
 * thing that varies by run and not by wire behaviour:
 *
 *  - MEASUREMENT: in a child `notifications/ave/log` frame,
 *    `params.meta.ruMaxrss` is the child's peak RSS. Its raw value is copied
 *    to the measurement record and the frame holds `"<measured>"`. Any other
 *    number still compares exactly.
 *  - TEMPORARY ROOTS: the plugin root (a `mkdtemp` copy of the fixture with
 *    its `vendor/`) and the data root are outside the golden root, so
 *    `goldenPath` leaves them; they reach construct's context and `entryPath`.
 *    Each is replaced, as allocated and after `realpath`, longest spelling
 *    first, as are the validation context's fixed roots — and the transcript
 *    is refused if the OS temp directory or the checkout still appears in it.
 */
describe.runIf(process.platform !== "win32")("the python smoke's conversation, over real pipes", () => {
  const PYTHON_SMOKE_GOLDEN = join(GOLDEN_ROOT, "plugins", "python-smoke", "expected.jsonl");

  /** The two spellings of a path: as given, and after `realpath`. */
  const spellings = (path: string): string[] => [...new Set([path, realpathSync(path)])];

  /**
   * Replace `params.meta.ruMaxrss` of each child log frame with `"<measured>"`,
   * returning the raw values in order. The frames are rewritten in place.
   */
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

  /** Every string in `value` with each `[spelling, placeholder]` replaced, in the order given. */
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
    /** The child's own `ru_maxrss`, in bytes: darwin reports bytes, linux KiB. */
    readonly ruMaxrssBytes: number;
  }

  /** One recording, in its own freshly allocated plugin and data roots. */
  async function recordPythonConversation(): Promise<PythonRecording> {
    const pluginRoot = mkdtempSync(join(tmpdir(), "python-smoke-plugin-"));
    const pluginDataDir = mkdtempSync(join(tmpdir(), "python-smoke-data-"));
    try {
      installPythonSmoke(pluginRoot);
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
      // The validator's link writes to the child through a `PassThrough` it
      // pipes into stdin, so the host's frames are read where they are written.
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
        // The session never reached its own teardown, so the child is ended
        // here; the link starts its one termination sequence at most once.
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
    const first = await recordPythonConversation();
    const second = await recordPythonConversation();
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
      // Every MCP request carries the S1 metadata, and the plugin answered it.
      // A tools/call also names the host invocation it serves; a child that
      // makes no hostApi call (this one) has nothing to carry it back on.
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
      installPythonSmoke(pluginRoot);
      const manifest = flattenAgentPluginsManifest(
        JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf-8")),
      );
      const launch = resolveProcessLaunch(manifest, pluginRoot, pluginDataDir);
      // The pipe the test owns: these frames are written by hand, because the
      // session's `requestMcp` always stamps the metadata and its `probe`
      // refuses MCP methods.
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
      // Ended only once every request is answered: the plugin leaves when its
      // stdin ends, abandoning whatever is still in flight.
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
