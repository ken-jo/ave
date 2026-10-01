import { describe, expect, it } from "vitest";
import { MarketplaceError } from "../../errors.js";
import {
  matchesSourcePattern,
  normalizeSourceUrl,
  parseSourcePattern,
  sameSourceRepository,
} from "../source-url.js";

function rejected(input: string): MarketplaceError {
  try {
    normalizeSourceUrl(input);
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).code).toBe("SOURCE_URL_REJECTED");
    return error as MarketplaceError;
  }
  throw new Error(`expected ${input} to be rejected`);
}

describe("normalizeSourceUrl", () => {
  it.each([
    ["acme/tools", "https://github.com/acme/tools"],
    ["https://github.com/acme/tools", "https://github.com/acme/tools"],
    ["https://GitHub.com/acme/tools.git", "https://github.com/acme/tools"],
    ["https://github.com./acme/tools/", "https://github.com/acme/tools"],
    ["https://github.com:443/acme/tools", "https://github.com/acme/tools"],
    ["https://git.example:8443/acme/tools", "https://git.example:8443/acme/tools"],
    ["http://git.corp.example:80/a/b", "http://git.corp.example/a/b"],
    ["git@github.com:acme/tools.git", "ssh://git@github.com/acme/tools"],
    ["ssh://git@github.com:22/acme/tools.git", "ssh://git@github.com/acme/tools"],
    ["ssh://git@github.com:2222/acme/tools", "ssh://git@github.com:2222/acme/tools"],
    ["  https://github.com/acme/tools  ", "https://github.com/acme/tools"],
    ["https://github.com/acme/%7Etools", "https://github.com/acme/~tools"],
    ["https://github.com/acme/a%2fb", "https://github.com/acme/a%2Fb"],
    ["https://bücher.example/a/b", "https://xn--bcher-kva.example/a/b"],
    ["https://0x7f.1/a/b", "https://127.0.0.1/a/b"],
    ["https://[0:0::1]/a/b", "https://[::1]/a/b"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeSourceUrl(input).url).toBe(expected);
  });

  it("returns the parsed fields", () => {
    expect(normalizeSourceUrl("git@Git.Example:9/acme/tools")).toEqual({
      scheme: "ssh",
      user: "git",
      host: "git.example",
      port: null,
      path: "/9/acme/tools",
      url: "ssh://git@git.example/9/acme/tools",
    });
    expect(normalizeSourceUrl("ssh://git@git.example:2222/acme/tools")).toMatchObject({
      port: 2222,
      path: "/acme/tools",
    });
  });

  it.each([
    "",
    "file:///tmp/repo",
    "git://github.com/acme/tools",
    "ext::sh -c touch% /tmp/pwned",
    "https://user:secret@github.com/acme/tools",
    "https://token@github.com/acme/tools",
    "ssh://git:secret@github.com/acme/tools",
    "https://github.com/acme/tools?ref=main",
    "https://github.com/acme/tools#main",
    "https://github.com",
    "https://github.com/",
    "https://github.com/acme/../tools",
    "https://github.com/acme/./tools",
    "https://github.com/acme//tools",
    "https://github.com/acme/%2e%2e",
    "https://github.com/acme/%zz",
    "https://github.com/acme/to ols",
    "https://github.com/acme\\tools",
    "https://github.com:0/acme/tools",
    "https://github.com:70000/acme/tools",
    "https://gith%75b.com/acme/tools",
    "https://github.com/.git",
    "C:\\repos\\tools",
    "/abs/path",
    "acme",
    "ssh://-oProxyCommand=x/acme/tools",
    "https://-evil.example/acme/tools",
    "https://git$(id).example/acme/tools",
    "-oProxyCommand=x@github.com:acme/tools",
    "ssh://-l@github.com/acme/tools",
  ])("rejects %j", (input) => {
    rejected(input);
  });

  it.each([
    ["https://user:secret@github.com/acme/tools", { reason: "credentials-in-url" }],
    ["https://token@github.com/acme/tools", { reason: "credentials-in-url" }],
    ["ssh://git:secret@github.com/acme/tools", { reason: "credentials-in-url" }],
    ["file:///tmp/repo", { reason: "scheme-unsupported", scheme: "file" }],
    ["GIT://github.com/acme/tools", { reason: "scheme-unsupported", scheme: "git" }],
    ["https://github.com/acme/tools?ref=main", { reason: "format" }],
    ["https://github.com/acme/tools#main", { reason: "format" }],
    ["https://github.com/acme/to ols", { reason: "format" }],
    ["https://github.com/acme\\tools", { reason: "format" }],
  ])("names why %j is refused (§18.8)", (input, detail) => {
    expect(rejected(input).detail).toEqual(detail);
  });

  it.each(["ssh://-l@github.com/acme/tools", "https://github.com/acme/../tools", "acme", "ext::sh"])(
    "refuses %j without a reason it does not have",
    (input) => {
      expect(rejected(input).detail).toBeUndefined();
    },
  );

  it("never carries the password of a refused address in its message", () => {
    const error = rejected("https://alice:verifier-secret@example.com/owner/repo");
    expect(error.message).not.toContain("verifier-secret");
    expect(error.message).toContain("example.com/owner/repo");
  });

  it("treats scheme, port, ssh user and path case as connection detail, not repository identity", () => {
    expect(
      sameSourceRepository(
        normalizeSourceUrl("ssh://git@git.example/acme/tools"),
        normalizeSourceUrl("ssh://deploy@git.example/acme/tools.git"),
      ),
    ).toBe(true);
    expect(
      sameSourceRepository(
        normalizeSourceUrl("ssh://git@git.example/acme/tools"),
        normalizeSourceUrl("https://git.example:8443/ACME/Tools"),
      ),
    ).toBe(true);
    expect(
      sameSourceRepository(normalizeSourceUrl("https://git.example/acme/tools"), normalizeSourceUrl("https://git.example/acme/tools-2")),
    ).toBe(false);
    expect(
      sameSourceRepository(normalizeSourceUrl("https://git.example/acme/tools"), normalizeSourceUrl("https://other.example/acme/tools")),
    ).toBe(false);
  });

  it("keeps the path's case in the stored URL, which git fetches from", () => {
    expect(normalizeSourceUrl("https://github.com/Acme/Tools.git").url).toBe("https://github.com/Acme/Tools");
  });
});

describe("source patterns", () => {
  const url = (input: string) => normalizeSourceUrl(input);

  it("host patterns match every scheme and port", () => {
    const pattern = parseSourcePattern("host:Git.Example.");
    expect(matchesSourcePattern(url("https://git.example/a/b"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("git@git.example:a/b"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("https://git.example:8443/a/b"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("https://other.example/a/b"), pattern)).toBe(false);
  });

  it("exact patterns compare the repository on any scheme and in any case", () => {
    const pattern = parseSourcePattern("https://GitHub.com/acme/tools.git");
    expect(matchesSourcePattern(url("acme/tools"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("ACME/Tools"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("git@github.com:acme/tools.git"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("acme/tools-2"), pattern)).toBe(false);
    // A nested repository (GitLab subgroups) is another repository; only a download lives beneath one.
    expect(matchesSourcePattern(url("https://github.com/acme/tools/sub"), pattern)).toBe(false);
    expect(matchesSourcePattern(url("https://github.com/acme/tools/sub"), pattern, "download")).toBe(true);
  });

  it("a trailing * after a slash stays inside that path", () => {
    const pattern = parseSourcePattern("https://github.com/acme/*");
    expect(matchesSourcePattern(url("acme/tools"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("https://github.com/acme/tools/sub"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("acme-corp/tools"), pattern)).toBe(false);
    // Neither scheme, port nor case may sidestep a pattern.
    expect(matchesSourcePattern(url("git@github.com:acme/tools"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("https://github.com:8443/acme/tools"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("Acme/tools"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("https://gitlab.com/acme/tools"), pattern)).toBe(false);
  });

  it("a trailing * without a slash is a plain prefix", () => {
    const pattern = parseSourcePattern("https://github.com/Acme*");
    expect(matchesSourcePattern(url("acme-corp/tools"), pattern)).toBe(true);
    expect(matchesSourcePattern(url("other/tools"), pattern)).toBe(false);
  });

  it("a host-wide wildcard matches every path", () => {
    const pattern = parseSourcePattern("https://git.corp.example/*");
    expect(matchesSourcePattern(url("https://git.corp.example/x/y"), pattern)).toBe(true);
  });

  it.each(["https://github.com/*/tools*", "https://github.com/*/tools", "file:///x*", "host:", "host:a/b", "host:git.corp.example:8080", "host:-x.example"])("rejects pattern %j", (text) => {
    expect(() => parseSourcePattern(text)).toThrow(MarketplaceError);
  });
});
