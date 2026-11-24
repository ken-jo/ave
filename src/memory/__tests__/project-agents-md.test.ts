/** Project AGENTS.md discovery leaf; unit tests. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, type SpawnOptions } from "node:child_process";

const gitCalls = vi.hoisted(() => ({
  checkIgnore: [] as string[],
  lastEnv: undefined as NodeJS.ProcessEnv | undefined,
  lastCwd: undefined as string | undefined,
  traceEnv: undefined as NodeJS.ProcessEnv | undefined,
  versionFixture: undefined as string | undefined,
  explicitFixture: undefined as string | undefined,
  ignoreFixture: undefined as { path: string; patterns: string[] } | undefined,
  intercept: undefined as ((args: readonly string[]) => Buffer) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((file: string, args: readonly string[], options: SpawnOptions) => {
      if (file === gitCalls.versionFixture && args.includes("--version")) return gitProbeChild((complete) => complete("git version 2.56.0"));
      if (args.includes("check-ignore")) {
        gitCalls.checkIgnore.push(file);
        gitCalls.lastEnv = options.env;
        gitCalls.lastCwd = options.cwd?.toString();
        if (gitCalls.intercept || gitCalls.ignoreFixture?.path === file) {
          // A thrown numeric code is the exit status the answer ends with; any other throw is a process that could not run.
          let ended: number | Error = 0;
          try {
            if (gitCalls.intercept) gitCalls.intercept(args);
            else {
              const target = args.at(-1)?.replaceAll("\\", "/") ?? "";
              const ignored = gitCalls.ignoreFixture?.patterns.some((pattern) => pattern.endsWith("/") ? target.startsWith(pattern) : target === pattern);
              if (!ignored) throw Object.assign(new Error("not ignored"), { code: 1 });
            }
          } catch (error) {
            const { code } = error as { code?: unknown };
            ended = typeof code === "number" ? code : error as Error;
          }
          const child = gitProbeChild((complete) => {
            if (typeof ended === "number") complete("", ended);
            else child.emit("error", ended);
          });
          return child;
        }
        options = { ...options, env: { ...options.env, ...FIXTURE_GIT_CONFIG, ...gitCalls.traceEnv } };
      }
      return actual.spawn(file, args, options);
    }) as typeof actual.spawn,
  };
});
vi.mock("../../shared/host-git-executable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/host-git-executable.js")>();
  return {
    ...actual,
    withHostGitLaunch: ((packaged, use) => {
      const path = gitCalls.explicitFixture ?? gitCalls.ignoreFixture?.path;
      return path ? use({ path, options: { env: { GIT_ALLOW_PROTOCOL: "" } } }) : actual.withHostGitLaunch(packaged, use);
    }) as typeof actual.withHostGitLaunch,
  };
});
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import {
  discoverDirectoryInstructions,
  discoverProjectAgentsMd,
  PROJECT_AGENTS_MD_MAX_TOTAL_BYTES,
  PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH,
} from "../project-agents-md.js";
import { gitProbeChild } from "../../__tests__/support/git-probe-child.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { requireFixtureGit } from "../../__tests__/support/fixture-git-executable.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { holdSandboxGitWrites } from "../../shared/host-git.js";

const FIXTURE_GIT_CONFIG = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
};

function initIgnoredBuild(
  project: string,
  patterns: string,
  layout: "nested" | "recursive" | "plain",
) {
  mkdirSync(join(project, ".git"));
  gitCalls.ignoreFixture = { path: join(project, "fixture-git"), patterns: patterns.trim().split("\n") };
  if (layout !== "plain") mkdirSync(layout === "nested" ? join(project, "build", "out") : join(project, "build"), { recursive: true });
  else mkdirSync(join(project, "build"));
  writeFileSync(join(project, "build", "AGENTS.md"), "generated rule");
}

it("uses an absolute host Git path even with an executable in the project and relative PATH entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-git-path-"));
  const project = join(root, "project");
  const host = join(root, "host-bin");
  const binary = process.platform === "win32" ? "git.exe" : "git";
  const cwd = process.cwd();
  try {
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, "build"));
    mkdirSync(host);
    writeFileSync(join(project, "build", "AGENTS.md"), "fixture instructions");
    writeFileSync(join(project, binary), "project sentinel", { mode: 0o755 });
    writeFileSync(join(host, binary), "host fixture", { mode: 0o755 });
    process.chdir(project);
    vi.stubEnv("PATH", ["", ".", "", host].join(delimiter));
    vi.stubEnv("PATHEXT", ".CMD;.BAT;.EXE");
    vi.resetModules();
    gitCalls.versionFixture = join(host, binary);
    gitCalls.intercept = () => Buffer.alloc(0);
    const before = gitCalls.checkIgnore.length;
    const { discoverDirectoryInstructions: discover } = await import("../project-agents-md.js");
    expect(await discover(project, join("build", "x.js"), new Set())).toEqual([]);
    expect(gitCalls.checkIgnore.slice(before)).toEqual([join(host, binary)]);
  } finally {
    gitCalls.versionFixture = undefined;
    gitCalls.intercept = undefined;
    vi.unstubAllEnvs();
    process.chdir(cwd);
    await cleanupTmpDir(root);
  }
});

it.each([
  { platform: "win32", configured: "C:/example/tools/git.exe", expected: "C:\\example\\tools\\git.exe" },
  { platform: "win32", configured: "C:\\example\\tools\\git-2.56.0.exe", expected: "C:\\example\\tools\\git-2.56.0.exe" },
  { platform: "linux", configured: "/example/tools/link/../bin/git", expected: "/example/tools/link/../bin/git" },
] as const)("runs the ignore query using the explicitly selected fixture $configured", async ({ platform, configured, expected }) => {
  const project = mkdtempSync(join(tmpdir(), "ave-explicit-git-"));
  const originalPlatform = process.platform;
  try {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, "build"));
    writeFileSync(join(project, "build", "AGENTS.md"), "generated rule");
    setProcessPlatform(platform);
    vi.stubEnv("AVE_TEST_GIT_EXECUTABLE", configured);
    vi.stubEnv("PATH", (platform === "win32" ? win32 : posix).dirname(configured));
    const spawn = vi.fn(() => ({
      pid: 1, status: 0, signal: null, stdout: "git version 2.56.0", stderr: "", output: [null, "git version 2.56.0", ""],
    }));
    gitCalls.explicitFixture = requireFixtureGit(spawn).path;
    gitCalls.intercept = () => Buffer.alloc(0);
    vi.resetModules();
    const { discoverDirectoryInstructions: discover } = await import("../project-agents-md.js");
    const before = gitCalls.checkIgnore.length;

    await discover(project, join("build", "file.ts"), new Set());
    expect(gitCalls.checkIgnore.slice(before)).toEqual([expected]);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expected, ["--no-lazy-fetch", "--version"], expect.anything());
  } finally {
    setProcessPlatform(originalPlatform);
    gitCalls.explicitFixture = undefined;
    gitCalls.intercept = undefined;
    vi.unstubAllEnvs();
    await cleanupTmpDir(project);
  }
});

it("keeps the ignore query local when a skip-worktree ignore blob is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-ignore-blob-"));
  const source = join(root, "source");
  const project = join(root, "project");
  const trace = join(root, "git-trace.jsonl");
  try {
    const fixture = requireFixtureGit();
    const git = (...args: string[]) => execFileSync(fixture.path, args, fixture.options);
    git("init", "-q", source);
    git("-C", source, "config", "uploadpack.allowFilter", "true");
    git("-C", source, "config", "uploadpack.allowAnySHA1InWant", "true");
    writeFileSync(join(source, ".gitignore"), "build/\n");
    git("-C", source, "add", ".gitignore");
    git("-C", source, "-c", "user.name=Example", "-c", "user.email=git@example.test", "commit", "-qm", "fixture");
    const ignoreBlob = git("-C", source, "rev-parse", "HEAD:.gitignore").trim();
    const inspectBlob = () => execFileSync(
      fixture.path, ["--no-lazy-fetch", "-C", project, "cat-file", "--batch-check"],
      { ...fixture.options, input: `${ignoreBlob}\n` },
    ).trim();
    git("clone", "-q", "--filter=blob:none", "--no-checkout", "-c", "protocol.file.allow=always", pathToFileURL(source).href, project);
    git("-C", project, "read-tree", "HEAD");
    git("-C", project, "update-index", "--skip-worktree", ".gitignore");
    expect(git("-C", project, "ls-files", "-t", ".gitignore").trim()).toBe("S .gitignore");
    expect(existsSync(join(project, ".gitignore"))).toBe(false);
    expect(inspectBlob()).toBe(`${ignoreBlob} missing`);
    mkdirSync(join(project, "build"));
    writeFileSync(join(project, "build", "AGENTS.md"), "fixture instructions");

    gitCalls.traceEnv = { GIT_TRACE2_EVENT: trace };
    gitCalls.explicitFixture = fixture.path;
    const { discoverDirectoryInstructions: discover } = await import("../project-agents-md.js");
    const before = gitCalls.checkIgnore.length;
    const layers = await discover(project, join("build", "x.js"), new Set());
    expect(gitCalls.checkIgnore.slice(before)).toEqual([fixture.path]);
    const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "cmd_name", name: "check-ignore" })]));
    expect(events.filter((event) => event.event === "child_start").map((event) => event.argv)).toEqual([]);
    expect(inspectBlob()).toBe(`${ignoreBlob} missing`);
    expect(layers.map((layer) => layer.content)).toEqual(["fixture instructions"]);
  } finally {
    gitCalls.explicitFixture = undefined;
    gitCalls.traceEnv = undefined;
    await cleanupTmpDir(root);
  }
});

it("rediscovers when the cached Git cannot launch check-ignore", async () => {
  const project = mkdtempSync(join(tmpdir(), "ave-ignore-git-launch-"));
  const dirs = [join(project, "first"), join(project, "second")] as const;
  const binary = process.platform === "win32" ? "git.exe" : "git";
  const first = join(dirs[0], binary);
  const second = join(dirs[1], binary);
  try {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, "build"));
    writeFileSync(join(project, "build", "AGENTS.md"), "generated rule");
    for (const dir of dirs) {
      mkdirSync(dir);
      writeFileSync(join(dir, binary), "fixture executable", { mode: 0o755 });
    }
    vi.stubEnv("PATH", dirs.join(delimiter));
    vi.resetModules();
    const { discoverDirectoryInstructions: discover } = await import("../project-agents-md.js");
    gitCalls.versionFixture = first;
    gitCalls.intercept = () => Buffer.alloc(0);
    await expect(discover(project, join("build", "file.ts"), new Set())).resolves.toEqual([]);

    const before = gitCalls.checkIgnore.length;
    gitCalls.versionFixture = second;
    gitCalls.intercept = () => {
      if (gitCalls.checkIgnore.at(-1) === first) throw Object.assign(new Error("cannot launch"), { code: "ENOENT", path: first });
      return Buffer.alloc(0);
    };
    await expect(discover(project, join("build", "file.ts"), new Set())).resolves.toEqual([]);
    expect(gitCalls.checkIgnore.slice(before)).toEqual([first, second]);
  } finally {
    gitCalls.versionFixture = undefined;
    gitCalls.intercept = undefined;
    vi.unstubAllEnvs();
    await cleanupTmpDir(project);
  }
});

it("strips inherited Git variables case-insensitively on Windows", async () => {
  const project = mkdtempSync(join(tmpdir(), "ave-ignore-env-"));
  const originalPlatform = process.platform;
  try {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, "build"));
    writeFileSync(join(project, "build", "AGENTS.md"), "fixture instructions");
    const fixture = join(project, process.platform === "win32" ? "git.exe" : "git");
    writeFileSync(fixture, "fixture executable", { mode: 0o755 });
    gitCalls.versionFixture = fixture;
    vi.stubEnv("PATH", project);
    vi.resetModules();
    const { discoverDirectoryInstructions: discover } = await import("../project-agents-md.js");
    gitCalls.intercept = () => Buffer.alloc(0);
    await discover(project, join("build", "x.js"), new Set());
    setProcessPlatform("win32");
    vi.stubEnv("Git_ExeC_PatH", join(project, "helper"));
    vi.stubEnv("GIT_DIR", join(project, "elsewhere"));
    gitCalls.lastEnv = undefined;
    await discover(project, join("build", "x.js"), new Set());
    expect(gitCalls.lastEnv).toBeDefined();
    expect(gitCalls.lastEnv).not.toHaveProperty("Git_ExeC_PatH");
    expect(gitCalls.lastEnv).not.toHaveProperty("GIT_DIR");
  } finally {
    gitCalls.versionFixture = undefined;
    setProcessPlatform(originalPlatform);
    gitCalls.intercept = undefined;
    vi.unstubAllEnvs();
    await cleanupTmpDir(project);
  }
});

describe("discoverProjectAgentsMd", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-proj-agents-"));
  });
  afterEach(async () => {
    await cleanupTmpDir(root);
  });

  it("(a) returns the layer for <root>/AGENTS.md", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Project rules\nUse tabs.");
    const found = discoverProjectAgentsMd(root);
    expect(found.layers).toHaveLength(1);
    expect(found.layers[0].relativePath).toBe("AGENTS.md");
    expect(found.layers[0].content).toContain("Use tabs.");
    expect(found.layers[0].truncated).toBe(false);
    expect(found.totalBytes).toBeGreaterThan(0);
  });

  it("(b) returns empty layers when the file is absent", () => {
    const found = discoverProjectAgentsMd(root);
    expect(found.layers).toHaveLength(0);
    expect(found.totalBytes).toBe(0);
  });

  it("(c) drops a whitespace-only file", () => {
    writeFileSync(join(root, "AGENTS.md"), "   \n\t\n  ");
    expect(discoverProjectAgentsMd(root).layers).toHaveLength(0);
  });

  it("(d) truncates a file over the byte budget and stays within budget", () => {
    const big = "x".repeat(PROJECT_AGENTS_MD_MAX_TOTAL_BYTES + 5000);
    writeFileSync(join(root, "AGENTS.md"), big);
    const found = discoverProjectAgentsMd(root);
    expect(found.layers).toHaveLength(1);
    expect(found.layers[0].truncated).toBe(true);
    expect(found.totalBytes).toBeLessThanOrEqual(PROJECT_AGENTS_MD_MAX_TOTAL_BYTES);
  });

  it("(e) normalizes CRLF to LF in the returned content", () => {
    writeFileSync(join(root, "AGENTS.md"), "line1\r\nline2\r\n");
    const content = discoverProjectAgentsMd(root).layers[0].content;
    expect(content).not.toContain("\r\n");
    expect(content).toContain("line1\nline2");
  });

  it("(f) skips an AGENTS.md symlink whose realpath escapes the root", async () => {
    // Write the real target OUTSIDE the project root.
    const outside = mkdtempSync(join(tmpdir(), "ave-outside-"));
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "# secret host file that must not leak");
    let symlinked = false;
    try {
      symlinkSync(secret, join(root, "AGENTS.md"));
      symlinked = true;
    } catch {
      // Windows without privilege can't symlink; skip the assertion there.
    }
    try {
      if (symlinked) {
        const found = discoverProjectAgentsMd(root);
        expect(found.layers).toHaveLength(0); // escaping symlink not read
      }
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("(g) treats a directory named AGENTS.md as absent (EISDIR)", () => {
    mkdirSync(join(root, "AGENTS.md"));
    expect(discoverProjectAgentsMd(root).layers).toHaveLength(0);
  });
});

describe("project instruction chain", () => {
  let repo: string;
  let project: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ave-proj-chain-"));
    mkdirSync(join(repo, ".git"));
    project = join(repo, "packages", "app");
    mkdirSync(project, { recursive: true });
  });
  afterEach(async () => {
    await cleanupTmpDir(repo);
  });

  it("walks from the repository root down to the project root, closest last", () => {
    writeFileSync(join(repo, "AGENTS.md"), "root rule");
    writeFileSync(join(repo, "packages", "AGENTS.md"), "packages rule");
    writeFileSync(join(project, "AGENTS.md"), "app rule");
    const found = discoverProjectAgentsMd(project);
    expect(found.layers.map((layer) => layer.relativePath)).toEqual([
      "AGENTS.md",
      join("packages", "AGENTS.md"),
      join("packages", "app", "AGENTS.md"),
    ]);
    const joined = found.layers.map((layer) => layer.content).join("\n");
    expect(joined.indexOf("root rule")).toBeLessThan(joined.indexOf("packages rule"));
    expect(joined.indexOf("packages rule")).toBeLessThan(joined.indexOf("app rule"));
  });

  it("treats a worktree's .git file as the repository root", () => {
    const worktree = mkdtempSync(join(tmpdir(), "ave-proj-worktree-"));
    try {
      writeFileSync(join(worktree, ".git"), "gitdir: elsewhere");
      writeFileSync(join(worktree, "AGENTS.md"), "worktree rule");
      mkdirSync(join(worktree, "sub"));
      expect(discoverProjectAgentsMd(join(worktree, "sub")).layers[0]?.content).toContain("worktree rule");
    } finally {
      void cleanupTmpDir(worktree);
    }
  });

  it("falls back to CLAUDE.md per directory only when AGENTS.md is absent or empty", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "root fallback");
    writeFileSync(join(project, "AGENTS.md"), "app rule");
    writeFileSync(join(project, "CLAUDE.md"), "app fallback must not load");
    const joined = discoverProjectAgentsMd(project).layers.map((layer) => layer.content).join("\n");
    expect(joined).toContain("root fallback");
    expect(joined).toContain("app rule");
    expect(joined).not.toContain("app fallback must not load");
  });

  it("appends @imports relative to the importing file and skips code", () => {
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "style.md"), "style guide body");
    writeFileSync(join(project, "docs", "fenced.md"), "fenced body");
    writeFileSync(join(project, "docs", "span.md"), "span body");
    writeFileSync(join(project, "AGENTS.md"), [
      "See @docs/style.md.",
      "Inline `@docs/span.md` is code.",
      "```",
      "@docs/fenced.md",
      "```",
      "Mention @someone without a file.",
    ].join("\n"));
    const content = discoverProjectAgentsMd(project).layers[0]!.content;
    expect(content).toContain("style guide body");
    expect(content).not.toContain("span body");
    expect(content).not.toContain("fenced body");
  });

  it("refuses imports that leave the repository and stops at the depth limit", () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-proj-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "secret body");
      const chain = Array.from({ length: PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH + 2 }, (_, index) => `hop${index}.md`);
      chain.forEach((name, index) => {
        const next = chain[index + 1];
        writeFileSync(join(project, name), `body ${index}${next ? ` @${next}` : ""}`);
      });
      writeFileSync(join(project, "AGENTS.md"), [
        `@${join(outside, "secret.md")}`,
        `@../../../${outside.split("/").pop()}/secret.md`,
        "@~/secret.md",
        `@${chain[0]}`,
        "@AGENTS.md",
      ].join("\n"));
      const content = discoverProjectAgentsMd(project).layers[0]!.content;
      expect(content).not.toContain("secret body");
      expect(content).toContain(`body ${PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH - 1}`);
      expect(content).not.toContain(`body ${PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH}`);
    } finally {
      void cleanupTmpDir(outside);
    }
  });

  it("rejects an @import that climbs to a credentials file, even inside the repository", () => {
    mkdirSync(join(repo, ".aws"));
    writeFileSync(join(repo, ".aws", "credentials"), "aws_secret_access_key = in-repo");
    writeFileSync(join(repo, ".env"), "TOKEN=in-repo-env");
    writeFileSync(join(project, "AGENTS.md"), [
      "@../../.aws/credentials",
      "@../../../../.aws/credentials",
      "@../../.env",
      "app rule",
    ].join("\n"));
    const content = discoverProjectAgentsMd(project).layers[0]!.content;
    expect(content).toContain("app rule");
    expect(content).not.toContain("aws_secret_access_key");
    expect(content).not.toContain("in-repo-env");
  });

  it("shares one budget across layers and drops what follows the clamped layer", () => {
    writeFileSync(join(repo, "AGENTS.md"), "r".repeat(PROJECT_AGENTS_MD_MAX_TOTAL_BYTES + 10));
    writeFileSync(join(project, "AGENTS.md"), "app rule");
    const found = discoverProjectAgentsMd(project);
    expect(found.layers).toHaveLength(1);
    expect(found.layers[0]!.truncated).toBe(true);
    expect(found.totalBytes).toBeLessThanOrEqual(PROJECT_AGENTS_MD_MAX_TOTAL_BYTES);
  });

  it("watches every candidate on the chain, including files that do not exist yet", () => {
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "style.md"), "style");
    writeFileSync(join(project, "AGENTS.md"), "@docs/style.md");
    const watched = discoverProjectAgentsMd(project).watchedPaths;
    const real = realpathSync(repo);
    expect(watched).toEqual(expect.arrayContaining([
      join(real, "AGENTS.md"),
      join(real, "CLAUDE.md"),
      join(real, "packages", "AGENTS.md"),
    ]));
    expect(watched.some((path) => path.endsWith(join("docs", "style.md")))).toBe(true);
  });
});

describe("home-bounded repository climb", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ave-proj-home-"));
  });
  afterEach(async () => {
    await cleanupTmpDir(home);
  });

  it("does not climb to a dotfiles repository at the home directory", () => {
    mkdirSync(join(home, ".git"));
    writeFileSync(join(home, "AGENTS.md"), "personal home rule");
    mkdirSync(join(home, ".aws"));
    writeFileSync(join(home, ".aws", "credentials"), "aws_secret_access_key = home");
    const project = join(home, "work", "app");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "app rule\n@../../.aws/credentials\n@../../AGENTS.md");
    const found = discoverProjectAgentsMd(project, { homeDir: home });
    expect(found.layers.map((layer) => layer.relativePath)).toEqual(["AGENTS.md"]);
    const content = found.layers[0]!.content;
    expect(content).toContain("app rule");
    expect(content).not.toContain("personal home rule");
    expect(content).not.toContain("aws_secret_access_key");
    expect(found.watchedPaths.some((path) => path === join(realpathSync(home), "AGENTS.md"))).toBe(false);
  });

  it("does not climb to a repository above the home directory", () => {
    const outer = mkdtempSync(join(tmpdir(), "ave-proj-outer-"));
    try {
      mkdirSync(join(outer, ".git"));
      writeFileSync(join(outer, "AGENTS.md"), "above home rule");
      const nestedHome = join(outer, "home");
      const project = join(nestedHome, "app");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "AGENTS.md"), "app rule");
      const found = discoverProjectAgentsMd(project, { homeDir: nestedHome });
      expect(found.layers.map((layer) => layer.content)).toEqual(["app rule"]);
    } finally {
      void cleanupTmpDir(outer);
    }
  });

  it("still climbs to a monorepo root below the home directory", () => {
    const repo = join(home, "code", "mono");
    const project = join(repo, "packages", "a");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "mono rule");
    writeFileSync(join(project, "AGENTS.md"), "package rule");
    const found = discoverProjectAgentsMd(project, { homeDir: home });
    expect(found.layers.map((layer) => layer.relativePath)).toEqual([
      "AGENTS.md",
      join("packages", "a", "AGENTS.md"),
    ]);
  });

  it("loads the home directory's own file only when it is the project root", () => {
    mkdirSync(join(home, ".git"));
    writeFileSync(join(home, "AGENTS.md"), "home project rule");
    expect(discoverProjectAgentsMd(home, { homeDir: home }).layers[0]?.content).toContain("home project rule");
  });
});

describe("discoverDirectoryInstructions", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "ave-proj-dir-"));
    mkdirSync(join(project, "src", "api"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "launch layer");
    writeFileSync(join(project, "src", "AGENTS.md"), "src rule");
    writeFileSync(join(project, "src", "api", "CLAUDE.md"), "api rule");
  });
  afterEach(async () => {
    gitCalls.ignoreFixture = undefined;
    await cleanupTmpDir(project);
  });

  it("returns the files between the project root and the touched path, root-first", async () => {
    const layers = await discoverDirectoryInstructions(project, join("src", "api", "handler.ts"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule", "api rule"]);
  });

  it("skips files already attached and never repeats the launch layer", async () => {
    const attached = new Set([join("src", "AGENTS.md")]);
    const layers = await discoverDirectoryInstructions(project, join(project, "src", "api"), attached);
    expect(layers.map((layer) => layer.relativePath)).toEqual([join("src", "api", "CLAUDE.md")]);
    expect(await discoverDirectoryInstructions(project, "README.md", new Set())).toEqual([]);
  });

  it("ignores paths outside the project root", async () => {
    expect(await discoverDirectoryInstructions(project, join(tmpdir(), "elsewhere", "x.ts"), new Set())).toEqual([]);
    expect(await discoverDirectoryInstructions(project, "../outside.ts", new Set())).toEqual([]);
  });

  it("stops at node_modules", async () => {
    mkdirSync(join(project, "src", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(project, "src", "node_modules", "AGENTS.md"), "node_modules rule");
    writeFileSync(join(project, "src", "node_modules", "dep", "AGENTS.md"), "dependency rule");
    const layers = await discoverDirectoryInstructions(project, join("src", "node_modules", "dep", "index.js"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule"]);
  });

  it("stops at a nested repository whose .git is a directory", async () => {
    mkdirSync(join(project, "src", "vendor", "clone", ".git"), { recursive: true });
    mkdirSync(join(project, "src", "vendor", "clone", "lib"), { recursive: true });
    writeFileSync(join(project, "src", "vendor", "AGENTS.md"), "vendor dir rule");
    writeFileSync(join(project, "src", "vendor", "clone", "AGENTS.md"), "third-party rule");
    writeFileSync(join(project, "src", "vendor", "clone", "lib", "AGENTS.md"), "third-party lib rule");
    const layers = await discoverDirectoryInstructions(project, join("src", "vendor", "clone", "lib", "x.ts"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule", "vendor dir rule"]);
  });

  it("stops at a submodule whose .git is a file", async () => {
    mkdirSync(join(project, "src", "sub"), { recursive: true });
    writeFileSync(join(project, "src", "sub", ".git"), "gitdir: ../../.git/modules/sub");
    writeFileSync(join(project, "src", "sub", "AGENTS.md"), "submodule rule");
    const layers = await discoverDirectoryInstructions(project, join("src", "sub", "file.ts"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule"]);
  });

  it("uses a deterministic ignore fixture even when PATH starts with unusable Git", async () => {
    const before = gitCalls.checkIgnore.length;
    const other = join(project, "other-bin");
    mkdirSync(other);
    writeFileSync(join(other, process.platform === "win32" ? "git.exe" : "git"), "unusable Git", { mode: 0o755 });
    vi.stubEnv("PATH", other);
    try {
      initIgnoredBuild(project, "build/\nsrc/api/CLAUDE.md\n", "nested");
      writeFileSync(join(project, "build", "out", "AGENTS.md"), "generated nested rule");
      expect(await discoverDirectoryInstructions(project, join("build", "out", "x.js"), new Set())).toEqual([]);
      const layers = await discoverDirectoryInstructions(project, join("src", "api", "handler.ts"), new Set());
      expect(layers.map((layer) => layer.content)).toEqual(["src rule"]);
      expect(new Set(gitCalls.checkIgnore.slice(before))).toEqual(new Set([join(project, "fixture-git")]));
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("asks git once per path for the session's repeated touches", async () => {
    initIgnoredBuild(project, "build/\n", "recursive");
    const verdicts = new Map<string, boolean>();
    const before = gitCalls.checkIgnore.length;
    for (let touch = 0; touch < 3; touch++) {
      expect(await discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts })).toEqual([]);
    }
    expect(gitCalls.checkIgnore.length - before).toBe(1);
    // A new session starts with an empty memo and asks again.
    verdicts.clear();
    await discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts });
    expect(gitCalls.checkIgnore.length - before).toBe(2);
  });

  it("does not query Git while unavailable and checks again for the same path when it appears", async () => {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, "build"));
    writeFileSync(join(project, "build", "AGENTS.md"), "generated rule");
    const resolve = vi.fn().mockReturnValue(null);
    vi.resetModules();
    vi.doMock("../../shared/host-git-executable.js", () => ({ withHostGitLaunch: (_packaged: boolean, use: (git: unknown) => unknown) => use(resolve()) }));
    try {
      const before = gitCalls.checkIgnore.length;
      const { discoverDirectoryInstructions: discover } = await import("../project-agents-md.js");
      const opts = { gitIgnoreVerdicts: new Map<string, boolean>() };
      const layers = await discover(project, join("build", "x.js"), new Set(), opts);
      expect(layers.map((layer) => layer.content)).toEqual(["generated rule"]);
      expect(gitCalls.checkIgnore).toHaveLength(before);
      const fixtureGit = join(project, "fixture-git");
      const options = { cwd: join(project, "installer"), env: { GIT_ALLOW_PROTOCOL: "" } };
      mkdirSync(options.cwd);
      resolve.mockReturnValue({ path: fixtureGit, options });
      gitCalls.intercept = () => Buffer.alloc(0);
      expect(await discover(project, join("build", "x.js"), new Set(), opts)).toEqual([]);
      expect(gitCalls.checkIgnore.slice(before)).toEqual([fixtureGit]);
      expect(gitCalls.lastEnv).toBe(options.env);
      expect(gitCalls.lastCwd).toBe(options.cwd);
    } finally {
      gitCalls.intercept = undefined;
      vi.doUnmock("../../shared/host-git-executable.js");
      vi.resetModules();
    }
  });

  it.each([129, 128, undefined])("retries an inconclusive Git ignore query after exit %s", async (status) => {
    mkdirSync(join(project, ".git"));
    const fixtureGit = join(project, "fixture-git");
    const resolve = () => ({ path: fixtureGit, options: { env: {} } });
    const unsupported = vi.fn(() => {
      throw Object.assign(new Error("Git query failed"), { code: status });
    });
    vi.resetModules();
    vi.doMock("../../shared/host-git-executable.js", () => ({ withHostGitLaunch: (_packaged: boolean, use: (git: unknown) => unknown) => use(resolve()) }));
    gitCalls.intercept = unsupported;
    try {
      const before = gitCalls.checkIgnore.length;
      const { discoverDirectoryInstructions: discover } = await import("../project-agents-md.js");
      const verdicts = new Map<string, boolean>();
      const opts = { gitIgnoreVerdicts: verdicts };
      const layers = await discover(project, join("src", "handler.ts"), new Set(), opts);
      expect(gitCalls.checkIgnore.slice(before)).toEqual([fixtureGit]);
      expect(unsupported).toHaveBeenCalledWith(expect.arrayContaining(["--no-lazy-fetch", "check-ignore"]));
      expect(layers.map((layer) => layer.content)).toEqual(["src rule"]);
      expect.soft(verdicts.size).toBe(0);
      gitCalls.intercept = () => { throw Object.assign(new Error("not ignored"), { code: 1 }); };
      expect(await discover(project, join("src", "handler.ts"), new Set(), opts)).toEqual(layers);
      expect([...verdicts.values()]).toEqual([false]);
      expect(gitCalls.checkIgnore.slice(before)).toEqual([fixtureGit, fixtureGit]);
    } finally {
      gitCalls.intercept = undefined;
      vi.doUnmock("../../shared/host-git-executable.js");
      vi.resetModules();
    }
  });

  it("defers workspace Git queries until sandbox cleanup releases the hold without caching the temporary answer", async () => {
    initIgnoredBuild(project, "build/\n", "plain");
    const verdicts = new Map<string, boolean>();
    const before = gitCalls.checkIgnore.length;
    const release = holdSandboxGitWrites([join(project, "build")]);
    try {
      const deferred = await discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts });
      expect(deferred.map((layer) => layer.content)).toEqual(["generated rule"]);
      expect(gitCalls.checkIgnore).toHaveLength(before);
      expect(verdicts.size).toBe(0);
    } finally {
      release();
    }
    expect(await discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts })).toEqual([]);
    expect(gitCalls.checkIgnore.length - before).toBe(1);
    expect([...verdicts.values()]).toEqual([true]);
  });

  it("uses a cached ignore verdict again only after the workspace hold is released", async () => {
    initIgnoredBuild(project, "build/\n", "plain");
    const opts = { gitIgnoreVerdicts: new Map<string, boolean>() };
    const target = join("build", "x.js");
    expect(await discoverDirectoryInstructions(project, target, new Set(), opts)).toEqual([]);
    expect([...opts.gitIgnoreVerdicts.values()]).toEqual([true]);
    const before = gitCalls.checkIgnore.length;
    const release = holdSandboxGitWrites([join(project, "build")]);
    try {
      const layers = await discoverDirectoryInstructions(project, target, new Set(), opts);
      expect(layers.map((layer) => layer.content)).toEqual(["generated rule"]);
    } finally { release(); }
    expect(await discoverDirectoryInstructions(project, target, new Set(), opts)).toEqual([]);
    expect(gitCalls.checkIgnore).toHaveLength(before);
  });
});
