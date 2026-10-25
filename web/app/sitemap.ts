import type { MetadataRoute } from "next";
import { DOC_SLUGS } from "@/lib/docs";
import { SITE_ORIGIN } from "@/lib/i18n";
import { FEATURES, PATHS } from "@/lib/nav";

export const dynamic = "force-static";

/** Every page in both locales; the not-found page is left out. With trailingSlash: true every route is slashed. */
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    PATHS.home,
    ...FEATURES.map((f) => PATHS[f]),
    PATHS.download,
    PATHS.docs,
    ...DOC_SLUGS.map((s) => `/docs/${s}/`),
    PATHS.changelog,
  ];
  return paths.flatMap((path) => [
    { url: `${SITE_ORIGIN}${path}`, changeFrequency: "weekly" as const, priority: path === "/" ? 1 : 0.7 },
    { url: `${SITE_ORIGIN}${path === "/" ? "/en/" : `/en${path}`}`, changeFrequency: "weekly" as const, priority: path === "/" ? 0.9 : 0.6 },
  ]);
}
