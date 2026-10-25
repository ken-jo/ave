/** Renderer forms and main validation share schema support; display labels must not redefine acceptance. */

import { isRecord } from "./is-record.js";

export type ElicitationFieldKind = "string" | "number" | "integer" | "boolean";

export type ElicitationEnumValue = string | number | boolean | null;

export type ElicitationSchemaField = {
  name: string;
  /** Declared `type`; defaults to `"string"` for enum-only fields. */
  kind: ElicitationFieldKind;
  required: boolean;
  /** Present only when the property declared a non-empty `enum`. */
  enumValues?: readonly ElicitationEnumValue[];
  /** Display-only passthroughs, trimmed; absent when blank or non-string. */
  title?: string;
  description?: string;
  /** Raw `default`, unvalidated — consumers decide whether it is usable. */
  defaultValue?: unknown;
};

export type ParsedElicitationSchema = {
  fields: readonly ElicitationSchemaField[];
};

const MAX_ELICITATION_FIELDS = 12;

const ELICITATION_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function isElicitationEnumValue(value: unknown): value is ElicitationEnumValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" || typeof value === "boolean";
}

function parseEnumValues(value: unknown): readonly ElicitationEnumValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return undefined;
  if (!value.every(isElicitationEnumValue)) return undefined;
  return value;
}

function supportedKind(value: unknown): ElicitationFieldKind | undefined {
  if (value === "string" || value === "number" || value === "integer" || value === "boolean") {
    return value;
  }
  return undefined;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reject unsupported schemas whole, never partial forms; empty scalar enum values remain valid. */
export function parseElicitationSchema(rawSchema: unknown): ParsedElicitationSchema | undefined {
  if (!isRecord(rawSchema) || rawSchema.type !== "object" || !isRecord(rawSchema.properties)) {
    return undefined;
  }

  const entries = Object.entries(rawSchema.properties);
  if (entries.length > MAX_ELICITATION_FIELDS) return undefined;

  let requiredNames: Set<string>;
  if (rawSchema.required === undefined) {
    requiredNames = new Set();
  } else if (
    Array.isArray(rawSchema.required) &&
    rawSchema.required.every((name) => typeof name === "string")
  ) {
    requiredNames = new Set<string>(rawSchema.required);
  } else {
    return undefined;
  }

  const fields: ElicitationSchemaField[] = [];
  for (const [name, rawProperty] of entries) {
    if (!ELICITATION_FIELD_NAME_RE.test(name) || !isRecord(rawProperty)) return undefined;

    const enumValues = rawProperty.enum === undefined ? undefined : parseEnumValues(rawProperty.enum);
    if (rawProperty.enum !== undefined && enumValues === undefined) return undefined;

    const declaredKind = supportedKind(rawProperty.type);
    if (rawProperty.type !== undefined && declaredKind === undefined) return undefined;

    const kind = declaredKind ?? (enumValues ? "string" : undefined);
    if (kind === undefined) return undefined;

    const title = trimmedString(rawProperty.title);
    const description = trimmedString(rawProperty.description);

    fields.push({
      name,
      kind,
      required: requiredNames.has(name),
      ...(enumValues ? { enumValues } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(rawProperty.default !== undefined ? { defaultValue: rawProperty.default } : {}),
    });
  }

  const declaredNames = new Set(fields.map((field) => field.name));
  for (const requiredName of requiredNames) {
    if (!declaredNames.has(requiredName)) return undefined;
  }

  return { fields };
}
