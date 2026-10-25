// Reject installed runtimes whose generated schema lacks any request, notification, field, or literal the integration requires.
import { isRecord } from "../shared/is-record.js";

type JsonSchema = Record<string, unknown>;

type SchemaType = "string" | "boolean" | "integer" | "number" | "array" | "object" | "null";

interface ValueRequirement {
  readonly type?: SchemaType;
  // String literals, or the `type` discriminators of object alternatives.
  readonly values?: readonly string[];
  readonly value?: boolean;
  readonly fields?: readonly FieldRequirement[];
  // Every item shape the client can put in this array.
  readonly items?: readonly ValueRequirement[];
  // A value passed through as arbitrary JSON.
  readonly anyJson?: boolean;
}

interface FieldRequirement extends ValueRequirement {
  // Dotted path below the containing object; each segment is a property name.
  readonly path: string;
  // The client can omit this field while retaining the rest of the object.
  readonly optional?: boolean;
  // This key is a map entry rather than a declared protocol field.
  readonly mapEntry?: boolean;
  // Report parameter children without adding an envelope segment to their paths.
  readonly inlineDiagnostics?: boolean;
}

interface MethodRequirement {
  readonly method: string;
  readonly fields?: readonly FieldRequirement[];
  // Separate request shapes, each of which must fit a complete union branch.
  readonly variants?: readonly (readonly FieldRequirement[])[];
}

export interface CodexProtocolRequirements {
  readonly clientRequests: readonly MethodRequirement[];
  readonly serverNotifications: readonly string[];
  readonly serverRequests: readonly string[];
}

export const CODEX_PROTOCOL_REQUIREMENTS: CodexProtocolRequirements = Object.freeze({
  clientRequests: Object.freeze<readonly MethodRequirement[]>([
    {
      method: "initialize",
      fields: [
        { path: "clientInfo", type: "object", fields: [
          { path: "name", type: "string", values: ["ave"] },
          { path: "title", type: "string", values: ["Ave"] },
          { path: "version", type: "string" },
        ] },
        { path: "capabilities", type: "object", optional: true, fields: [
          { path: "experimentalApi", type: "boolean", value: true },
        ] },
      ],
    },
    { method: "account/read", fields: [{ path: "refreshToken", type: "boolean", value: false }] },
    {
      method: "account/login/start",
      variants: [
        [
          { path: "type", type: "string", values: ["chatgpt"] },
          { path: "useHostedLoginSuccessPage", type: "boolean", value: true },
          { path: "appBrand", type: "string", values: ["codex"] },
        ],
        [{ path: "type", type: "string", values: ["chatgptDeviceCode"] }],
      ],
    },
    { method: "account/login/cancel", fields: [{ path: "loginId", type: "string" }] },
    { method: "account/logout" },
    { method: "model/list", fields: [{ path: "limit", type: "integer" }, { path: "includeHidden", type: "boolean", value: false }] },
    {
      method: "thread/start",
      fields: [
        { path: "model", type: "string", optional: true },
        { path: "dynamicTools", type: "array", optional: true, items: [
          { type: "object", values: ["function"], fields: [
            { path: "name", type: "string" },
            { path: "description", type: "string" },
            { path: "inputSchema", anyJson: true },
            { path: "deferLoading", type: "boolean", value: false, optional: true },
          ] },
          { type: "object", values: ["namespace"], fields: [
            { path: "name", type: "string" },
            { path: "description", type: "string" },
            { path: "tools", type: "array", items: [
              { type: "object", values: ["function"], fields: [
                { path: "name", type: "string" },
                { path: "description", type: "string" },
                { path: "inputSchema", anyJson: true },
                { path: "deferLoading", type: "boolean", optional: true },
              ] },
            ] },
          ] },
        ] },
        { path: "cwd", type: "string" },
        { path: "environments", type: "array" },
        { path: "config", type: "object", fields: [
          { path: "include_permissions_instructions", type: "boolean", value: false, mapEntry: true },
        ] },
        { path: "approvalPolicy", type: "string", values: ["untrusted"] },
        { path: "sandbox", type: "string", values: ["read-only"] },
        { path: "ephemeral", type: "boolean", value: true },
      ],
    },
    {
      method: "turn/start",
      fields: [
        { path: "threadId", type: "string" },
        { path: "input", type: "array", items: [
          { type: "object", values: ["text"], fields: [{ path: "text", type: "string" }] },
          { type: "object", values: ["localImage"], fields: [{ path: "path", type: "string" }] },
        ] },
        { path: "model", type: "string", optional: true },
        { path: "cwd", type: "string" },
        { path: "environments", type: "array" },
        { path: "approvalPolicy", type: "string", values: ["untrusted"] },
        { path: "sandboxPolicy", type: "object", values: ["readOnly"], fields: [
          { path: "networkAccess", type: "boolean", value: false },
        ] },
      ],
    },
    { method: "turn/interrupt", fields: [{ path: "threadId", type: "string" }, { path: "turnId", type: "string" }] },
    { method: "windowsSandbox/readiness" },
  ]),
  serverNotifications: Object.freeze([
    "account/updated",
    "account/login/completed",
    "item/started",
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "thread/tokenUsage/updated",
    "turn/completed",
  ]),
  serverRequests: Object.freeze([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/call",
    "item/tool/requestUserInput",
  ]),
});

// The generated schema documents a check reads, keyed by their file names.
export interface CodexGeneratedSchemas {
  readonly clientRequest: unknown;
  readonly serverNotification: unknown;
  readonly serverRequest: unknown;
}

export const CODEX_SCHEMA_FILES = Object.freeze({
  clientRequest: "ClientRequest.json",
  serverNotification: "ServerNotification.json",
  serverRequest: "ServerRequest.json",
});

function definitionsOf(document: JsonSchema): Record<string, unknown> {
  return isRecord(document.definitions) ? document.definitions : {};
}

// One union branch contains all its intersecting constraints, never its siblings.
interface SchemaBranch {
  readonly constraints: readonly JsonSchema[];
  readonly choices: readonly { readonly schema: JsonSchema; readonly index: number }[];
}

function intersectBranches(left: SchemaBranch[], right: SchemaBranch[]): SchemaBranch[] {
  if (left.length * right.length > 256) return [];
  return left.flatMap((a) => right.map((b) => ({
    constraints: [...a.constraints, ...b.constraints],
    choices: [...a.choices, ...b.choices],
  })));
}

function alternatives(schema: unknown, definitions: Record<string, unknown>, depth = 0): SchemaBranch[] {
  if (depth > 32 || schema === false) return [];
  if (schema === true) return [{ constraints: [], choices: [] }];
  if (!isRecord(schema)) return [];
  let branches: SchemaBranch[] = [{ constraints: [schema], choices: [] }];
  if (schema.$ref !== undefined) {
    const match = typeof schema.$ref === "string" ? /^#\/definitions\/([^/]+)$/.exec(schema.$ref) : null;
    const target = match ? definitions[match[1]!] : undefined;
    branches = intersectBranches(branches, alternatives(target, definitions, depth + 1));
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    if (schema[key] === undefined) continue;
    const variants = schema[key];
    if (!Array.isArray(variants)) return [];
    branches = intersectBranches(branches, variants.flatMap((variant, index) => alternatives(variant, definitions, depth + 1)
      .map((branch) => ({
        ...branch,
        choices: key === "oneOf" ? [...branch.choices, { schema, index }] : branch.choices,
      }))));
  }
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf)) return [];
    for (const constraint of schema.allOf) {
      branches = intersectBranches(branches, alternatives(constraint, definitions, depth + 1));
    }
  }
  return branches;
}

function propertySchema(branch: SchemaBranch, name: string, mapEntry = false): unknown {
  let declared = false;
  const constraints: unknown[] = [];
  for (const schema of branch.constraints) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Object.hasOwn(properties, name)) {
      declared = true;
      constraints.push(properties[name]);
    } else if (schema.additionalProperties !== undefined) {
      constraints.push(schema.additionalProperties);
    }
  }
  if (!declared && !mapEntry) return undefined;
  return { allOf: constraints };
}

function hasSchemaType(value: unknown, expected: SchemaType): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return isRecord(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function admitsType(branch: SchemaBranch, expected: SchemaType): boolean {
  return branch.constraints.every((schema) => {
    if (Array.isArray(schema.enum) && !schema.enum.some((value) => hasSchemaType(value, expected))) return false;
    if (Object.hasOwn(schema, "const") && !hasSchemaType(schema.const, expected)) return false;
    if (schema.type === undefined) return true;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    return types.includes(expected) || (expected === "integer" && types.includes("number"));
  });
}

function admitsLiteral(branch: SchemaBranch, value: string | boolean): boolean {
  return admitsType(branch, typeof value === "string" ? "string" : "boolean")
    && branch.constraints.every((schema) => (!Array.isArray(schema.enum) || schema.enum.includes(value))
      && (!Object.hasOwn(schema, "const") || schema.const === value));
}

function methodsOf(document: JsonSchema): Map<string, SchemaBranch[]> {
  const definitions = definitionsOf(document);
  const methods = new Map<string, SchemaBranch[]>();
  for (const branch of alternatives(document, definitions)) {
    for (const method of alternatives(propertySchema(branch, "method"), definitions)) {
      const names = method.constraints.flatMap((schema) => Array.isArray(schema.enum)
        ? schema.enum
        : typeof schema.const === "string" ? [schema.const] : []);
      for (const name of names) {
        if (typeof name === "string" && admitsLiteral(method, name)) {
          methods.set(name, [...(methods.get(name) ?? []), branch]);
        }
      }
    }
  }
  return methods;
}

// Group dotted paths before checking so sibling fields share one object branch.
function nestedFields(fields: readonly FieldRequirement[]): FieldRequirement[] {
  const grouped = new Map<string, FieldRequirement>();
  for (const field of fields) {
    const [name, ...segments] = field.path.split(".");
    const existing = grouped.get(name!);
    if (segments.length === 0) {
      grouped.set(name!, { ...field, fields: [...(existing?.fields ?? []), ...(field.fields ?? [])] });
    } else {
      grouped.set(name!, {
        ...existing,
        path: name!,
        type: "object",
        fields: [...(existing?.fields ?? []), { ...field, path: segments.join(".") }],
      });
    }
  }
  return [...grouped.values()];
}

function hasUnrestrictedJson(branch: SchemaBranch): boolean {
  return branch.constraints.every((schema) => Object.keys(schema).every((key) => [
    "$ref", "$schema", "$id", "$comment", "definitions", "allOf", "anyOf", "oneOf",
    "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  ].includes(key)));
}

function missingShape(
  branches: SchemaBranch[],
  requirement: ValueRequirement,
  path: string,
  definitions: Record<string, unknown>,
): string[] {
  if (requirement.type === "boolean" && requirement.value === undefined) {
    return [true, false].flatMap((value) => missingShape(branches, { ...requirement, value }, path, definitions));
  }
  if ((requirement.values?.length ?? 0) > 1) {
    return requirement.values!.flatMap((value) => missingShape(branches, { ...requirement, values: [value] }, path, definitions));
  }
  const fields = nestedFields(requirement.fields ?? []);
  const tag = requirement.type === "object" ? requirement.values?.[0] : undefined;
  const discriminator = tag === undefined ? fields.find((field) => field.path === "type" && field.values?.length === 1) : undefined;
  const tagValue = tag ?? discriminator?.values?.[0];
  if (tagValue !== undefined) {
    branches = branches.filter((branch) => alternatives(propertySchema(branch, "type"), definitions)
      .some((candidate) => admitsLiteral(candidate, tagValue)));
    if (branches.length === 0) return [`${path}${tag === undefined ? ".type" : ""}=${tagValue}`];
  }
  if (tag !== undefined) fields.unshift({ path: "type", type: "string", values: [tag] });
  const failures = branches.map((branch) => {
    if (requirement.anyJson && !hasUnrestrictedJson(branch)) return [`${path} (arbitrary JSON)`];
    if (requirement.type && !admitsType(branch, requirement.type)) return [`${path} (type ${requirement.type})`];
    if (requirement.value !== undefined && !admitsLiteral(branch, requirement.value)) return [`${path}=${requirement.value}`];
    if (requirement.type !== "object" && requirement.values?.some((value) => !admitsLiteral(branch, value))) {
      return requirement.values.filter((value) => !admitsLiteral(branch, value)).map((value) => `${path}=${value}`);
    }
    const missing: string[] = [];
    for (const field of fields) {
      const fieldPath = `${path}.${field.path}`;
      const schema = propertySchema(branch, field.path, field.mapEntry);
      if (schema === undefined) missing.push(fieldPath);
      else missing.push(...missingShape(alternatives(schema, definitions), field, field.inlineDiagnostics ? path : fieldPath, definitions));
    }
    if (fields.length > 0) {
      const provided = new Set(fields.filter((field) => !field.optional).map((field) => field.path));
      for (const schema of branch.constraints) {
        for (const required of Array.isArray(schema.required) ? schema.required : []) {
          if (typeof required === "string" && !provided.has(required)) missing.push(`${path}.${required} (required)`);
        }
      }
    }
    if (requirement.items) {
      const itemSchemas = branch.constraints.flatMap((schema) => schema.items === undefined ? [] : [schema.items]);
      const itemBranches = alternatives({ allOf: itemSchemas }, definitions);
      for (const item of requirement.items) missing.push(...missingShape(itemBranches, item, path, definitions));
    }
    return missing;
  });
  const successes = branches.filter((_, index) => failures[index]!.length === 0);
  if (successes.some((branch) => branch.choices.every((choice) => !successes.some((other) => other.choices
    .some((candidate) => candidate.schema === choice.schema && candidate.index !== choice.index))))) return [];
  if (successes.length > 0) return [`${path} (exclusive union)`];
  return failures.sort((a, b) => a.length - b.length)[0]
    ?? [`${path}${requirement.anyJson ? " (arbitrary JSON)" : requirement.type ? ` (type ${requirement.type})` : ""}`];
}

// List every requirement the generated schemas do not satisfy, as stable strings such as `request thread/start.environments`. An empty list means the
// declared request shapes and incoming method names match.
export function missingCodexProtocolRequirements(
  schemas: CodexGeneratedSchemas,
  requirements: CodexProtocolRequirements = CODEX_PROTOCOL_REQUIREMENTS,
): string[] {
  const missing: string[] = [];
  if (!isRecord(schemas.clientRequest) || !isRecord(schemas.serverNotification) || !isRecord(schemas.serverRequest)) {
    return ["schema documents"];
  }
  const clientDefinitions = definitionsOf(schemas.clientRequest);
  const clientMethods = methodsOf(schemas.clientRequest);
  for (const requirement of requirements.clientRequests) {
    const variants = clientMethods.get(requirement.method);
    if (!variants) {
      missing.push(`request ${requirement.method}`);
      continue;
    }
    const payloads = requirement.variants ?? (requirement.fields ? [requirement.fields] : []);
    for (const fields of payloads.length === 0 ? [undefined] : payloads) {
      const envelopeFields: FieldRequirement[] = [
        { path: "id", type: "integer" },
        { path: "method", type: "string", values: [requirement.method] },
      ];
      if (fields) envelopeFields.push({ path: "params", type: "object", fields, inlineDiagnostics: true });
      missing.push(...missingShape(variants, { type: "object", fields: envelopeFields }, `request ${requirement.method}`, clientDefinitions));
    }
  }
  const notifications = methodsOf(schemas.serverNotification);
  for (const method of requirements.serverNotifications) {
    if (!notifications.has(method)) missing.push(`notification ${method}`);
  }
  const serverRequests = methodsOf(schemas.serverRequest);
  for (const method of requirements.serverRequests) {
    if (!serverRequests.has(method)) missing.push(`server request ${method}`);
  }
  return [...new Set(missing)];
}
