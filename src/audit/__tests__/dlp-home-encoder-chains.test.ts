import { afterEach, expect, it } from "vitest";
import { loadHomeRedactors, resetHomeRedactors } from "../../__tests__/support/home-redaction-fixture.js";

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
  ["win32", "D:\\fixtures\\habitat", "\\"], ["win32", "\\\\server\\share\\habitat", "\\"], ["win32", "C:\\Users\\John Smith", "\\"], ["win32", "C:\\Users\\김철수", "\\"], ["win32", "D:\\fixtures\\a𐐀b", "\\"],
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
  // These sequences merge a native Windows separator with a unicode escape
  // when percent and entity syntax are peeled together.
  const expected = home === String.raw`C:\Users\김철수` || home === String.raw`D:\fixtures\a𐐀b`
    ? ["htmlSpecial>jsonAscii>uri sentence", "htmlNamed>jsonAscii>uri sentence"] : [];
  expect(retained).toEqual(expected);
});
