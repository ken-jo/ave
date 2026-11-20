import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { literalHomeCorpus, WINDOWS_LITERAL_HOMES, windowsDescendantInputs } from "../../__tests__/support/home-redaction-corpus.js";
import { loadHomeRedactors, resetHomeRedactors } from "../../__tests__/support/home-redaction-fixture.js";

afterEach(resetHomeRedactors);

const base = JSON.parse(readFileSync(new URL("./fixtures/home-redaction-base.json", import.meta.url), "utf8")) as {
  revision: string;
  cases: string[][];
  descendants: string[][];
};
const unsupported = JSON.parse(readFileSync(
  new URL("./fixtures/home-redaction-unsupported-concatenations.json", import.meta.url), "utf8",
)) as { cases: Record<string, string[]> };
const corpus = literalHomeCorpus();

it.each(corpus.map((row, index) => ({ ...row, baseline: base.cases[index] })))(
  "matches the pinned base on literal text and paths for $platform $home",
  async ({ platform, home, inputs, baseline }) => {
    const { redactHomePathsInText, redactFsPath } = await loadHomeRedactors(home, platform);
    expect(base.revision).toBe("102440fca");
    expect(baseline).toHaveLength(inputs.length);
    for (const [index, [mode, input, kind]] of inputs.entries()) {
      if (kind === "concatenation") continue;
      const output = mode === "text" ? redactHomePathsInText(input) : redactFsPath(input);
      const upper = platform === "darwin" && input === `${home}/File.txt`.toUpperCase();
      const expected = upper ? (mode === "text" ? "[home]/FILE.TXT" : "<home>/FILE.TXT") : baseline[index];
      expect(output, `${mode} ${JSON.stringify(input)}`).toBe(expected);
    }
  },
);

describe("unsupported home concatenations documented in the redaction contract", () => {
  it.each(corpus.flatMap(({ platform, home, inputs }) => {
    const joined = inputs.filter(([, , kind]) => kind === "concatenation");
    return joined.length ? [{ platform, home, joined }] : [];
  }))("pins the two-copy outputs for $platform $home", async ({ platform, home, joined }) => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
    const expected = unsupported.cases[`${platform}:${home}`];
    expect(expected).toHaveLength(joined.length);
    for (const [index, [, input]] of joined.entries()) {
      expect(redactHomePathsInText(input), input).toBe(expected[index]);
    }
  });

  it.each([
    ["dot-joined drive copies", String.raw`D:\data\habitat`,
      String.raw`D:\data\habitat.D:\data\habitat`, String.raw`D:\data\habitat.[home]`],
    ["dot-joined drive copies with a suffix", String.raw`D:\fixtures\habitat`,
      String.raw`open D:\fixtures\habitat.D:\fixtures\habitat\x now`, String.raw`open D:\fixtures\habitat.[home]\x now`],
    ["dot-joined native and slash copies", String.raw`E:\temp\ted`,
      String.raw`E:\temp\ted.E:/temp/ted`, String.raw`E:\temp\ted.[home]`],
    ["dot-joined Unicode copies", String.raw`C:\Users\Café`,
      String.raw`C:\Users\Café.C:\Users\Café`, "[home]é.[home]"],
    ["dot-joined generic copies", String.raw`C:\Users\bob`,
      String.raw`C:\Users\bob.C:\Users\bob`, "[home][home]"],
    ["a directly joined pair before a dot join", String.raw`C:\Users\bob`,
      String.raw`C:\Users\bobC:\Users\bob.C:\Users\bob`, String.raw`[home]:\Users\bob.[home]`],
    ["four mixed generic copies with a literal suffix", String.raw`C:\Users\bob`,
      String.raw`open C:\Users\bobC:/Users/bobC:\Users\bobC:\Users\bob\x now`, String.raw`open [home]:[home][home][home]\x now`],
    ["four mixed drive copies with a literal suffix", String.raw`D:\fixtures\habitat`,
      String.raw`open D:\fixtures\habitatD:/fixtures/habitatD:\fixtures\habitatD:\fixtures\habitat\x now`,
      String.raw`open D:\fixtures\habitatD:/fixtures/habitatD:\fixtures\habitat[home]\x now`],
    ["adjacent slash copies within a four-copy run", String.raw`D:\fixtures\habitat`,
      String.raw`open D:\fixtures\habitatD:/fixtures/habitatD:/fixtures/habitatD:\fixtures\habitat\x now`, "open [home-token] now"],
    ["a dot join after a literal descendant", String.raw`D:\data\habitat`,
      String.raw`open D:\data\habitat\temp;D:/data/habitat.D:\data\habitat\x now`, "open [home-token] now"],
    ["a file URL followed by a drive copy", String.raw`D:\fixtures\habitat`,
      String.raw`file:///D:/fixtures/habitatD:\fixtures\habitat`, "file:///D:/fixtures/habitat[home]"],
    ["file URLs between native and slash copies", String.raw`C:\Users\bob`,
      String.raw`C:/Users/bobfile:///C:/Users/bobfile:///C:/Users/bobC:\Users\bob`, "[home]://[home]:///[home][home]"],
  ] as const)("pins %s", async (_label, home, input, expected) => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    expect(redactHomePathsInText(input), input).toBe(expected);
  });
});

it.each(WINDOWS_LITERAL_HOMES.map((home, index) => ({ home, baseline: base.descendants[index] })))(
  "keeps every literal descendant byte from the pinned base for $home",
  async ({ home, baseline }) => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
    const inputs = windowsDescendantInputs(home);
    expect(baseline).toHaveLength(180);
    for (const [index, input] of inputs.entries()) {
      expect(redactHomePathsInText(input), input).toBe(baseline[index]);
    }
  },
);

describe("complete source escape spans", () => {
  it("includes an escaped first separator", async () => {
    const { redactHomePathsInText } = await loadHomeRedactors("/srv/fixtures/habitat");
    const input = String.raw`{"p":"\/srv/fixtures/habitat/file","other":1}`;
    const output = redactHomePathsInText(input);
    expect(JSON.parse(output)).toEqual({ p: "[home]/file", other: 1 });
  });
  it("only consumes a JSON escape when the enclosing document parses", async () => {
    const home = "/srv/fixtures/habitat";
    const { redactHomePathsInText } = await loadHomeRedactors(home);
    const escaped = String.raw`\/${home.slice(1)}/file`;
    const prose = `{"p":"${escaped}","other":invalid}`;
    expect(redactHomePathsInText(prose)).toBe(prose.replace(home, "[home]"));
    const nested = JSON.stringify(JSON.stringify({ p: `${home}/file`, other: 1 })).replace(home, `\\${home}`);
    expect(JSON.parse(JSON.parse(nested))).toEqual({ p: `${home}/file`, other: 1 });
    expect(JSON.parse(JSON.parse(redactHomePathsInText(nested)))).toEqual({ p: "[home]/file", other: 1 });
  });
  it("preserves the plain backslash before a generic home inside prose quotes", async () => {
    const { redactHomePathsInText } = await loadHomeRedactors("/srv/fixtures/habitat");
    const input = String.raw`cd "C:\temp\/home/bob/x"`;
    expect(redactHomePathsInText(input)).toBe(String.raw`cd "C:\temp\[home]/x"`);
  });
  it("keeps paired backslashes before a literal home in JSON", async () => {
    const home = "/srv/fixtures/habitat";
    const { redactHomePathsInText } = await loadHomeRedactors(home);
    const prefix = "D:\\fixtures\\";
    for (const input of [
      JSON.stringify({ p: `${prefix}${home}/file`, other: 1 }),
      String.raw`{"p":"D:\\fixtures\\\/${home.slice(1)}/file","other":1}`,
    ]) {
      expect(JSON.parse(input)).toEqual({ p: `${prefix}${home}/file`, other: 1 });
      expect(JSON.parse(redactHomePathsInText(input))).toEqual({ p: `${prefix}[home]/file`, other: 1 });
    }
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

it.each([
  ["D:\\", "D:/", "D:"],
  ["\\\\server\\share\\", "//server/share/", "//server/share"],
] as const)("leaves unsupported Windows root home %s and its descendants unchanged", async (home, slashHome, stem) => {
  const { redactHomePathsInText, redactJudgeText, redactFsPath } = await loadHomeRedactors(home, "win32");
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  for (const p of [
    home, `${stem}"`, `${home}"`, `Open ${home}"`, `Open:"${home}"`,
    `${home}descendant`, `${slashHome}descendant`, `${home}new\\file`,
    `Open:"${home}new\\file"`, `[Open:"${home}new\\file"]`,
  ]) {
    expect(redactHomePathsInText(p)).toBe(p);
    expect(redactJudgeText(p)).toBe(p);
    let serialized = JSON.stringify({ p, other: 1 });
    for (let depth = 1; depth <= 3; depth++) {
      expect(redactHomePathsInText(serialized)).toBe(serialized);
      expect(redactJudgeText(serialized)).toBe(serialized);
      expect(JSON.parse(serializeRuntimeAuditData(serialized) ?? "")).toBe(serialized);
      serialized = JSON.stringify(serialized);
    }
  }
  expect(redactFsPath(`${home}descendant`)).toBe(`${home}descendant`);
});

it.each([
  ["D:\\", "D:/", "D:"],
  ["\\\\srv\\share\\", "//srv/share/", "//srv/share"],
] as const)("leaves Unicode escapes under an unsupported root %s unchanged", async (home, rooted, outside) => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
  for (const prefix of [rooted, outside]) {
    let input = `{"p":"${prefix}\\u00e9/file","other":1}`;
    expect(JSON.parse(input)).toEqual({ p: `${prefix}é/file`, other: 1 });
    expect(redactHomePathsInText(`${prefix}é/file`)).toBe(`${prefix}é/file`);
    for (let depth = 1; depth <= 3; depth++) {
      expect(redactHomePathsInText(input)).toBe(input);
      input = JSON.stringify(input);
    }
  }
  const nativeOutside = `${home.slice(0, -1)}é/file`;
  expect(redactHomePathsInText(nativeOutside)).toBe(nativeOutside);
});

it.each([
  ["linux", "/", "/srv/fixtures/file"],
  ["darwin", "//", "/srv/fixtures/file"],
  ["win32", "D:/./", "D:/fixtures/file"],
  ["win32", "\\\\srv\\share", "\\\\srv\\share\\fixtures\\file"],
] as const)("uses only generic text rules when %s has unsupported root home %s", async (platform, home, path) => {
  const { redactHomePathsInText, redactFsPath } = await loadHomeRedactors(home, platform);
  expect(redactHomePathsInText(path)).toBe(path);
  expect(redactFsPath(path)).toBe(path);
  expect(redactHomePathsInText("C:/Users/sample/a /home/example/b")).toBe("[home]/a [home]/b");
});
