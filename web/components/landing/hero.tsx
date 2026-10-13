import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { href, type Locale } from "@/lib/i18n";
import { HeroArt } from "./illustrations";

const copy = {
  ko: {
    notice: "0.14.0 · Ave가 Ave가 되었습니다 — 새로 설치해 주세요",
    title: ["일의 신호는 조용히,", "결정은 당신이."],
    lead: "Ave는 메일·일정·회의·문서의 신호를 당신의 PC에서 읽고, 필요한 순간에 하나의 제안으로 정리합니다. 쓰기 작업은 언제나 당신의 승인으로 시작됩니다.",
    download: "Ave 다운로드",
    docs: "문서 보기",
    platforms: "macOS · Windows · Linux",
  },
  en: {
    notice: "0.14.0 · Ave is now Ave — a fresh install is required",
    title: ["Quiet about signals.", "Clear about decisions."],
    lead: "Ave reads the signals in your mail, calendar, meetings, and documents on your own PC, and turns them into one proposal when it matters. Every write action starts with your approval.",
    download: "Download Ave",
    docs: "Read the docs",
    platforms: "macOS · Windows · Linux",
  },
} as const;

export function Hero({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  const home = locale === "en" ? "/en/" : "/";
  return (
    <section aria-labelledby="hero-title" className="border-b border-border">
      <div className="frame-rails mx-auto max-w-[1120px] px-4 pb-16 pt-14 sm:px-8 sm:pb-20 sm:pt-20">
        <Reveal className="flex justify-center">
          <Link
            href={`${home}#reinstall`}
            className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-ink/30 hover:text-ink"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-fern" />
            <span className="min-w-0">{t.notice}</span>
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </Link>
        </Reveal>

        <Reveal delay={60}>
          <h1
            id="hero-title"
            className="mx-auto mt-7 max-w-3xl text-balance text-center text-[clamp(2.25rem,7vw,3.75rem)] font-medium leading-[1.08] tracking-[-0.03em] text-ink"
          >
            {t.title[0]}
            <br />
            {t.title[1]}
          </h1>
        </Reveal>

        <Reveal delay={120}>
          <p className="mx-auto mt-6 max-w-xl text-center text-[16.5px] leading-relaxed text-muted-foreground">
            {t.lead}
          </p>
        </Reveal>

        <Reveal delay={180}>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`${home}#download`}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white transition-colors hover:bg-ink-soft"
            >
              <Download aria-hidden="true" className="h-4 w-4" />
              {t.download}
            </Link>
            <Link
              href={href(locale, "/docs/")}
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-white px-5 text-[15px] font-medium text-ink transition-colors hover:bg-secondary"
            >
              {t.docs}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
          <p className="mt-4 text-center text-[13px] text-muted-foreground">{t.platforms}</p>
        </Reveal>

        <Reveal delay={240}>
          <div className="wash-dawn mt-14 overflow-hidden rounded-[28px] border border-border px-2 py-6 sm:px-8 sm:py-10">
            <HeroArt />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
