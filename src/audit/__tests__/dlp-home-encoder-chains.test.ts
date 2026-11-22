import { afterEach, expect, it } from "vitest";
import { loadHomeRedactors, resetHomeRedactors } from "../../__tests__/support/home-redaction-fixture.js";
import { escapeHtml } from "../../shared/escape-html.js";
import { escapeRegExp } from "../../shared/escape-reg-exp.js";

afterEach(resetHomeRedactors);

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
const utf8 = (c: string) => [...Buffer.from(c, "utf8")];
const encoders = {
  json: (s: string) => JSON.stringify(s).slice(1, -1),
  jsonAscii: (s: string) => JSON.stringify(s).slice(1, -1).split("")
    .map(unit => unit.charCodeAt(0) <= 0x7f ? unit : `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  jsonSlash: (s: string) => JSON.stringify(s).slice(1, -1).replaceAll("/", "\\/"),
  uriComponent: (s: string) => encodeURIComponent(s), uri: (s: string) => encodeURI(s),
  pctLower: (s: string) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  htmlSpecial: (s: string) => s.replace(/[&<>"'/\\]/g, (c) => `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`),
  htmlAll: (s: string) => [...s].map((c) => `&#${c.codePointAt(0)};`).join(""),
  htmlNamed: (s: string) => s.replace(/&/g, "&amp;").replace(/\//g, "&sol;").replace(/\\/g, "&bsol;"),
  hexBytes: (s: string) => [...s].map((c) => (/[A-Za-z0-9 ]/.test(c) ? c : utf8(c).map((b) => `\\x${hex2(b)}`).join(""))).join(""),
};
const html = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&sol;/g, "/").replace(/&bsol;/g, "\\").replace(/&amp;/g, "&");
const decoders = {
  json: (s: string) => JSON.parse(`"${s}"`), jsonAscii: (s: string) => JSON.parse(`"${s}"`), jsonSlash: (s: string) => JSON.parse(`"${s}"`),
  uriComponent: decodeURIComponent, uri: decodeURI, pctLower: decodeURIComponent,
  htmlSpecial: html, htmlAll: html, htmlNamed: html,
  hexBytes: (s: string) => s.replace(/(?:\\x[0-9A-F]{2})+/g, (m) => Buffer.from(m.split("\\x").slice(1).map((h) => parseInt(h, 16))).toString("utf8")),
};
const homes = [
  ["linux", "/srv/fixtures/habitat", "/"], ["linux", "/srv/fixtures/김 철수", "/"], ["linux", "/srv/fixtures/O'Brien", "/"], ["linux", "/srv/fixtures/a&b", "/"],
  ["win32", "D:\\fixtures\\habitat", "\\"], ["win32", "\\\\server\\share\\habitat", "\\"], ["win32", "C:\\Users\\Demo Smith", "\\"], ["win32", "C:\\Users\\김철수", "\\"], ["win32", "D:\\fixtures\\a𐐀b", "\\"],
] as const;

type Encoder = keyof typeof encoders;
const names = Object.keys(encoders) as Encoder[];
const chains: Encoder[][] = [[]];
for (let length = 1; length <= 3; length++) {
  for (const previous of chains.filter(chain => chain.length === length - 1)) {
    for (const encoder of names) chains.push([...previous, encoder]);
  }
}

it.each(homes)("redacts chained encoder output on %s for %s", async (platform, home, separator) => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
  const anchor = home.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const retained: string[] = [];
  let count = 0;
  for (const chain of chains) {
    const encoded = chain.reduce((value, name) => encoders[name](value), `${home}${separator}file.txt`);
    for (const wrapper of chain.length < 3 ? ["sentence", "json"] : ["sentence"]) {
      const subject = wrapper === "json" ? JSON.stringify({ p: encoded, q: 1 }) : `see ${encoded} now`;
      const output = redactHomePathsInText(subject);
      let inner: string;
      if (wrapper === "json") {
        const parsed = JSON.parse(output) as { p: string; q: number };
        expect(parsed.q).toBe(1);
        inner = parsed.p;
      } else {
        inner = output.slice(4, -4);
      }
      for (const name of [...chain].reverse()) {
        try { inner = decoders[name](inner); } catch { /* A marker can replace the encoded layer. */ }
      }
      if (output.toLowerCase().includes(anchor) || inner.toLowerCase().includes(anchor)) {
        expect(output).toBe(subject);
        retained.push(`${chain.join(">")} ${wrapper}`);
      }
      count++;
    }
  }
  expect(count).toBe(1222);
  expect(retained).toEqual([]);
});

it.each([
  ["linux", "/srv/fixtures/é&sol;x"],
  ["win32", "D:/fixtures/é&sol;x"],
  ["win32", "D:\\fixtures\\é&sol;x"],
] as const)("keeps literal entity syntax while detecting a URI-encoded home on %s for %s", async (platform, home) => {
  const { redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home, platform);
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  const path = `${home}/file`;
  let input = path;
  for (let layers = 1; layers <= 3; layers++) {
    input = encodeURI(input);
    let recovered = input;
    for (let count = 0; count < layers; count++) recovered = decodeURI(recovered);
    expect(recovered).toBe(path);
    expect(redactHomePathsInText(input)).toBe("[home-token]");
    expect(redactJudgeText(input)).toBe("[home-token]");
    expect(serializeRuntimeAuditData({ p: input })).toBe('{"p":"[home-token]"}');
  }
  expect(redactHomePathsInText(encodeURI(input))).toBe(encodeURI(input));
});

it("keeps literal percent syntax while detecting an entity-encoded home", async () => {
  const home = "/srv/fixtures/é%41";
  const { redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home);
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  let input = "/srv/fixtures/&#233;%41/file";
  for (let layers = 1; layers <= 3; layers++) {
    expect(redactHomePathsInText(input)).toBe("[home-token]");
    expect(redactJudgeText(input)).toBe("[home-token]");
    expect(serializeRuntimeAuditData({ p: input })).toBe('{"p":"[home-token]"}');
    input = input.replaceAll("&", "&amp;");
  }
  expect(redactHomePathsInText(input)).toBe(input);
});

it.each([String.raw`C:\Users\bob`, String.raw`E:\temp\ted`])("redacts percent encoding inside two JSON layers for %s", async home => {
  const { redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home, "win32");
  for (const encode of [encodeURIComponent, encodeURI]) {
    for (const suffix of ["", String.raw`\docs\file.txt`]) {
      const input = JSON.stringify(JSON.stringify({ p: encode(home + suffix), other: 1 }));
      const expected = JSON.stringify(JSON.stringify({ p: "[home-token]", other: 1 }));
      expect(redactHomePathsInText(input)).toBe(expected);
      expect(redactJudgeText(input)).toBe(expected);
    }
  }
});

const wrappedEncoders = {
  string: { encode: (text: string) => JSON.stringify(text), decode: (text: string) => JSON.parse(text) as string, json: true },
  object: {
    encode: (text: string) => JSON.stringify({ p: text, other: 1 }),
    decode: (text: string) => {
      const parsed = JSON.parse(text) as { p: string; other: number };
      expect(parsed.other).toBe(1);
      return parsed.p;
    },
    json: true,
  },
  ascii: {
    encode: (text: string) => `"${encoders.jsonAscii(text)}"`,
    decode: (text: string) => JSON.parse(text) as string, json: true,
  },
  component: { encode: encodeURIComponent, decode: decodeURIComponent, json: false },
  uri: { encode: encodeURI, decode: decodeURI, json: false },
  html: {
    encode: (text: string) => escapeHtml(text).replace(/[\u0080-\u{10ffff}]/gu, character => `&#${character.codePointAt(0)};`),
    decode: (text: string) => html(text.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">")),
    json: false,
  },
};

type WrappedEncoder = keyof typeof wrappedEncoders;
const wrapperNames = Object.keys(wrappedEncoders) as WrappedEncoder[];
const wrappedChains = wrapperNames.flatMap(a => [
  [a], ...wrapperNames.flatMap(b => [[a, b], ...wrapperNames.map(c => [a, b, c])]),
]);

const separatorMatrixEncoders = {
  ...wrappedEncoders,
  array: {
    encode: (text: string) => JSON.stringify([1, text]),
    decode: (text: string) => {
      const [retained, value] = JSON.parse(text) as [number, string];
      expect(retained).toBe(1);
      return value;
    },
    json: true,
  },
  slash: { encode: (text: string) => `"${encoders.jsonSlash(text)}"`, decode: wrappedEncoders.string.decode, json: true },
  hexEntity: { encode: (text: string) => escapeHtml(text).replace(/[\u0080-\u{10ffff}]/gu, c => `&#x${c.codePointAt(0)?.toString(16)};`), decode: wrappedEncoders.html.decode, json: false },
  hexUtf8: { encode: (text: string) => utf8(text).map(byte => byte < 0x80 ? String.fromCharCode(byte) : `\\x${hex2(byte)}`).join(""), decode: decoders.hexBytes, json: false },
};

type SeparatorEncoder = keyof typeof separatorMatrixEncoders;
const separatorNames = Object.keys(separatorMatrixEncoders) as SeparatorEncoder[];
const separatorChains: SeparatorEncoder[][] = [[], ...separatorNames.flatMap(a => [
  [a], ...separatorNames.flatMap(b => [[a, b], ...separatorNames.map(c => [a, b, c])]),
])];
const uriChains = separatorChains.filter(chain => chain.includes("uri"));

it.each([
  [String.raw`D:\data\Café`, String.raw`\ucafe\a.txt`],
  [String.raw`\\srv\share\Café`, String.raw`\docs\a.txt`],
  [String.raw`D:\fixtures\Café`, String.raw`\docs\a.txt`],
  [String.raw`E:\temp\tëd`, String.raw`\docs\a.txt`],
  [String.raw`C:\Users\demoçois`, String.raw`\docs\a.txt`],
  [String.raw`C:\Users\bobás`, String.raw`\docs\a.txt`],
  [String.raw`C:\Users\demoée`, String.raw`\docs\a.txt`],
  [String.raw`C:\Users\yúñez`, String.raw`\docs\a.txt`],
  [String.raw`C:\Users\bazörn`, String.raw`\docs\a.txt`],
] as const)("redacts hexadecimal UTF-8 without decoding native separators in %s", async (home, suffix) => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
  const path = `${home}${suffix}`;
  const bytes = separatorMatrixEncoders.hexUtf8.encode(path);
  expect(decoders.hexBytes(bytes)).toBe(path);
  const lower = bytes.replace(/\\x[\dA-F]{2}/gu, byteEscape => byteEscape.toLowerCase());
  const value = `open ${bytes} now`;
  for (const [input, expected] of [
    [`open ${lower} now`, "open [home-token] now"],
    [encodeURI(value), "[home-token]"],
    [encodeURIComponent(value), "[home-token]"],
    [JSON.stringify({ p: value, retained: 1 }), '{"p":"open [home-token] now","retained":1}'],
    [JSON.stringify({ p: encodeURI(value), retained: 1 }), '{"p":"[home-token]","retained":1}'],
    [encodeURI(JSON.stringify(value)), "[home-token]"],
  ] as const) expect(redactHomePathsInText(input), input).toBe(expected);
});

it.each([String.raw`\\srv\share\Café`, String.raw`D:\fixtures\Café`, String.raw`E:\temp\tëd`, String.raw`\\srv\share\CafÃ©`])(
  "redacts hexadecimal code units without decoding native separators in %s", async home => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    const units = home.replace(/[\u0080-\u00ff]/gu, character => `\\x${hex2(character.charCodeAt(0))}`);
    expect(redactHomePathsInText(`open ${units}\\docs now`)).toBe("open [home-token] now");
    expect(redactHomePathsInText(encodeURI(units))).toBe("[home-token]");
  },
);

function expectMixedToken(
  redact: (text: string) => string, home: string, input: string, chain: readonly SeparatorEncoder[] = [],
): void {
  const account = home.split("\\").at(-1)?.toLowerCase() ?? "";
  // JSON outside the opaque token still parses at every layer.
  const outer = JSON.stringify({ p: JSON.stringify({ value: input, retained: 1 }), retained: 2 });
  const parsed = JSON.parse(redact(outer)) as { p: string; retained: number };
  const inner = JSON.parse(parsed.p) as { value: string; retained: number };
  expect(parsed.retained).toBe(2);
  expect(inner.retained).toBe(1);
  let output = redact(input);
  for (const name of chain.toReversed()) {
    const codec = separatorMatrixEncoders[name];
    if (!codec.json) break;
    output = codec.decode(output);
  }
  for (const result of [output, inner.value]) {
    expect(result.match(/\[home-token\]/gu), input).toEqual(["[home-token]"]);
    expect(result).not.toContain("[home]");
    expect(result.toLowerCase()).not.toContain(account);
  }
}

const listingSeparators = ["\n", "\r\n", "\b", "\f", "\u0001", "\t"];
const jsonValueCodecs = ["string", "object", "array", "ascii"] as const;
const controlRunChains: SeparatorEncoder[][] = jsonValueCodecs.flatMap(first =>
  [...jsonValueCodecs, "uri" as const].map<SeparatorEncoder[]>(next => [first, next, "uri"]));

it.each([String.raw`C:\Users\bob`, String.raw`D:\fixtures\habitat`, String.raw`E:\temp\ted`, String.raw`\\srv\share\habitat`])(
  "redacts a whole mixed token after slash runs for %s", async home => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    const slashHome = home.replaceAll("\\", "/");
    expect(controlRunChains).toHaveLength(20);
    for (const separator of listingSeparators) {
      for (const directory of ["b", "f"]) {
        const listing = `copy${separator}${home}\\${directory}${separator}${slashHome}/a`;
        for (const chain of controlRunChains) {
          const input = chain.reduce((text, codec) => separatorMatrixEncoders[codec].encode(text), listing);
          expectMixedToken(redactHomePathsInText, home, input, chain);
        }
      }
    }
  },
);

const uncListingChains = uriChains.filter(chain => {
  const json = chain.findIndex(codec => separatorMatrixEncoders[codec].json);
  return json >= 0 && json < chain.indexOf("uri") && !chain.includes("slash") && !chain.includes("component");
});

it.each([String.raw`\\srv\share\habitat`, String.raw`\\srv\share\bob`])(
  "redacts whole mixed tokens in UNC listings for %s", async home => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    const literal = `${home.replaceAll("\\", "/")}/a`;
    expect(uncListingChains).toHaveLength(76);
    for (const separator of listingSeparators) {
      const encoded = `${home}\\c`;
      for (const listing of [
        `${literal}${separator}${encoded}`, `${literal}${separator}${encoded}${separator}${home}\\d`,
        `x${separator}${home}\\b${separator}${literal}${separator}${encoded} y`,
      ]) {
        for (const chain of uncListingChains) {
          const input = chain.reduce((text, codec) => separatorMatrixEncoders[codec].encode(text), listing);
          expectMixedToken(redactHomePathsInText, home, input, chain);
        }
      }
    }
  },
);

it.each(["D:\\fixtures\\habitat", "\\\\srv\\share\\habitat", "C:\\Users\\Demo Smith", "C:\\Users\\Bobé", "E:\\temp\\ted"])(
  "redacts both encoded homes before a literal home for %s", async home => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    const parts = home.replace(/^[a-z]:/iu, "").split(/\\+/u).filter(Boolean).map(escapeRegExp);
    const tail = new RegExp(String.raw`[\\/]+${parts.join(String.raw`[\\/]+`)}(?![\p{L}\p{N}_-])`, "iu");
    const slashHome = home.replaceAll("\\", "/");
    const exposures: string[] = [];
    let count = 0;
    for (const separator of listingSeparators) {
      const listing = [`${home}\\b`, `${home}\\c`, `${slashHome}/a`].join(separator);
      for (const chain of separatorChains) {
        const input = chain.reduce((text, codec) => separatorMatrixEncoders[codec].encode(text), listing);
        const output = redactHomePathsInText(input);
        let inverted = "";
        try {
          inverted = chain.toReversed().reduce((text, codec) => separatorMatrixEncoders[codec].decode(text), output);
        } catch {
          // A whole encoded token can include a wrapper encoded on an inner layer.
        }
        if (tail.test(output) || tail.test(inverted)) exposures.push(`${chain.join(">")} ${JSON.stringify(separator)}: ${output}`);
        count++;
      }
    }
    expect(count).toBe(6_666);
    expect(exposures.length, exposures.slice(0, 4).join("\n")).toBe(0);
  },
);

it.each(["C:\\Users\\bob", "D:\\fixtures\\habitat"])(
  "redacts a whole mixed token containing a literal download suffix for %s", async home => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    const literal = `${home.replaceAll("\\", "/")}/Downloads`;
    for (const separator of ["\n", "\t", "\r\n"]) {
      const next = separator === "\r\n" ? [`${home}\\Documents`, `${home}\\Music`].join(separator) : `${home}\\Documents`;
      for (const wrap of [wrappedEncoders.string.encode, wrappedEncoders.object.encode, (text: string) => JSON.stringify(JSON.stringify(text))]) {
        const input = encodeURI(wrap(`${literal}${separator}${next}`));
        expectMixedToken(redactHomePathsInText, home, input);
      }
    }
  },
);

it.each([String.raw`D:\fixtures\habitat`, String.raw`\\srv\share\habitat`, String.raw`E:\temp\ted`])(
  "redacts whole mixed tokens through three layers for %s", async home => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    const slashHome = home.replaceAll("\\", "/");
    for (const [before, suffix, after, descendant] of [
      ["", "/one", "?from=", "two"], ["", "/one", " ", "two"], ["copy ", "/a", " ", "b"],
    ] as const) {
      const literalPath = slashHome + suffix;
      let count = 0;
      for (const chain of uriChains) {
        const encode = (value: string) => chain.reduce((text, codec) => separatorMatrixEncoders[codec].encode(text), value);
        const prefix = before + literalPath + after;
        const input = encode(`${prefix}${home}\\${descendant}`);
        if (!input.includes(literalPath)) continue;
        count++;
        expectMixedToken(redactHomePathsInText, home, input, chain);
      }
      expect(count).toBe(185);
    }
  },
);

it("replaces the whole encoded object token while preserving an outer JSON layer", async () => {
  const home = String.raw`E:\temp\ted`;
  const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
  const value = { p: `${home}\\docs\\file.txt`, other: 1 };
  const encoded = encodeURIComponent(JSON.stringify(value));
  expect(JSON.parse(decodeURIComponent(encoded))).toEqual(value);
  expect(redactHomePathsInText(encoded)).toBe("[home-token]");
  const outer = JSON.stringify({ payload: encoded, retained: 2 });
  const output = redactHomePathsInText(outer);
  expect(output).not.toContain(home);
  expect(JSON.parse(output)).toEqual({ payload: "[home-token]", retained: 2 });
});

function invertWrappedChain(text: string, chain: readonly WrappedEncoder[]): string {
  let insideNonJson = false;
  for (const name of chain.toReversed()) {
    const codec = wrappedEncoders[name];
    try {
      text = codec.decode(text);
    } catch (error) {
      // A token outside the innermost JSON can include that JSON's syntax.
      if (insideNonJson && text.includes("[home-token]")) return text;
      throw error;
    }
    insideNonJson ||= !codec.json;
  }
  return text;
}

it.each([String.raw`C:\Users\bob`, String.raw`E:\temp\ted`])("redacts with JSON object wrappers at any encoder position for %s", async home => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
  const path = `${home}\\docs\\file.txt`;
  const account = home.split("\\").at(-1) ?? "";
  expect(wrappedChains).toHaveLength(258);
  for (const chain of wrappedChains) {
    const input = chain.reduce((value, name) => wrappedEncoders[name].encode(value), path);
    expect(invertWrappedChain(input, chain), chain.join(" > ")).toBe(path);
    const output = redactHomePathsInText(input);
    expect(output, chain.join(" > ")).not.toContain(account);
    expect(invertWrappedChain(output, chain), chain.join(" > ")).not.toContain(account);
  }
});

it.each([
  ["win32", String.raw`D:\data\Café`], ["win32", String.raw`E:\temp\tëd`],
  ["win32", String.raw`\\srv\share\Café`], ["win32", String.raw`C:\Users\Bobé`], ["linux", "/srv/fixtures/Café"],
] as const)("redacts decoded-only homes before escape-like descendants on %s for %s", async (platform, home) => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
  const separator = platform === "win32" ? "\\" : "/";
  const account = home.split(separator).at(-1) ?? "";
  let count = 0;
  for (const name of ["x64", "new", "u0032", "tab", "file"]) {
    const path = [home, name, "file"].join(separator);
    for (const value of [path, `Open:"${path}"`, `[Open:"${path}"]`]) {
      for (const initial of ["ascii", "component", "html"] as const) {
        const chain: WrappedEncoder[] = [initial];
        let input = wrappedEncoders[initial].encode(value);
        for (let depth = 1; depth <= 3; depth++) {
          expect(invertWrappedChain(input, chain)).toBe(value);
          const output = redactHomePathsInText(input);
          expect(output, input).not.toBe(input);
          expect(invertWrappedChain(output, chain), input).not.toContain(account);
          count++;
          input = JSON.stringify(input);
          chain.push("string");
        }
      }
    }
  }
  expect(count).toBe(135);
});

const jsSourceHomes = [
  ["linux", "/srv/fixtures/Â©"],
  ["win32", "D:\\fixtures\\Â©"],
  ["win32", "\\\\srv\\share\\Â©"],
] as const;

it.each(jsSourceHomes)("redacts hexadecimal code units and UTF-8 bytes on %s for %s", async (platform, home) => {
  const { redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home, platform);
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  const prefix = JSON.stringify(home.slice(0, -2)).slice(1, -1);
  for (const account of [String.raw`\xC2\xA9`, String.raw`\xC3\x82\xC2\xA9`]) {
    let input = `"${prefix}${account}/file"`;
    let expected = '"[home-token]"';
    for (let depth = 1; depth <= 3; depth++) {
      expect(redactHomePathsInText(input), input).toBe(expected);
      expect(redactJudgeText(input), input).toBe(expected);
      expect(JSON.parse(serializeRuntimeAuditData(input) ?? ""), input).toBe(expected);
      input = JSON.stringify(input);
      expected = JSON.stringify(expected);
    }
  }
});

it.each(jsSourceHomes)("leaves unsupported braced Unicode and octal source escapes unchanged on %s for %s", async (platform, home) => {
  const { redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home, platform);
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  const prefix = JSON.stringify(home.slice(0, -2)).slice(1, -1);
  for (const account of [String.raw`\u{C2}\u{0000a9}`, String.raw`\302\251`]) {
    let input = `"${prefix}${account}/file"`;
    for (let depth = 1; depth <= 3; depth++) {
      expect(redactHomePathsInText(input)).toBe(input);
      expect(redactJudgeText(input)).toBe(input);
      expect(JSON.parse(serializeRuntimeAuditData(input) ?? "")).toBe(input);
      input = JSON.stringify(input);
    }
  }
});

it("leaves unsupported braced astral escape spellings unchanged", async () => {
  const { redactHomePathsInText } = await loadHomeRedactors("/srv/fixtures/🚀");
  for (const input of [String.raw`"/srv/fixtures/\u{1F680}/file"`, String.raw`"/srv/fixtures/\u{11F680}/file"`]) {
    expect(redactHomePathsInText(input)).toBe(input);
  }
});
