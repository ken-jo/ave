import { afterEach, describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
const fixture = vi.hoisted(() => ({ home: `D:/fixtures/${"long-root/".repeat(18)}home`, platform: "win32" as "win32" | "linux" }));
const WINDOWS_HOME = fixture.home;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const overrides = { homedir: () => fixture.home, platform: () => fixture.platform };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
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

async function loadHomeRedactor(platform: "win32" | "linux") {
  fixture.platform = platform;
  fixture.home = platform === "win32" ? WINDOWS_HOME : "/srv/fixtures/habitat";
  vi.resetModules();
  return import("../dlp-filter.js");
}

describe.each(["win32", "linux"] as const)("home text component boundaries on %s", (platform) => {
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
    for (const suffix of ["2", ".bak", "-x"]) {
      const value = `Target ${fixture.home}${suffix}/Output`;
      expect(dlp.redactHomePathsInText(value)).toBe(value);
    }
  });
  it("preserves punctuated sibling components", async () => {
    const dlp = await loadHomeRedactor(platform);
    for (const suffix of [",backup", ";backup", "[copy]", "(old)"]) {
      const value = `Target ${fixture.home}${suffix}/Output`;
      expect(dlp.redactHomePathsInText(value)).toBe(value);
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

describe.each(["win32", "linux"] as const)("home text suffix matrix on %s", (platform) => {
  it("keeps suffix spelling across paths and file URLs", async () => {
    const dlp = await loadHomeRedactor(platform);
    const home = fixture.home;
    const spellings = [...new Set([home, home.toUpperCase(), home.replaceAll("/", "\\"), home.replace("fixtures/", "fixtures\\")])];
    const forms = spellings.flatMap(spelling => [
      { text: spelling, replacement: "[home]", matches: platform === "win32" || spelling === home },
      { text: `file://${spelling}`, replacement: "file://[home]", matches: platform === "win32" || spelling === home },
      { text: pathToFileURL(spelling).toString(), replacement: "file://[home]", matches: platform === "win32" || pathToFileURL(spelling).toString() === pathToFileURL(home).toString() },
    ]);
    const punctuation = [".", ",", ";", ":", "!", "?", ")", "]", "}", '"', "'", ">", "`"];
    const terminalRuns = [...punctuation, punctuation.join(""), '"),', ".!?"];
    const homeSuffixes = ["", "/", "\\", "/Mixed/FiLe.TXT", "\\Mixed/FiLe.TXT",
      ...[" ", "\t", "\n", "\r\n"].map(space => `${space}rest`),
      ...terminalRuns.flatMap(run => [run, `${run} Next`, `${run}\tNext`, `${run}\nNext`])];
    const filenameSuffixes = ["2/x", ".bak/x", "-x/x", ",backup/x", ";backup/x", "[copy]/x", "(old)/x", ":stream", "<copy>/x", "{copy}/x",
      ...terminalRuns.map(run => `${run}backup/x`)];
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
