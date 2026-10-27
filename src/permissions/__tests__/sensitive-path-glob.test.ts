import { describe, expect, it, vi } from "vitest";
import { globToRegExp } from "../../lib/glob-matcher.js";
import { compileSensitivePathGlob } from "../sensitive-path-glob.js";
import { createSensitivePathMatcher, policyMatchPaths, SENSITIVE_PATH_PATTERNS } from "../sensitive-paths.js";

const PATTERNS = ["", "*", "**", "?", "**/", "**/a", "a/**/b", "a/*/b", "**/.env*", "**/A?b/**", "a**b*c", "a/[x]/b", "**/İ", "**/ß", "**/ſ", "**/K"];
const ALPHABET = ["a", "A", "b", "/", ".", "\n", "\r", "İ", "ß", "ſ", "K", "\u2028"];
const paths = ["", ...ALPHABET];
for (const first of ALPHABET) for (const second of ALPHABET) paths.push(first + second);
for (const first of ["a", "A", "/", "\n"]) for (const second of ALPHABET) for (const third of ALPHABET) paths.push(first + second + third);

describe("deterministic sensitive path glob matching", () => {
  it.each([false, true])("matches the established glob language insensitive=%s", (insensitive) => {
    for (const pattern of PATTERNS) {
      const reference = globToRegExp(pattern, { caseInsensitive: insensitive });
      const match = compileSensitivePathGlob(pattern, insensitive);
      for (const path of paths) expect(match(path), JSON.stringify({ pattern, path, insensitive })).toBe(reference.test(path));
    }
  });

  it("keeps every catalogue pattern reachable through the segment index", () => {
    const match = createSensitivePathMatcher("write");
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      const path = pattern.replace(/\*\*\//g, "probe/").replace(/\*/g, "probe").replace(/\?/g, "x");
      expect(match(path.startsWith("/") ? path : `/${path}`), pattern).not.toBeNull();
    }
  });

  it("preserves catalogue precedence after indexed candidate selection", () => {
    const path = "/probe/.ssh/id_rsa";
    const expected = SENSITIVE_PATH_PATTERNS.find((pattern) => policyMatchPaths(path).some((candidate) => globToRegExp(pattern, { caseInsensitive: true }).test(candidate)));
    expect(createSensitivePathMatcher("write")(path)).toBe(expected);
  });

  it.each(["read", "write"] as const)("normalizes separators before selecting %s policy candidates", (effect) => {
    const match = createSensitivePathMatcher(effect);
    for (const path of [
      "C:/Users/example/.ssh/id_rsa",
      "C:/Users/example/AppData/Local/Google/Chrome/User Data/Default/Login Data",
      "//host/share/example/.aws/credentials",
    ]) {
      const expected = match(path);
      expect(expected, path).not.toBeNull();
      expect(match(path.replace(/\//g, "\\")), path).toBe(expected);
    }
  });

  it("handles repeated matching segments without backtracking", () => {
    const path = `/${"Library/Application Support/".repeat(250)}not-a-secret`;
    expect(createSensitivePathMatcher("write")(path)).toBeNull();
    const match = compileSensitivePathGlob("**/a/**/a/**/a/**/a/**/missing", false);
    expect(match(`${"a/".repeat(2_000)}ordinary`)).toBe(false);
  });

  it("preserves literal suffixes after repeated wildcard spans", () => {
    const prefix = `/${"AppData/Local/a/User Data/b/".repeat(256)}`;
    const match = compileSensitivePathGlob("**/AppData/Local/**/User Data/**/Login Data", true);
    expect(match(prefix + "tail")).toBe(false);
    expect(match(prefix + "Login Data")).toBe(true);
    expect(match((prefix + "Login Data").toUpperCase().replaceAll("/", "\\"))).toBe(true);
  });

  it("indexes deep paths without hashing every full prefix", () => {
    const path = `/${"AppData/Local/a/User Data/b/".repeat(256)}tail`;
    const match = createSensitivePathMatcher("write");
    const originalGet = Map.prototype.get;
    let fullPathKeyChars = 0;
    const get = vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      if (typeof key === "string" && key.includes("AppData/Local/a/User Data/b/")) fullPathKeyChars += key.length;
      return originalGet.call(this, key);
    });
    let result: string | null;
    try { result = match(path); }
    finally { get.mockRestore(); }
    expect(result).toBeNull();
    expect(fullPathKeyChars).toBeLessThanOrEqual(path.length * 4);
  });
});
