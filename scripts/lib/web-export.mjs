// The website's static export, after `next build`: the not-found pages are
// moved to the 404.html files the host serves for a missing path, and the
// exported pages are checked as a link graph. The rules are the site's
// information architecture (the site's DESIGN.md, "Navigation"):
//
// - every internal link and every media source resolves to an exported file,
//   and a link to an anchor on another page finds that id there;
// - no page links to itself (the logo on a home page is the one exception) and
//   no link jumps within its own page (the skip link excepted);
// - on one page, one label leads to one destination;
// - the download page is at most two clicks from every page;
// - every page is linked from another page, and the not-found pages link out;
// - every image and video states its width and height;
// - the sitemap lists exactly the exported pages.

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Route the not-found page is built at, per locale prefix; see web/lib/nav.ts NOT_FOUND_PATH. */
const NOT_FOUND_ROUTE = "not-found";
const LOCALES = ["", "en"];

/** Moves `<locale>/not-found/index.html` to `<locale>/404.html` and removes the routes Next exported for it. */
export function finishNotFound(outDir) {
  for (const prefix of LOCALES) {
    const dir = join(outDir, prefix, NOT_FOUND_ROUTE);
    const page = join(dir, "index.html");
    if (!existsSync(page)) throw new Error(`the export has no ${relative(outDir, page).split(sep).join("/")}`);
    renameSync(page, join(outDir, prefix, "404.html"));
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(outDir, prefix, `${NOT_FOUND_ROUTE}.txt`), { force: true });
  }
  // Next's own not-found route, exported as live pages by trailingSlash: Next 16
  // emits both /404/ and /_not-found/ (beside 404.html), so neither is legacy.
  for (const route of ["404", "_not-found"]) rmSync(join(outDir, route), { recursive: true, force: true });
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };

function decode(text) {
  return text.replace(/&(#?[a-z0-9]+);/giu, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function attrs(source) {
  const out = {};
  for (const m of source.matchAll(/([a-zA-Z:-]+)(?:="([^"]*)")?/gu)) out[m[1].toLowerCase()] = decode(m[2] ?? "");
  return out;
}

/** Markup without scripts, styles and templates, whose text is not page content. */
function visible(html) {
  return html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/giu, "");
}

export function anchors(html) {
  const out = [];
  for (const m of visible(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const a = attrs(m[1]);
    const text = decode(m[2].replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
    out.push({ href: a.href ?? "", cls: (a.class ?? "").split(/\s+/u), hreflang: a.hreflang, label: text || a["aria-label"] || "" });
  }
  return out;
}

function ids(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]));
}

/** `/x/` is served by `/x/index.html`. */
function fileFor(urlPath) {
  return urlPath.endsWith("/") ? `${urlPath}index.html` : urlPath;
}

const isHome = (path) => path === "/" || path === "/en/";
const localeOf = (path) => (path === "/en/" || path.startsWith("/en/") ? "en" : "ko");

/**
 * Checks a set of exported pages.
 * `pages` maps each page's URL path ("/", "/docs/start/", "/404.html") to its HTML.
 * `exists(urlPath)` says whether a file is exported at that path.
 * `notFound` lists the not-found pages' paths; they are not link targets.
 */
export function analyzePages(pages, exists, { notFound = [], origin } = {}) {
  const problems = [];
  const pageSet = new Set(pages.keys());
  const linksFrom = new Map();
  const download = { ko: "/download/", en: "/en/download/" };

  for (const [path, html] of pages) {
    const isNotFound = notFound.includes(path);
    const base = new URL(path, "https://site.invalid");
    const labels = new Map();
    const targets = new Set();
    let internal = 0;
    for (const a of anchors(html)) {
      const where = `${path}: <a href="${a.href}"> "${a.label}"`;
      if (!a.href) {
        problems.push(`${where} has no href`);
        continue;
      }
      if (a.href.startsWith("#")) {
        if (!a.cls.includes("skip")) problems.push(`${where} jumps within its own page`);
        continue;
      }
      if (/^(mailto|tel):/u.test(a.href)) continue;
      const url = new URL(a.href, base);
      if (url.origin !== "https://site.invalid") {
        if (origin && url.origin === origin) problems.push(`${where} spells out the site's own origin`);
        continue;
      }
      internal++;
      const target = url.pathname;
      const dest = `${target}${url.hash}`;
      if (!exists(fileFor(target))) problems.push(`${where} leads to a missing page`);
      else if (url.hash && pages.has(target) && !ids(pages.get(target)).has(decodeURIComponent(url.hash.slice(1)))) {
        problems.push(`${where} names an anchor ${target} does not have`);
      }
      if (target === path && !(a.cls.includes("logo") && isHome(path))) problems.push(`${where} links to the page it is on`);
      if (!a.hreflang) {
        const seen = labels.get(a.label);
        if (seen && seen !== dest) problems.push(`${path}: the label "${a.label}" leads to both ${seen} and ${dest}`);
        else labels.set(a.label, dest);
      }
      if (pageSet.has(target) && target !== path) targets.add(target);
    }
    linksFrom.set(path, targets);
    if (isNotFound && internal < 3) problems.push(`${path}: a not-found page needs links out, found ${internal}`);

    const shown = visible(html);
    for (const m of shown.matchAll(/<(img|video)\b([^>]*)>/giu)) {
      const a = attrs(m[2]);
      if (!a.width || !a.height) problems.push(`${path}: <${m[1]}> without width and height (${a.src ?? a.alt ?? ""})`);
    }
    for (const m of shown.matchAll(/\s(src|srcset|poster)="([^"]+)"/giu)) {
      for (const candidate of m[2].split(",")) {
        const ref = candidate.trim().split(/\s+/u)[0];
        if (!ref || /^(data:|https?:)/u.test(ref)) continue;
        const target = new URL(ref, base).pathname;
        if (!exists(target)) problems.push(`${path}: ${m[1]} "${ref}" is missing`);
      }
    }
  }

  // Download within two clicks, and no orphan pages.
  for (const [path, targets] of linksFrom) {
    if (notFound.includes(path)) continue;
    const goal = download[localeOf(path)];
    if (path === goal || targets.has(goal)) continue;
    if (![...targets].some((t) => linksFrom.get(t)?.has(goal))) problems.push(`${path}: ${goal} is more than two clicks away`);
  }
  const linked = new Set([...linksFrom.values()].flatMap((s) => [...s]));
  for (const path of pageSet) {
    if (!notFound.includes(path) && !linked.has(path)) problems.push(`${path}: no other page links here`);
  }
  return problems;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Reads the export in `outDir` and checks it; returns the problems found. */
export function checkExport(outDir, { origin }) {
  const files = walk(outDir).map((f) => `/${relative(outDir, f).split(sep).join("/")}`);
  const fileSet = new Set(files);
  const notFound = ["/404.html", "/en/404.html"];
  const pages = new Map();
  for (const f of files) {
    if (!f.endsWith(".html")) continue;
    const path = notFound.includes(f) ? f : f.endsWith("/index.html") ? f.slice(0, -"index.html".length) : null;
    if (path === null) continue;
    pages.set(path, readFileSync(join(outDir, f), "utf8"));
  }
  const problems = [];
  for (const nf of notFound) if (!pages.has(nf)) problems.push(`the export has no ${nf}`);
  for (const live of ["/404/", "/_not-found/"]) {
    if (fileSet.has(`${live}index.html`)) problems.push(`the export still has a live ${live} page`);
  }
  problems.push(...analyzePages(pages, (p) => fileSet.has(p), { notFound, origin }));

  const sitemap = readFileSync(join(outDir, "sitemap.xml"), "utf8");
  const listed = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((m) => new URL(m[1]).pathname));
  for (const path of pages.keys()) {
    if (!notFound.includes(path) && !listed.has(path)) problems.push(`sitemap.xml does not list ${path}`);
  }
  for (const path of listed) if (!pages.has(path)) problems.push(`sitemap.xml lists ${path}, which is not an exported page`);
  return problems;
}
