/**
 * The app-server protocol surface Ave depends on, checked against the JSON
 * Schema a user-installed `codex` binary generates for itself.
 *
 * Every entry names a request, notification or server request Ave sends or
 * handles, and the parameter fields and enum values it relies on. A binary
 * whose generated schema lacks any of them cannot run Ave's integration, so
 * the check reports every missing item and never guesses a substitute.
 */

type JsonSchema = Record<string, unknown>;

interface FieldRequirement {
  /** Dotted path below the params object; each segment is a property name. */
  readonly path: string;
  /** Enum values (or `type` discriminators) the field must admit. */
  readonly values?: readonly string[];
}

interface MethodRequirement {
  readonly method: string;
  readonly fields?: readonly FieldRequirement[];
}

export interface CodexProtocolRequirements {
  readonly clientRequests: readonly MethodRequirement[];
  readonly serverNotifications: readonly string[];
  readonly serverRequests: readonly string[];
}

export const CODEX_PROTOCOL_REQUIREMENTS: CodexProtocolRequirements = Object.freeze({
  clientRequests: Object.freeze([
    { method: "initialize", fields: [{ path: "clientInfo.name" }, { path: "clientInfo.title" }, { path: "clientInfo.version" }, { path: "capabilities.experimentalApi" }] },
    { method: "account/read", fields: [{ path: "refreshToken" }] },
    {
      method: "account/login/start",
      fields: [
        { path: "type", values: ["chatgpt", "chatgptDeviceCode"] },
        { path: "useHostedLoginSuccessPage" },
        { path: "appBrand", values: ["codex"] },
      ],
    },
    { method: "account/login/cancel", fields: [{ path: "loginId" }] },
    { method: "account/logout" },
    { method: "model/list", fields: [{ path: "limit" }, { path: "includeHidden" }] },
    {
      method: "thread/start",
      fields: [
        { path: "model" },
        { path: "dynamicTools" },
        { path: "cwd" },
        { path: "environments" },
        { path: "config" },
        { path: "approvalPolicy", values: ["untrusted"] },
        { path: "sandbox", values: ["read-only"] },
        { path: "ephemeral" },
      ],
    },
    {
      method: "turn/start",
      fields: [
        { path: "threadId" },
        { path: "input", values: ["text", "localImage"] },
        { path: "model" },
        { path: "cwd" },
        { path: "environments" },
        { path: "approvalPolicy", values: ["untrusted"] },
        { path: "sandboxPolicy", values: ["readOnly"] },
        { path: "sandboxPolicy.networkAccess" },
      ],
    },
    { method: "turn/interrupt", fields: [{ path: "threadId" }, { path: "turnId" }] },
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

/** The generated schema documents a check reads, keyed by their file names. */
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

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definitionsOf(document: JsonSchema): Record<string, unknown> {
  return isSchema(document.definitions) ? document.definitions : {};
}

function resolveRef(schema: JsonSchema, definitions: Record<string, unknown>, depth = 0): JsonSchema | null {
  if (depth > 16) return null;
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const match = /^#\/definitions\/([^/]+)$/.exec(ref);
  const target = match ? definitions[match[1]!] : undefined;
  return isSchema(target) ? resolveRef(target, definitions, depth + 1) : null;
}

/** Every concrete alternative of a schema: union branches flattened, refs resolved. */
function alternatives(schema: unknown, definitions: Record<string, unknown>, depth = 0): JsonSchema[] {
  if (!isSchema(schema) || depth > 16) return [];
  const resolved = resolveRef(schema, definitions);
  if (!resolved) return [];
  const branches = [resolved.oneOf, resolved.anyOf, resolved.allOf].find(Array.isArray) as unknown[] | undefined;
  if (branches) return branches.flatMap((branch) => alternatives(branch, definitions, depth + 1));
  if (isSchema(resolved.items)) return alternatives(resolved.items, definitions, depth + 1);
  return [resolved];
}

function methodsOf(document: JsonSchema): Map<string, JsonSchema> {
  const methods = new Map<string, JsonSchema>();
  const variants = Array.isArray(document.oneOf) ? document.oneOf : [];
  for (const variant of variants) {
    if (!isSchema(variant) || !isSchema(variant.properties)) continue;
    const method = variant.properties.method;
    const names = isSchema(method) && Array.isArray(method.enum) ? method.enum : [];
    for (const name of names) {
      if (typeof name === "string") methods.set(name, variant);
    }
  }
  return methods;
}

/** Property schemas reachable at `segment` across every alternative of `schema`. */
function propertyAt(schemas: JsonSchema[], segment: string, definitions: Record<string, unknown>): JsonSchema[] {
  const found: JsonSchema[] = [];
  for (const schema of schemas) {
    const properties = isSchema(schema.properties) ? schema.properties : null;
    const property = properties?.[segment];
    if (isSchema(property)) found.push(...alternatives(property, definitions));
  }
  return found;
}

/** The literal values a field admits: its own enum, or each object branch's `type` enum. */
function admittedValues(schemas: JsonSchema[], definitions: Record<string, unknown>): Set<string> {
  const values = new Set<string>();
  for (const schema of schemas) {
    if (Array.isArray(schema.enum)) {
      for (const value of schema.enum) if (typeof value === "string") values.add(value);
    }
    if (typeof schema.const === "string") values.add(schema.const);
    for (const discriminator of propertyAt([schema], "type", definitions)) {
      if (Array.isArray(discriminator.enum)) {
        for (const value of discriminator.enum) if (typeof value === "string") values.add(value);
      }
    }
  }
  return values;
}

/**
 * List every requirement the generated schemas do not satisfy, as stable
 * strings such as `request thread/start.environments`. An empty list means
 * the binary speaks everything Ave uses.
 */
export function missingCodexProtocolRequirements(
  schemas: CodexGeneratedSchemas,
  requirements: CodexProtocolRequirements = CODEX_PROTOCOL_REQUIREMENTS,
): string[] {
  const missing: string[] = [];
  if (!isSchema(schemas.clientRequest) || !isSchema(schemas.serverNotification) || !isSchema(schemas.serverRequest)) {
    return ["schema documents"];
  }
  const clientDefinitions = definitionsOf(schemas.clientRequest);
  const clientMethods = methodsOf(schemas.clientRequest);
  for (const requirement of requirements.clientRequests) {
    const variant = clientMethods.get(requirement.method);
    if (!variant) {
      missing.push(`request ${requirement.method}`);
      continue;
    }
    const params = alternatives((variant.properties as JsonSchema).params, clientDefinitions);
    for (const field of requirement.fields ?? []) {
      let current = params;
      for (const segment of field.path.split(".")) {
        current = propertyAt(current, segment, clientDefinitions);
      }
      if (current.length === 0) {
        missing.push(`request ${requirement.method}.${field.path}`);
        continue;
      }
      const admitted = admittedValues(current, clientDefinitions);
      for (const value of field.values ?? []) {
        if (!admitted.has(value)) missing.push(`request ${requirement.method}.${field.path}=${value}`);
      }
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
  return missing;
}
