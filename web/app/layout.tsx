import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/docs/header";
import { AppFrame } from "@/components/docs/app-frame";
import { CommandPaletteProvider } from "@/components/docs/command-palette";
import { ScrollProgress } from "@/components/motion/scroll-progress";
import { SkipLink } from "@/components/docs/skip-link";
import { SiteFooter } from "@/components/docs/site-footer";

export const metadata: Metadata = {
  title: {
    default: "Ave — 일의 신호는 조용히, 결정은 당신이",
    template: "%s · Ave",
  },
  description:
    "Ave는 메일·회의·문서·일정의 신호를 당신의 PC에서 읽고, 필요한 순간에 하나의 제안으로 정리합니다. 쓰기 작업은 언제나 당신의 승인으로 시작됩니다.",
  applicationName: "Ave",
  // The public host stays former-site.invalid until the domain itself moves.
  metadataBase: new URL("https://former-site.invalid"),
  openGraph: {
    title: "Ave — 일의 신호는 조용히, 결정은 당신이",
    description: "신호는 조용히, 실행은 당신의 승인으로. 당신의 PC에서 일하는 업무 AI, Ave.",
    type: "website",
    siteName: "Ave",
  },
  icons: {
    icon: "/favicon.svg",
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-dvh">
        <noscript>
          {/* Keep scroll-reveal content visible without JS. */}
          <style>{`.reveal{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
        <SkipLink />
        <CommandPaletteProvider>
          <ScrollProgress />
          <Header />
          <AppFrame>{children}</AppFrame>
        </CommandPaletteProvider>

        <SiteFooter />
      </body>
    </html>
  );
}
