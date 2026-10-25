/** A malformed tool schema can reject an entire model request; require items wherever type includes array. */

export interface ToolSchemaViolation {
  pointer: string;
  rule: string;
  message: string;
}

function typeIncludesArray(type: unknown): boolean {
  if (type === "array") return true;
  if (Array.isArray(type)) return type.includes("array");
  return false;
}

function escapePointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function walk(node: unknown, pointer: string, out: ToolSchemaViolation[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Record<string, unknown>;

  // JSON Pointer uses an empty string for the document root.
  if (typeIncludesArray(schema.type) && schema.items === undefined) {
    out.push({
      pointer,
      rule: "array-missing-items",
      message: `array schema at ${pointer || "(root)"} is missing "items" (OpenAI/Azure reject arrays without an items schema)`,
    });
  }

  const props = schema.properties;
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
      walk(child, `${pointer}/properties/${escapePointerSegment(key)}`, out);
    }
  }

  if (Array.isArray(schema.items)) {
    schema.items.forEach((child, i) => walk(child, `${pointer}/items/${i}`, out));
  } else if (schema.items !== undefined) {
    walk(schema.items, `${pointer}/items`, out);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branch = schema[keyword];
    if (Array.isArray(branch)) {
      branch.forEach((child, i) => walk(child, `${pointer}/${keyword}/${i}`, out));
    }
  }

  const addl = schema.additionalProperties;
  if (addl !== null && typeof addl === "object" && !Array.isArray(addl)) {
    walk(addl, `${pointer}/additionalProperties`, out);
  }
}

/** Return every schema violation without throwing. */
export function lintToolInputSchema(schema: unknown): ToolSchemaViolation[] {
  const violations: ToolSchemaViolation[] = [];
  walk(schema, "", violations);
  return violations;
}
