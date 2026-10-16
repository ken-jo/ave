import { describe, expect, it } from "vitest";
import { linearGrowthBound, measureCpuGrowth } from "../../__tests__/support/cpu-growth.js";
import { decodeHtmlEntities, htmlToMarkdown } from "../html-to-markdown.js";

const md = (html: string, base = "https://example.test/dir/page.html") => htmlToMarkdown(html, base).markdown;

describe("htmlToMarkdown", () => {
  it("renders the body when the optional </head> and </p> end tags are missing", () => {
    expect(md("<html><head><title>T</title><meta charset=utf-8><body><p>first<p>second<h2>Sub</h2>")).toBe(
      "first\n\nsecond\n\n## Sub",
    );
    expect(htmlToMarkdown("<title>Page &amp; title</title><p>x</p>").title).toBe("Page & title");
  });

  it("closes implicit list items and numbers ordered lists from start", () => {
    expect(md("<ol start=3><li>a<li>b</ol><ul><li>x<li>y</ul>")).toBe("3. a\n4. b\n\n- x\n- y");
  });

  it("keeps inline emphasis, images, mailto and base-relative links", () => {
    expect(md("<p><b>bold</b> and <em>it</em> <img src='i.png' alt='pic'> <a href='mailto:a@b.test'>mail</a></p>"))
      .toBe("**bold** and _it_ ![pic](https://example.test/dir/i.png) [mail](mailto:a@b.test)");
    expect(md("<base href='https://cdn.test/root/'><a href='x (1).html'>x</a>")).toBe(
      "[x](https://cdn.test/root/x%20%281%29.html)",
    );
  });

  it("drops fragment-only, script and data links but keeps their text", () => {
    expect(md("<a href='#top'>top</a> <a href='data:text/html,x'>data</a> <a href='javascript:void(0)'>js</a>"))
      .toBe("top data js");
  });

  it("quotes blockquotes and fences code that contains backticks", () => {
    expect(md("<blockquote><p>one</p><p>two</p></blockquote>")).toBe("> one\n>\n> two");
    expect(md("<pre>use ``` here</pre>")).toBe("````\nuse ``` here\n````");
    expect(md("<p><code>a`b</code></p>")).toBe("``a`b``");
  });

  it("omits scripts, styles, comments, forms controls and navigation", () => {
    expect(md("<nav>menu</nav><!-- note --><script>if (a < b) {}</script><style>p{}</style><button>Go</button><p>body</p>"))
      .toBe("body");
  });

  it("treats a stray < as text and decodes numeric entities", () => {
    expect(md("<p>1 < 2 &#x1F600; &#169; &bogus;</p>")).toBe("1 < 2 😀 © &bogus;");
    expect(decodeHtmlEntities("&#0;&#xD800;")).toBe("��");
  });

  it("strips layout marker characters that appear in page text", () => {
    expect(md("<p>a\u0001b\u0003c</p>")).toBe("abc");
  });

  it("stays linear on tags that never close", () => {
    // The growth of CPU time from 37.5 KB to 600 KB is judged, not a wall-clock cap that a loaded runner can breach.
    // Linear code reads 15-18 against the bound of 64. The ratio catches a super-linear term only once that term
    // dominates the cost at 600 KB: at this spread, a quadratic term must cost about four times the linear work
    // there. A smaller quadratic slips through. A rescan of index/1024 characters per position read 28-62 and
    // passed, while index/64 read 106 and failed. A wider spread does not help, because the geometric-mean bound
    // rises faster than the quadratic share. A bound nearer 18 would trade away the noise margin. Going larger
    // than 600 KB would multiply the cost of every run.
    const SMALL = 37_500;
    const LARGE = 16 * SMALL;
    const MAX_GROWTH = linearGrowthBound(LARGE / SMALL);
    for (const unit of ["<a ", "<a \"", "<a '\"<b ", "<a\t"]) {
      const small = unit.repeat(Math.ceil(SMALL / unit.length));
      const html = unit.repeat(Math.ceil(LARGE / unit.length));
      expect(htmlToMarkdown(html).markdown.length).toBeGreaterThan(0);
      const { smallMs, largeMs, growth } = measureCpuGrowth(() => htmlToMarkdown(small), () => htmlToMarkdown(html), {
        fastEnoughMs: 5,
        minSampleMs: 20,
      });
      if (growth === undefined) continue;
      expect(growth, `${JSON.stringify(unit)}: ${smallMs.toFixed(1)} ms at ${SMALL}, ${largeMs.toFixed(1)} ms at ${LARGE}`).toBeLessThan(MAX_GROWTH);
    }
    // The judgement reads CPU time, so load cannot move it; the wall time spent collecting that CPU time can.
  }, 180_000);

  it("keeps parsing quoted attributes that contain > and <", () => {
    expect(htmlToMarkdown('<p><a href="https://e.com/?q=a>b" title="x<y">link</a></p>').markdown)
      .toBe('[link](https://e.com/?q=a%3Eb "x<y")');
  });

  it("reads a page nested far deeper than the tree keeps", () => {
    const depth = 100_000;
    const html = `<title>Deep</title>${"<div>".repeat(depth)}bottom${"</div>".repeat(depth)}`;
    const result = htmlToMarkdown(html);
    expect(result.title).toBe("Deep");
    expect(result.markdown).toContain("bottom");
  });

  it("reads a deeply nested list as plain text instead of re-indenting it per level, and keeps deep quotes bounded", () => {
    // Asserted on the output, not on wall-clock time: a coverage run on a loaded
    // runner is many times slower than a laptop. Re-indenting every level turns
    // this 250 KB page into megabytes of "- " markers; the render budget reads it
    // as plain text instead, which is also what keeps it fast.
    for (const [open, close] of [["<ul><li>", "</li></ul>"], ["<blockquote>", "</blockquote>"]]) {
      const levels = Math.floor(250_000 / open.length);
      const html = `<title>Nest</title>${open.repeat(levels)}deepest${close.repeat(levels)}`;
      const result = htmlToMarkdown(html);
      expect(result.title).toBe("Nest");
      expect(result.markdown).toContain("deepest");
      expect(result.markdown.length).toBeLessThan(html.length);
      if (open === "<ul><li>") expect(result.markdown).not.toMatch(/^\s*- /m);
    }
  });

  it("keeps content that sits in a table outside any row", () => {
    const markdown = htmlToMarkdown("<table><tr><td>a</td><td>b</td>row text</tr><ul><li>listed</li></ul>loose text</table>").markdown;
    expect(markdown).toContain("| a | b |");
    // Foster-parented in front of the table, as a browser places it.
    for (const text of ["row text", "- listed", "loose text"]) {
      expect(markdown).toContain(text);
      expect(markdown.indexOf(text)).toBeLessThan(markdown.indexOf("| a | b |"));
    }
  });
});
