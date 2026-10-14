import Link from "next/link";
import { href, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";
import { docPages } from "@/lib/docs";
import { getDownloads } from "@/lib/downloads";
import { Button } from "./ui/button";

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect width="64" height="64" rx="16" fill="currentColor" />
      <path d="M16 46 L32 16 L48 46" fill="none" stroke="#c4f04a" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="40" r="4.5" fill="#c4f04a" />
    </svg>
  );
}

/**
 * Sticky bar (DESIGN.md 24): wordmark, section links centred, then the
 * language switch and one action. `path` is the canonical (Korean) path of the
 * current page, used for the language switch.
 */
export function Header({ locale, path, over = false }: { locale: Locale; path: string; over?: boolean }) {
  const c = homeCopy(locale).nav;
  const other: Locale = locale === "ko" ? "en" : "ko";
  const home = href(locale, "/");
  const links = (
    <>
      <Link href={`${home}#models`}>{c.models}</Link>
      <Link href={`${home}#plugins`}>{c.plugins}</Link>
      <Link href={href(locale, "/docs/")}>{c.docs}</Link>
    </>
  );
  return (
    <header className={over ? "site-header over" : "site-header"}>
      <div className="frame bar">
        <a className="skip" href="#main">
          {locale === "ko" ? "본문으로 건너뛰기" : "Skip to content"}
        </a>
        <Link className="wordmark" href={home} aria-label={locale === "ko" ? "Ave 첫 화면" : "Ave home"}>
          <Mark />
          <span>Ave</span>
        </Link>
        <nav className="nav" aria-label={locale === "ko" ? "주 메뉴" : "Main"}>
          {links}
        </nav>
        <div className="bar-end">
          <Link className="lang" href={href(other, path)} hrefLang={other} lang={other} aria-label={c.langLabel}>
            {c.lang}
          </Link>
          {/* Under 760 px the section links move into a menu that needs no script. */}
          <details className="menu">
            <summary className="menu-button">{c.menu}</summary>
            <nav className="menu-panel" aria-label={c.menu}>
              {links}
              <Link href={href(other, path)} hrefLang={other} lang={other} aria-label={c.langLabel}>{c.lang}</Link>
            </nav>
          </details>
          <Button asChild size="sm">
            <Link href={href(locale, "/download/")}>{c.download}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

/** Light multi-column close, then one line with the notice. */
export function Footer({ locale, path }: { locale: Locale; path: string }) {
  const h = homeCopy(locale);
  const c = h.footer;
  const other: Locale = locale === "ko" ? "en" : "ko";
  const home = href(locale, "/");
  return (
    <footer className="site-footer">
      <div className="frame">
        <div className="footer-cols">
          <div className="footer-brand">
            <Link className="wordmark" href={home} aria-label={locale === "ko" ? "Ave 첫 화면" : "Ave home"}>
              <Mark />
              <span>Ave</span>
            </Link>
          </div>
          <nav aria-labelledby="f-ave">
            <h2 id="f-ave">Ave</h2>
            <ul>
              <li><Link href={`${home}#workbench`}>{h.wb.title}</Link></li>
              <li><Link href={`${home}#models`}>{h.models.title}</Link></li>
              <li><Link href={`${home}#plugins`}>{h.plugins.title}</Link></li>
              <li><Link href={`${home}#alongside`}>{h.side.title}</Link></li>
            </ul>
          </nav>
          <nav aria-labelledby="f-docs">
            <h2 id="f-docs">{c.docs}</h2>
            <ul>
              {docPages(locale).map((p) => (
                <li key={p.slug}><Link href={href(locale, `/docs/${p.slug}/`)}>{p.title}</Link></li>
              ))}
            </ul>
          </nav>
          <nav aria-labelledby="f-dl">
            <h2 id="f-dl">{c.download}</h2>
            <ul>
              {getDownloads(locale).map((d) => (
                <li key={d.os}><Link href={`${href(locale, "/download/")}#${d.os}`}>{d.osLabel}</Link></li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="footer-line">
          <p className="copy">{c.copy}</p>
          <Link href={href(other, path)} hrefLang={other} lang={other}>{c.lang}</Link>
        </div>
      </div>
    </footer>
  );
}
