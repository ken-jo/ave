import manifestSchema from "../../schemas/plugin-manifest.schema.json" with { type: "json" };
import type { ValidateFunction } from "ajv";
import { isPackageName } from "../marketplace/catalog/types.js";
import { createLogger } from "../lib/logger.js";
import { parseStrictJson } from "../marketplace/catalog/strict-json.js";
import { resolveAddFormats, resolveAjv } from "./config-schema.js";
import { AGENT_PLUGINS_SCHEMA_URL, AVE_EXTENSION_NAMESPACE, foreignManifestTopLevelFields, type AgentPluginPackageManifest } from "./public-contract.js";

const log = createLogger("agent-plugin-manifest");
let compiledManifestValidator: ValidateFunction | undefined;

function manifestValidator(): ValidateFunction {
  if (compiledManifestValidator) return compiledManifestValidator;
  const Ajv = resolveAjv();
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
  resolveAddFormats()(ajv);
  compiledManifestValidator = ajv.compile(manifestSchema);
  return compiledManifestValidator;
}

export interface AgentPluginManifestIdentity {
  name?: string;
  version?: string;
  minAppVersion?: string;
}

/** Validate the shared three-branch shape before deciding which lifecycle owns it. */
export function validatePluginManifestShape(bytes: Buffer | string): Record<string, unknown> {
  const value: unknown = parseStrictJson(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("plugin.json must be an object");
  const document = value as Record<string, unknown>;
  const foreign = foreignManifestTopLevelFields(document);
  for (const key of foreign) log.warn(`plugin.json: ignoring unknown top-level field ${key}`);
  const known = Object.fromEntries(Object.entries(document).filter(([key]) => !foreign.includes(key)));
  const validate = manifestValidator();
  if (!validate(known)) {
    const error = validate.errors?.[0];
    const field = error?.keyword === "additionalProperties" ? String(error.params.additionalProperty) : (error?.instancePath || "/");
    throw new Error(`plugin.json ${field}: ${error?.message ?? "invalid manifest"}`);
  }
  return document;
}

/** Validate the non-executable branch of the shared manifest schema at a package boundary. */
export function parseAgentPluginManifest(bytes: Buffer | string, expected: AgentPluginManifestIdentity = {}): AgentPluginPackageManifest {
  const document = validatePluginManifestShape(bytes);
  if (document.$schema !== AGENT_PLUGINS_SCHEMA_URL || !isPackageName(document.name)) throw new Error("plugin.json has an invalid schema or name");
  if (typeof document.version !== "string") throw new Error("plugin.json needs version for marketplace installation");
  if (typeof document.description !== "string" || !document.description.trim()) throw new Error("plugin.json needs description for marketplace installation");
  const extensions = document.extensions as Record<string, unknown> | undefined;
  const own = extensions?.[AVE_EXTENSION_NAMESPACE] as Record<string, unknown> | undefined;
  if (own && (Object.hasOwn(own, "entry") || Object.hasOwn(own, "process"))) throw new Error("plugin.json declares an extension process");
  if (expected.name !== undefined && document.name !== expected.name) throw new Error(`plugin.json name ${document.name} differs from ${expected.name}`);
  if (expected.version !== undefined && document.version !== expected.version) throw new Error(`plugin.json version ${document.version} differs from ${expected.version}`);
  const declaredMinimum = (own?.requires as { minAppVersion?: string } | undefined)?.minAppVersion;
  if (expected.minAppVersion !== undefined && declaredMinimum !== undefined && declaredMinimum !== expected.minAppVersion) {
    throw new Error("plugin.json requires.minAppVersion differs from the descriptor");
  }
  return document as unknown as AgentPluginPackageManifest;
}
