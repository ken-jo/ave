import { afterEach, describe, expect, it } from "vitest";
import { loadHomeRedactors, resetHomeRedactors } from "../../__tests__/support/home-redaction-fixture.js";

afterEach(resetHomeRedactors);

describe("complete source escape spans", () => {
  it("includes an escaped first separator", async () => {
    const { redactHomePathsInText } = await loadHomeRedactors("/srv/fixtures/habitat");
    const input = String.raw`{"p":"\/srv/fixtures/habitat/file","other":1}`;
    const output = redactHomePathsInText(input);
    expect(JSON.parse(output)).toEqual({ p: "[home]/file", other: 1 });
  });
  it("keeps the serialized trailing separator outside the normalized home", async () => {
    const home = "/srv/fixtures/ab\\";
    const { redactHomePathsInText } = await loadHomeRedactors(home);
    for (const suffix of ["", "/file"]) {
      const output = redactHomePathsInText(JSON.stringify({ p: home + suffix, other: 1 }));
      expect(JSON.parse(output)).toEqual({ p: `[home]\\${suffix}`, other: 1 });
    }
  });
});

const homes = [
  ["linux", "/home/habitat"], ["darwin", "/Users/habitat"],
  ["linux", "/home/John Smith"], ["darwin", "/Users/o'brien"],
  ["win32", String.raw`C:\Users\habitat`], ["win32", String.raw`C:\Users\John Smith`],
  ["win32", String.raw`C:\Users\O'Brien (Work)`], ["win32", String.raw`\\srv\share\habitat`],
] as const;

it.each(homes)("preserves nested JSON syntax and idempotence on %s for %s", async (platform, home) => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
  const pieces = [
    "\\/home\\/bob", "/Users/bob", String.raw`C:\\Users\\bob`, "/home/bob/x",
    "file:///Users/bob/a%20b", String.raw`C:\Users\bob\file`, "\\", "\\\\", '"', "'", " ", "%", "&", "x",
    "/", "\\/", "é", "😀", "\\ud83d", "%G1", "&amp;", "[home]", ",", "{", "}", "(", ")", "\n",
    "%2F", "%5C", "\\u0068", "&#47;", home, encodeURIComponent(home), JSON.stringify(home).slice(1, -1),
    home.replace(/[a-z]/u, character => `\\u00${character.charCodeAt(0).toString(16)}`),
    home.replaceAll("/", "&#47;").replaceAll("\\", "&#92;"), `${home}2`, home.toUpperCase(),
  ];
  let seed = 987654;
  const next = (limit: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  const string = (): string => Array.from({ length: 1 + next(8) }, () => pieces[next(pieces.length)]).join("");
  for (let sample = 0; sample < 3000; sample++) {
    let input = JSON.stringify({ p: string(), q: [string(), 1e3], r: { [string()]: string() } });
    for (let layers = 1; layers <= 3; layers++) {
      let output = redactHomePathsInText(input);
      expect(redactHomePathsInText(output), input).toBe(output);
      for (let layer = 1; layer < layers; layer++) output = JSON.parse(output);
      expect(() => JSON.parse(output), input).not.toThrow();
      input = JSON.stringify(input);
    }
  }
});
