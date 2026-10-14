import { describe, expect, it } from "vitest";
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
});
