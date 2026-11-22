import { afterEach, describe, expect, it } from "vitest";
import { linearGrowthBound, measureCpuGrowth } from "../../__tests__/support/cpu-growth.js";
import { loadHomeRedactors, resetHomeRedactors } from "../../__tests__/support/home-redaction-fixture.js";

afterEach(resetHomeRedactors);

const DRIVE_BOB = String.raw`C:\Users\bob`;
const DRIVE_ALICE = String.raw`C:\Users\alice`;
const CONFIGURED =[["linux", "/srv/fixtures/habitat"], ["win32", String.raw`D:\fixtures\habitat`]] as const;

describe.each(CONFIGURED)("any account's home on %s with %s configured", (platform, home) => {
  it.each([
    ["a percent-encoded name", "open file:///home/bob%C3%A9/notes.txt now", "open file://[home]/notes.txt now"],
    ["a name encoded twice", "open file:///home/bob%25C3%25A9/notes.txt now", "open file://[home]/notes.txt now"],
    ["an encoded ASCII name", "open file:///Users/%62ob/notes.txt now", "open file://[home]/notes.txt now"],
    ["a non-ASCII name", "open /home/Bobé/notes.txt now", "open [home]/notes.txt now"],
    ["a name without ASCII", "open /home/예시/notes.txt now", "open [home]/notes.txt now"],
    ["a combining mark", "open /Users/demo\u0301/a now", "open [home]/a now"],
    ["an unquoted name up to whitespace", "cp /home/bob src/x", "cp [home] src/x"],
    ["a quoted name with a space", 'cp "/home/Demo Smith" src/x', 'cp "[home]" src/x'],
    ["a quoted drive profile with a space", String.raw`cp "C:\Users\Demo Smith\x" y`, String.raw`cp "[home]\x" y`],
    ["a code span with a space", "see `/home/Demo Smith/x` or 'C:\\Users\\Demo Smith\\y'", "see `[home]/x` or '[home]\\y'"],
    ["a UNC profile", String.raw`open \\example\share\Users\bob\notes.txt now`, String.raw`open \\example\share\[home]\notes.txt now`],
    ["a quoted UNC profile with a space", String.raw`open "\\example\Users\Demo Smith\notes.txt"`, String.raw`open "\\example\[home]\notes.txt"`],
    ["an encoded apostrophe", "open /home/y%27brien/notes.txt now", "open [home]/notes.txt now"],
    ["an escaped URL authority", "see file://example%2Dhost/Users/bob/x", "see file://example%2Dhost/[home]/x"],
    ["a URL name with an encoded space", "open file:///C:/Users/Demo%20Smith/notes.txt now", "open file://[home]/notes.txt now"],
    ["an encoded path in a query", "get ?path=%2Fhome%2Fbob%2Fx now", "get ?path=[home]%2Fx now"],
    ["a name with an apostrophe", "open /home/y'brien/notes.txt now", "open [home]/notes.txt now"],
    ["a quoted name", "cd '/home/bob' && ls '/Users/Bobé'", "cd '[home]' && ls '[home]'"],
    ["a name before a word", "the dir /home/bob is ready", "the dir [home] is ready"],
    ["an earlier mask before a drive", "/home/x:/users/", "[home]:/users/"],
    ["a drive profile joined to the next", `${DRIVE_BOB}${DRIVE_ALICE}\\x`, String.raw`[home][home]\x`],
    ["a URL authority", "see https://docs.example/users/예시/api", "see https://docs.example/[home]/api"],
    ["a URL authority before a home", "see https://docs.example/home/bob/api", "see https://docs.example/[home]/api"],
    ["an encoded URL authority", "next=https%3A%2F%2Fdocs.example%2Fusers%2Fbob%2Fapi", "next=https%3A%2F%2Fdocs.example%2F[home]%2Fapi"],
    ["a folder that looks like an escape", "open C:\\Users\\bob\\uface\\x now", "open [home]\\uface\\x now"],
  ])("redacts %s in text", async (_label, input, expected) => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
    expect(redactHomePathsInText(input)).toBe(expected);
  });

  it("keeps serialized JSON valid around a redacted name", async () => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
    const line = JSON.stringify({ p: "/home/Demo Smith/x", q: String.raw`C:\Users\Bobé\y`, r: "https://docs.example/users/bob" });
    expect(JSON.parse(redactHomePathsInText(line))).toEqual({ p: "[home]/x", q: String.raw`[home]\y`, r: "https://docs.example/[home]" });
  });

  it("reads names and separators escaped in a JSON string", async () => {
    const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
    const line = '{"p":"/home/bob\\u00e9/x","q":"\\u002fhome\\u002fbob/y","r":"/home/\\uc608\\uc81c/z","s":"\\\\\\\\example\\\\Users\\\\bob\\\\w","next":1}';
    expect(JSON.parse(redactHomePathsInText(line))).toEqual({ p: "[home]/x", q: "[home]/y", r: "[home]/z", s: String.raw`\\example\[home]\w`, next: 1 });
  });

  it("tells a JSON escape in a name from a folder after a backslash", async () => {
    const { redactFsPath, redactHomePathsInText } = await loadHomeRedactors(home, platform);
    const line = JSON.stringify({ p: "C:\\Users\\bob\\uface\\x" });
    expect(JSON.parse(redactHomePathsInText(line))).toEqual({ p: "[home]\\uface\\x" });
    const escaped = '{"c":"cat \\"/home/\\uc608\\uc81c\\"","d":"C:\\\\Users\\\\bob\\uc608\\\\x","e":"/home/bob\\uc608\\nx"}';
    for (const redact of [redactHomePathsInText, redactFsPath]) expect(redact(escaped)).not.toMatch(/uc608|uc81c/u);
  });

  it("keeps the arguments of a serialized command", async () => {
    const { redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home, platform);
    const line = JSON.stringify({ a: "cp /home/bob src/x", b: 'cp "/home/Demo Smith" src/x' });
    expect(JSON.parse(redactHomePathsInText(line))).toEqual({ a: "cp [home] src/x", b: 'cp "[home]" src/x' });
    expect(redactJudgeText("cp /home/bob src/x")).toBe("cp [home] src/x");
  });

  it("keeps a serialized drive path through a folder named Users or home", async () => {
    const { redactFsPath, redactHomePathsInText, redactJudgeText } = await loadHomeRedactors(home, platform);
    for (const path of [String.raw`D:\repo\src\Users\model.ts`, String.raw`C:\tools\app\home\index.html`]) {
      for (const text of [JSON.stringify({ path }), JSON.stringify(JSON.stringify({ path }))]) {
        for (const redact of [redactHomePathsInText, redactJudgeText, redactFsPath]) expect(redact(text)).toBe(text);
      }
    }
  });

  it.each([
    ["/home/bob/x", "[home]/x"],
    [String.raw`C:\Users\Demo Smith\x`, String.raw`[home]\x`],
    ["/home/Demo Smith", "[home]"],
    ["/home/Demo Smith/x", "[home]/x"],
    [String.raw`\\example\Users\Demo Smith\notes.txt`, String.raw`\\example\[home]\notes.txt`],
    ["file://example%2Dhost/Users/bob/x", "file://example%2Dhost/[home]/x"],
    ["file:///home/bob%C3%A9/x?y=1", "file://[home]/x?y=1"],
    ["file:///C:/Users/Bobé/x", "file://[home]/x"],
    ["https://docs.example/users/bob/api", "https://docs.example/[home]/api"],
    ["C:\\Users\\bob\\uface\\x", "[home]\\uface\\x"],
  ])("redacts any account's home in the path value %s", async (input, expected) => {
    const { redactFsPath } = await loadHomeRedactors(home, platform);
    expect(redactFsPath(input)).toBe(expected);
  });

  it("redacts any account's home in audit path fields only", async () => {
    const { redactAuditPayload } = await loadHomeRedactors(home, platform);
    const separator = platform === "win32" ? "\\" : "/";
    expect(redactAuditPayload({
      entryFsPath: "/home/bob/plugins/ui.js",
      frameUrl: "file:///home/bob%C3%A9/plugins/ui.html",
      realRoot: `${home}${separator}plugins`,
      reason: "/home/bob",
    })).toEqual({
      entryFsPath: "[home]/plugins/ui.js",
      frameUrl: "file://[home]/plugins/ui.html",
      realRoot: `<home>${separator}plugins`,
      reason: "/home/bob",
    });
  });
});

it.each([
  ["linux", "/home/Demo Smith", "open /home/Demo Smith/notes.txt now", "open [home]/notes.txt now"],
  ["win32", String.raw`C:\Users\Demo Smith`, String.raw`open C:\Users\Demo Smith\notes.txt now`, String.raw`open [home]\notes.txt now`],
  ["linux", "/home/bob", "see https://example.test/home/bob/x", "see https://example.test/[home]/x"],
] as const)("redacts the %s home %s in full in unquoted text", async (platform, home, input, expected) => {
  const { redactHomePathsInText } = await loadHomeRedactors(home, platform);
  expect(redactHomePathsInText(input)).toBe(expected);
});

it("scans adversarial home text and paths in linear time", async () => {
  const { redactFsPath, redactHomePathsInText } = await loadHomeRedactors("/srv/fixtures/habitat", "linux");
  const SMALL = 4 * 1024;
  const LARGE = 16 * SMALL;
  const fill = (size: number, unit: string, head = "") => head + unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const families = [
    ["x y ", "/home/"], ["/home/x y", ""], [DRIVE_BOB, ""], ["%C3", "/home/"], ["a", "https://"], ["a:/users/", "/home/"],
    ["%2525", "/home/"], ["x ", "C:\\Users\\"], ["/users/x", "https://x.example"],
    ["\\\\a\\b", ""], ["a", "\\\\"], ["\\", ""], ["x y ", '"/home/'], ['"/home/x y ', ""], ["\\u00e9", "/home/"],
    ["\\u002fhome", ""], ["%27", "/home/"], ["%2D", "file://"],
    ["\\uabcd", "/home/"], ["\\\\\\uabcd", "/home/"], ["\\uabcd\\x", "C:\\Users\\"], ["\\\\uabcd", "C:\\\\Users\\\\"],
  ] as const;
  for (const [unit, head] of families) {
    for (const redact of [redactHomePathsInText, redactFsPath]) {
      const { smallMs, largeMs, growth } = measureCpuGrowth(() => redact(fill(SMALL, unit, head)), () => redact(fill(LARGE, unit, head)), { fastEnoughMs: 5, minSampleMs: 20 });
      if (growth === undefined) continue;
      expect(growth, `${head}${unit}: ${smallMs.toFixed(1)} ms at 4 KiB, ${largeMs.toFixed(1)} ms at 64 KiB`).toBeLessThan(linearGrowthBound(LARGE / SMALL));
    }
  }
});
