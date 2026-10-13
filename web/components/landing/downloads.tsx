"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Download, RefreshCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/motion/reveal";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CopyButton } from "./copy-button";
import { useOS } from "./use-os";
import { Eyebrow, SectionHeading } from "./section";
import { getDownloads, KNOWN_AVAILABLE, type OS } from "@/lib/downloads";
import { href, type Locale } from "@/lib/i18n";
import { reinstallNotice } from "@/lib/reinstall";

const copy = {
  ko: {
    eyebrow: "다운로드",
    heading: "사용 중인 OS에 맞게 받으세요.",
    lead: "macOS·Windows·Linux 최신 빌드를 downloads.agent-connector.ai에서 바로 받습니다. 설치한 앱은 같은 곳에서 업데이트됩니다.",
    updates: "업데이트 안내",
    recommended: "권장",
    download: "다운로드",
    viewInstall: "설치 가이드 보기",
    ready: "최신 빌드",
    notReady: "준비 중",
    firstRun: "설치 후 첫 실행",
    installPre: "로그인과 첫 화면은",
    installGuide: "설치 가이드",
    installPost: "에서 이어집니다.",
  },
  en: {
    eyebrow: "Download",
    heading: "Get the build for your OS.",
    lead: "Download the latest macOS, Windows, or Linux build straight from downloads.agent-connector.ai. The installed app updates from the same place.",
    updates: "How updates work",
    recommended: "Recommended",
    download: "Download",
    viewInstall: "Open the install guide",
    ready: "Latest build",
    notReady: "Coming soon",
    firstRun: "First launch after install",
    installPre: "Sign-in and the first screen continue in the",
    installGuide: "install guide",
    installPost: ".",
  },
} as const;

/**
 * OS picker tabs: auto-selects the visitor's platform, one platform at a time,
 * so the per-OS setup steps get a full-width layout. The reinstall notice sits
 * above the picker so nobody upgrading from Ave misses it.
 */
export function Downloads({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  const reinstall = reinstallNotice(locale);
  const downloads = getDownloads(locale);
  const os = useOS();
  const [tab, setTab] = React.useState<OS>("windows");
  const [touched, setTouched] = React.useState(false);

  // Follow detection until the user explicitly picks a tab.
  React.useEffect(() => {
    if (os && !touched) setTab(os);
  }, [os, touched]);

  return (
    <section id="download" aria-labelledby="download-title" className="scroll-mt-16 border-b border-border">
      <div className="frame-rails mx-auto max-w-[1120px] px-4 py-20 sm:px-8 sm:py-28">
        <Reveal>
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <SectionHeading id="download-title">{t.heading}</SectionHeading>
          <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-muted-foreground">
            {t.lead}{" "}
            <Link
              href={href(locale, "/docs/getting-started/updates")}
              className="inline-flex items-center gap-0.5 font-semibold text-fern hover:underline"
            >
              {t.updates}
              <ArrowRight aria-hidden="true" className="h-3 w-3" />
            </Link>
          </p>
        </Reveal>

        <Reveal delay={60}>
          <div
            id="reinstall"
            role="note"
            aria-labelledby="reinstall-title"
            className="mt-10 scroll-mt-20 rounded-2xl border border-amber-300 bg-amber-50 p-5 sm:p-6"
          >
            <div className="flex items-start gap-3">
              <RefreshCcw aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-amber-800" />
              <div className="min-w-0">
                <h3 id="reinstall-title" className="text-[16px] font-semibold text-ink">
                  {reinstall.title}
                </h3>
                <ul className="mt-2.5 grid gap-1.5 text-[14.5px] leading-relaxed text-ink-soft">
                  {reinstall.points.map((line) => (
                    <li key={line} className="flex gap-2">
                      <span aria-hidden="true" className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-ink-soft" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTouched(true);
              setTab(v as OS);
            }}
            className="mt-10"
          >
            <TabsList className="h-auto max-w-full flex-wrap rounded-full border border-border bg-white p-1">
              {downloads.map((d) => (
                <TabsTrigger
                  key={d.os}
                  value={d.os}
                  className="gap-1.5 rounded-full px-4 py-1.5 text-[13.5px] data-[state=active]:bg-ink data-[state=active]:text-white"
                >
                  {d.osLabel}
                  {os === d.os ? (
                    <span className="rounded-full bg-fern-wash px-1.5 py-px text-[10.5px] font-semibold text-fern">
                      {t.recommended}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>

            {downloads.map((d) => {
              const ready = KNOWN_AVAILABLE[d.os];
              return (
                <TabsContent key={d.os} value={d.os} className="mt-6">
                  <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <div className="wash-fern flex flex-col rounded-2xl border border-border p-6">
                      <p className="text-[12px] font-semibold uppercase tracking-wider text-fern">{d.osLabel}</p>
                      <p className="mt-1.5 text-[24px] font-medium tracking-[-0.01em] text-ink">{d.title}</p>
                      <p className="mt-1 font-mono text-[12.5px] text-ink-soft">{d.format}</p>
                      <a
                        href={ready ? d.href : href(locale, "/docs/getting-started/install")}
                        className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-white transition-colors hover:bg-ink-soft"
                      >
                        <Download aria-hidden="true" className="h-4 w-4" />
                        {ready ? t.download : t.viewInstall}
                      </a>
                      <span
                        className={cn(
                          "mt-3 inline-flex w-fit rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
                          ready ? "bg-white text-ink-soft" : "bg-amber-100 text-amber-800"
                        )}
                      >
                        {ready ? t.ready : t.notReady}
                      </span>
                      <p className="mt-auto pt-6 text-[12.5px] leading-relaxed text-ink-soft">
                        {t.installPre}{" "}
                        <Link
                          href={href(locale, "/docs/getting-started/install")}
                          className="font-semibold text-ink underline-offset-2 hover:underline"
                        >
                          {t.installGuide}
                        </Link>
                        {t.installPost}
                      </p>
                    </div>

                    <div className="min-w-0 rounded-2xl border border-border bg-white p-6">
                      <p className="text-[14px] font-semibold text-ink">{t.firstRun}</p>
                      <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-muted-foreground">{d.setupNote}</p>
                      <ol className="mt-5 grid gap-4">
                        {d.steps.map((s, idx) => (
                          <li key={idx} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                            <span className="grid h-7 w-7 place-items-center rounded-full bg-secondary font-mono text-[12px] font-semibold text-ink-soft">
                              {idx + 1}
                            </span>
                            <div className="min-w-0">
                              <p className="pt-0.5 text-[14px] leading-relaxed text-ink-soft">{s.label}</p>
                              {s.command ? (
                                <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2">
                                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink">
                                    {s.command}
                                  </code>
                                  <CopyButton text={s.command} locale={locale} />
                                </div>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                      {d.extraNote ? (
                        <p className="mt-5 border-t border-border pt-3 text-[13px] leading-relaxed text-muted-foreground">
                          {d.extraNote}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </TabsContent>
              );
            })}
          </Tabs>
        </Reveal>
      </div>
    </section>
  );
}
