import Link from "next/link";
import { href, type Locale } from "@/lib/i18n";
import { getDownloads } from "@/lib/downloads";
import { docPages, type Block, type DocPage } from "@/lib/docs";
import { CopyButton } from "./client";

const words = {
  ko: {
    dlTitle: "Ave 내려받기",
    dlSub: "운영체제를 고르고 설치 파일을 받으세요. 지금 빌드는 서명되지 않아 처음 실행할 때 아래 단계가 필요합니다.",
    get: "설치 파일 받기",
    copy: "복사",
    copied: "복사됨",
    docsTitle: "Ave 문서",
    docsSub: "설치부터 권한, 플러그인, 마켓플레이스, 루틴까지. 앱에 보이는 이름 그대로 설명합니다.",
    pages: "문서 목록",
    prev: "이전",
    next: "다음",
    all: "모든 문서",
  },
  en: {
    dlTitle: "Download Ave",
    dlSub: "Choose your system and get the installer. Current builds are unsigned, so the first launch needs the steps below.",
    get: "Get the installer",
    copy: "Copy",
    copied: "Copied",
    docsTitle: "Ave docs",
    docsSub: "From installing to permissions, plugins, the marketplace and routines, named the way the app names them.",
    pages: "Pages",
    prev: "Previous",
    next: "Next",
    all: "All docs",
  },
} as const;

function Code({ text, locale }: { text: string; locale: Locale }) {
  const w = words[locale];
  return (
    <div className="copy-row">
      <pre className="codeblock"><code>{text}</code></pre>
      <CopyButton text={text} label={w.copy} done={w.copied} />
    </div>
  );
}

export function DownloadPage({ locale }: { locale: Locale }) {
  const w = words[locale];
  return (
    <main id="main">
      <section className="page-hero wrap grid">
        <h1 className="page-title">{w.dlTitle}</h1>
        <p className="page-sub lead">{w.dlSub}</p>
      </section>
      <div className="wrap os-blocks">
        {getDownloads(locale).map((d) => (
          <section key={d.os} id={d.os} className="os-block" aria-labelledby={`os-${d.os}`}>
            <header>
              <h2 id={`os-${d.os}`}>{d.osLabel}</h2>
              <p className="lead">{d.title}, {d.format}</p>
              <p><a className="button" href={d.href}>{w.get}</a></p>
            </header>
            <div className="steps">
              <p>{d.setupNote}</p>
              <ol>
                {d.steps.map((s) => (
                  <li key={s.label}>
                    {s.label}
                    {s.command ? <Code text={s.command} locale={locale} /> : null}
                  </li>
                ))}
              </ol>
              {d.extraNote ? <p className="note muted">{d.extraNote}</p> : null}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

export function DocsIndex({ locale }: { locale: Locale }) {
  const w = words[locale];
  return (
    <main id="main">
      <section className="page-hero wrap grid">
        <h1 className="page-title">{w.docsTitle}</h1>
        <p className="page-sub lead">{w.docsSub}</p>
      </section>
      <div className="wrap" style={{ paddingBottom: "var(--section)" }}>
        <ol className="doc-index" aria-label={w.pages}>
          {docPages(locale).map((p) => (
            <li key={p.slug}>
              <Link href={href(locale, `/docs/${p.slug}/`)}>
                <span className="t">{p.title}</span>
                <span>{p.summary}</span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}

function renderBlock(b: Block, i: number, locale: Locale) {
  if ("p" in b) return <p key={i}>{b.p}</p>;
  if ("ul" in b) return <ul key={i}>{b.ul.map((x) => <li key={x}>{x}</li>)}</ul>;
  if ("code" in b) return <Code key={i} text={b.code} locale={locale} />;
  return (
    <dl key={i}>
      {b.dl.map(([term, desc]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{desc}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DocArticle({ locale, page }: { locale: Locale; page: DocPage }) {
  const w = words[locale];
  const pages = docPages(locale);
  const at = pages.findIndex((p) => p.slug === page.slug);
  const prev = pages[at - 1];
  const next = pages[at + 1];
  const list = (
    <ol>
      <li><Link href={href(locale, "/docs/")}>{w.all}</Link></li>
      {pages.map((p) => (
        <li key={p.slug}>
          <Link href={href(locale, `/docs/${p.slug}/`)} aria-current={p.slug === page.slug ? "page" : undefined}>
            {p.title}
          </Link>
        </li>
      ))}
    </ol>
  );
  return (
    <main id="main">
      <section className="page-hero wrap grid">
        <h1 className="page-title">{page.title}</h1>
        <p className="page-sub lead">{page.summary}</p>
      </section>
      <div className="wrap doc-layout">
        <nav className="doc-nav" aria-label={w.pages}>
          <details>
            <summary>{w.pages}</summary>
            {list}
          </details>
          <div className="desk-only">{list}</div>
        </nav>
        <article className="doc-body">
          {page.sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`h-${s.id}`}>
              <h2 id={`h-${s.id}`}>{s.h}</h2>
              {s.blocks.map((b, i) => renderBlock(b, i, locale))}
            </section>
          ))}
          <nav className="doc-next" aria-label={locale === "ko" ? "이전 다음" : "Previous and next"}>
            {prev ? <Link href={href(locale, `/docs/${prev.slug}/`)} rel="prev">← {prev.title}</Link> : <span />}
            {next ? <Link href={href(locale, `/docs/${next.slug}/`)} rel="next">{next.title} →</Link> : <span />}
          </nav>
        </article>
      </div>
    </main>
  );
}
