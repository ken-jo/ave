/** Expand templates host-side from values, never a renderer-supplied URI; allow Level 1 substitution only and revalidate the finished scheme. */
import {
  isUsableResourceUri,
  MCP_RESOURCE_URI_MAX_CHARS,
} from "./mcp-resource-bounds.js";

export const MCP_RESOURCE_TEMPLATE_MAX_VARIABLES = 8;

/** Dialog and main enforce the same value-length bound. */
export const MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS = 512;

/** Expression parsing and IPC key validation share one supported variable-name grammar. */
const VARIABLE_NAME_PATTERN = "[A-Za-z0-9_]{1,64}";

/** Any non-Level-1 expression invalidates the whole template. */
const TEMPLATE_EXPRESSION_RE = new RegExp(`\\{(${VARIABLE_NAME_PATTERN})\\}`, "g");

const TEMPLATE_VARIABLE_NAME_RE = new RegExp(`^${VARIABLE_NAME_PATTERN}$`);

/** Reject unsupported or unbounded renderer keys even when expansion would ignore them. */
export function isUsableTemplateVariableName(value: unknown): value is string {
  return typeof value === "string" && TEMPLATE_VARIABLE_NAME_RE.test(value);
}

const ANY_BRACE_RUN_RE = /\{[^}]*\}|[{}]/g;

/** Unpaired surrogates make encoding throw; use a non-global check without shared regex state. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Render each variable once in first-declaration order and substitute repeated occurrences consistently. */
export function resourceTemplateVariables(uriTemplate: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of uriTemplate.matchAll(TEMPLATE_EXPRESSION_RE)) {
    const name = match[1];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Check finished path segments, including encoded dots and literal/value composition; encoding does not neutralize bare dots. */
function hasDotSegment(uri: string): boolean {
  const scheme = uri.indexOf(":");
  const afterScheme = scheme === -1 ? uri : uri.slice(scheme + 1);
  const pathEnd = afterScheme.search(/[?#]/);
  const path = pathEnd === -1 ? afterScheme : afterScheme.slice(0, pathEnd);
  return path.split("/").some((raw) => {
    const segment = raw.replace(/%2e/gi, ".");
    return segment === "." || segment === "..";
  });
}

/** Validate the placeholder skeleton with the ordinary URI predicate to preserve scheme and character policy. */
export function isUsableResourceUriTemplate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MCP_RESOURCE_URI_MAX_CHARS) return false;

  // Check the cheap strict expression count first; pathological loose brace scans are much more expensive.
  const strict = [...value.matchAll(TEMPLATE_EXPRESSION_RE)];
  if (strict.length === 0) return false;

  // Keep expression validation even though remaining braces also fail skeleton validation; it owns template semantics.
  const loose = [...value.matchAll(ANY_BRACE_RUN_RE)];
  if (strict.length !== loose.length) return false;
  if (resourceTemplateVariables(value).length > MCP_RESOURCE_TEMPLATE_MAX_VARIABLES) {
    return false;
  }

  // Use an unreserved placeholder so skeleton failures are independent of user values.
  const skeleton = value.replace(TEMPLATE_EXPRESSION_RE, "x");
  if (!isUsableResourceUri(skeleton)) return false;

  // Reject literal dot segments at discovery to avoid dead picker rows.
  // Discovery checks do not replace finished-expansion enforcement; values can introduce dot segments unseen by the skeleton.
  return !hasDotSegment(skeleton);
}

/** Encode every value, reject missing or oversized values, then reject dot segments and revalidate the finished URI and scheme. */
export function expandResourceUriTemplate(
  uriTemplate: string,
  values: ReadonlyMap<string, string>,
): string | null {
  if (!isUsableResourceUriTemplate(uriTemplate)) return null;

  let refused = false;
  const expanded = uriTemplate.replace(TEMPLATE_EXPRESSION_RE, (_match, name: string) => {
    const value = values.get(name);
    if (typeof value !== "string") {
      refused = true;
      return "";
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS) {
      refused = true;
      return "";
    }
    // Reject lone surrogates so clipped pasted emoji returns null rather than throwing.
    if (LONE_SURROGATE_RE.test(trimmed)) {
      refused = true;
      return "";
    }
    return encodeURIComponent(trimmed);
  });
  if (refused) return null;
  if (expanded.length > MCP_RESOURCE_URI_MAX_CHARS) return null;
  if (hasDotSegment(expanded)) return null;
  return isUsableResourceUri(expanded) ? expanded : null;
}
