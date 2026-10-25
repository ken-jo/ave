import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR } from "next/font/google";
import { SITE_ORIGIN, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";
import { SiteScripts } from "./client";
import "../app/globals.css";

/* Geist for Latin, Noto Sans KR for Hangul through the stack, Geist Mono for
   code. All three are OFL and self-hosted by next/font. */
const geist = Geist({ subsets: ["latin"], display: "swap", variable: "--font-geist" });
const kr = Noto_Sans_KR({ subsets: ["latin"], display: "swap", variable: "--font-kr", preload: false });
const mono = Geist_Mono({ subsets: ["latin"], display: "swap", variable: "--font-geist-mono", preload: false });

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
  ],
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
    <html lang={locale} className={`${geist.variable} ${kr.variable} ${mono.variable}`}>
      <body>
        {children}
        <SiteScripts />
      </body>
    </html>
  );
}
