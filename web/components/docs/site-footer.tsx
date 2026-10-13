"use client";
import { usePathname } from "next/navigation";
import { localeFromPathname, href } from "@/lib/i18n";
import { uiStrings } from "@/lib/ui-strings";

export function SiteFooter() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname);
  const strings = uiStrings(locale);
  const home = href(locale, "/");
  const anchor = (id: string) => `${home === "/" ? "" : home}/#${id}`;

  const footerLinks = [
    {
      title: strings.footerProduct,
      links: [
        { label: strings.footerHome, href: home },
        { label: strings.nav.download, href: anchor("download") },
        { label: strings.footerLinks.reinstall, href: anchor("reinstall") },
        { label: "Marketplace", href: href(locale, "/docs/marketplace") },
      ],
    },
    {
      title: strings.footerDocs,
      links: [
        { label: strings.footerLinks.start, href: href(locale, "/docs/getting-started/install") },
        { label: strings.footerLinks.updates, href: href(locale, "/docs/getting-started/updates") },
        { label: strings.footerLinks.plugins, href: href(locale, "/docs/plugins") },
      ],
    },
    {
      title: strings.footerResources,
      links: [
        { label: strings.footerLinks.architecture, href: href(locale, "/docs/architecture/overview") },
        { label: strings.footerLinks.hostApi, href: href(locale, "/docs/architecture/host-api") },
        { label: strings.footerLinks.roadmap, href: href(locale, "/docs/roadmap") },
      ],
    },
  ];

  return (
    <footer className="border-t border-border bg-[#fbfbfa]">
      <div className="mx-auto grid max-w-[1120px] gap-10 px-4 py-14 sm:grid-cols-2 sm:px-8 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ave-mark.svg" alt="" className="h-7 w-7" />
            <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">Ave</span>
          </div>
          <p className="mt-3 max-w-xs text-[13.5px] leading-relaxed text-muted-foreground">
            {strings.footerTagline}
          </p>
        </div>
        {footerLinks.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <p className="text-[13px] font-semibold text-ink">{col.title}</p>
            <ul className="mt-3 grid gap-2">
              {col.links.map((l) => (
                <li key={l.label}>
                  <a href={l.href} className="text-[13.5px] text-muted-foreground transition-colors hover:text-ink">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-2 px-4 py-5 text-[12.5px] text-muted-foreground sm:px-8">
          <span>© Ave</span>
          <span>former-site.invalid</span>
        </div>
      </div>
    </footer>
  );
}
