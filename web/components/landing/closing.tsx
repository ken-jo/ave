import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { href, type Locale } from "@/lib/i18n";

const copy = {
  ko: {
    heading: "오늘의 신호부터 시작하세요.",
    lead: "메일과 일정 하나만 연결해도 충분합니다. 나머지는 필요할 때 익스텐션으로 더하면 됩니다.",
    download: "Ave 다운로드",
    guide: "설치 가이드",
  },
  en: {
    heading: "Start with today's signals.",
    lead: "Connecting one mailbox and one calendar is plenty. Add the rest as extensions when you need them.",
    download: "Download Ave",
    guide: "Install guide",
  },
} as const;

export function Closing({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  const home = locale === "en" ? "/en/" : "/";
  return (
    <section aria-labelledby="closing-title" className="border-b border-border">
      <div className="frame-rails mx-auto max-w-[1120px] px-4 py-16 sm:px-8 sm:py-20">
        <Reveal>
          <div className="wash-dawn rounded-[28px] border border-border px-6 py-14 text-center sm:px-12 sm:py-20">
            <h2
              id="closing-title"
              className="mx-auto max-w-2xl text-balance text-[clamp(1.75rem,4.5vw,2.75rem)] font-medium leading-[1.12] tracking-[-0.025em] text-ink"
            >
              {t.heading}
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-[16px] leading-relaxed text-ink-soft">{t.lead}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href={`${home}#download`}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white transition-colors hover:bg-ink-soft"
              >
                <Download aria-hidden="true" className="h-4 w-4" />
                {t.download}
              </Link>
              <Link
                href={href(locale, "/docs/getting-started/install")}
                className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-white px-5 text-[15px] font-medium text-ink transition-colors hover:bg-secondary"
              >
                {t.guide}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
