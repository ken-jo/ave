import type { MetadataRoute } from "next";
import { DOC_SLUGS } from "@/lib/docs";
import { SITE_ORIGIN } from "@/lib/i18n";

export const dynamic = "force-static";

/** Every page in both locales. With trailingSlash: true every route is slashed. */
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ["/", "/download/", "/docs/", ...DOC_SLUGS.map((s) => `/docs/${s}/`)];
  return paths.flatMap((path) => [
    { url: `${SITE_ORIGIN}${path}`, changeFrequency: "weekly" as const, priority: path === "/" ? 1 : 0.7 },
    { url: `${SITE_ORIGIN}/en${path}`, changeFrequency: "weekly" as const, priority: path === "/" ? 0.9 : 0.6 },
  ]);
}
