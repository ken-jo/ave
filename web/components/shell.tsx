import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_KR } from "next/font/google";
import { SITE_ORIGIN, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";
import { Motion } from "./client";
import "../app/globals.css";

const plex = IBM_Plex_Sans_KR({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex",
  preload: false,
});

export const viewport: Viewport = { themeColor: "#f1f2ed" };

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
    <html lang={locale} className={plex.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body>
        {children}
        <Motion />
      </body>
    </html>
  );
}
