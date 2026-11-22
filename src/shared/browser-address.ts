/** What text typed into a browser address row means: an address to open, or words for the configured search engine. */
import { isNavigableHostname, validateExternalUrl } from "./external-url.js";

/** The search engines address-row text can be sent to. Each template receives the encoded query in place of `%s`. */
export const ADDRESS_SEARCH_ENGINES = {
  google: "https://www.google.com/search?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  naver: "https://search.naver.com/search.naver?query=%s",
} as const;
export type AddressSearchEngine = keyof typeof ADDRESS_SEARCH_ENGINES;
export const ADDRESS_SEARCH_ENGINE_IDS = Object.keys(ADDRESS_SEARCH_ENGINES) as readonly AddressSearchEngine[];
export const DEFAULT_ADDRESS_SEARCH_ENGINE: AddressSearchEngine = "google";

export function isAddressSearchEngine(value: unknown): value is AddressSearchEngine {
  return typeof value === "string" && Object.hasOwn(ADDRESS_SEARCH_ENGINES, value);
}

export type AddressBarTarget =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "search"; readonly url: string; readonly query: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
/** Schemes that name local or script content. Typed as one word they are an address the browser refuses, not a search. */
const UNOPENABLE_SCHEME = /^(?:javascript|data|file|vbscript|blob|about|view-source):/i;

/** A canonical http(s) URL for an address: a bare host gets `https`. Null when it is not an openable address. */
export function normalizeBrowserNavigationUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const validated = validateExternalUrl(SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  return validated.ok ? validated.url : null;
}

/** The host a scheme-less address names, without its port: the text before the first path, query or fragment mark. */
function bareHost(text: string): string {
  const authority = text.split(/[/?#]/, 1)[0] ?? "";
  if (authority.startsWith("[")) return authority.slice(0, authority.indexOf("]") + 1);
  return authority.replace(/:\d*$/, "");
}

/** Hosts that name this machine or a literal network address: no certificate can cover them, so they default to `http`. */
function isLocalOrLiteralHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost") || IPV4.test(lower) || (lower.startsWith("[") && isNavigableHostname(lower));
}

/**
 * Resolve address-row text.
 * - An explicit scheme is an address or an error, never a search.
 * - `localhost`, `*.localhost` and IP literals without a scheme open over `http`.
 * - Text with whitespace, or whose host has no dot, is a search.
 * - One word that starts with a local or script scheme is refused.
 * - Anything else is tried as an `https` address and searched when it is not one.
 */
export function resolveAddressBarInput(value: string, engine: AddressSearchEngine): AddressBarTarget | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (SCHEME.test(trimmed)) {
    const url = normalizeBrowserNavigationUrl(trimmed);
    return url === null ? null : { kind: "url", url };
  }
  const search = (): AddressBarTarget => ({
    kind: "search", query: trimmed, url: ADDRESS_SEARCH_ENGINES[engine].replace("%s", encodeURIComponent(trimmed)),
  });
  if (/\s/.test(trimmed)) return search();
  if (UNOPENABLE_SCHEME.test(trimmed)) return null;
  const host = bareHost(trimmed);
  if (isLocalOrLiteralHost(host)) {
    const validated = validateExternalUrl(`http://${trimmed}`);
    return validated.ok ? { kind: "url", url: validated.url } : search();
  }
  if (!host.includes(".")) return search();
  const url = normalizeBrowserNavigationUrl(trimmed);
  return url === null ? search() : { kind: "url", url };
}
