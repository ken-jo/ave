/** Config schemas use draft-07; format: "secret" routes values to encrypted storage without validating content. */

import * as AjvModule from "ajv";
import * as AddFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { PluginConfigSchema, PluginConfigSchemaProperty } from "./types.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("plugin-config-schema");

export interface AjvCtor {
  new (opts?: unknown): {
    compile: (schema: unknown) => ValidateFunction;
    addFormat: (name: string, def: unknown) => void;
    addSchema: (schema: unknown) => unknown;
    getSchema: (ref: string) => ValidateFunction | undefined;
  };
}

/** Resolve the shared schema-validator constructor across default-export and CommonJS interop. */
export function resolveAjv(): AjvCtor {
  const mod = AjvModule as unknown as { default?: unknown };
  return (mod.default ?? AjvModule) as AjvCtor;
}

export function resolveAddFormats(): (a: unknown) => void {
  const mod = AddFormatsModule as unknown as { default?: unknown };
  return (mod.default ?? AddFormatsModule) as (a: unknown) => void;
}

export function pluginSecretKey(pluginId: string, key: string): string {
  return `plugin.${pluginId}.${key}`;
}

export function isSecretProperty(prop: PluginConfigSchemaProperty | undefined): boolean {
  return Boolean(prop && prop.type === "string" && prop.format === "secret");
}

/** Secret keys must be stripped from cleartext config and persisted through setSecret. */
export function listSecretKeys(schema: PluginConfigSchema | undefined): Set<string> {
  const out = new Set<string>();
  if (!schema?.properties) return out;
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isSecretProperty(prop)) out.add(key);
  }
  return out;
}

/** Compilation failures return null so callers can sanitize config without wedging boot. */
export function compileConfigSchemaValidator(
  schema: PluginConfigSchema,
): ValidateFunction | null {
  try {
    const AjvCtor = resolveAjv();
    const ajv = new AjvCtor({
      strict: false,
      allErrors: true,
      useDefaults: false,
      coerceTypes: false,
    });
    resolveAddFormats()(ajv);
    // The secret format is a storage hint; register it as non-validating under strict format checks.
    try {
      ajv.addFormat("secret", { type: "string", validate: () => true });
    } catch {
      // Format registration can throw when repeated on the same instance.
    }
    const wrapper = {
      type: "object",
      properties: schema.properties,
      required: Array.isArray(schema.required) ? schema.required : undefined,
      additionalProperties: true,
    } as const;
    return ajv.compile(wrapper);
  } catch (err) {
    // eslint-disable-next-line no-console
    log.warn(
      "AJV compile failed — falling back to permissive sanitizer: %s",
      (err as Error).message,
    );
    return null;
  }
}

/** Saved values override defaults; return a shallow copy. */
export function applyConfigDefaults(
  schema: PluginConfigSchema | undefined,
  saved: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema?.properties) return { ...saved };
  const out: Record<string, unknown> = { ...saved };
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (out[key] === undefined && prop.default !== undefined) {
      out[key] = prop.default;
    }
  }
  return out;
}

/** Strip secret fields at IPC as defense in depth against accidental cleartext settings writes. */
export function stripSecretFields(
  schema: PluginConfigSchema | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema?.properties) return config;
  const secretKeys = listSecretKeys(schema);
  if (secretKeys.size === 0) return config;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (!secretKeys.has(k)) out[k] = v;
  }
  return out;
}
