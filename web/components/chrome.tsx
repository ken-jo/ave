import { homeCopy } from "@/lib/home";
import { href, type Locale } from "@/lib/i18n";
import { counterpart, footerColumns, headerNav, page, type NavLink } from "@/lib/nav";

/**
 * Header and footer. `path` is the canonical (Korean, slashed) path of the
 * page being shown. A link to that same page is rendered as plain text
 * marked aria-current, so no page links to itself; the logo on the home page
 * is the one exception.
 */

export function Item({ link, path, className }: { link: NavLink; path: string; className?: string }) {
  if (link.canonical === path) {
    return (
      <span className={className} aria-current="page">
        {link.label}
      </span>
    );
  }
  return (
    <a className={className} href={link.href}>
      {link.label}
    </a>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="currentColor" />
      <path d="M16 46 L32 16 L48 46" fill="none" stroke="#c4f04a" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="40" r="4.5" fill="#c4f04a" />
    </svg>
  );
}

function LangSwitch({ locale, path, className }: { locale: Locale; path: string; className?: string }) {
  const other = counterpart(locale, path);
  return (
    <a className={className} href={other.href} hrefLang={other.lang} lang={other.lang} aria-label={other.aria}>
      {other.label}
    </a>
  );
}

export function Header({ locale, path }: { locale: Locale; path: string }) {
  const c = homeCopy(locale).footer;
  const nav = headerNav(locale);
  const download = page(locale, "download");
  return (
    <header className="site-header">
      <a className="skip" href="#main">
        {c.skip}
      </a>
      <div className="wrap">
        <a className="logo" href={href(locale, "/")} aria-label={locale === "ko" ? "Ave 홈" : "Ave home"}>
          <Mark />
          <span>Ave</span>
        </a>
        <nav className="nav" aria-label={locale === "ko" ? "주 메뉴" : "Main"}>
          {nav.map((l) => (
            <Item key={l.canonical} link={l} path={path} />
          ))}
        </nav>
        <div className="header-end">
          <LangSwitch locale={locale} path={path} className="lang" />
          <Item link={download} path={path} className="btn btn-primary" />
          <details className="menu">
            <summary aria-label={c.menu}>
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </summary>
            <nav className="menu-panel" aria-label={c.menu}>
              {nav.map((l) => (
                <Item key={l.canonical} link={l} path={path} />
              ))}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

export function Footer({ locale, path }: { locale: Locale; path: string }) {
  const c = homeCopy(locale).footer;
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="foot-grid">
          <div className="foot-brand">
            <p className="logo" aria-hidden="true">
              <Mark />
              <span>Ave</span>
            </p>
            <p>{c.tagline}</p>
          </div>
          {footerColumns(locale).map((col) => (
            <nav key={col.title} className="foot-col" aria-label={col.title}>
              <h2>{col.title}</h2>
              <ul>
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Item link={l} path={path} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="foot-base">
          <span>{c.copy}</span>
          <LangSwitch locale={locale} path={path} />
        </div>
      </div>
    </footer>
  );
}
