/** Main builds per-resource CSP from freshly read metadata; inherited response headers cap inner-frame policies. */
import type { McpUiResourceCsp } from "../mcp/types.js";

/** Allow inline and local data required by app content, but never wildcard network access beyond declared resource origins. */
const DEFAULT_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["default-src", ["'none'"]],
  ["script-src", ["'unsafe-inline'"]],
  ["style-src", ["'unsafe-inline'", "data:"]],
  ["img-src", ["data:", "blob:"]],
  ["font-src", ["data:"]],
  ["media-src", ["data:", "blob:"]],
  ["connect-src", ["'none'"]],
  // Frame-src gates URL subframes, not the URL-free srcdoc app frame.
  ["frame-src", ["'none'"]],
  ["worker-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["form-action", ["'none'"]],
  ["frame-ancestors", ["'none'"]],
];

/** Resource domains open all static-resource directives, not only images. */
const BUCKET_TO_DIRECTIVES: ReadonlyArray<readonly [keyof McpUiResourceCsp, readonly string[]]> = [
  ["connectDomains", ["connect-src"]],
  ["resourceDomains", ["script-src", "style-src", "img-src", "font-src", "media-src"]],
  ["frameDomains", ["frame-src"]],
  ["baseUriDomains", ["base-uri"]],
];

/** Accept absolute HTTPS origins only; reject credentials, wildcards, and directive separators. */
function sanitizeDeclaredOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const source = raw.trim();
  if (source.length === 0) return undefined;
  if (source.endsWith(":") || source.includes("*") || source.includes(";") || /\s/.test(source)) {
    return undefined;
  }
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function readBucket(csp: McpUiResourceCsp | undefined, bucket: keyof McpUiResourceCsp): string[] {
  const raw = csp?.[bucket];
  if (!Array.isArray(raw)) return [];
  const kept: string[] = [];
  for (const entry of raw) {
    const origin = sanitizeDeclaredOrigin(entry);
    if (origin !== undefined) {
      kept.push(origin);
    } else if (typeof entry === "string" && entry.length > 0) {
      // Warn when dropping unsupported wildcard declarations so blank apps remain diagnosable.
      console.warn(`[mcp-app-csp] dropped non-conforming declared origin in ${bucket}: ${entry}`);
    }
  }
  return kept;
}

/** Network gates consume the same sanitized domain union as CSP to prevent contradictory permissions. */
export function declaredOrigins(csp?: McpUiResourceCsp): string[] {
  const origins = new Set<string>();
  for (const [bucket] of BUCKET_TO_DIRECTIVES) {
    for (const origin of readBucket(csp, bucket)) origins.add(origin);
  }
  return [...origins];
}

function addSources(base: readonly string[], additions: readonly string[]): string[] {
  const merged = new Set(base);
  for (const source of additions) merged.add(source);
  // `'none'` is meaningless — and invalid — alongside a real source.
  if (merged.size > 1) merged.delete("'none'");
  return [...merged];
}

/** Read policy from the resource, never the tool result; tool metadata carries only resource identity and rendering hints. */
export function buildMcpCspHeader(csp?: McpUiResourceCsp): string {
  const directives = new Map<string, string[]>(
    DEFAULT_CSP_DIRECTIVES.map(([name, sources]) => [name, [...sources]]),
  );
  for (const [bucket, targets] of BUCKET_TO_DIRECTIVES) {
    const declared = readBucket(csp, bucket);
    if (declared.length === 0) continue;
    for (const directive of targets) {
      directives.set(directive, addSources(directives.get(directive) ?? [], declared));
    }
  }
  return [...directives.entries()]
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** The same policy in `<meta http-equiv>` form. Used by CSP probe harnesses/tests. */
export function buildMcpCsp(csp?: McpUiResourceCsp): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildMcpCspHeader(csp)}">`;
}

/** Wrap a document in the meta form. Retained for CSP probe harnesses/tests. */
export function wrapWithCsp(html: string, csp?: McpUiResourceCsp): string {
  const cspMeta = buildMcpCsp(csp);
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${cspMeta}`);
  }
  return `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}
