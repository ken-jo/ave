import { docPages, type Block, type DocPage } from "@/lib/docs";
import { href, type Locale } from "@/lib/i18n";
import { doc, page, PATHS, type NavLink } from "@/lib/nav";
import { pagesCopy } from "@/lib/pages";
import { Command } from "./blocks";
import { Footer, Header, Item } from "./chrome";

function renderBlock(b: Block, i: number, locale: Locale) {
  if ("p" in b) return <p key={i}>{b.p}</p>;
  if ("ul" in b) return <ul key={i}>{b.ul.map((x) => <li key={x}>{x}</li>)}</ul>;
  if ("code" in b) return <Command key={i} text={b.code} locale={locale} />;
  if ("link" in b) {
    return (
      <p key={i}>
        <a className="more" href={href(locale, b.link.to)}>{b.link.label}</a>
      </p>
    );
  }
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

/** The guide's sidebar: the index, then every page; the current one is text, not a link. */
function Sidebar({ locale, path }: { locale: Locale; path: string }) {
  const c = pagesCopy(locale).docs;
  const links = [page(locale, "docs"), ...docPages(locale).map((p) => doc(locale, p.slug as Parameters<typeof doc>[1]))];
  return (
    <nav className="doc-side" aria-label={c.pages}>
      <ol>
        {links.map((l) => (
          <li key={l.canonical}>
            <Item link={l} path={path} />
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function DocsIndexView({ locale }: { locale: Locale }) {
  const c = pagesCopy(locale).docs;
  const path = PATHS.docs;
  return (
    <>
      <Header locale={locale} path={path} />
      <main id="main">
        <section className="hero" aria-labelledby="title">
          <div className="wrap hero-copy">
            <h1 id="title" className="h1">{c.title}</h1>
            <p className="lead">{c.lead}</p>
          </div>
        </section>
        <section className="sec band" aria-label={c.pages}>
          <div className="wrap">
            <ol className="doc-index">
              {docPages(locale).map((p) => {
                const l = doc(locale, p.slug as Parameters<typeof doc>[1]);
                return (
                  <li key={p.slug}>
                    <a href={l.href}>
                      <b>{l.label}</b>
                      <span>{p.summary}</span>
                    </a>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}

export function DocView({ locale, page: current }: { locale: Locale; page: DocPage }) {
  const w = pagesCopy(locale).ui;
  const path = `/docs/${current.slug}/`;
  const pages = docPages(locale);
  const at = pages.findIndex((p) => p.slug === current.slug);
  // The guide reads as one chain: Download comes before the first page, the changelog after the last.
  const prev: NavLink = at > 0 ? doc(locale, pages[at - 1]!.slug as Parameters<typeof doc>[1]) : page(locale, "download");
  const next: NavLink = at < pages.length - 1 ? doc(locale, pages[at + 1]!.slug as Parameters<typeof doc>[1]) : page(locale, "changelog");
  return (
    <>
      <Header locale={locale} path={path} />
      <main id="main" className="wrap docs">
        <Sidebar locale={locale} path={path} />
        <article className="doc">
          <h1 className="h1">{current.title}</h1>
          <p className="lead">{current.summary}</p>
          {current.sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`h-${s.id}`}>
              <h2 id={`h-${s.id}`}>{s.h}</h2>
              {s.blocks.map((b, i) => renderBlock(b, i, locale))}
            </section>
          ))}
          <nav className="pager" aria-label={locale === "ko" ? "이전 다음" : "Previous and next"}>
            <a href={prev.href} rel="prev">
              <small>{w.prev}</small>
              <span>{prev.label}</span>
            </a>
            <a href={next.href} rel="next" className="to-next">
              <small>{w.next}</small>
              <span>{next.label}</span>
            </a>
          </nav>
        </article>
      </main>
      <Footer locale={locale} path={path} />
    </>
  );
}
