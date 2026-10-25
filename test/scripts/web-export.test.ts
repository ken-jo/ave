import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzePages, anchors, finishNotFound } from "../../scripts/lib/web-export.mjs";

/** A page with the given body links inside a minimal document. */
const doc = (body: string) => `<!DOCTYPE html><html><head><script>self.__next=["<a href=\\"/nowhere/\\">x</a>"]</script></head><body>${body}</body></html>`;

/** A small consistent site: home, download, docs, 404; every page links to download. */
function site(overrides: Record<string, string> = {}) {
  const nav = `<a class="logo" href="/">Ave</a><a href="/download/">Download</a><a href="/docs/">Docs</a>`;
  const pages = new Map<string, string>([
    ["/", doc(`${nav}<a class="skip" href="#main">Skip</a><main id="main"></main>`)],
    ["/download/", doc(`<a class="logo" href="/">Ave</a><span aria-current="page">Download</span><a href="/docs/">Docs</a><h2 id="mac">macOS</h2>`)],
    ["/docs/", doc(`<a class="logo" href="/">Ave</a><a href="/download/">Download</a><a href="/download/#mac">For macOS</a>`)],
    ["/404.html", doc(`<a href="/">Home</a><a href="/download/">Download</a><a href="/docs/">Docs</a>`)],
  ]);
  for (const [k, v] of Object.entries(overrides)) pages.set(k, v);
  const files = new Set([...pages.keys()].map((p) => (p.endsWith("/") ? `${p}index.html` : p)));
  files.add("/media/a-light.avif");
  return { pages, exists: (p: string) => files.has(p) };
}

const check = (pages: Map<string, string>, exists: (p: string) => boolean) => analyzePages(pages, exists, { notFound: ["/404.html"], origin: "https://example.test" });

describe("web export link graph", () => {
  it("accepts a consistent site, ignoring markup inside scripts", () => {
    const { pages, exists } = site();
    expect(check(pages, exists)).toEqual([]);
  });

  it("reads labels from text, falling back to aria-label", () => {
    expect(anchors(`<a href="/x/" class="more big"><span>More</span> on &amp; on</a><a href="/y/" aria-label="Ave home"><svg></svg></a>`)).toEqual([
      { href: "/x/", cls: ["more", "big"], hreflang: undefined, label: "More on & on" },
      { href: "/y/", cls: [""], hreflang: undefined, label: "Ave home" },
    ]);
  });

  it("finds dead links and missing anchors", () => {
    const { pages, exists } = site({ "/docs/": doc(`<a href="/download/">Download</a><a href="/gone/">Gone</a><a href="/download/#linux">Linux</a>`) });
    const problems = check(pages, exists);
    expect(problems).toContain('/docs/: <a href="/gone/"> "Gone" leads to a missing page');
    expect(problems).toContain('/docs/: <a href="/download/#linux"> "Linux" names an anchor /download/ does not have');
  });

  it("rejects self-links except the logo on the home page, and same-page jumps except the skip link", () => {
    const { pages, exists } = site({
      "/download/": doc(`<a class="logo" href="/">Ave</a><a href="/download/#mac">For macOS</a><a href="#mac">Jump</a><h2 id="mac"></h2><a href="/docs/">Docs</a>`),
    });
    const problems = check(pages, exists);
    expect(problems).toContain('/download/: <a href="/download/#mac"> "For macOS" links to the page it is on');
    expect(problems).toContain('/download/: <a href="#mac"> "Jump" jumps within its own page');
    expect(problems.filter((p) => p.startsWith("/: "))).toEqual([]);
  });

  it("rejects one label leading to two places, but not the language switch", () => {
    const { pages } = site({
      "/docs/": doc(`<a href="/download/">Download</a><a href="/">Download</a><a href="/en/docs/" hreflang="en">English</a>`),
    });
    pages.set("/en/docs/", doc(`<a href="/en/download/">Download</a>`));
    pages.set("/en/download/", doc(`<a href="/en/docs/">Docs</a>`));
    const files = new Set(["/index.html", "/download/index.html", "/docs/index.html", "/404.html", "/en/docs/index.html", "/en/download/index.html"]);
    const problems = check(pages, (p) => files.has(p));
    expect(problems).toContain('/docs/: the label "Download" leads to both /download/ and /');
    expect(problems.some((p) => p.includes('"English"'))).toBe(false);
  });

  it("requires Download within two clicks, links into every page, and links out of the not-found page", () => {
    const { pages, exists } = site({
      "/docs/": doc(`<a href="/far/">Far</a>`),
      "/404.html": doc(`<a href="/">Home</a>`),
    });
    pages.set("/far/", doc(`<a href="/docs/">Docs</a>`));
    pages.set("/lonely/", doc(`<a href="/download/">Download</a>`));
    const files = new Set(["/index.html", "/download/index.html", "/docs/index.html", "/404.html", "/far/index.html", "/lonely/index.html"]);
    const problems = check(pages, (p) => files.has(p) || exists(p));
    expect(problems).toContain("/docs/: /download/ is more than two clicks away");
    expect(problems).toContain("/lonely/: no other page links here");
    expect(problems).toContain("/404.html: a not-found page needs links out, found 1");
  });

  it("requires media dimensions and existing media files, and relative links to the site itself", () => {
    const { pages, exists } = site({
      "/": doc(`<a href="/download/">Download</a><a href="/docs/">Docs</a><img src="/media/a-light.avif" alt="a"><picture><source srcset="/media/b.avif"></picture><a href="https://example.test/docs/">Docs</a>`),
    });
    const problems = check(pages, exists);
    expect(problems).toContain("/: <img> without width and height (/media/a-light.avif)");
    expect(problems).toContain('/: srcset "/media/b.avif" is missing');
    expect(problems).toContain(`/: <a href="https://example.test/docs/"> "Docs" spells out the site's own origin`);
  });
});

describe("not-found export", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("moves each locale's not-found route to 404.html and removes the live routes", () => {
    dir = mkdtempSync(join(tmpdir(), "web-export-"));
    for (const prefix of ["", "en"]) {
      mkdirSync(join(dir, prefix, "not-found"), { recursive: true });
      writeFileSync(join(dir, prefix, "not-found", "index.html"), `nf ${prefix}`);
      writeFileSync(join(dir, prefix, "not-found.txt"), "rsc");
    }
    for (const live of ["404", "_not-found"]) {
      mkdirSync(join(dir, live));
      writeFileSync(join(dir, live, "index.html"), "next");
    }
    finishNotFound(dir);
    expect(readFileSync(join(dir, "404.html"), "utf8")).toBe("nf ");
    expect(readFileSync(join(dir, "en", "404.html"), "utf8")).toBe("nf en");
    for (const gone of ["not-found", "not-found.txt", "en/not-found", "en/not-found.txt", "404", "_not-found"]) {
      expect(existsSync(join(dir, gone))).toBe(false);
    }
  });

  it("fails when a locale's not-found page was not built", () => {
    dir = mkdtempSync(join(tmpdir(), "web-export-"));
    expect(() => finishNotFound(dir)).toThrow("the export has no not-found/index.html");
  });
});
