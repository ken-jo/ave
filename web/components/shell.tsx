import type { Metadata, Viewport } from "next";
import { SITE_ORIGIN, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";
import { SiteScripts } from "./client";
import "../app/globals.css";

/* Pretendard Variable for Latin and Hangul, JetBrains Mono for code. Both are
   OFL and vendored under public/fonts with their licences (no font CDN).
   Pretendard is the dynamic subset: the browser fetches only the unicode-range
   slices a page uses. */
const FONT_CSS = ["/fonts/pretendard/pretendardvariable-dynamic-subset.css", "/fonts/jetbrains-mono/jetbrains-mono.css"];

export const viewport: Viewport = {
  // Light and warm night follow the system (web/DESIGN.md, "Tokens").
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f7f4" },
    { media: "(prefers-color-scheme: dark)", color: "#120f0c" },
  ],
  colorScheme: "light dark",
};

export function siteMetadata(locale: Locale): Metadata {
  const c = homeCopy(locale).meta;
  return {
    metadataBase: new URL(SITE_ORIGIN),
    title: { default: c.title, template: "%s · Ave" },
    description: c.description,
    openGraph: { title: c.title, description: c.description, type: "website", siteName: "Ave", locale: locale === "ko" ? "ko_KR" : "en_US" },
    icons: { icon: "/favicon.svg" },
    manifest: "/site.webmanifest",
  };
}

/** One root layout per locale so `<html lang>` is right on every page. */
export function Shell({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return (
    <html lang={locale}>
      <head>
        {FONT_CSS.map((h) => (
          <link key={h} rel="stylesheet" href={h} precedence="fonts" />
        ))}
      </head>
      <body>
        {children}
        <SiteScripts />
      </body>
    </html>
  );
}
