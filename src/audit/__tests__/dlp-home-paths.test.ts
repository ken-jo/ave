import { afterEach, describe, expect, it, vi } from "vitest";
import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { judgeInvocation, judgeRequest } from "../../permissions/judge/__tests__/judge-request-fixture.js";
const fixture = vi.hoisted(() => ({ home: `D:/fixtures/${"long-root/".repeat(18)}home`, platform: "win32" as "win32" | "linux" | "darwin" }));
const WINDOWS_HOME = fixture.home;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const overrides = { homedir: () => fixture.home, platform: () => fixture.platform };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return {
    ...actual,
    // URL construction must follow the same platform as the mocked home, including inside the redactors.
    pathToFileURL: (path: string) => actual.pathToFileURL(path, { windows: fixture.platform === "win32" }),
  };
});
import { redactFsPath, redactHomePathsInText } from "../dlp-filter.js";
describe("home paths with mixed Windows spellings", () => {
  const nativeHome = win32.normalize(fixture.home);
  it.each([nativeHome, nativeHome.toUpperCase(), fixture.home, fixture.home.toUpperCase(), fixture.home.replace("fixtures/", "fixtures\\")])("redacts a home prefix in a path: %s", (home) => {
    expect(redactFsPath(`${home}\\private\\output`)).toBe("<home>\\private\\output");
    expect(redactHomePathsInText(`Target ${home}\\private\\output`)).toBe("Target [home]\\private\\output");
  });
  it("redacts native and standard file URL forms", () => {
    expect(redactFsPath(`file://${nativeHome}\\private`)).toBe("file://<home>/private");
    expect(redactHomePathsInText(`Target file://${nativeHome}\\private`)).toBe("Target file://[home]\\private");
    expect(redactFsPath(`${pathToFileURL(fixture.home)}/private`)).toBe("file://<home>/private");
  });
  const spellings = [nativeHome, nativeHome.toUpperCase(), fixture.home, fixture.home.toUpperCase(), fixture.home.replace("fixtures/", "fixtures\\")];
  const siblings = [...new Set(spellings.flatMap(home => ["2", ".bak", "-x"].flatMap(suffix => [
    `${home}${suffix}\\Output`, `${home}${suffix}/Output`, `file://${home}${suffix}\\Output`, `${pathToFileURL(home + suffix)}/Output`,
  ])))];
  it.each(siblings)("preserves a sibling component in both redactors: %s", (sibling) => {
    const bounded = [...sibling];
    expect(redactFsPath(sibling)).toBe(bounded.length > 256 ? `${bounded.slice(0, 256).join("")}…` : sibling);
    expect(redactHomePathsInText(`Target ${sibling}`)).toBe(`Target ${sibling}`);
  });
  it.each(spellings)("redacts the bare home and preserves descendant spelling: %s", (home) => {
    expect(redactFsPath(home)).toBe("<home>");
    expect(redactHomePathsInText(`Target ${home}`)).toBe("Target [home]");
    const suffix = "\\MixedCase/FiLe.TXT";
    expect(redactFsPath(home + suffix)).toBe(`<home>${suffix}`);
    expect(redactHomePathsInText(`Target ${home}${suffix}`)).toBe(`Target [home]${suffix}`);
    for (const url of [`file://${home}`, pathToFileURL(home).toString()]) {
      expect(redactFsPath(url)).toBe("file://<home>");
      expect(redactHomePathsInText(`Target ${url}`)).toBe("Target file://[home]");
      expect(redactHomePathsInText(`Target ${url}${suffix}`)).toBe(`Target file://[home]${suffix}`);
    }
  });
  it.each([" ", "\t", "\n"])("redacts a home followed by whitespace: %j", (delimiter) => {
    expect(redactHomePathsInText(`Target ${nativeHome}${delimiter}rest`)).toBe(`Target [home]${delimiter}rest`);
  });
});

afterEach(() => {
  fixture.home = WINDOWS_HOME;
  fixture.platform = "win32";
  vi.resetModules();
});

async function loadHomeRedactor(platform: "win32" | "linux", native = false) {
  fixture.platform = platform;
  fixture.home = platform === "win32" ? WINDOWS_HOME : "/srv/fixtures/habitat";
  if (native && platform === "win32") fixture.home = win32.normalize(fixture.home);
  vi.resetModules();
  return import("../dlp-filter.js");
}

describe.each(["win32", "linux"] as const)("home text component boundaries on %s", (platform) => {
  it("redacts the native home in standard file URLs and preserves siblings", async () => {
    const dlp = await loadHomeRedactor(platform);
    const url = pathToFileURL(fixture.home).href;
    expect(dlp.redactFsPath(url)).toBe("file://<home>");
    expect(dlp.redactFsPath(`${url}/Mixed/File`)).toBe("file://<home>/Mixed/File");
    expect(dlp.redactHomePathsInText(url)).toBe("file://[home]");
    expect(dlp.redactHomePathsInText(`${url}/Mixed/File`)).toBe("file://[home]/Mixed/File");
    const sibling = pathToFileURL(`${fixture.home}2`).href;
    expect(dlp.redactFsPath(sibling)).toBe(sibling);
    expect(dlp.redactHomePathsInText(sibling)).toBe(sibling);
  });
  it("redacts a colon terminator", async () => {
    const dlp = await loadHomeRedactor(platform);
    expect(dlp.redactHomePathsInText(`Target ${fixture.home}:`)).toBe("Target [home]:");
  });
  it("redacts a sentence final period", async () => {
    const dlp = await loadHomeRedactor(platform);
    expect(dlp.redactHomePathsInText(`Target ${fixture.home}.`)).toBe("Target [home].");
  });
  it("redacts a sentence period before whitespace", async () => {
    const dlp = await loadHomeRedactor(platform);
    expect(dlp.redactHomePathsInText(`Target ${fixture.home}. Next`)).toBe("Target [home]. Next");
  });
  it("redacts bare homes and real descendants", async () => {
    const dlp = await loadHomeRedactor(platform);
    for (const suffix of ["", "/", "/Mixed/File", "\\", "\\Mixed/File"]) {
      expect(dlp.redactHomePathsInText(`Target ${fixture.home}${suffix}`)).toBe(`Target [home]${suffix}`);
    }
  });
  it("preserves complete sibling components", async () => {
    const dlp = await loadHomeRedactor(platform);
    for (const suffix of ["2", ".bak", "-x", "_old", "한글", "é", "٢", ".é", "._old", ".-x"]) {
      const value = `Target ${fixture.home}${suffix}/Output`;
      expect(dlp.redactHomePathsInText(value)).toBe(value);
    }
  });
  it("intentionally over-redacts punctuated sibling components to fail closed", async () => {
    const dlp = await loadHomeRedactor(platform);
    for (const suffix of [",backup", ";backup", "[copy]", "(old)", ";x", ", backup"]) {
      const value = `Target ${fixture.home}${suffix}/Output`;
      expect(dlp.redactHomePathsInText(value)).toBe(`Target [home]${suffix}/Output`);
    }
  });
  it("folds case and home separators only on Windows", async () => {
    const dlp = await loadHomeRedactor(platform);
    const upper = fixture.home.toUpperCase();
    expect(dlp.redactHomePathsInText(`Target ${upper}/Mixed`)).toBe(`Target ${platform === "win32" ? "[home]" : upper}/Mixed`);
    const native = fixture.home.replaceAll("/", "\\");
    expect(dlp.redactHomePathsInText(`Target ${native}/Mixed`)).toBe(`Target ${platform === "win32" ? "[home]" : native}/Mixed`);
  });
});

describe.each(["win32", "linux"] as const)("structured home text boundaries on %s", (platform) => {
  it("redacts a home in compact JSON before the next field", async () => {
    await loadHomeRedactor(platform);
    const { redactJudgeText } = await import("../../permissions/judge/judge-redaction.js");
    expect(redactJudgeText(JSON.stringify({ path: fixture.home, other: 1 }))).toBe(JSON.stringify({ path: "[home]", other: 1 }));
  });
  it("redacts a quoted home before the next shell statement", async () => {
    await loadHomeRedactor(platform, true);
    const { redactJudgeText } = await import("../../permissions/judge/judge-redaction.js");
    expect(redactJudgeText(`cd "${fixture.home}";pwd`)).toBe('cd "[home]";pwd');
  });
  it("redacts a home in a Markdown link label", async () => {
    await loadHomeRedactor(platform);
    const { redactJudgeText } = await import("../../permissions/judge/judge-redaction.js");
    expect(redactJudgeText(`[${fixture.home}](target)`)).toBe("[[home]](target)");
  });
});

describe("serialized native home paths", () => {
  it.each([String.raw`D:\fixtures\habitat`, String.raw`\\server\share\habitat`, String.raw`\\?\D:\fixtures\habitat`, String.raw`\\?\UNC\server\share\habitat`])("keeps escaped separator suffix bytes for %s", async (home) => {
    fixture.home = home;
    vi.resetModules();
    const { redactHomePathsInText } = await import("../dlp-filter.js");
    for (const count of [1, 2, 4]) {
      const escapedHome = home.replaceAll("\\", "\\".repeat(count));
      const suffix = `${"\\".repeat(count)}Mixed/FiLe.TXT`;
      expect(redactHomePathsInText(escapedHome.toUpperCase() + suffix)).toBe(`[home]${suffix}`);
      for (const sibling of ["2", "_old", "-bak", ".bak"]) {
        expect(redactHomePathsInText(escapedHome + sibling + suffix)).toBe(escapedHome + sibling + suffix);
      }
    }
  });
  it("redacts a serialized native descendant through judge text", async () => {
    await loadHomeRedactor("win32", true);
    const { redactJudgeText } = await import("../../permissions/judge/judge-redaction.js");
    for (const suffix of ["/file", "\\file"]) {
      expect(redactJudgeText(JSON.stringify({ path: fixture.home + suffix }))).toBe(JSON.stringify({ path: `[home]${suffix}` }));
    }
  });
  it("redacts a non-string argument after judge request serialization", async () => {
    await loadHomeRedactor("win32", true);
    const { redactJudgeRequest, redactJudgeText } = await import("../../permissions/judge/judge-redaction.js");
    const argument = { path: `${fixture.home}\\file`, other: 1 };
    const expected = JSON.stringify({ path: "[home]\\file", other: 1 });
    expect(redactJudgeRequest(judgeRequest({ invocation: judgeInvocation({ finalInput: { argument } }) })).tool.input.argument).toBe(expected);
    expect(redactJudgeText(JSON.stringify(argument))).toBe(expected);
  });
});

describe.each(["win32", "linux"] as const)("home text suffix matrix on %s", (platform) => {
  it("keeps suffix spelling across paths and file URLs", async () => {
    const dlp = await loadHomeRedactor(platform);
    const home = fixture.home;
    const spellings = [...new Set([home, home.toUpperCase(), home.replaceAll("/", "\\"), home.replace("fixtures/", "fixtures\\")])];
    const forms = spellings.flatMap(spelling => {
      // Root POSIX spellings before URL conversion so literal backslashes never introduce the process directory.
      const url = pathToFileURL(platform === "linux" ? posix.resolve("/", spelling) : spelling).toString();
      return [
        { text: spelling, replacement: "[home]", matches: platform === "win32" || spelling === home },
        { text: `file://${spelling}`, replacement: "file://[home]", matches: platform === "win32" || spelling === home },
        { text: url, replacement: "file://[home]", matches: platform === "win32" || url === pathToFileURL(home).toString() },
      ];
    });
    const punctuation = [".", ",", ";", ":", "!", "?", ")", "]", "}", '"', "'", ">", "`"];
    const terminalRuns = [...punctuation, punctuation.join(""), '"),', ".!?"];
    const punctuatedSuffixes = [",backup/x", ";backup/x", "[copy]/x", "(old)/x", ":stream", "<copy>/x", "{copy}/x",
      ...terminalRuns.filter(run => run !== ".").map(run => `${run}backup/x`)];
    const homeSuffixes = ["", "/", "\\", "/Mixed/FiLe.TXT", "\\Mixed/FiLe.TXT", ...punctuatedSuffixes,
      ...[" ", "\t", "\n", "\r\n"].map(space => `${space}rest`),
      ...terminalRuns.flatMap(run => [run, `${run} Next`, `${run}\tNext`, `${run}\nNext`])];
    const filenameSuffixes = ["2/x", ".bak/x", "-x/x", "_old/x", ".backup/x"];
    for (const form of forms) {
      for (const suffix of homeSuffixes) {
        const expected = form.matches ? form.replacement : form.text;
        const value = `Target ${form.text}${suffix}`;
        expect(dlp.redactHomePathsInText(value), value).toBe(`Target ${expected}${suffix}`);
      }
      for (const suffix of filenameSuffixes) {
        const value = `Target ${form.text}${suffix}`;
        expect(dlp.redactHomePathsInText(value), value).toBe(value);
      }
      const expected = form.matches ? form.replacement : form.text;
      expect(dlp.redactHomePathsInText(`"${form.text}",`)).toBe(`"${expected}",`);
      expect(dlp.redactHomePathsInText(`(${form.text})`)).toBe(`(${expected})`);
    }
  });
});


describe.each([
  { shape: "UNC", home: String.raw`\\server\share\alice` },
  { shape: "extended drive", home: String.raw`\\?\D:\fixtures\alice` },
  { shape: "extended UNC", home: String.raw`\\?\UNC\server\share\alice` },
  { shape: "drive", home: String.raw`D:\fixtures\alice` },
])("Windows separator runs for $shape homes", ({ home }) => {
  it("redacts native, doubled, slash and case variants while retaining suffix bytes", async () => {
    fixture.home = home;
    vi.resetModules();
    const { redactHomePathsInText } = await import("../dlp-filter.js");
    const spellings = [home, home.replaceAll("\\", "\\\\"), home.replaceAll("\\", "/"), home.toUpperCase()];
    for (const spelling of spellings) {
      for (const suffix of ["", String.raw`\Mixed/FiLe.TXT`, String.raw`\\Mixed/FiLe.TXT`, "/Mixed/FiLe.TXT", '","other":1}', ";x", ". Next"]) {
        expect(redactHomePathsInText(spelling + suffix)).toBe(`[home]${suffix}`);
      }
      for (const suffix of ["2", "_old", "-bak", ".bak", "é", "٢"]) {
        expect(redactHomePathsInText(spelling + suffix)).toBe(spelling + suffix);
      }
    }
  });
  if (home.startsWith("\\")) {
    it("redacts the whole leading separator run with extra backslashes or a slash", async () => {
      fixture.home = home;
      vi.resetModules();
      const { redactHomePathsInText } = await import("../dlp-filter.js");
      for (const prefix of ["\\".repeat(3), "/"]) {
        const suffix = String.raw`\\Mixed/FiLe.TXT`;
        expect(redactHomePathsInText(prefix + home + suffix)).toBe(`[home]${suffix}`);
      }
    });
  }
});

describe.each([
  { shape: "UNC", home: String.raw`\\server\share\alice` },
  { shape: "extended", home: String.raw`\\?\D:\fixtures\alice` },
  { shape: "drive", home: String.raw`D:\fixtures\alice` },
])("home redaction scaling for $shape paths", ({ home, shape }) => {
  it("scans long separator runs and near-miss names with linear scaling", async () => {
    fixture.home = home;
    vi.resetModules();
    const { redactHomePathsInText } = await import("../dlp-filter.js");
    const firstSeparator = home.indexOf("\\");
    const prefix = home.slice(0, firstSeparator);
    const nearMiss = `${home.slice(firstSeparator).replace(/^\\+/u, "").slice(0, -1)}X`;
    const inputs = (size: number): string[] => [
      `${"\\".repeat(size - 9)}near-miss`,
      prefix + "\\".repeat(size - prefix.length - nearMiss.length) + nearMiss,
    ];
    const measure = (value: string): number => {
      const start = performance.now();
      const result = redactHomePathsInText(value);
      const elapsed = performance.now() - start;
      expect(result).toBe(value);
      expect(elapsed).toBeLessThan(2_000);
      return elapsed;
    };
    // Reject slow small inputs before attempting the large scaling samples.
    for (const value of inputs(2 * 1024)) measure(value);
    const timings = [100, 200, 400, 800].map(kib => {
      const values = inputs(kib * 1024);
      const samples = Array.from({ length: 5 }, () => values.reduce((total, value) => total + measure(value), 0));
      samples.sort((a, b) => a - b);
      return samples[2];
    });
    // A timer-resolution floor keeps scheduling noise from magnifying sub-millisecond samples.
    expect(timings[1]).toBeLessThan(Math.max(timings[0], 1) * 4);
    expect(timings[2]).toBeLessThan(Math.max(timings[1], 1) * 4);
    expect(timings[2]).toBeLessThan(Math.max(timings[0], 1) * 8);
    expect(timings[3]).toBeLessThan(Math.max(timings[2], 1) * 4);
    expect(timings[3]).toBeLessThan(Math.max(timings[0], 1) * 16);
    console.info("home redaction scaling", { shape, kib: [100, 200, 400, 800], milliseconds: timings });
  });
});

describe.each(["win32", "linux"] as const)("reversible home encodings on %s", (platform) => {
  async function load(home?: string) {
    fixture.platform = platform;
    fixture.home = home ?? (platform === "win32" ? "D:/fixtures/habitat" : "/srv/fixtures/habitat");
    vi.resetModules();
    return { ...await import("../dlp-filter.js"), ...await import("../../permissions/judge/judge-redaction.js") };
  }
  const home = platform === "win32" ? "D:/fixtures/habitat" : "/srv/fixtures/habitat";
  const json = (path: string): string => JSON.stringify({ path, other: 1 });
  it.each(["\\/", "\\u002f", "%2F", "&#47;", "&#x2F;", "&sol;"])("redacts single-layer separators %s", async (separator) => {
    const { redactJudgeText } = await load();
    const input = separator.startsWith("\\") ? json(`${home}/file`).replaceAll("/", separator) : json(`${home.replaceAll("/", separator)}/file`);
    const output = redactJudgeText(input);
    expect(JSON.parse(output)).toEqual({ path: platform === "win32" && separator === "\\/" ? "[home]/file" : "[home-token]", other: 1 });
    expect(output).not.toMatch(/habitat/iu);
  });
  it("redacts complete tokens for encoded letters and byte separators", async () => {
    const { redactJudgeText, redactHomePathsInText } = await load();
    expect(JSON.parse(redactJudgeText(json(`${home}/file`).replace("habitat", "\\u0068abitat")))).toEqual({ path: "[home-token]", other: 1 });
    expect(redactJudgeText(json(`${home}/file`).replaceAll("/", "\\x2f"))).toBe('{"path":"[home-token]","other":1}');
    const mixed = home.replaceAll("/", "%2F").replace("habitat", "\\u0068abit&#97;t");
    expect(redactHomePathsInText(`a ${mixed}%2Ffile b`)).toBe("a [home-token] b");
  });
  it.each(["%252F", "%25252F", "&amp;#47;", "&amp;amp;#47;"])("redacts deeper home tokens %s", async (separator) => {
    const { redactJudgeText } = await load();
    expect(JSON.parse(redactJudgeText(json(`${home.replaceAll("/", separator)}/file`)))).toEqual({ path: "[home-token]", other: 1 });
  });
  it("finds percent escapes inside character escapes and nested serialized strings", async () => {
    const { redactHomePathsInText } = await load();
    const input = json(`${home.replaceAll("/", "%2F")}/file`).replaceAll("%", "\\u0025");
    expect(JSON.parse(redactHomePathsInText(input))).toEqual({ path: "[home-token]", other: 1 });
    const nested = JSON.stringify(JSON.stringify({ p: `${home.replaceAll("/", "%252F")}/file`, q: 2 }));
    expect(JSON.parse(JSON.parse(redactHomePathsInText(nested)) as string)).toEqual({ p: "[home-token]", q: 2 });
  });
  it("preserves ordinary text and escapes without a matching home", async () => {
    const { redactHomePathsInText } = await load();
    for (const token of ["%2525252F", "&amp;amp;amp;sol;", `${"\\".repeat(8)}u002f`]) {
      expect(redactHomePathsInText(`a ${token} b`)).toBe(`a ${token} b`);
    }
    for (const text of ["ordinary text", "100% complete", "abc & unknown;", `${"\\".repeat(32)}near-miss`, "a\\nb", "\\u{2f}", "&unknown;"]) expect(redactHomePathsInText(text)).toBe(text);
  });
  it.each(["%7", "%G1", "\\u12", "\\xG1", "&#;", "&unknown;", "&unterminated", "&averylongunknownentityname;"])("preserves malformed candidates and redacts adjacent literal homes %s", async (bad) => {
    const { redactHomePathsInText } = await load();
    for (const candidate of [home.slice(0, -1) + bad, home.replace("habitat", `habit${bad}t`), home.replace("fixtures", `fixt${bad}res`), home.replace(platform === "win32" ? "D:" : "srv", platform === "win32" ? `D${bad}` : `s${bad}v`), home + bad, bad + home]) {
      expect(redactHomePathsInText(`a ${candidate} b`), candidate).toBe(`a ${candidate.replace(home, "[home]")} b`);
    }
    expect(redactHomePathsInText(`a unrelated${bad} b`)).toBe(`a unrelated${bad} b`);
    expect(redactHomePathsInText(`a unrelated${bad}t b`)).toBe(`a unrelated${bad}t b`);
  });
  it("retains encoded siblings and original token delimiters", async () => {
    const { redactHomePathsInText } = await load();
    const encoded = home.replaceAll("/", "%2F");
    for (const suffix of ["2", "_old", "-x", ".ext", ".é"]) expect(redactHomePathsInText(`${encoded + suffix}/file`)).toBe(`${encoded + suffix}/file`);
    for (const suffix of ["", "/", "\\", "/Mixed/FiLe.TXT", ":", ".", ". Next", ",backup/Output", "(old)", "[copy]", ";x", ", backup/Output", '"', "'", ">", "\tNext", "\nNext", "\\ud83d"]) {
      const boundary = suffix.search(/[\s"'<>()[\],]/u);
      expect(redactHomePathsInText(encoded + suffix), suffix).toBe(`[home-token]${boundary < 0 ? "" : suffix.slice(boundary)}`);
    }
    for (const separator of ["/", "\\/"]) {
      const input = (`${home}/one ${home}/two ${home}2/file`).replaceAll("/", separator);
      const siblings = (`${home}2/file`).replaceAll("/", separator);
      const prefix = platform === "linux" && separator !== "/" ? "[home-token] [home-token]" : `[home]${separator}one [home]${separator}two`;
      expect(redactHomePathsInText(input)).toBe(`${prefix} ${siblings}`);
    }
  });
  it.each([
    { name: "김철수", encodings: ["%EA%B9%80%EC%B2%A0%EC%88%98", "\\uae40\\ucca0\\uc218"] },
    { name: "José", encodings: ["Jos&eacute;", "Jos%E9", "Jos%C3%A9", "Jos\\xC3\\xA9"] },
    { name: "a😀", encodings: ["a\\ud83d\\ude00", "a%F0%9F%98%80", "a&#128512;", "a\\xF0\\x9F\\x98\\x80"] },
    { name: "O'Brien", encodings: ["O\\'Brien", "O&apos;Brien"] },
  ])("decodes account characters in $name", async ({ name, encodings }) => {
    const { redactHomePathsInText } = await load(home.replace("habitat", name));
    for (const encoded of encodings) expect(redactHomePathsInText(`${home.replace("habitat", encoded)}/x`), encoded).toBe("[home-token]");
  });
  it("handles native encoded separators and escape-start ambiguity", async () => {
    if (platform === "linux") {
      const { redactHomePathsInText } = await load("/home/habitat");
      expect(redactHomePathsInText("/home/h%61bitat/file")).toBe("[home-token]");
      return;
    }
    const { redactHomePathsInText } = await load(String.raw`D:\fixtures\habitat`);
    expect(redactHomePathsInText("D:%5Cfixtures%5Chabitat/file")).toBe("[home-token]");
    expect(redactHomePathsInText(String.raw`D:\fixtures\habit&#97;t\x`)).toBe("[home-token]");
    const once = "D:\\\\fixtures\\\\\\u0068abitat";
    expect(redactHomePathsInText(once)).toBe("[home-token]");
    expect(redactHomePathsInText(once.replaceAll("\\", "\\\\"))).toBe("[home-token]");
  });
});

it("keeps the generated entity subset complete and bounded", async () => {
  const { HOME_NAMED_ENTITIES } = await import("../home-named-entities.js");
  expect(Object.keys(HOME_NAMED_ENTITIES)).toHaveLength(158);
  for (const codePoint of Object.values(HOME_NAMED_ENTITIES)) expect(codePoint).toBeLessThanOrEqual(255);
  expect(HOME_NAMED_ENTITIES).toMatchObject({ sol: 47, bsol: 92, colon: 58, period: 46, lowbar: 95, amp: 38, percnt: 37, apos: 39, eacute: 233 });
});

const MIXED_ESCAPE_FRAGMENT = String.raw`%252541&amp;amp;amp;B\u0043`;

describe.each(["%", "\\u", "&#", "&#x", "&amp;", "%25", "peeling", "zeros", MIXED_ESCAPE_FRAGMENT])("decoder scaling for %s", (shape) => {
  it("scans adversarial runs with linear scaling", async () => {
    const { redactHomePathsInText } = await loadHomeRedactor("linux");
    const input = (size: number): string => shape === "peeling" ? `%${"25".repeat(Math.floor(size / 2))}2F` : shape === "zeros" ? `&#${"0".repeat(size)}47;` : shape.repeat(Math.ceil(size / shape.length));
    const measure = (size: number): number => {
      const text = input(size);
      const samples = Array.from({ length: 5 }, () => {
        const start = performance.now();
        const output = redactHomePathsInText(text);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(2_000);
        if (shape === MIXED_ESCAPE_FRAGMENT) expect(output).toBe(text);
        return elapsed;
      });
      return samples.sort((a, b) => a - b)[2];
    };
    measure(2 * 1024);
    const timings = [100, 200, 400, 800].map(kib => measure(kib * 1024));
    expect(timings[1]).toBeLessThan(Math.max(timings[0], 1) * 4);
    expect(timings[2]).toBeLessThan(Math.max(timings[1], 1) * 4);
    expect(timings[2]).toBeLessThan(Math.max(timings[0], 1) * 8);
    expect(timings[3]).toBeLessThan(Math.max(timings[2], 1) * 4);
    expect(timings[3]).toBeLessThan(Math.max(timings[0], 1) * 16);
    console.info("decoder scaling", { shape, kib: [100, 200, 400, 800], milliseconds: timings });
  });
});

it("checks a long mixed token when a necessary path character is synthesized in later layers", async () => {
  const { redactHomePathsInText } = await loadHomeRedactor("linux");
  const root = "%26%23%34%37%3B";
  const encodedHome = fixture.home.replaceAll("/", root);
  const noise = MIXED_ESCAPE_FRAGMENT.repeat(400);
  expect(redactHomePathsInText(noise)).toBe(noise);
  expect(redactHomePathsInText(`${noise}${encodedHome}${root}file`)).toBe("[home-token]");
});

it("preserves input marker text without manufacturing home evidence", async () => {
  const { redactHomePathsInText } = await loadHomeRedactor("linux");
  for (const value of ["[home]%G1", "file://[home]\\u12", "[home]&unknown;"]) {
    expect(redactHomePathsInText(value)).toBe(value);
    expect(redactHomePathsInText(`${fixture.home}/x ${value}`)).toBe(`[home]/x ${value}`);
  }
});

it("preserves malformed and non-normalized spellings", async () => {
  fixture.platform = "win32";
  fixture.home = "D:/fixtures/İhabitat";
  vi.resetModules();
  const { redactHomePathsInText, redactFsPath } = await import("../dlp-filter.js");
  expect(redactHomePathsInText("a D:/fixtures/İhabita%7 b")).toBe("a D:/fixtures/İhabita%7 b");
  const spelling = pathToFileURL(fixture.home).toString().replace("%C4%B0", "i%CC%87");
  expect(redactFsPath(`${spelling}/x`)).toBe(`${spelling}/x`);
});

describe.each(["win32", "linux"] as const)("distributed malformed home characters on %s", (platform) => {
  it("leaves distributed malformed escapes in place", async () => {
    fixture.platform = platform;
    fixture.home = platform === "win32" ? "D:/fixtures/habitat" : "/srv/fixtures/habitat";
    vi.resetModules();
    const { redactHomePathsInText } = await import("../dlp-filter.js");
    const candidate = fixture.home.replace("srv", "s%G1v").replace("fixtures", "f%G1xtu%G1es").replace("habitat", "h%G1bi%G1at");
    expect(redactHomePathsInText(`a ${candidate} b`)).toBe(`a ${candidate} b`);
  });
});

it("preserves malformed candidates for short homes", async () => {
  fixture.platform = "linux";
  fixture.home = "/a";
  vi.resetModules();
  const { redactHomePathsInText } = await import("../dlp-filter.js");
  expect(redactHomePathsInText("a /%G1a b")).toBe("a /%G1a b");
  expect(redactHomePathsInText("a /%G1 b")).toBe("a /%G1 b");
});

describe.each([
  String.raw`D:\fixtures\habitat`,
  String.raw`\\server\share\habitat`,
  String.raw`\\?\D:\fixtures\habitat`,
  String.raw`\\?\UNC\server\share\habitat`,
])("native malformed home candidates for %s", (home) => {
  it("retains native paths with malformed spellings", async () => {
    fixture.platform = "win32";
    fixture.home = home;
    vi.resetModules();
    const { redactHomePathsInText } = await import("../dlp-filter.js");
    for (const candidate of [home.slice(0, -1) + String.raw`\u12`, home.replace("habitat", String.raw`habit\xG1t`), home.replace("habitat", "habit&unterminatedt")]) {
      expect(redactHomePathsInText(`a ${candidate} b`), candidate).toBe(`a ${candidate} b`);
    }
    const other = home.replace("habitat", String.raw`other\u12`);
    expect(redactHomePathsInText(other)).toBe(other);
  });
});

it("folds home case on macOS while retaining POSIX separators", async () => {
  fixture.platform = "darwin";
  fixture.home = "/srv/fixtures/a𐐀b";
  vi.resetModules();
  const { redactHomePathsInText } = await import("../dlp-filter.js");
  expect(redactHomePathsInText("/SRV/FIXTURES/a𐐨b/end")).toBe("[home]/end");
  expect(redactHomePathsInText("/SRV/FIXTURES/a%F0%90%90%A8b/end")).toBe("[home-token]");
  expect(redactHomePathsInText(String.raw`\SRV\FIXTURES\a𐐨b/end`)).toBe(String.raw`\SRV\FIXTURES\a𐐨b/end`);
});

it("preserves each structured judge argument value when keys redact to the same name", async () => {
  await loadHomeRedactor("linux");
  const { redactJudgeRequest } = await import("../../permissions/judge/judge-redaction.js");
  const argument = { [fixture.home]: `${fixture.home}/file`, "[home]": 2, encoded: encodeURIComponent(fixture.home) };
  const result = redactJudgeRequest(judgeRequest({ invocation: judgeInvocation({ finalInput: { argument } }) }));
  expect(JSON.parse(result.tool.input.argument)).toEqual({ "[home]#2": "[home]/file", "[home]": 2, encoded: "[home-token]" });
});
describe.each(["win32", "linux"] as const)("frame URL home encoding on %s", (platform) => {
  it("redacts a canonical URL when the configured home contains dot segments", async () => {
    fixture.platform = platform;
    const home = platform === "win32" ? "D:/fixtures/alice" : "/srv/fixtures/alice";
    for (const configured of [`${home}/.`, `${home}/staging/../`, home.replace("fixtures/", "fixtures//")]) {
      fixture.home = configured;
      vi.resetModules();
      const { redactHomePathsInText, redactFsPath } = await import("../dlp-filter.js");
      const url = pathToFileURL(`${configured}/readme`).href;
      expect(url).toBe(pathToFileURL(`${home}/readme`).href);
      expect(redactHomePathsInText(url), configured).toBe("file://[home]/readme");
      expect(redactFsPath(url), configured).toBe("file://<home>/readme");
    }
  });
  it("redacts equivalent URL encodings and decodes descendants in the fallback", async () => {
    fixture.platform = platform;
    fixture.home = platform === "win32" ? "D:/fixtures/habitat" : "/srv/fixtures/habitat";
    vi.resetModules();
    const { redactFsPath } = await import("../dlp-filter.js");
    const home = pathToFileURL(fixture.home).toString();
    for (const encoded of [home.replace("fixtures", "%66ixtures"), home.replaceAll("/", "%2f").replace("file:%2f%2f", "file://")]) {
      expect(redactFsPath(`${encoded}/Mixed%20File`)).toBe("file://<home>/Mixed File");
      expect(redactFsPath(`${encoded}%2FMixed%20File`)).toBe("file://<home>/Mixed File");
      expect(redactFsPath(`${encoded}%32/other`)).toBe(`${encoded}%32/other`);
    }
  });
  it("recognizes UTF-8 escapes and literal spaces in URL homes", async () => {
    fixture.platform = platform;
    fixture.home = platform === "win32" ? "D:/fixtures/김 test%root" : "/srv/fixtures/김 test%root";
    vi.resetModules();
    const { redactFsPath } = await import("../dlp-filter.js");
    const home = pathToFileURL(fixture.home).toString();
    expect(redactFsPath(`${home.replaceAll("%20", " ").replaceAll("%EA", "%ea")}/x`)).toBe("file://<home>/x");
    expect(redactFsPath(`${home}?view=1`)).toBe("file://<home>?view=1");
    expect(redactFsPath(`${home}#page`)).toBe("file://<home>#page");
  });
});

it("keeps a descendant file URL when the configured home is an unsupported POSIX root", async () => {
  fixture.platform = "linux";
  fixture.home = "/";
  vi.resetModules();
  const { redactFsPath } = await import("../dlp-filter.js");
  expect(redactFsPath("file:///etc/config")).toBe("file:///etc/config");
});

it("keeps encoded descendant bytes for a canonical UNC file URL", async () => {
  fixture.platform = "win32";
  fixture.home = String.raw`\\server\share\habitat`;
  vi.resetModules();
  const { redactFsPath } = await import("../dlp-filter.js");
  const url = pathToFileURL(fixture.home).href;
  expect(url).toBe("file://server/share/habitat");
  expect(redactFsPath(`${url}/Mixed%20File`)).toBe("file://<home>/Mixed%20File");
});

it("scrubs boxed strings and non-plain serialized keys before sending judge arguments", async () => {
  const { redactHomePathsInText } = await loadHomeRedactor("linux");
  const { redactJudgeRequest, redactJudgeText } = await import("../../permissions/judge/judge-redaction.js");
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  const home = fixture.home;
  class Argument {
    constructor() {
      Object.defineProperty(this, home, { enumerable: true, value: `${home}/file` });
    }
  }
  const boxed = Object(`${home}/file`);
  const { rawJSON } = JSON as typeof JSON & { rawJSON(value: string): object };
  const raw = rawJSON(JSON.stringify(`${home}/file`));
  const finalInput = { boxed, nested: [new Argument(), raw], raw };
  const request = judgeRequest({ invocation: judgeInvocation({ finalInput }) });
  const inputs = redactJudgeRequest(request).tool.input;
  for (const [key, value] of Object.entries(finalInput)) {
    expect(inputs[key]).toBe(redactJudgeText(JSON.stringify(value)));
    expect(inputs[key]).not.toContain(home);
  }
  expect(serializeRuntimeAuditData(boxed)).toBe(JSON.stringify(redactHomePathsInText(`${home}/file`)));
  expect(serializeRuntimeAuditData(raw)).toBe(JSON.stringify(`${home}/file`));
});

it("propagates application RangeErrors through structured judge arguments", async () => {
  const { redactJudgeRequest } = await import("../../permissions/judge/judge-redaction.js");
  const { serializeRuntimeAuditData } = await import("../runtime-audit-json.js");
  const failure = new RangeError("application serialization error");
  const reject = () => { throw failure; };
  for (const argument of [{ get p() { return reject(); } }, { p: { toJSON: reject } }]) {
    const request = judgeRequest({ invocation: judgeInvocation({ finalInput: { argument } }) });
    let caught: unknown;
    try { redactJudgeRequest(request); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(serializeRuntimeAuditData(argument)).toBe('{"unserializable":true}');
  }
});
