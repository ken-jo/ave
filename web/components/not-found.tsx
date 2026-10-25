import { href, type Locale } from "@/lib/i18n";
import { FEATURES, NOT_FOUND_PATH, page } from "@/lib/nav";
import { pagesCopy } from "@/lib/pages";
import { Footer, Header } from "./chrome";

/**
 * The not-found page. It is exported as 404.html at the root and under /en/
 * (scripts/finish-web-export.mjs), so it is served for a missing path at any
 * URL; every link on it is therefore absolute, and it never counts as "the
 * current page" for the self-link rule.
 */
export function NotFoundView({ locale }: { locale: Locale }) {
  const c = pagesCopy(locale).notFound;
  const download = page(locale, "download");
  const docs = page(locale, "docs");
  return (
    <>
      <Header locale={locale} path={NOT_FOUND_PATH} />
      <main id="main" className="wrap nf">
        <p className="eyebrow">404</p>
        <h1 className="h1">{c.title}</h1>
        <p className="lead">{c.lead}</p>
        <p className="nf-links">
          <a className="btn btn-primary" href={href(locale, "/")}>{c.home}</a>
          <a className="btn btn-ghost" href={download.href}>{download.label}</a>
          <a className="btn btn-ghost" href={docs.href}>{docs.label}</a>
        </p>
        <ul className="nf-more">
          {FEATURES.map((f) => {
            const l = page(locale, f);
            return (
              <li key={f}>
                <a className="more" href={l.href}>{l.label}</a>
              </li>
            );
          })}
        </ul>
      </main>
      <Footer locale={locale} path={NOT_FOUND_PATH} />
    </>
  );
}
