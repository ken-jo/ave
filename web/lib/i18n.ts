export type Locale = "ko" | "en";

/** The site's canonical origin. The app reads its service descriptor from here too. */
export const SITE_ORIGIN = "https://ave.agent-connector.ai";

/**
 * Korean lives at the root and English under /en. `canonical` is the Korean
 * path with a trailing slash ("/", "/docs/", "/docs/start/").
 */
export function href(locale: Locale, canonical: string): string {
  if (locale === "ko") return canonical;
  return canonical === "/" ? "/en/" : `/en${canonical}`;
}
