/**
 * The plugin host protocol TS client generator. Its command line, which writes
 * the client or checks the committed copy, is
 * `scripts/generate-plugin-host-protocol-client.ts`; this module only builds
 * the text and runs the two compile programs, so a test can drive both without
 * writing anything into the tree.
 *
 * `schemas/plugin-host-protocol/<version>/protocol-client.ts` is a typed
 * JSON-RPC client for one served protocol version
 * (docs/design/plugin-hostapi-protocol.md §9.7 P1). It is GENERATED from the
 * COMMITTED schema file beside it — not from the TypeScript sources the schema
 * is itself generated from — so the client is provably a projection of the
 * published artifact, and any language could project it the same way:
 *
 *  - `$defs.types` and every method's `params` and `result` compile through
 *    `json-schema-to-typescript` into named declarations;
 *  - `$defs.methods`, `$defs.notifications` and `$defs.errorCodes` become the
 *    `HostMethod`, `InstanceMethod`, `HostNotification` and
 *    `HostProtocolErrorCode` unions;
 *  - every `ave/host/*` method becomes one typed stub of `createHostClient`,
 *    named by its path segments (`storage/read` → `storage.read`).
 *
 * The file imports nothing and embeds no app version (decision 28): the
 * schema's `$id` and root description, which carry it, are never read. A
 * plugin repository pins the file by sha256 from the tag, like the schema.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { HOST_PROTOCOL_VERSIONS_SERVED } from "../../src/plugins/isolation/host-api-wire.js";

type JsonSchema = Record<string, unknown>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The prefix of every line the generator and its command line print. */
export const HOST_PROTOCOL_CLIENT_LABEL = "[plugin-host-protocol-client]";
const LABEL = HOST_PROTOCOL_CLIENT_LABEL;

/**
 * The two programs `--check` compiles, relative to the repository root. They
 * are separate because one invocation cannot serve both: the standalone one
 * must see no ambient type at all, and the host-equality one needs the
 * repository's own `lib`, `types` and `skipLibCheck` for the host modules it
 * imports.
 */
export const HOST_PROTOCOL_CLIENT_PROGRAMS = {
  standalone: "scripts/tsconfig.plugin-host-protocol-client.json",
  hostEquality: "scripts/tsconfig.plugin-host-protocol-client-assertions.json",
} as const;

const HOST_PREFIX = "ave/host/";
const INSTANCE_PREFIX = "ave/instance/";
/** The declaration the compile root is emitted as, which the generator removes. */
const ROOT_NAME = "HostProtocolCompileRoot";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function fail(message: string): never {
  throw new Error(`${LABEL} ${message}`);
}

/** Where one served version's schema lives, relative to the repository root. */
function hostProtocolSchemaPath(version: string): string {
  return `schemas/plugin-host-protocol/${version}/protocol.schema.json`;
}

/** Where one served version's client lives, relative to the repository root. */
function hostProtocolClientPath(version: string): string {
  return `schemas/plugin-host-protocol/${version}/protocol-client.ts`;
}

/** The one version this build serves, which names both files. */
function servedVersion(): string {
  if (HOST_PROTOCOL_VERSIONS_SERVED.length !== 1) {
    fail(
      `the host serves ${HOST_PROTOCOL_VERSIONS_SERVED.join(", ")}; one client per version `
        + "needs a schema per version, which this generator does not yet read",
    );
  }
  return HOST_PROTOCOL_VERSIONS_SERVED[0]!;
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, where: string): JsonSchema {
  return isRecord(value) ? value : fail(`the schema's ${where} is not an object`);
}

/** The same canonical key order the schema generator writes, so the input is order-independent. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/**
 * Re-root every `#/$defs/types/X` reference at `#/$defs/X`: the compile root
 * holds the named types flat under its own `$defs`, which is where
 * `json-schema-to-typescript` takes a declaration's name from.
 */
function reroot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reroot);
  if (!isRecord(value)) return value;
  const out: JsonSchema = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === "$ref") {
      if (typeof member !== "string" || !member.startsWith("#/$defs/types/")) {
        fail(`a reference outside $defs.types cannot be projected: ${JSON.stringify(member)}`);
      }
      out.$ref = member.replace(/^#\/\$defs\/types\//u, "#/$defs/");
    } else {
      out[key] = reroot(member);
    }
  }
  return out;
}

/** `ave/host/storage/read` → `["storage", "read"]`, each a valid identifier. */
function segmentsOf(method: string, prefix: string): string[] {
  const segments = method.slice(prefix.length).split("/");
  for (const segment of segments) {
    if (!IDENTIFIER.test(segment)) fail(`'${method}' has a path segment '${segment}' that is not an identifier`);
  }
  return segments;
}

function pascal(segments: readonly string[]): string {
  return segments.map((segment) => segment[0]!.toUpperCase() + segment.slice(1)).join("");
}

/** A JSDoc block at `indent`, or nothing for no text. */
function docComment(text: string | undefined, indent: string): string {
  if (!text?.trim()) return "";
  const lines = text.replace(/\r\n?/gu, "\n").replaceAll("*/", "*\\/").trim().split("\n");
  return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function unionOf(name: string, members: readonly string[], description: string): string {
  if (members.length === 0) fail(`${name} would be an empty union`);
  return `${docComment(description, "")}export type ${name} =\n${members.map((member) => `  | ${quoted(member)}`).join("\n")};\n`;
}

/** One `ave/host/*` stub: where it sits in the client and what it sends and answers. */
interface HostStub {
  method: string;
  segments: string[];
  params: string;
  result: string;
  description: string | undefined;
}

/** A tree of stubs keyed by path segment; a leaf is a stub, a branch a namespace. */
type StubTree = Map<string, HostStub | StubTree>;

function stubTree(stubs: readonly HostStub[]): StubTree {
  const tree: StubTree = new Map();
  for (const stub of stubs) {
    let node = tree;
    stub.segments.forEach((segment, index) => {
      const existing = node.get(segment);
      if (index === stub.segments.length - 1) {
        if (existing) fail(`'${stub.method}' is both a method and a namespace of methods`);
        node.set(segment, stub);
        return;
      }
      if (existing && !(existing instanceof Map)) fail(`'${existing.method}' is both a method and a namespace of methods`);
      const branch: StubTree = existing ?? new Map();
      node.set(segment, branch);
      node = branch;
    });
  }
  return tree;
}

function interfaceMembers(tree: StubTree, indent: string): string {
  return [...tree.keys()]
    .sort()
    .map((key) => {
      const node = tree.get(key)!;
      if (node instanceof Map) return `${indent}readonly ${key}: {\n${interfaceMembers(node, `${indent}  `)}${indent}};\n`;
      return `${docComment(node.description, indent)}${indent}${key}(params: ${node.params}): Promise<${node.result}>;\n`;
    })
    .join("");
}

function implementationMembers(tree: StubTree, indent: string): string {
  return [...tree.keys()]
    .sort()
    .map((key) => {
      const node = tree.get(key)!;
      if (node instanceof Map) return `${indent}${key}: {\n${implementationMembers(node, `${indent}  `)}${indent}},\n`;
      return `${indent}${key}: (params) => transport.request(${quoted(node.method)}, params) as Promise<${node.result}>,\n`;
    })
    .join("");
}

/** Build the client text for one protocol version from its schema's parsed JSON. */
export async function renderHostProtocolClient(version: string, schema: unknown): Promise<string> {
  const defs = recordAt(recordAt(schema, "root").$defs, "$defs");
  const types = recordAt(defs.types, "$defs.types");
  const methods = recordAt(defs.methods, "$defs.methods");
  const notifications = recordAt(defs.notifications, "$defs.notifications");
  const errorCodes = recordAt(defs.errorCodes, "$defs.errorCodes").enum;
  if (!Array.isArray(errorCodes) || !errorCodes.every((code): code is string => typeof code === "string")) {
    fail("the schema's $defs.errorCodes has no enum of strings");
  }
  const versionType = recordAt(types.HostProtocolVersion, "$defs.types.HostProtocolVersion");
  if (versionType.const !== version) {
    fail(`the schema's HostProtocolVersion is ${JSON.stringify(versionType.const)}, but it was read as version ${version}`);
  }

  // Everything that compiles, flat under one `$defs`, so each declaration is
  // named by its key: the named types first, then each method side that is not
  // a reference to one of them.
  const compiled: JsonSchema = {};
  for (const name of Object.keys(types).sort()) compiled[name] = reroot(types[name]);
  const sideName = (method: string, side: "params" | "result"): string => {
    const entry = recordAt(methods[method], `$defs.methods['${method}']`);
    const schemaOfSide = recordAt(entry[side], `$defs.methods['${method}'].${side}`);
    const ref = schemaOfSide.$ref;
    if (typeof ref === "string" && Object.keys(schemaOfSide).length === 1) {
      const name = ref.replace(/^#\/\$defs\/types\//u, "");
      if (name === ref || !(name in types)) fail(`'${method}' ${side} references ${ref}, which is not a named type`);
      return name;
    }
    const [prefix, owner] = method.startsWith(HOST_PREFIX)
      ? [HOST_PREFIX, "Host"]
      : method.startsWith(INSTANCE_PREFIX)
        ? [INSTANCE_PREFIX, "Instance"]
        : fail(`'${method}' is neither an ave/host nor an ave/instance method`);
    const name = `${owner}${pascal(segmentsOf(method, prefix))}${side === "params" ? "Params" : "Result"}`;
    if (name in compiled || name === ROOT_NAME) fail(`'${method}' ${side} would be named ${name}, which is taken`);
    compiled[name] = reroot(schemaOfSide);
    return name;
  };

  const hostMethods: string[] = [];
  const instanceMethods: string[] = [];
  const stubs: HostStub[] = [];
  for (const method of Object.keys(methods).sort()) {
    const params = sideName(method, "params");
    const result = sideName(method, "result");
    if (method.startsWith(HOST_PREFIX)) {
      hostMethods.push(method);
      const description = recordAt(methods[method], `$defs.methods['${method}']`).description;
      if (description !== undefined && typeof description !== "string") fail(`'${method}' has a description that is not a string`);
      stubs.push({ method, segments: segmentsOf(method, HOST_PREFIX), params, result, description });
    } else {
      instanceMethods.push(method);
    }
  }

  const root = {
    $defs: compiled,
    anyOf: Object.keys(compiled).map((name) => ({ $ref: `#/$defs/${name}` })),
  };
  const declarations = await compile(sortKeys(root) as JSONSchema, ROOT_NAME, {
    bannerComment: "",
    additionalProperties: false,
    strictIndexSignatures: true,
    unknownAny: true,
    cwd: ROOT,
    $refOptions: { resolve: { external: false } },
  });
  // The compile root is only a handle on every declaration; it names nothing
  // of the protocol, so its own declaration goes.
  const rootDeclaration = new RegExp(`^export type ${ROOT_NAME} =[\\s\\S]*?;\\n`, "mu");
  const matches = declarations.match(new RegExp(rootDeclaration.source, "gmu")) ?? [];
  if (matches.length !== 1) fail(`the compiled types declare ${ROOT_NAME} ${matches.length} times, not once`);
  const body = declarations.replace(rootDeclaration, "");
  if (new RegExp(`\\b${ROOT_NAME}\\b`, "u").test(body)) fail(`a compiled type refers to ${ROOT_NAME}`);

  const notificationNames = Object.keys(notifications).sort();
  const text = [
    `/**
 * Ave plugin host protocol ${version}: the types and a typed JSON-RPC client.
 *
 * Generated by scripts/generate-plugin-host-protocol-client.ts from
 * ${hostProtocolSchemaPath(version)}; do not edit. It imports nothing, and
 * it names the protocol version it speaks and no app version, so it changes
 * only when the protocol does.
 *
 * \`createHostClient\` sends every \`ave/host/*\` request through a
 * \`HostClientTransport\` the plugin implements over its own stream. The client
 * does not validate replies: a result is typed as the schema names it.
 */
`,
    body.trimEnd(),
    "",
    "",
    `/** The protocol version this client speaks; \`construct\` carries it as \`hostProtocol.version\`. */
export const HOST_PROTOCOL_VERSION = ${quoted(version)};
`,
    unionOf("HostMethod", hostMethods, "A request the plugin sends to the host."),
    unionOf("InstanceMethod", instanceMethods, "A request the host sends to the plugin."),
    unionOf("HostNotification", notificationNames, "A notification either side may send; each one's description in the schema names its direction."),
    unionOf("HostProtocolErrorCode", errorCodes, "The `data.code` of a protocol error reply."),
    `/**
 * What the client sends through. The plugin implements it over its own stream:
 * \`request\` writes one JSON-RPC request and resolves with the reply's
 * \`result\` (or rejects with its \`error\`), and \`notify\` writes one
 * notification, which is never answered.
 */
export interface HostClientTransport {
  request(method: HostMethod, params: unknown): Promise<unknown>;
  notify(method: HostNotification, params: unknown): void;
}

/** One typed method per \`ave/host/*\` request, named by its path segments. */
export interface HostClient {
${interfaceMembers(stubTree(stubs), "  ")}}

/** A client that sends every \`ave/host/*\` request through \`transport\`. */
export function createHostClient(transport: HostClientTransport): HostClient {
  return {
${implementationMembers(stubTree(stubs), "    ")}  };
}

const HOST_NOTIFICATIONS: ReadonlySet<string> = new Set<HostNotification>([
${notificationNames.map((name) => `  ${quoted(name)},`).join("\n")}
]);

/** A JSON-RPC notification frame of this protocol. */
export interface HostNotificationFrame {
  jsonrpc: "2.0";
  method: HostNotification;
  params?: unknown;
}

/** Whether \`frame\` is a notification of this protocol: no \`id\`, and a method the protocol names. */
export function isHostNotification(frame: unknown): frame is HostNotificationFrame {
  if (typeof frame !== "object" || frame === null || "id" in frame) return false;
  const { jsonrpc, method } = frame as { jsonrpc?: unknown; method?: unknown };
  return jsonrpc === "2.0" && typeof method === "string" && HOST_NOTIFICATIONS.has(method);
}
`,
  ].join("\n");
  return text.replace(/\r\n?/gu, "\n");
}

/** Build the client for the one served protocol version from its committed schema. */
export async function generateHostProtocolClient(): Promise<{ path: string; text: string }> {
  const version = servedVersion();
  const schemaPath = hostProtocolSchemaPath(version);
  let schemaText: string;
  try {
    schemaText = readFileSync(join(ROOT, schemaPath), "utf-8");
  } catch {
    fail(`${schemaPath} is missing; run bun run generate:plugin-host-protocol-schema`);
  }
  return {
    path: hostProtocolClientPath(version),
    text: await renderHostProtocolClient(version, JSON.parse(schemaText)),
  };
}

/**
 * Compile one program (`tsc -p <project>`), with the repository's compiler run
 * by `node`: the command line passes the Node it runs under, and a test passes
 * the plain Node its harness names, because under the Electron-hosted runner
 * `process.execPath` is Electron. Any non-zero status is a failed compile and
 * comes back with the compiler's own output; a compiler that could not start
 * or was killed throws.
 *
 * `alone` also fails a program that loaded any file besides its own `files`
 * and the compiler's `lib` declarations. A compile error catches an import
 * that does not resolve; this catches one that does — a relative import of a
 * file that happens to exist beside the client, or a package that happens to
 * be installed where the check runs — which is still a client that does not
 * stand alone.
 */
export function compileHostProtocolClientProgram(
  project: string,
  { alone, node }: { alone: boolean; node: string },
): { ok: boolean; output: string } {
  // `typescript` exports no `lib/tsc.js` subpath, so it is found beside the
  // package manifest, which it does export, wherever this module is resolved from.
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "lib", "tsc.js");
  const result = spawnSync(
    node,
    [tsc, "-p", project, "--pretty", "false", ...(alone ? ["--listFiles"] : [])],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.signal) fail(`tsc -p ${project} was terminated by ${result.signal}`);
  const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/u).filter((line) => line.trim());
  if (!alone) return { ok: result.status === 0, output: lines.join("\n") };

  // A listed file is a bare absolute path on its own line; a diagnostic names
  // its file relative to the working directory, with a position.
  const listed = (line: string): boolean => isAbsolute(line) && !/\(\d+,\d+\): /u.test(line);
  const real = (path: string): string => realpathSync.native(path);
  const projectPath = resolve(ROOT, project);
  const own = new Set(
    ((JSON.parse(readFileSync(projectPath, "utf-8")) as { files?: string[] }).files ?? []).map((file) =>
      real(resolve(dirname(projectPath), file))),
  );
  const files = lines.filter(listed).map(real);
  // The compiler's own declarations: the directory it loaded its base
  // `lib.es5.d.ts` from, which the native compiler ships in a platform package
  // rather than beside `tsc.js`.
  const libDirs = new Set(files.filter((file) => basename(file) === "lib.es5.d.ts").map((file) => dirname(file)));
  const strays = files.filter((file) => !own.has(file) && !libDirs.has(dirname(file)));
  const diagnostics = lines.filter((line) => !listed(line));
  const output = [
    ...diagnostics,
    ...strays.map((file) => `${file}: loaded beside the client, which must import nothing`),
  ].join("\n");
  return { ok: result.status === 0 && strays.length === 0, output };
}
