import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import { loadHomeRedactors, resetHomeRedactors } from "../../__tests__/support/home-redaction-fixture.js";

afterEach(() => {
  vi.doUnmock("node:url");
  resetHomeRedactors();
});

type Platform = "linux" | "darwin" | "win32";

interface HomeProbe {
  name: string;
  home: string;
  platform: Platform;
  input: string;
  expected: string;
  json?: boolean;
}

const POSIX_ROOT = "/srv/fixtures/";
const WINDOWS_ROOT = "D:/fixtures/";
const POSIX_HOME = `${POSIX_ROOT}habitat`;
const WINDOWS_HOME = `${WINDOWS_ROOT}habitat`;
const UNC_HOME = String.raw`\\server\share\habitat`;
const ASTRAL_HOME = "D:/fixtures/a𐐀b/habitat";
const TOKEN = "[home-token]";
const probes: HomeProbe[] = [];

function add(name: string, home: string, input: string, expected = input, platform: Platform = "linux", json = false): void {
  probes.push({ name, home, platform, input, expected, json });
}

const COMMAND_HOME = String.raw`E:\temp\ted`;
add("literal Windows home in a quoted command", COMMAND_HOME,
  `cd "${COMMAND_HOME}\\repo" && ls`, 'cd "[home]\\repo" && ls', "win32");
const BRACKETED_PATH = `[Open:"${COMMAND_HOME}\\new\\file"]`;
add("literal Windows home in serialized bracketed prose", COMMAND_HOME,
  JSON.stringify({ p: BRACKETED_PATH, other: 1 }), JSON.stringify({ p: '[Open:"[home]\\new\\file"]', other: 1 }), "win32", true);
add("literal Windows home before an escape-like directory name", WINDOWS_HOME,
  `run "${win32.normalize(WINDOWS_HOME)}\\x64\\tool.exe"`, 'run "[home]\\x64\\tool.exe"', "win32");
add("literal Windows home in prose with mixed separators", win32.normalize(WINDOWS_HOME),
  String.raw`Open:"D:/fixtures/habitat\u0032\file"`, String.raw`Open:"[home]\u0032\file"`, "win32");
const MIXED_PATH_LIST = encodeURI(`${WINDOWS_HOME}/one;${win32.normalize(WINDOWS_HOME)}\\two`);
add("keeps a literal suffix before a separate encoded path", WINDOWS_HOME, MIXED_PATH_LIST, "[home]/one;[home-token]", "win32");
add("keeps a literal suffix and its entity before a separate encoded path", WINDOWS_HOME,
  MIXED_PATH_LIST.replace("/one;", "/one&amp;;"), "[home]/one&amp;;[home-token]", "win32");

for (const { character, tail, count } of [
  { character: '"', tail: '"' }, { character: "\n", tail: "n" }, { character: "\t", tail: "t" },
  { character: "\b", tail: "b" }, { character: "\f", tail: "f" }, { character: "\r", tail: "r" },
  { character: "\\", tail: "", count: 16 },
]) {
  add(`unsupported home character ${JSON.stringify(character)}`, `${POSIX_ROOT}a${character}b`, `${POSIX_ROOT}a${"\\".repeat(count ?? 8)}${tail}b/file`);
}
for (const units of [["ud83d", "ude00"], ["xF0", "x9F", "x98", "x80"]]) {
  const encoded = units.map(unit => `${"\\".repeat(16)}${unit}`).join("");
  add(`astral encoding past the layer limit ${units.join()}`, `${POSIX_ROOT}a😀b`, `${POSIX_ROOT}a${encoded}b/file`);
}
for (const { name, units } of [
  { name: "kit", units: ["u212a"] }, { name: "sit", units: ["u017f"] },
  { name: "σit", units: ["u03c2"] }, { name: "kit", units: ["xE2", "x84", "xAA"] },
]) {
  const encoded = units.map(unit => `${"\\".repeat(16)}${unit}`).join("");
  const input = `${WINDOWS_ROOT}${encoded}it/file`;
  add(`case alias past the layer limit ${units.join()}`, WINDOWS_ROOT + name, input, input, "win32");
}
let beyondLimit = POSIX_HOME;
for (let layer = 0; layer < 4; layer++) beyondLimit = encodeURIComponent(beyondLimit);
add("an otherwise complete home beyond three layers", POSIX_HOME, beyondLimit);
for (const input of [`${"\\".repeat(128)}near-miss`, "ordinary text", String.raw`a\nb`]) {
  add(`ordinary text ${input.slice(-12)}`, String.raw`D:\fixtures\habitat`, input, input, "win32");
}

for (const prefix of [`${POSIX_ROOT}habita`, "%2Fsrv%2Ffixtures%2Fhabita", POSIX_HOME]) {
  for (const boundary of ["", " next", '"']) {
    const input = `${prefix}\\x${boundary}`;
    add(`truncated byte escape after ${prefix} before ${JSON.stringify(boundary)}`, POSIX_HOME, input,
      prefix === POSIX_HOME ? `[home]\\x${boundary}` : input);
  }
}
add("alternate folder spelling after a decoded Windows home", String.raw`D:\fixtures\habitat`,
  String.raw`D:\fixtures\habit&#97;t\x`, TOKEN, "win32");

for (const [platform, root] of [["linux", POSIX_ROOT], ["win32", WINDOWS_ROOT]] as const) {
  const home = `${root}Alice Smith`;
  for (const name of ["Alice Smit%G1", "Ali%G1e Smith"]) {
    const input = `${root}${name}`;
    add(`${platform} malformed space-bearing home ${name}`, home, input, input, platform);
    add(`${platform} malformed space-bearing home in context ${name}`, home, `a ${input}/file b`, `a ${input}/file b`, platform);
  }
  const apostrophe = `${root}O'Brie%G1`;
  add(`${platform} malformed apostrophe-bearing home`, `${root}O'Brien`, apostrophe, apostrophe, platform);
  add(`${platform} malformed apostrophe-bearing home in context`, `${root}O'Brien`, `a ${apostrophe} b`, `a ${apostrophe} b`, platform);
  for (const gaps of [" %G1 ", "%20%G1%20"]) {
    const input = `${root}A${gaps}B/file`;
    const splitHome = `${root}A   B`;
    add(`${platform} malformed delimiter group ${gaps}`, splitHome, input, input, platform);
    add(`${platform} malformed delimiter group in context ${gaps}`, splitHome, `a ${input} b`, `a ${input} b`, platform);
  }
  add(`${platform} valid delimiter group`, `${root}A   B`, `${root}A%20%20%20B/file`, TOKEN, platform);
  add(`${platform} standalone manufactured slash pair`, `${root}habitat`, "a %25255C%25255C b", "a %25255C%25255C b", platform);
}

add("decoded space-bearing home", `${POSIX_ROOT}Alice Smith`, "%2Fsrv%2Ffixtures%2FAlice Smith%2Fx", TOKEN);
add("space-bearing home inside a larger token", `${POSIX_ROOT}Alice Smith`, "see %2Fsrv%2Ffixtures%2FAlice Smith%2Fx now", TOKEN);
add("literal space-bearing home inside a sentence", `${POSIX_ROOT}Alice Smith`, `see ${POSIX_ROOT}Alice Smith/x now`, "see [home]/x now");
add("decoded apostrophe-bearing home", `${POSIX_ROOT}O'Brien`, "x %2Fsrv%2Ffixtures%2FO'Brien%2Fy z", "x [home-token] z");
add("malformed home with dotted uppercase I", `${WINDOWS_ROOT}İAlice Smith`,
  "a D:/fixtures/İAli%G1e Smith/file b", "a D:/fixtures/İAli%G1e Smith/file b", "win32");
for (const delimiter of ["%20", "&#32;"]) {
  add(`decoded delimiter beside a malformed escape ${delimiter}`, `${POSIX_ROOT}Alice Smith`, `a ${POSIX_ROOT}Alice${delimiter}Smit%G1/file b`);
}
const repeated = `${POSIX_ROOT}Alice%G1 Smith/file`;
add("repeated malformed candidates", `${POSIX_ROOT}Alice Smith`, `a ${repeated} c ${repeated} b`);
for (const [name, variant] of [
  ["Alice Smith", "Alice ſmit%G1"], ["sigma", "ſigm%G1"],
  ["σigma", "ςigm%G1"], ["kit", "Ki%G1"], ["ΐit", "ΐi%G1"],
]) {
  const input = `a ${WINDOWS_ROOT}${variant} b`;
  add(`case alias beside a malformed escape ${variant}`, WINDOWS_ROOT + name, input, input, "win32");
}

const mixedDepth = "pre:%2Fsrv%2Ffixtures%2Fhabitat/one;%252Fsrv%252Ffixtures%252Fhabitat/two";
add("mixed depths in one token", POSIX_HOME, mixedDepth, TOKEN);
add("mixed depths after an astral prefix", POSIX_HOME, `😀${mixedDepth}`, TOKEN);
add("mixed depths across separate tokens", POSIX_HOME, `${mixedDepth};${mixedDepth} ${mixedDepth}`, `${TOKEN} ${TOKEN}`);
const trailingHome = `${POSIX_ROOT}ab\\`;
for (const suffix of ["", "/file"]) {
  const input = JSON.stringify({ p: trailingHome + suffix, other: 1 });
  add(`normalized trailing separator${suffix}`, trailingHome, input, JSON.stringify({ p: `[home]\\${suffix}`, other: 1 }), "linux", true);
}
add("escaped first slash belongs to the replaced literal span", POSIX_HOME,
  String.raw`{"p":"\/srv/fixtures/habitat/file","other":1}`, '{"p":"[home]/file","other":1}', "linux", true);
const trailingRun = "\\".repeat(4);
for (const [prefix, expected] of [["plain", "plain"], [encodeURIComponent(POSIX_HOME), TOKEN]]) {
  add(`serialized trailing slash run after ${prefix}`, POSIX_HOME,
    JSON.stringify({ p: prefix + trailingRun, other: 1 }), JSON.stringify({ p: expected + trailingRun, other: 1 }), "linux", true);
}

const emojiHome = `${POSIX_ROOT}a😀b`;
for (const half of [String.raw`a\ud83d%G1b`, String.raw`a%G1\ude00b`]) {
  add(`malformed astral account ${half}`, emojiHome, `%2Fsrv%2Ffixtures%2F${half}%2Fend`);
  add(`malformed astral parent ${half}`, `${emojiHome}/habitat`, `😀 %2Fsrv%2Ffixtures%2F${half}%2Fhabitat%2Fend 😀`);
}
add("malformed astral parent across a space", `${POSIX_ROOT}First a😀b/habitat`,
  String.raw`a /srv/fixtures/First a\ud83d%G1b/habitat/end z`);
add("encoded astral home and isolated suffix half", emojiHome,
  String.raw`%2Fsrv%2Ffixtures%2Fa\ud83d\ude00b%2Fend\ud83d`, TOKEN);
add("literal home and isolated suffix half", POSIX_HOME, String.raw`/srv/fixtures/habitat\ud83d`, String.raw`[home]\ud83d`);

add("decoded root without its account", POSIX_HOME, "a %2Fsrv%2Ffixtures%2Fhabi%2561 b");
add("unrelated decoded root", POSIX_HOME, "a %2Fsrv%2Fother%2Fhabi%2561 b");
add("literal root before a manufactured non-escape slash", POSIX_HOME, "a /srv/fixtures/habi%5Cz b");
add("literal root before a manufactured control escape", WINDOWS_HOME,
  "a D:/fixtures/habi%5Cntat b", "a D:/fixtures/habi%5Cntat b", "win32");
const rootedJson = JSON.stringify({ p: `${POSIX_ROOT}habi\\`, other: 1 });
add("incomplete rooted value ending in a slash", POSIX_HOME, rootedJson, rootedJson, "linux", true);

for (const separator of ["%5C", "%2F"]) {
  const encoded = `${separator}${separator}server${separator}share${separator}habitat`;
  for (const suffix of ["2", "_old", "-x", ".ext", ".é"]) {
    const input = `${encoded}${suffix}/file`;
    add(`encoded UNC sibling ${separator} ${suffix}`, UNC_HOME, input, input, "win32");
  }
  add(`encoded UNC home ${separator}`, UNC_HOME, `${encoded}/file`, TOKEN, "win32");
}
for (const [platform, root] of [["linux", POSIX_ROOT], ["win32", WINDOWS_ROOT]] as const) {
  for (const name of ["a&b", "a%G1b"]) {
    const home = root + name;
    add(`${platform} literal punctuation ${name}`, home, `${home}/file`, "[home]/file", platform);
    add(`${platform} encoded punctuation ${name}`, home, `${encodeURIComponent(home)}/file`, TOKEN, platform);
  }
  add(`${platform} literal punctuation with malformed suffix`, `${root}a&b`, `${root}a&b%G1/file`, "[home]%G1/file", platform);
}

const quotedHomeInput = JSON.stringify({ p: "%252Fsrv%252Ffixtures%252Fhabitat", other: 1 });
add("unsupported quote at end of a home", `${POSIX_HOME}"`, quotedHomeInput, quotedHomeInput, "linux", true);
const extraFieldInput = '{"p":"%2Fsrv%2Ffixtures%2FA","q":"%G1B","other":1}';
add("unsupported home spelling resembling JSON fields", `${POSIX_ROOT}A","q":"B`, extraFieldInput, extraFieldInput, "linux", true);
for (const half of [String.raw`\udc28`, String.raw`\udc00`]) {
  const input = `a D:/fixtures/a%G1${half}b/habitat/end z`;
  add(`malformed Windows astral alias ${half}`, ASTRAL_HOME, input, input, "win32");
}
add("encoded Windows astral alias", ASTRAL_HOME,
  String.raw`a D:/fixtures/a\ud801\udc28b/habitat/end z`, "a [home-token] z", "win32");
add("literal Windows astral alias", ASTRAL_HOME, "a D:/fixtures/a𐐨b/habitat/end z", "a [home]/end z", "win32");
add("literal UNC astral alias", String.raw`\\srv\share\a𐐀b`, String.raw`a \\SRV\SHARE\a𐐨b\end z`,
  String.raw`a [home]\end z`, "win32");

it.each(probes)("$name", async ({ home, platform, input, expected, json }) => {
  const { redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home, platform);
  for (const redact of [redactHomePathsInText, redactJudgeText]) {
    const output = redact(input);
    expect(output).toBe(expected);
    if (json) expect(() => JSON.parse(output)).not.toThrow();
  }
});

it("retains all colliding entries and raw numeric values in serialized audit JSON", async () => {
  await loadHomeRedactors(POSIX_HOME);
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  const { rawJSON } = JSON as typeof JSON & { rawJSON(value: string): object };
  const input = {
    [POSIX_HOME]: { event: 1 },
    [encodeURIComponent(POSIX_HOME)]: { event: 2 },
    "[home]": { event: 3 },
    untouched: { event: 4 },
  };
  expect(JSON.parse(serializeRuntimeAuditData(input) ?? "")).toEqual({
    "[home]#2": { event: 1 }, "[home-token]": { event: 2 }, "[home]": { event: 3 }, untouched: { event: 4 },
  });
  expect(serializeRuntimeAuditData({ n: rawJSON("1e400") })).toBe('{"n":1e400}');
  expect(serializeRuntimeAuditData({ n: rawJSON("9223372036854775807") })).toBe('{"n":9223372036854775807}');
});

it.each([
  ["linux", POSIX_HOME],
  ["win32", WINDOWS_HOME],
  ["win32", UNC_HOME],
] as const)("uses base literal boundaries before escaped sibling characters on %s for %s", async (platform, home) => {
  vi.doMock("node:url", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:url")>();
    return { ...actual, pathToFileURL: (path: string) => actual.pathToFileURL(path, { windows: platform === "win32" }) };
  });
  const { redactHomePathsInText, redactJudgeText, redactFsPath } = await loadHomeRedactors(home, platform);
  const url = pathToFileURL(`${home}.é/file`, { windows: platform === "win32" }).href;
  expect(redactFsPath(url)).toBe(url);
  const unicode = `{"p":${JSON.stringify(home).slice(0, -1)}\\u0032/file","other":1}`;
  expect(JSON.parse(unicode).p).toBe(`${home}2/file`);
  const inputs = [
    [url, "file://[home].%C3%A9/file"],
    [unicode, String.raw`{"p":"[home]\u0032/file","other":1}`],
    ...["%32", "%5Fold", "%2Eext", "%2532", ".&#00000000000233;"].map(suffix => [`${home}${suffix}/file`, `[home]${suffix}/file`] as const),
    [`${encodeURIComponent(home)}%2532/file`, TOKEN],
  ] as const;
  for (const [input, expected] of inputs) {
    expect(redactHomePathsInText(input), input).toBe(expected);
    expect(redactJudgeText(input), input).toBe(expected);
  }
  expect(redactHomePathsInText(`${home}%2Ffile`)).toBe("[home]%2Ffile");
});

it.each([win32.normalize(WINDOWS_HOME), UNC_HOME])("keeps an escaped sibling suffix after a base literal hit for %s", async home => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
  const literal = JSON.stringify(home).slice(1, -1);
  for (const quote of ['"', "'", "`"]) {
    for (const suffix of [String.raw`\xE9`, String.raw`\u00e9`, String.raw`\u{e9}`, String.raw`\351`]) {
      expect(redactHomePathsInText(`${quote}${literal}${suffix}/file${quote}`)).toBe(`${quote}[home]${suffix}/file${quote}`);
    }
  }
});

it.each([WINDOWS_HOME, UNC_HOME])("still redacts a native descendant starting with escape-like text for %s", async home => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, "win32");
  const descendant = win32.join(home, "u0032", "file");
  const expected = "[home]\\u0032\\file";
  expect(redactHomePathsInText(descendant)).toBe(expected);
  const serialized = JSON.stringify({ p: descendant });
  expect(JSON.parse(redactHomePathsInText(serialized))).toEqual({ p: expected });
  expect(redactHomePathsInText(encodeURIComponent(descendant))).toBe("[home-token]");
});
