// Project schemas from the same contracts and wire types used by dispatch.
// Read parameter type nodes directly and regenerate app-tagged schema URLs on version bumps.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  SchemaGenerator,
  createFormatter,
  createParser,
  createProgram,
  ts,
  type CompletedConfig,
} from "ts-json-schema-generator";
import {
  HOSTAPI_PATH_CONTRACTS,
  HOST_API_WIRE_ERROR_CODES,
  HOST_PROTOCOL_NOTIFICATIONS,
  HOST_PROTOCOL_CURRENT_VERSION,
  UNIVERSAL_WIRE_ERROR_CODES,
  hostApiMethodOf,
  type HostApiPath,
  type HostApiWireErrorCode,
} from "../../src/plugins/isolation/host-api-wire.js";
import { PLUGIN_INSTANCE_METHODS } from "../../src/plugins/isolation/plugin-instance-wire.js";
import { hostProtocolSchemaId } from "./plugin-host-protocol-mirror.mjs";

type JsonSchema = Record<string, unknown>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Compiler keys and generator globs require forward slashes on every platform.
const POSIX_ROOT = ROOT.replaceAll("\\", "/");
const PUBLIC_CONTRACT = "src/plugins/public-contract.ts";
const HOST_API_WIRE = "src/plugins/isolation/host-api-wire.ts";
const PLUGIN_INSTANCE_WIRE = "src/plugins/isolation/plugin-instance-wire.ts";
export const HOST_PROTOCOL_SCHEMA_LABEL = "[plugin-host-protocol-schema]";
const LABEL = HOST_PROTOCOL_SCHEMA_LABEL;

function hostProtocolSchemaPath(version: string): string {
  return `schemas/plugin-host-protocol/${version}/protocol.schema.json`;
}

function schemaId(version: string, appVersion: string): string {
  return hostProtocolSchemaId(`${version}/v${appVersion}/protocol.schema.json`);
}

// Encoded axes need explicit wire shapes; golden frames keep these paired with dispatcher and child stubs.
const WIRE_FORMS: Partial<
  Record<HostApiPath, { params?: Record<string, string | JsonSchema>; result?: string | JsonSchema }>
> = {
  "storage.read": { result: "WireBytes" },
  "storage.write": { params: { data: "WireBytes" } },
  resolveApiKey: { params: { opts: "WireResolveApiKeyOptions" }, result: "WireApiKeyLease" },
  callLlm: { params: { options: "WireCallLlmOptions" } },
  hostFetch: {
    // Only URL text crosses the boundary, never Request or URL objects.
    params: { input: { type: "string" }, init: "WireRequestInit" },
    result: "WireHttpResponse",
  },
  spawnWorker: { result: "WireWorkerHandle" },
  startAudioCapture: { result: "WireAudioCaptureHandle" },
  attachFloatingPanel: { result: "WireFloatingPanelHandle" },
};

const INSTANCE_FORMS: Record<
  keyof typeof PLUGIN_INSTANCE_METHODS,
  { params: string | JsonSchema; result: string | JsonSchema; errors: readonly HostApiWireErrorCode[] }
> = {
  construct: {
    params: "PluginConstructParams",
    result: "PluginConstructResult",
    errors: ["protocol-version-mismatch", "argument-marshalling-rejected", "payload-too-large"],
  },
  start: { params: { type: "object" }, result: { type: "null" }, errors: ["payload-too-large"] },
  onPublished: { params: { type: "object" }, result: { type: "null" }, errors: ["payload-too-large"] },
  stop: { params: { type: "object" }, result: { type: "null" }, errors: ["payload-too-large"] },
  shutdown: { params: "PluginShutdownParams", result: { type: "null" }, errors: ["payload-too-large"] },
};

const SUBSCRIPTION_ID: JsonSchema = {
  type: "string",
  description: "The subscription id the child allocated. The function stays in the child.",
};

function fail(message: string): never {
  throw new Error(`${LABEL} ${message}`);
}

interface Signature {
  readonly parameters: ReadonlyArray<{ name: string; optional: boolean; type: ts.TypeNode | undefined }>;
  readonly returnType: ts.TypeNode | undefined;
  readonly description: string | undefined;
}

// Normalize line endings before cutting summaries so a trailing CR cannot become content.
function firstParagraph(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/)[0]!.replace(/\s*\n\s*/g, " ");
}

function summaryOf(node: ts.Node): string | undefined {
  for (const doc of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(doc)) continue;
    const text = ts.getTextOfJSDocComment(doc.comment);
    if (text?.trim()) return firstParagraph(text);
  }
  return undefined;
}

function hostApiSignatures(source: ts.SourceFile): Map<string, Signature[]> {
  const declarations = new Map<string, ts.Node>();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      declarations.set(statement.name.text, statement);
    }
  }
  const membersOf = (node: ts.Node | undefined): readonly ts.TypeElement[] => {
    if (!node) return [];
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) return node.members;
    if (ts.isTypeAliasDeclaration(node)) return membersOf(node.type);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      return membersOf(declarations.get(node.typeName.text));
    }
    return [];
  };
  const found = new Map<string, Signature[]>();
  const walk = (container: ts.Node | undefined, prefix: string): void => {
    for (const member of membersOf(container)) {
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      const path = `${prefix}${member.name.text}`;
      if (ts.isMethodSignature(member)) {
        const signature: Signature = {
          parameters: member.parameters.map((parameter) => ({
            name: parameter.name.getText(source),
            optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
            type: parameter.type,
          })),
          returnType: member.type,
          description: summaryOf(member),
        };
        found.set(path, [...(found.get(path) ?? []), signature]);
      } else if (ts.isPropertySignature(member)) {
        walk(member.type, `${path}.`);
      }
    }
  };
  walk(declarations.get("PluginHostApi"), "");
  return found;
}

// Data-table declarations are not emitted types; never is a table value rather than an exclusion.
export const TABLE_DECLARATIONS = ["HostApiEventPayloads"] as const;

type TableDeclaration = (typeof TABLE_DECLARATIONS)[number];

// Here never means the registration or handle pushes nothing.
const EVENT_PAYLOADS_TABLE: TableDeclaration = "HostApiEventPayloads";

function eventPayloads(
  named: ReadonlyMap<string, ts.Node>,
  source: ts.SourceFile,
): Map<string, { type: ts.TypeNode; description: string | undefined }> {
  const declaration = named.get(EVENT_PAYLOADS_TABLE);
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) {
    fail(`${EVENT_PAYLOADS_TABLE} is not an interface in the wire sources`);
  }
  const found = new Map<string, { type: ts.TypeNode; description: string | undefined }>();
  for (const member of declaration.members) {
    if (!ts.isPropertySignature(member) || !member.type || !member.name
      || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
      fail(`a ${EVENT_PAYLOADS_TABLE} entry is not 'path: Type': ${member.getText(source)}`);
    }
    found.set(member.name.text, { type: member.type, description: summaryOf(member) });
  }
  return found;
}

// Project never properties as false subschemas so exclusive unions reject both keys.
// Exempt data tables; un-emitted interfaces fail rather than silently skipping enforcement.
export function excludeNeverProperties(
  named: ReadonlyMap<string, ts.Node>,
  types: Record<string, unknown>,
): void {
  for (const [name, declaration] of named) {
    if (!ts.isInterfaceDeclaration(declaration) || (TABLE_DECLARATIONS as readonly string[]).includes(name)) continue;
    const excluded = declaration.members.flatMap((member) =>
      ts.isPropertySignature(member)
        && member.type?.kind === ts.SyntaxKind.NeverKeyword
        && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        ? [member.name.text]
        : []);
    if (excluded.length === 0) continue;
    const exported = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const emitted = types[name] as { properties?: Record<string, unknown> } | undefined;
    if (!exported || emitted === undefined) {
      fail(
        `'${name}' declares ${excluded.map((property) => `'${property}'`).join(", ")} as never but is not emitted `
          + `(${exported ? "nothing on the wire reaches it" : "it is not exported"}), so the exclusion would be lost`,
      );
    }
    if (!emitted.properties || typeof emitted.properties !== "object") {
      fail(`'${name}' is emitted without a properties object, so its never members cannot be excluded`);
    }
    for (const property of excluded) emitted.properties[property] = false;
  }
}

// Rewrite draft-07 references and tuple items into the published schema dialect.
function to2020(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(to2020);
  if (!value || typeof value !== "object") return value;
  const out: JsonSchema = {};
  for (const [key, member] of Object.entries(value)) {
    if (key === "$ref" && typeof member === "string") {
      out.$ref = member.replace(/^#\/definitions\//, "#/$defs/types/");
    } else if (key === "items" && Array.isArray(member)) {
      out.prefixItems = to2020(member);
    } else if (key === "additionalItems") {
      out.items = to2020(member);
    } else {
      out[key] = to2020(member);
    }
  }
  if (Array.isArray(out.anyOf)) {
    // Undefined has no wire value; absent members represent it, so remove empty undefined branches.
    const branches = (out.anyOf as unknown[]).filter(
      (branch) => JSON.stringify(branch) !== JSON.stringify({ not: {} }),
    );
    const { anyOf: _undefinedBranch, ...rest } = out;
    return branches.length === 1 ? { ...rest, ...(branches[0] as JsonSchema) } : { ...rest, anyOf: branches };
  }
  return out;
}

// Normalize key order and line endings for byte-stable output.
// Summary text must be normalized before cutting to avoid retaining a stray CR.
function sortKeys(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n");
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as JsonSchema)[key])]),
  );
}

// Replies can carry any dispatcher-classified error except version mismatch, which belongs to construction.
// Member error lists describe local implementation failures, not a wire guarantee.
const HOST_METHOD_ERROR_CODES = HOST_API_WIRE_ERROR_CODES.filter(
  (code) => code !== "protocol-version-mismatch",
);

function errorSchema(
  codes: readonly HostApiWireErrorCode[],
  coded: boolean,
  description?: string,
): JsonSchema {
  const data: JsonSchema = {
    type: "object",
    properties: {
      code: { enum: [...codes] },
      name: { type: "string" },
      detail: { type: "object" },
      retryAfterMs: { type: "integer", minimum: 0, maximum: 5000 },
    },
    required: ["code", "name"],
    allOf: [{
      if: { properties: { code: { const: "rate-limited" } }, required: ["code"] },
      then: {
        properties: { retryAfterMs: { type: "integer", minimum: 0, maximum: 5000 } },
        required: ["retryAfterMs"],
      },
    }],
  };
  return {
    ...(description ? { description } : {}),
    type: "object",
    properties: { code: { type: "integer" }, message: { type: "string" }, data },
    required: coded ? ["code", "message", "data"] : ["code", "message"],
  };
}

export function generateHostProtocolSchema(): { path: string; text: string } {
  // Legacy protocols keep their frozen copies; only the current one is generated from the sources.
  const version = HOST_PROTOCOL_CURRENT_VERSION;
  const appVersion = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string })
    .version;

  const config: CompletedConfig = {
    ...DEFAULT_CONFIG,
    path: `${POSIX_ROOT}/{${PUBLIC_CONTRACT},${HOST_API_WIRE},${PLUGIN_INSTANCE_WIRE}}`,
    tsconfig: join(ROOT, "tsconfig.json"),
    skipTypeCheck: true,
    expose: "export",
    topRef: false,
    jsDoc: "basic",
    additionalProperties: true,
  };
  const program = createProgram(config);
  const generator = new SchemaGenerator(
    program,
    createParser(program, config),
    createFormatter(config),
    config,
  );
  const sourceOf = (file: string): ts.SourceFile =>
    program.getSourceFile(`${POSIX_ROOT}/${file}`) ?? fail(`the program did not load ${file}`);

  const types: Record<string, unknown> = {};
  const addType = (name: string, definition: unknown): void => {
    const converted = to2020(definition);
    if (name in types && JSON.stringify(types[name]) !== JSON.stringify(converted)) {
      fail(`two different definitions are both named '${name}'`);
    }
    types[name] = converted;
  };
  const schemaOf = (node: ts.Node): JsonSchema => {
    const { $schema: _draft, definitions, ...root } = generator.createSchemaFromNodes([node]) as JsonSchema & {
      definitions?: Record<string, unknown>;
    };
    for (const [name, definition] of Object.entries(definitions ?? {})) addType(name, definition);
    return to2020(root) as JsonSchema;
  };
  const named = new Map<string, ts.Node>();
  for (const file of [PUBLIC_CONTRACT, HOST_API_WIRE, PLUGIN_INSTANCE_WIRE]) {
    for (const statement of sourceOf(file).statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        named.set(statement.name.text, statement);
      }
    }
  }
  const formOf = (form: string | JsonSchema): JsonSchema => {
    if (typeof form !== "string") return form;
    const declaration = named.get(form) ?? fail(`no type named '${form}' in the wire sources`);
    if (!(form in types)) addType(form, schemaOf(declaration));
    return { $ref: `#/$defs/types/${form}` };
  };
  const anyOf = (schemas: JsonSchema[]): JsonSchema => {
    const distinct = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
    return distinct.length === 1 ? distinct[0]! : { anyOf: distinct };
  };

  const signatures = hostApiSignatures(sourceOf(PUBLIC_CONTRACT));
  const events = eventPayloads(named, sourceOf(HOST_API_WIRE));
  const methods: Record<string, JsonSchema> = {};
  const capabilities: string[] = [];

  for (const path of events.keys()) {
    if (!(path in HOSTAPI_PATH_CONTRACTS)) fail(`${EVENT_PAYLOADS_TABLE} names '${path}', which is not a member`);
  }

  for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]) {
    const contract = HOSTAPI_PATH_CONTRACTS[path];
    const forms = WIRE_FORMS[path];
    if (contract.result === "child-local") {
      if (forms) fail(`'${path}' is child-local and never crosses, so it has no wire form`);
      continue;
    }
    const overloads = signatures.get(path) ?? fail(`'${path}' is not a member of PluginHostApi`);
    for (const overload of overloads) {
      const names = overload.parameters.map((parameter) => parameter.name);
      if (JSON.stringify(names) !== JSON.stringify(contract.params)) {
        fail(`'${path}' declares (${names.join(", ")}) but its contract names (${contract.params.join(", ")})`);
      }
    }
    for (const name of Object.keys(forms?.params ?? {})) {
      if (contract.arguments !== "encoded") fail(`'${path}' has plain arguments, so '${name}' has no wire form`);
      if (!(contract.params as readonly string[]).includes(name)) fail(`'${path}' has no parameter '${name}'`);
    }
    if (contract.arguments === "encoded" && !forms?.params) {
      fail(`'${path}' encodes its arguments; name each encoded one's wire form`);
    }
    const registers = contract.arguments === "handler-registration";
    // Subscription and handle pushes remain part of the protocol after the initial reply.
    const outlivesReply = registers || contract.result === "handle" || contract.result === "handle-or-denied";
    const event = events.get(path);
    if (outlivesReply !== (event !== undefined)) {
      fail(
        outlivesReply
          ? `'${path}' registers or returns a handle; name what it pushes in ${EVENT_PAYLOADS_TABLE} (never for nothing)`
          : `'${path}' neither registers nor returns a handle, so it pushes nothing to name`,
      );
    }
    const resultNeedsForm =
      contract.result === "encoded" || ((contract.result === "handle" || contract.result === "handle-or-denied") && !registers);
    if (resultNeedsForm !== (forms?.result !== undefined)) {
      fail(
        resultNeedsForm
          ? `'${path}' returns a ${contract.result} result; name its wire form`
          : `'${path}' returns ${contract.result}, which needs no wire form`,
      );
    }

    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    contract.params.forEach((name, index) => {
      const override = forms?.params?.[name];
      properties[name] = override
        ? formOf(override)
        : anyOf(
            overloads.map((overload) => {
              const type = overload.parameters[index]!.type;
              if (registers && type && ts.isFunctionTypeNode(type)) return SUBSCRIPTION_ID;
              return type ? schemaOf(type) : {};
            }),
          );
      if (overloads.every((overload) => !overload.parameters[index]!.optional)) required.push(name);
    });

    let result: JsonSchema;
    if (contract.result === "void") result = { type: "null" };
    else if (forms?.result !== undefined) result = formOf(forms.result);
    else if (contract.result === "handle") result = formOf("HostApiHandle");
    else {
      result = anyOf(
        overloads.map((overload) =>
          overload.returnType ? schemaOf(overload.returnType) : fail(`'${path}' declares no return type`)),
      );
    }

    const method = hostApiMethodOf(path);
    const description = overloads.find((overload) => overload.description)?.description;
    methods[method] = {
      ...(description ? { description } : {}),
      params: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
      result,
      errors: errorSchema(
        HOST_METHOD_ERROR_CODES,
        true,
        `The boundary's own refusals (${UNIVERSAL_WIRE_ERROR_CODES.join(", ")}) can reply to any call`
          + (contract.errors.length > 0
            ? `; this member's implementation raises ${contract.errors.join(", ")}.`
            : "; this member's implementation raises none of its own."),
      ),
      ...(event
        ? {
            events: {
              ...(event.description ? { description: event.description } : {}),
              ...schemaOf(event.type),
            },
          }
        : {}),
    };
    capabilities.push(method);
  }

  for (const [key, method] of Object.entries(PLUGIN_INSTANCE_METHODS)) {
    const form = INSTANCE_FORMS[key as keyof typeof PLUGIN_INSTANCE_METHODS];
    methods[method] = {
      params: formOf(form.params),
      result: formOf(form.result),
      // Plugin-code lifecycle failures carry no code; runtime refusals do.
      errors: errorSchema(form.errors, false),
    };
  }

  const notifications: Record<string, JsonSchema> = {};
  const wire = sourceOf(HOST_API_WIRE);
  const union = named.get("HostApiNotification");
  if (!union || !ts.isTypeAliasDeclaration(union) || !ts.isUnionTypeNode(union.type)) {
    fail("HostApiNotification is not a union of notification types");
  }
  for (const member of union.type.types) {
    const [nameNode, paramsNode] = ts.isTypeReferenceNode(member) ? (member.typeArguments ?? []) : [];
    if (!nameNode || !paramsNode || !ts.isTypeQueryNode(nameNode) || !ts.isQualifiedName(nameNode.exprName)) {
      fail(`a HostApiNotification member is not HostProtocolNotification<typeof NAME, PARAMS>: ${member.getText(wire)}`);
    }
    const key = nameNode.exprName.right.text as keyof typeof HOST_PROTOCOL_NOTIFICATIONS;
    const method = HOST_PROTOCOL_NOTIFICATIONS[key] ?? fail(`no notification named '${key}'`);
    if (method in notifications) fail(`'${method}' is declared twice`);
    // Union-member docs are trivia before the separator; read the final doc block in the preceding gap.
    const index = union.type.types.indexOf(member);
    const gap = wire.text.slice(
      index === 0 ? union.type.pos : union.type.types[index - 1]!.end,
      member.getStart(wire),
    );
    const comment = gap.match(/\/\*\*[\s\S]*?\*\//g)?.at(-1)
      ?? fail(`'${method}' has no doc comment in HostApiNotification; it is the notification's description`);
    const description = firstParagraph(
      comment
        .replace(/^\/\*\*|\*\/$/g, "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/^\s*\* ?/, ""))
        .join("\n"),
    );
    notifications[method] = { description, params: schemaOf(paramsNode) };
  }
  for (const method of Object.values(HOST_PROTOCOL_NOTIFICATIONS)) {
    if (!(method in notifications)) fail(`'${method}' has no shape in HostApiNotification`);
  }

  excludeNeverProperties(named, types);

  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: schemaId(version, appVersion),
    title: `Ave plugin host protocol ${version}`,
    description:
      `Generated by scripts/generate-plugin-host-protocol-schema.ts from Ave ${appVersion}; `
      + "do not edit. Each method names its params, its result and the errors it may reply with, "
      + "and a method whose registration or handle outlives the reply names the payload of every "
      + "notifications/ave/subscription frame for it under events; each notification names its params. "
      + "docs/design/plugin-hostapi-protocol.md describes the protocol.",
    $defs: {
      methods,
      notifications,
      error: errorSchema(HOST_API_WIRE_ERROR_CODES, true),
      errorCodes: { enum: [...HOST_API_WIRE_ERROR_CODES] },
      capabilities: {
        description: "Every ave/host method a host with every optional member bound advertises in construct.",
        type: "array",
        uniqueItems: true,
        items: { enum: capabilities.sort() },
      },
      types,
    },
  };
  return {
    path: hostProtocolSchemaPath(version),
    text: `${JSON.stringify(sortKeys(schema), null, 2)}\n`,
  };
}
