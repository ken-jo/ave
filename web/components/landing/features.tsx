import Link from "next/link";
import { ArrowUpRight, HardDrive, Puzzle, ShieldCheck } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { href, type Locale } from "@/lib/i18n";
import { Band, Eyebrow, LeadIn, SectionHeading } from "./section";
import { GateArt, ProposalArt, SignalsArt } from "./illustrations";

const copy = {
  ko: {
    statementEyebrow: "Ave",
    statementLead: "Ave는 당신의 PC에서 일하는 업무 AI 호스트입니다.",
    statementRest:
      "신호를 읽는 곳도, 제안을 만드는 곳도, 결과를 실행하는 과정도 디바이스 안에서 일어납니다. 필요한 기능은 격리된 익스텐션으로 더하고, 쓰기 작업은 위험도가 표시된 승인 게이트를 지납니다.",
    flowEyebrow: "작동 방식",
    flowHeading: "관찰하고, 정리하고, 기다립니다.",
    tiles: [
      { wash: "wash-mist", Art: SignalsArt, lead: "조용한 관찰.", body: "메일·일정·회의·문서의 신호는 먼저 읽기 전용으로 분류됩니다. 알림을 쏟아내는 대신, 지금 의미 있는 하나를 고릅니다." },
      { wash: "wash-sand", Art: ProposalArt, lead: "하나의 제안.", body: "흩어진 맥락을 묶어 실행 가능한 제안 한 장으로 만듭니다. 무엇을, 왜 하려는지 먼저 보여 줍니다." },
      { wash: "wash-fern", Art: GateArt, lead: "당신의 승인.", body: "쓰기 작업은 위험도와 함께 승인 게이트를 통과해야 시작됩니다. 고위험 작업은 사유를 남겨야 합니다." },
    ],
    trustEyebrow: "신뢰",
    trustHeading: "기본값은 로컬, 실행은 승인 후.",
    trust: [
      { Icon: HardDrive, title: "로컬 우선", body: "로컬 인덱서가 PC 안 문서를 디바이스에서 색인합니다. 문서 본문은 밖으로 나가지 않습니다." },
      { Icon: Puzzle, title: "격리된 익스텐션", body: "익스텐션은 각자의 런타임에서 실행되고, 호스트가 허락한 경계 안에서만 동작합니다." },
      { Icon: ShieldCheck, title: "승인 중심 실행", body: "관찰과 제안은 조용히, 쓰기는 명시적인 결정으로. 권한과 판단 근거는 기록으로 남습니다." },
    ],
    docsEyebrow: "문서",
    docsHeading: "필요한 만큼 깊이 들어가세요.",
    docs: [
      { title: "시작하기", body: "설치, 로그인, 업데이트", to: "/docs/getting-started/install" },
      { title: "채팅과 권한", body: "레이아웃, 질문 카드, 승인 흐름", to: "/docs/chat/layout" },
      { title: "마켓플레이스", body: "폴더·Git 소스와 업데이트", to: "/docs/marketplace" },
      { title: "익스텐션", body: "공식 익스텐션과 권한", to: "/docs/plugins" },
      { title: "아키텍처", body: "호스트 API, 저장소, 권한 모델", to: "/docs/architecture/overview" },
      { title: "로드맵", body: "다음에 올 것들", to: "/docs/roadmap" },
    ],
  },
  en: {
    statementEyebrow: "Ave",
    statementLead: "Ave is an AI work host that runs on your own PC.",
    statementRest:
      "Reading signals, drafting proposals, and carrying out results all happen on your device. You add capabilities as isolated extensions, and every write action passes a risk-labeled approval gate.",
    flowEyebrow: "How it works",
    flowHeading: "It watches, it composes, it waits.",
    tiles: [
      { wash: "wash-mist", Art: SignalsArt, lead: "Quiet observation.", body: "Signals from mail, calendar, meetings, and documents are classified read-only first. Instead of a stream of alerts, Ave picks the one that matters now." },
      { wash: "wash-sand", Art: ProposalArt, lead: "One proposal.", body: "Scattered context becomes a single, actionable proposal that shows what it wants to do and why — before anything happens." },
      { wash: "wash-fern", Art: GateArt, lead: "Your approval.", body: "Write actions start only after they pass a risk-labeled approval gate. High-risk actions require a stated reason." },
    ],
    trustEyebrow: "Trust",
    trustHeading: "Local by default. Action after approval.",
    trust: [
      { Icon: HardDrive, title: "Local-first", body: "The local indexer indexes documents on your PC, on the device. Document contents never leave it." },
      { Icon: Puzzle, title: "Isolated extensions", body: "Each extension runs in its own runtime and acts only inside the boundaries the host allows." },
      { Icon: ShieldCheck, title: "Approval-first", body: "Observation and proposals stay quiet; writes need an explicit decision. Permissions and their reasons are recorded." },
    ],
    docsEyebrow: "Docs",
    docsHeading: "Go as deep as you need.",
    docs: [
      { title: "Getting started", body: "Install, sign in, updates", to: "/docs/getting-started/install" },
      { title: "Chat & permissions", body: "Layout, question cards, approvals", to: "/docs/chat/layout" },
      { title: "Marketplace", body: "Folder and Git sources, updates", to: "/docs/marketplace" },
      { title: "Extensions", body: "Official extensions and permissions", to: "/docs/plugins" },
      { title: "Architecture", body: "Host API, storage, permission model", to: "/docs/architecture/overview" },
      { title: "Roadmap", body: "What comes next", to: "/docs/roadmap" },
    ],
  },
} as const;

export function Statement({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <Band innerClassName="sm:py-24">
      <Reveal className="mx-auto max-w-3xl">
        <Eyebrow>{t.statementEyebrow}</Eyebrow>
        <p className="mt-4 text-[clamp(1.25rem,2.6vw,1.6rem)] font-medium leading-[1.5] tracking-[-0.01em] text-muted-foreground">
          <span className="text-ink">{t.statementLead}</span> {t.statementRest}
        </p>
      </Reveal>
    </Band>
  );
}

export function Flow({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <Band id="features" labelledBy="features-title" className="bg-[#fbfbfa]">
      <Reveal className="text-center">
        <Eyebrow>{t.flowEyebrow}</Eyebrow>
        <SectionHeading id="features-title">{t.flowHeading}</SectionHeading>
      </Reveal>
      <ol className="mt-14 grid gap-8 md:grid-cols-3 md:gap-6">
        {t.tiles.map(({ wash, Art, lead, body }, i) => (
          <Reveal as="li" key={lead} delay={i * 80}>
            <div className={`${wash} overflow-hidden rounded-2xl border border-border p-4`}>
              <Art />
            </div>
            <LeadIn lead={lead} className="mt-4 px-1">
              {body}
            </LeadIn>
          </Reveal>
        ))}
      </ol>
    </Band>
  );
}

export function Trust({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <Band id="trust" labelledBy="trust-title">
      <Reveal>
        <Eyebrow>{t.trustEyebrow}</Eyebrow>
        <SectionHeading id="trust-title" className="max-w-2xl">
          {t.trustHeading}
        </SectionHeading>
      </Reveal>
      <ul className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3">
        {t.trust.map(({ Icon, title, body }, i) => (
          <Reveal as="li" key={title} delay={i * 80} className="bg-white p-6 sm:p-8">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-fern-wash text-fern">
              <Icon aria-hidden="true" className="h-[18px] w-[18px]" />
            </span>
            <h3 className="mt-5 text-[17px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted-foreground">{body}</p>
          </Reveal>
        ))}
      </ul>
    </Band>
  );
}

export function DocsIndex({ locale = "ko" }: { locale?: Locale }) {
  const t = copy[locale];
  return (
    <Band id="docs" labelledBy="docs-title" className="bg-[#fbfbfa]">
      <Reveal>
        <Eyebrow>{t.docsEyebrow}</Eyebrow>
        <SectionHeading id="docs-title">{t.docsHeading}</SectionHeading>
      </Reveal>
      <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {t.docs.map((d) => (
          <li key={d.to}>
            <Link
              href={href(locale, d.to)}
              className="group flex h-full items-start justify-between gap-4 rounded-2xl border border-border bg-white p-5 transition-colors hover:border-ink/25"
            >
              <span>
                <span className="block text-[15.5px] font-semibold text-ink">{d.title}</span>
                <span className="mt-1 block text-[14px] text-muted-foreground">{d.body}</span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-ink"
              />
            </Link>
          </li>
        ))}
      </ul>
    </Band>
  );
}
