/** Substitution must keep user input inside the server-published path structure. */
import { describe, expect, it } from "vitest";
import {
  expandResourceUriTemplate,
  isUsableResourceUriTemplate,
  MCP_RESOURCE_TEMPLATE_MAX_VARIABLES,
  MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS,
  resourceTemplateVariables,
} from "../mcp-resource-template-bounds.js";
import { isUsableResourceUri, MCP_RESOURCE_URI_MAX_CHARS } from "../mcp-resource-bounds.js";

describe("isUsableResourceUriTemplate", () => {
  it("accepts Level 1 templates over schemes a resource may use", () => {
    for (const template of [
      "file:///project/{path}",
      "git://repo/{ref}",
      "github://repos/{owner}/{repo}/issues/{number}",
      "schema://users/{id}",
      "acme-internal://records/{recordId}",
    ]) {
      expect(isUsableResourceUriTemplate(template), template).toBe(true);
    }
  });

  it("refuses every RFC 6570 operator and modifier", () => {
    // Reserved expansion leaves slashes unencoded and permits traversal; allow plain substitution only.
    for (const template of [
      "file:///project/{+path}",
      "file:///project/{#frag}",
      "file:///project{/segments}",
      "file:///project{?query}",
      "file:///project{&more}",
      "file:///project/{path*}",
      "file:///project/{path:3}",
      "file:///project/{}",
      "file:///project/{a b}",
      "file:///project/{",
      "file:///project/}",
    ]) {
      expect(isUsableResourceUriTemplate(template), template).toBe(false);
    }
  });

  it("refuses a MIXED template — one good variable plus one operator", () => {
    // Require every expression to be valid, not merely one matching expression.
    for (const template of [
      "file:///project/{ok}/{+path}",
      "file:///project/{ok}{?query}",
      "file:///project/{ok}/{path*}",
      "file:///project/{ok}/{",
    ]) {
      expect(isUsableResourceUriTemplate(template), template).toBe(false);
    }
    // Validate the remaining skeleton too; nested braces can pass expression-count checks.
    expect(isUsableResourceUriTemplate("file:///{a{b}")).toBe(false);
  });

  it("refuses a template whose LITERAL part already contains a dot segment", () => {
    // Reject dot-segment templates at discovery so catalogued entries cannot be guaranteed read failures.
    expect(isUsableResourceUriTemplate("file:///project/../{path}")).toBe(false);
    expect(isUsableResourceUriTemplate("file:///project/./{path}")).toBe(false);
    expect(isUsableResourceUri("file:///project/../secret")).toBe(true);
  });

  it("refuses a template with no variable at all", () => {
    // Concrete URIs are not zero-variable templates; the two paths have different gates.
    expect(isUsableResourceUriTemplate("file:///project/README.md")).toBe(false);
  });

  it("holds the skeleton to the SAME rules a plain URI must pass", () => {
    // Validate the skeleton with the ordinary URI predicate to keep scheme policy consistent.
    expect(isUsableResourceUriTemplate("ui://widget/{id}")).toBe(false);
    expect(isUsableResourceUriTemplate("javascript:alert({x})")).toBe(false);
    expect(isUsableResourceUriTemplate("no-scheme/{path}")).toBe(false);
    expect(isUsableResourceUriTemplate("file:///a b/{path}")).toBe(false);
    expect(isUsableResourceUriTemplate(`file:///${"a".repeat(MCP_RESOURCE_URI_MAX_CHARS)}/{p}`))
      .toBe(false);
    expect(isUsableResourceUriTemplate(`file:///poli${String.fromCodePoint(0x200b)}cy/{p}`))
      .toBe(false);
  });

  it("bounds how many variables a form may ask for", () => {
    const ok = Array.from({ length: MCP_RESOURCE_TEMPLATE_MAX_VARIABLES },
      (_, i) => `{v${i}}`).join("/");
    const tooMany = Array.from({ length: MCP_RESOURCE_TEMPLATE_MAX_VARIABLES + 1 },
      (_, i) => `{v${i}}`).join("/");
    expect(isUsableResourceUriTemplate(`file:///${ok}`)).toBe(true);
    expect(isUsableResourceUriTemplate(`file:///${tooMany}`)).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const value of [42, null, undefined, {}, ["file:///{p}"]]) {
      expect(isUsableResourceUriTemplate(value as unknown), String(value)).toBe(false);
    }
  });
});

describe("resourceTemplateVariables", () => {
  it("lists names in declaration order, once each", () => {
    // Repeated variables render once and substitute at every occurrence in first-seen order.
    expect(resourceTemplateVariables("github://repos/{owner}/{repo}/tree/{owner}"))
      .toEqual(["owner", "repo"]);
    expect(resourceTemplateVariables("file:///{path}")).toEqual(["path"]);
  });
});

describe("expandResourceUriTemplate", () => {
  const values = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("fills a template and produces a URI the ordinary predicate accepts", () => {
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "README.md" })))
      .toBe("file:///project/README.md");
    expect(expandResourceUriTemplate(
      "github://repos/{owner}/{repo}/issues/{number}",
      values({ owner: "acme", repo: "widgets", number: "42" }),
    )).toBe("github://repos/acme/widgets/issues/42");
  });

  it("substitutes a repeated variable at every occurrence", () => {
    expect(expandResourceUriTemplate("git://{ref}/diff/{ref}", values({ ref: "HEAD" })))
      .toBe("git://HEAD/diff/HEAD");
  });

  it("cannot be typed out of the segment the server published", () => {
    // Encode traversal, queries, and fragments as segment data.
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "../../etc/passwd" })))
      .toBe("file:///project/..%2F..%2Fetc%2Fpasswd");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "a/b" })))
      .toBe("file:///project/a%2Fb");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "x?q=1" })))
      .toBe("file:///project/x%3Fq%3D1");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "x#frag" })))
      .toBe("file:///project/x%23frag");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "javascript:alert(1)" })))
      .toBe("file:///project/javascript%3Aalert(1)");
  });

  it("cannot be typed into a DOT SEGMENT, which encoding does not touch", () => {
    // Bare dot segments survive encodeURIComponent and need explicit rejection.
    expect(expandResourceUriTemplate(
      "file:///project/{dir}/{name}",
      values({ dir: "..", name: "id_rsa" }),
    )).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: ".." }))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "." }))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "  ..  " })))
      .toBeNull();
    expect(expandResourceUriTemplate(
      "github://repos/{owner}/{repo}/issues/{number}",
      values({ owner: "..", repo: "widgets", number: "42" }),
    )).toBeNull();
    // Validate the finished URI so literals and substitutions cannot compose a dot segment.
    expect(expandResourceUriTemplate("file:///project/.{x}/y", values({ x: "." }))).toBeNull();

    // Check percent-encoded dot variants assembled from server literals and user values.
    expect(expandResourceUriTemplate("file:///project/%{x}/id_rsa", values({ x: "2e." })))
      .toBeNull();
    expect(expandResourceUriTemplate("file:///project/%{x}/id_rsa", values({ x: "2E." })))
      .toBeNull();
    expect(expandResourceUriTemplate("file:///project/.%2{x}/id_rsa", values({ x: "e" })))
      .toBeNull();
    expect(expandResourceUriTemplate("file:///project/%2e%2e/{name}", values({ name: "x" })))
      .toBeNull();
    expect(expandResourceUriTemplate("file:///project/%2{x}/id_rsa", values({ x: "e" })))
      .toBeNull();

    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "..hidden" })))
      .toBe("file:///project/..hidden");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "v1.2.3" })))
      .toBe("file:///project/v1.2.3");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "..." })))
      .toBe("file:///project/...");
  });

  it("refuses a lone surrogate instead of throwing", () => {
    // Pasted text clipped at UTF-16 limits can contain unpaired surrogates; expansion must not throw.
    const clipped = `${"x".repeat(511)}😀`.slice(0, 512);
    expect(clipped.endsWith("\uD83D")).toBe(true);
    expect(expandResourceUriTemplate("file:///p/{path}", values({ path: clipped }))).toBeNull();
    expect(expandResourceUriTemplate("file:///p/{path}", values({ path: "\uDC00" }))).toBeNull();
    expect(expandResourceUriTemplate("file:///p/{path}", values({ path: "😀" })))
      .toBe("file:///p/%F0%9F%98%80");
  });

  it("cannot be typed into a scheme the host reserves", () => {
    // Revalidate expanded schemes: unreserved values in scheme position are not neutralized by encoding.
    expect(isUsableResourceUriTemplate("{scheme}://example.com/{path}")).toBe(true);
    expect(isUsableResourceUriTemplate("{scheme}:alert(1)")).toBe(true);

    expect(expandResourceUriTemplate("{scheme}:alert(1)", values({ scheme: "javascript" })))
      .toBeNull();
    expect(expandResourceUriTemplate("{scheme}://widget/{id}", values({ scheme: "ui", id: "x" })))
      .toBeNull();
    expect(expandResourceUriTemplate("{scheme}:x", values({ scheme: "data" }))).toBeNull();
    // HTTP expansions remain listable; the client rejects host fetches at read time.
    expect(expandResourceUriTemplate("{scheme}://example.com/{path}",
      values({ scheme: "https", path: "r.pdf" }))).toBe("https://example.com/r.pdf");
  });

  it("refuses rather than substituting nothing", () => {
    // Empty expansion can silently select the parent directory and must be refused.
    expect(expandResourceUriTemplate("file:///project/{path}", values({}))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "" }))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "   " }))).toBeNull();
    expect(expandResourceUriTemplate(
      "file:///project/{path}",
      values({ path: "x".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS + 1) }),
    )).toBeNull();
  });

  it("refuses to expand a template it would not have catalogued", () => {
    // Recheck template validity here even when discovery should already have validated it.
    expect(expandResourceUriTemplate("file:///project/{+path}", values({ path: "x" }))).toBeNull();
    expect(expandResourceUriTemplate("ui://widget/{id}", values({ id: "x" }))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/README.md", values({}))).toBeNull();
  });

  it("refuses an expansion that outgrows the URI bound", () => {
    const long = "x".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS);
    const template = `file:///${Array.from({ length: 8 }, (_, i) => `{v${i}}`).join("/")}`;
    const filled = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`v${i}`, long]),
    );
    expect(expandResourceUriTemplate(template, values(filled))).toBeNull();
  });
});
