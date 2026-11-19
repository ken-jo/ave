import { afterEach, describe, expect, it, vi } from "vitest";
import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { judgeInvocation, judgeRequest } from "../../permissions/judge/__tests__/judge-request-fixture.js";
const fixture = vi.hoisted(() => ({ home: `D:/fixtures/${"long-root/".repeat(18)}home`, platform: "win32" as "win32" | "linux" }));
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
    expect(redactFsPath(sibling)).toBe(sibling);
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
    const timings = [100, 200, 400].map(kib => {
      const values = inputs(kib * 1024);
      const samples = Array.from({ length: 5 }, () => values.reduce((total, value) => total + measure(value), 0));
      samples.sort((a, b) => a - b);
      return samples[2];
    });
    // A timer-resolution floor keeps scheduling noise from magnifying sub-millisecond samples.
    expect(timings[1]).toBeLessThan(Math.max(timings[0], 1) * 4);
    expect(timings[2]).toBeLessThan(Math.max(timings[1], 1) * 4);
    expect(timings[2]).toBeLessThan(Math.max(timings[0], 1) * 8);
    console.info("home redaction scaling", { shape, kib: [100, 200, 400], milliseconds: timings });
  });
});
