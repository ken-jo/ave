/** Resource URIs identify server-owned data; the host must not resolve them or grant UI-serving semantics. */
import { describe, expect, it } from "vitest";
import { isUsableMcpServerId, MAX_SERVER_ID_LEN } from "../mcp-app-partition.js";
import { stagedOriginFor } from "../staged-origins.js";
import {
  hasUnsafeUriChars,
  isHostFetchRefusedUri,
  isUsableResourceUri,
  MCP_RESOURCE_DESCRIPTION_MAX_CHARS,
  MCP_RESOURCE_NAME_MAX_CHARS,
  MCP_RESOURCE_URI_MAX_CHARS,
  usableResourceText,
} from "../mcp-resource-bounds.js";

describe("isUsableResourceUri", () => {
  it("accepts the schemes the spec names plus server-custom ones", () => {
    for (const uri of [
      "file:///project/src/main.rs",
      "git://repo/HEAD",
      "https://example.com/doc",
      "schema://users",
      "issue://123",
      "acme-internal://records/42",
      "x:y",
    ]) {
      expect(isUsableResourceUri(uri), uri).toBe(true);
    }
  });

  it("refuses schemes the host reserves for other meanings", () => {
    for (const uri of [
      "ui://widget/main.html",
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "blob:http://x/y",
      "vbscript:msgbox",
      "about:blank",
      "UI://Widget",
      "JavaScript:alert(1)",
    ]) {
      expect(isUsableResourceUri(uri), uri).toBe(false);
    }
  });

  it("refuses shapes that are not a URI at all", () => {
    for (const uri of [
      "",
      "no-scheme-here",
      "/absolute/path",
      "./relative",
      "9lives:x",
      `file://${"a".repeat(MCP_RESOURCE_URI_MAX_CHARS)}`,
      42,
      null,
      undefined,
      { uri: "file:///x" },
    ]) {
      expect(isUsableResourceUri(uri as unknown), String(uri).slice(0, 40)).toBe(false);
    }
  });

  it("refuses a control character anywhere in the URI", () => {
    // Reject newlines and NUL because URIs enter audit records and labels.
    expect(isUsableResourceUri("file:///a\u0000b")).toBe(false);
    expect(isUsableResourceUri("file:///a\nb")).toBe(false);
    expect(isUsableResourceUri("file:///a\u007fb")).toBe(false);
  });

  // Reject raw fence-breaking characters; percent-encoded forms remain valid.
  it("refuses characters RFC 3986 excludes, so no consumer has to escape them", () => {
    for (const uri of [
      'doc:x"></mcp-resource> injected',
      "doc:x<script>",
      "doc:x>y",
      "file:///a b",
      "file:///a\\b",
      "doc:x`y",
      "doc:x{y}",
      "doc:x|y",
      "doc:x^y",
    ]) {
      expect(isUsableResourceUri(uri), uri.slice(0, 40)).toBe(false);
    }
    expect(isUsableResourceUri("doc:x%22y")).toBe(true);
    expect(isUsableResourceUri("file:///a%20b")).toBe(true);
  });

  it("cannot be tricked by a path that looks like a scheme", () => {
    expect(isUsableResourceUri("some/path:with-colon")).toBe(false);
  });

  // Sample the shared invisible class independently of any hand-enumerated implementation.
  it("refuses invisible and reordering characters, sampling the class", () => {
    const invisibles = [
      0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x180b, 0x180e,
      0x200b, 0x200e, 0x2065, 0x202e, 0x2066, 0x3164, 0xfe0f, 0xffa0,
      0xe0001, 0xe0041,
    ];
    for (const codePoint of invisibles) {
      const uri = `file:///poli${String.fromCodePoint(codePoint)}cy.md`;
      expect(isUsableResourceUri(uri), codePoint.toString(16)).toBe(false);
    }
    expect(isUsableResourceUri("file:///poli%E2%80%AEcy.md")).toBe(true);
  });

  it("still catalogues legitimate non-ASCII paths", () => {
    // Preserve ordinary non-ASCII paths while rejecting invisible spoofing characters.
    expect(isUsableResourceUri("file:///Users/example/문서/정상.md")).toBe(true);
    expect(isUsableResourceUri("file:///docs/年度報告.pdf")).toBe(true);
    expect(isUsableResourceUri("file:///docs/café-résumé.txt")).toBe(true);
  });

  it("refuses an emoji variation selector and a ZWJ sequence, the cost of one class", () => {
    // Reject variation selectors in identifiers because they can make distinct URIs look identical.
    const VS16 = String.fromCodePoint(0xfe0f);
    const ZWJ = String.fromCodePoint(0x200d);
    expect(isUsableResourceUri(`file:///docs/❤${VS16}notes.md`)).toBe(false);
    expect(isUsableResourceUri(`file:///docs/a${ZWJ}b.md`)).toBe(false);
  });
});

describe("isHostFetchRefusedUri", () => {
  it("refuses to fetch https, which the spec reserves for direct client access", () => {
    // Listing an HTTP URI does not authorize the host to fetch a server-selected destination.
    expect(isHostFetchRefusedUri("https://example.com/doc")).toBe(true);
    expect(isHostFetchRefusedUri("HTTPS://EXAMPLE.COM")).toBe(true);
    expect(isHostFetchRefusedUri("file:///x")).toBe(false);
    expect(isHostFetchRefusedUri("git://x")).toBe(false);
  });
});

describe("usableResourceText", () => {
  it("trims, bounds, and rejects unusable values", () => {
    expect(usableResourceText("  main.rs  ", MCP_RESOURCE_NAME_MAX_CHARS)).toBe("main.rs");
    expect(usableResourceText("", MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
    expect(usableResourceText("   ", MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
    expect(usableResourceText(42 as unknown, MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
    expect(usableResourceText("a\u0000b", MCP_RESOURCE_NAME_MAX_CHARS)).toBeUndefined();
  });

  it("truncates to the caller's bound", () => {
    const long = "x".repeat(MCP_RESOURCE_DESCRIPTION_MAX_CHARS + 100);
    expect(usableResourceText(long, MCP_RESOURCE_DESCRIPTION_MAX_CHARS)?.length).toBe(
      MCP_RESOURCE_DESCRIPTION_MAX_CHARS,
    );
  });
});

describe("isUsableMcpServerId", () => {
  it("is the ONE rule for a server id, independent of the envelope pattern", () => {
    // Server-id syntax is independent of provenance envelope syntax; test compatibility explicitly.
    for (const ok of ["hr-mcp", "com.example.thing", "a", "A0._-", "x".repeat(MAX_SERVER_ID_LEN)]) {
      expect(isUsableMcpServerId(ok), ok.slice(0, 24)).toBe(true);
    }
    const tooLong = "x".repeat(MAX_SERVER_ID_LEN + 1);
    for (const bad of ["", "-leading", ".leading", "has space", tooLong, "unicode✓", 42, null]) {
      expect(isUsableMcpServerId(bad as unknown), String(bad).slice(0, 24)).toBe(false);
    }
  });

  it("agrees with the envelope source patterns that carry a server id", () => {
    const cases = [
      "hr-mcp",
      "com.example.thing",
      "a",
      "A0._-",
      "x".repeat(MAX_SERVER_ID_LEN),
      "",
      "-leading",
      "has space",
      "x".repeat(MAX_SERVER_ID_LEN + 1),
      "unicode✓",
      // Include a trailing newline so adding multiline regex mode cannot silently split the validators.
      "a\n",
    ];
    for (const id of cases) {
      const usable = isUsableMcpServerId(id);
      for (const [origin, prefix] of [
        ["mcp-prompt-emitted", "mcp-prompt"],
        ["app-emitted", "app"],
      ] as const) {
        const kind = stagedOriginFor(origin);
        expect(kind.sourcePattern.test(`${prefix}:${id}`), `${origin} / ${id.slice(0, 24)}`)
          .toBe(usable);
      }
    }
  });
});

/** `U+XXXX` for an assertion label, so a failure names the codepoint not the glyph. */
function label(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

describe("hasUnsafeUriChars — the composition, arm by arm", () => {
  // Probe each rule’s unique contribution; union-based fixtures cannot detect a missing arm.
  // Derive class samples from the actual composition, not a hand-transcribed mirror.

  it("refuses what ONLY the RFC 3986 arm catches", () => {
    // Whitespace uniquely covers tabs, line breaks, and spaces admitted by the prose invisible class.
    for (const cp of [
      0x0020, 0x0022, 0x003c, 0x003e, 0x005c, 0x005e, 0x0060, 0x007b, 0x007c, 0x007d,
      0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
      0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
    ]) {
      expect(hasUnsafeUriChars(`a${String.fromCodePoint(cp)}b`), label(cp)).toBe(true);
    }
  });

  it("refuses what ONLY the invisible/reordering arm catches", () => {
    // Sample C1, format, variation-selector, and astral-tag members unique to the invisible class.
    for (const cp of [
      0x0080, 0x00ad, 0x034f, 0x061c, 0x115f, 0x180e, 0x2060, 0x2064,
      0x200b, 0x202e, 0xfe0f, 0xfeff, 0xe0001, 0xe0041,
    ]) {
      expect(hasUnsafeUriChars(`a${String.fromCodePoint(cp)}b`), label(cp)).toBe(true);
    }
  });

  // Control characters add no unique matches; do not claim distinguishable coverage for that redundant arm.

  it("accepts what none of the arms catches", () => {
    // Keep ordinary non-ASCII identifiers as positive controls.
    for (const value of ["plain", "a-b_c.d~e", "%E1%84%92", "카드", "日本語", "v1.2.3"]) {
      expect(hasUnsafeUriChars(value), value).toBe(false);
    }
  });
});
