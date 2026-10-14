import Link from "next/link";
import { href, type Locale } from "@/lib/i18n";
import { homeCopy } from "@/lib/home";

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect width="64" height="64" rx="16" fill="currentColor" />
      <path d="M16 46 L32 16 L48 46" fill="none" stroke="#c4f04a" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="40" r="4.5" fill="#c4f04a" />
    </svg>
  );
}

/**
 * Plain bar: wordmark, two in-page links, docs, the language switch and one
 * action. `path` is the canonical (Korean) path of the current page, used for
 * the language switch.
 */
export function Header({ locale, path }: { locale: Locale; path: string }) {
  const c = homeCopy(locale).nav;
  const other: Locale = locale === "ko" ? "en" : "ko";
  const home = href(locale, "/");
  return (
    <header className="site-header">
      <div className="wrap bar">
        <a className="skip" href="#main">
          {locale === "ko" ? "본문으로 건너뛰기" : "Skip to content"}
        </a>
        <Link className="wordmark" href={home} aria-label={locale === "ko" ? "Ave 첫 화면" : "Ave home"}>
          <Mark />
          <span>Ave</span>
        </Link>
        <nav className="nav" aria-label={locale === "ko" ? "주 메뉴" : "Main"}>
          <Link className="nav-section" href={`${home}#permissions`}>{c.permissions}</Link>
          <Link className="nav-section" href={`${home}#plugins`}>{c.plugins}</Link>
          <Link href={href(locale, "/docs/")}>{c.docs}</Link>
          <Link className="lang" href={href(other, path)} hrefLang={other} lang={other} aria-label={c.langLabel}>
            {c.lang}
          </Link>
          <Link className="button" href={href(locale, "/download/")}>{c.download}</Link>
        </nav>
      </div>
    </header>
  );
}

/** The close: the name at full width, then one line of links and the notice. */
export function Footer({ locale, path }: { locale: Locale; path: string }) {
  const c = homeCopy(locale).footer;
  const other: Locale = locale === "ko" ? "en" : "ko";
  return (
    <footer className="site-footer">
      <div className="wrap">
        <span className="footer-name" aria-hidden="true">Ave</span>
        <div className="footer-line">
          <nav aria-label={locale === "ko" ? "바닥글" : "Footer"}>
            <Link href={href(locale, "/docs/")}>{c.docs}</Link>
            <Link href={href(locale, "/download/")}>{c.download}</Link>
            <Link href={href(other, path)} hrefLang={other} lang={other}>{c.lang}</Link>
          </nav>
          <p className="copy">{c.copy}</p>
        </div>
      </div>
    </footer>
  );
}
