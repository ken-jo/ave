import Link from "next/link";
import { href, type Locale } from "@/lib/i18n";
import { getDownloads } from "@/lib/downloads";
import { docPages, type Block, type DocPage } from "@/lib/docs";
import { CopyButton } from "./client";
import { Chevron } from "./home";

const words = {
  ko: {
    dlTitle: "Ave 내려받기",
    dlSub: "운영체제를 고르고 설치 파일을 받으세요. 지금 빌드는 서명되지 않아 처음 실행할 때 아래 단계가 필요합니다.",
    get: "설치 파일 받기",
    setup: "설치 안내",
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
    setup: "Setup",
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

/** Centred page head (DESIGN.md 2, 8, 11). */
function PageHead({ title, sub }: { title: string; sub: string }) {
  return (
    <section className="page-hero">
      <div className="frame">
        <div className="center-head">
          <h1 className="display">{title}</h1>
          <p className="lead">{sub}</p>
        </div>
      </div>
    </section>
  );
}

export function DownloadPage({ locale }: { locale: Locale }) {
  const w = words[locale];
  const downloads = getDownloads(locale);
  return (
    <main id="main">
      <PageHead title={w.dlTitle} sub={w.dlSub} />
      {/* Three system cards (29). */}
      <section className="section section-tight rule-top" aria-label={w.get}>
        <div className="frame rails">
          <ul className="os-cards">
            {downloads.map((d) => (
              <li key={d.os} className="os-card">
                <div className="os-face" aria-hidden="true">
                  <span className="os-name">{d.osLabel}</span>
                  <span className="os-format">{d.format}</span>
                </div>
                <p><strong>{d.osLabel}</strong> {d.title}, {d.format}</p>
                <div className="os-actions">
                  <a className="button" href={d.href} aria-label={`${d.osLabel} ${w.get}`}>{w.get}</a>
                  <a className="textlink" href={`#${d.os}`}>{w.setup}</a>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
      {/* One setup section per system, at the anchors the hero action uses. */}
      {downloads.map((d, i) => (
        <section key={d.os} id={d.os} className={`section rule-top os-setup${i % 2 === 0 ? " band" : ""}`} aria-labelledby={`os-${d.os}`}>
          <div className="frame rails">
            <div className="measure">
              <h2 id={`os-${d.os}`} className="head">{d.osLabel}</h2>
              <p className="lead">{d.setupNote}</p>
              <ol className="steps">
                {d.steps.map((s) => (
                  <li key={s.label}>
                    <span>{s.label}</span>
                    {s.command ? <Code text={s.command} locale={locale} /> : null}
                  </li>
                ))}
              </ol>
              {d.extraNote ? <p className="note">{d.extraNote}</p> : null}
              <p className="os-again">
                <a className="button" href={d.href}>{w.get}</a>
              </p>
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}

export function DocsIndex({ locale }: { locale: Locale }) {
  const w = words[locale];
  return (
    <main id="main">
      <PageHead title={w.docsTitle} sub={w.docsSub} />
      <section className="section section-tight rule-top">
        <div className="frame rails">
          <ol className="doc-index" aria-label={w.pages}>
            {docPages(locale).map((p) => (
              <li key={p.slug}>
                <Link href={href(locale, `/docs/${p.slug}/`)}>
                  <span className="t">{p.title}<Chevron /></span>
                  <span className="s">{p.summary}</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>
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
    <main id="main" className="doc-main">
      <div className="frame rails doc-layout">
        <nav className="doc-nav" aria-label={w.pages}>
          <details>
            <summary>{w.pages}</summary>
            {list}
          </details>
          <div className="desk-only">{list}</div>
        </nav>
        <article className="doc-body">
          <header className="doc-head">
            <h1 className="head">{page.title}</h1>
            <p className="lead">{page.summary}</p>
          </header>
          {page.sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`h-${s.id}`}>
              <h2 id={`h-${s.id}`}>{s.h}</h2>
              {s.blocks.map((b, i) => renderBlock(b, i, locale))}
            </section>
          ))}
          <nav className="doc-next" aria-label={locale === "ko" ? "이전 다음" : "Previous and next"}>
            {prev ? (
              <Link href={href(locale, `/docs/${prev.slug}/`)} rel="prev">
                <span className="dir">{w.prev}</span>
                <span className="t">{prev.title}</span>
              </Link>
            ) : <span />}
            {next ? (
              <Link href={href(locale, `/docs/${next.slug}/`)} rel="next" className="to-next">
                <span className="dir">{w.next}</span>
                <span className="t">{next.title}</span>
              </Link>
            ) : <span />}
          </nav>
        </article>
      </div>
    </main>
  );
}
