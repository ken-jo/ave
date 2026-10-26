import { DOC_SLUGS, docPage } from "./docs";
import { href, type Locale } from "./i18n";

/**
 * The site's one navigation model. The header, the footer, the home sections'
 * "more" links, the feature pages' next steps and the 404 page all read their
 * destinations and labels from here, so one label always leads to one place.
 * The build's link-graph check (scripts/check-web-link-graph.mjs) enforces it
 * on the exported pages.
 */

export const FEATURES = ["browser", "terminal", "models", "plugins", "security"] as const;
export type Feature = (typeof FEATURES)[number];

/** Canonical (Korean, slashed) paths of every page the site exports. */
export const PATHS = {
  home: "/",
  download: "/download/",
  docs: "/docs/",
  changelog: "/changelog/",
  browser: "/browser/",
  terminal: "/terminal/",
  models: "/models/",
  plugins: "/plugins/",
  security: "/security/",
} as const;

export type PageKey = keyof typeof PATHS;

export interface NavLink {
  label: string;
  /** Locale-resolved href. */
  href: string;
  /** Canonical path (Korean), used to decide whether the link points at the page being shown. */
  canonical: string;
}

const LABELS: Record<Locale, Record<PageKey, string>> = {
  ko: {
    home: "홈",
    download: "내려받기",
    docs: "문서",
    changelog: "변경 기록",
    browser: "브라우저",
    terminal: "터미널",
    models: "모델",
    plugins: "플러그인",
    security: "보안",
  },
  en: {
    home: "Home",
    download: "Download",
    docs: "Docs",
    changelog: "Changelog",
    browser: "Browser",
    terminal: "Terminal",
    models: "Models",
    plugins: "Plugins",
    security: "Security",
  },
};

/** The "more" label each feature carries wherever it is linked from a section. */
const MORE: Record<Locale, Record<Feature, string>> = {
  ko: {
    browser: "브라우저 자세히",
    terminal: "터미널 자세히",
    models: "모델 연결 자세히",
    plugins: "플러그인 자세히",
    security: "보안 원칙 자세히",
  },
  en: {
    browser: "More on the browser",
    terminal: "More on the terminal",
    models: "More on connecting models",
    plugins: "More on plugins",
    security: "More on security",
  },
};

export function page(locale: Locale, key: PageKey): NavLink {
  const canonical = PATHS[key];
  return { label: LABELS[locale][key], href: href(locale, canonical), canonical };
}

export function more(locale: Locale, feature: Feature): NavLink {
  const canonical = PATHS[feature];
  return { label: MORE[locale][feature], href: href(locale, canonical), canonical };
}

export function doc(locale: Locale, slug: (typeof DOC_SLUGS)[number]): NavLink {
  const canonical = `/docs/${slug}/`;
  const found = docPage(locale, slug);
  if (!found) throw new Error(`unknown doc slug ${slug}`);
  return { label: found.title, href: href(locale, canonical), canonical };
}

/** Which guide carries the details of each feature page. */
export const FEATURE_DOC: Record<Feature, (typeof DOC_SLUGS)[number]> = {
  browser: "workbench",
  terminal: "workbench",
  models: "models",
  plugins: "plugins",
  security: "permissions",
};

/** Feature pages read forward: each one hands the reader to the next, the last to Download. */
export function nextAfter(feature: Feature): PageKey {
  const i = FEATURES.indexOf(feature);
  return i + 1 < FEATURES.length ? FEATURES[i + 1] : "download";
}

/** Header: the features, then Docs and Changelog; Download is the primary button. */
export function headerNav(locale: Locale): NavLink[] {
  return [...FEATURES, "docs", "changelog"].map((k) => page(locale, k as PageKey));
}

type OsKey = "mac" | "windows" | "linux";
const OS_LABEL: Record<OsKey, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

export interface FooterColumn {
  title: string;
  links: NavLink[];
}

/** Footer: the full index of the site. */
export function footerColumns(locale: Locale): FooterColumn[] {
  const ko = locale === "ko";
  return [
    { title: ko ? "제품" : "Product", links: FEATURES.map((f) => page(locale, f)) },
    {
      title: ko ? "시작하기" : "Get started",
      links: [
        page(locale, "download"),
        ...(["mac", "windows", "linux"] as OsKey[]).map((os) => ({
          label: ko ? `${OS_LABEL[os]}용` : `For ${OS_LABEL[os]}`,
          href: `${href(locale, PATHS.download)}#${os}`,
          canonical: PATHS.download,
        })),
        page(locale, "changelog"),
      ],
    },
    { title: ko ? "문서" : "Docs", links: [page(locale, "docs"), ...DOC_SLUGS.map((s) => doc(locale, s))] },
  ];
}

/**
 * Where the not-found page is built before the export step copies it to
 * 404.html (scripts/finish-web-export.mjs removes the route itself).
 */
export const NOT_FOUND_PATH = "/not-found/";

/** The same page in the other language, keeping the path. From the not-found page it is the other home page. */
export function counterpart(locale: Locale, path: string): { href: string; label: string; lang: Locale; aria: string } {
  const canonical = path === NOT_FOUND_PATH ? "/" : path;
  return locale === "ko"
    ? { href: href("en", canonical), label: "English", lang: "en", aria: "English version of this page" }
    : { href: canonical, label: "한국어", lang: "ko", aria: "이 페이지의 한국어판" };
}
