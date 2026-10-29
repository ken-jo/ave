/** Project AGENTS.md discovery leaf; unit tests. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";

const gitCalls = vi.hoisted(() => ({ checkIgnore: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: ((file: string, args: readonly string[], options: object) => {
      if (file === "git" && args.includes("check-ignore")) gitCalls.checkIgnore += 1;
      return actual.execFileSync(file, args, options);
    }) as typeof actual.execFileSync,
  };
});
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverDirectoryInstructions,
  discoverProjectAgentsMd,
  PROJECT_AGENTS_MD_MAX_TOTAL_BYTES,
  PROJECT_INSTRUCTIONS_MAX_IMPORT_DEPTH,
} from "../project-agents-md.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { holdSandboxGitWrites } from "../../shared/host-git.js";

function initIgnoredBuild(project: string, patterns: string, layout: "nested" | "recursive" | "plain") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  execFileSync("git", ["init", "-q", project], { stdio: "ignore", env });
  writeFileSync(join(project, ".gitignore"), patterns);
  if (layout !== "plain") mkdirSync(layout === "nested" ? join(project, "build", "out") : join(project, "build"), { recursive: true });
  else mkdirSync(join(project, "build"));
  writeFileSync(join(project, "build", "AGENTS.md"), "generated rule");
}

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
    await cleanupTmpDir(project);
  });

  it("returns the files between the project root and the touched path, root-first", () => {
    const layers = discoverDirectoryInstructions(project, join("src", "api", "handler.ts"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule", "api rule"]);
  });

  it("skips files already attached and never repeats the launch layer", () => {
    const attached = new Set([join("src", "AGENTS.md")]);
    const layers = discoverDirectoryInstructions(project, join(project, "src", "api"), attached);
    expect(layers.map((layer) => layer.relativePath)).toEqual([join("src", "api", "CLAUDE.md")]);
    expect(discoverDirectoryInstructions(project, "README.md", new Set())).toEqual([]);
  });

  it("ignores paths outside the project root", () => {
    expect(discoverDirectoryInstructions(project, join(tmpdir(), "elsewhere", "x.ts"), new Set())).toEqual([]);
    expect(discoverDirectoryInstructions(project, "../outside.ts", new Set())).toEqual([]);
  });

  it("stops at node_modules", () => {
    mkdirSync(join(project, "src", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(project, "src", "node_modules", "AGENTS.md"), "node_modules rule");
    writeFileSync(join(project, "src", "node_modules", "dep", "AGENTS.md"), "dependency rule");
    const layers = discoverDirectoryInstructions(project, join("src", "node_modules", "dep", "index.js"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule"]);
  });

  it("stops at a nested repository whose .git is a directory", () => {
    mkdirSync(join(project, "src", "vendor", "clone", ".git"), { recursive: true });
    mkdirSync(join(project, "src", "vendor", "clone", "lib"), { recursive: true });
    writeFileSync(join(project, "src", "vendor", "AGENTS.md"), "vendor dir rule");
    writeFileSync(join(project, "src", "vendor", "clone", "AGENTS.md"), "third-party rule");
    writeFileSync(join(project, "src", "vendor", "clone", "lib", "AGENTS.md"), "third-party lib rule");
    const layers = discoverDirectoryInstructions(project, join("src", "vendor", "clone", "lib", "x.ts"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule", "vendor dir rule"]);
  });

  it("stops at a submodule whose .git is a file", () => {
    mkdirSync(join(project, "src", "sub"), { recursive: true });
    writeFileSync(join(project, "src", "sub", ".git"), "gitdir: ../../.git/modules/sub");
    writeFileSync(join(project, "src", "sub", "AGENTS.md"), "submodule rule");
    const layers = discoverDirectoryInstructions(project, join("src", "sub", "file.ts"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule"]);
  });

  it("skips instruction files git ignores", () => {
    initIgnoredBuild(project, "build/\nsrc/api/CLAUDE.md\n", "nested");
    writeFileSync(join(project, "build", "out", "AGENTS.md"), "generated nested rule");
    expect(discoverDirectoryInstructions(project, join("build", "out", "x.js"), new Set())).toEqual([]);
    const layers = discoverDirectoryInstructions(project, join("src", "api", "handler.ts"), new Set());
    expect(layers.map((layer) => layer.content)).toEqual(["src rule"]);
  });
  it("asks git once per path for the session's repeated touches", () => {
    initIgnoredBuild(project, "build/\n", "recursive");
    const verdicts = new Map<string, boolean>();
    const before = gitCalls.checkIgnore;
    for (let touch = 0; touch < 3; touch++) {
      expect(discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts })).toEqual([]);
    }
    expect(gitCalls.checkIgnore - before).toBe(1);
    // A new session starts with an empty memo and asks again.
    verdicts.clear();
    discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts });
    expect(gitCalls.checkIgnore - before).toBe(2);
  });

  it("defers workspace Git queries until sandbox cleanup releases the hold without caching the temporary answer", () => {
    initIgnoredBuild(project, "build/\n", "plain");
    const verdicts = new Map<string, boolean>();
    const before = gitCalls.checkIgnore;
    const release = holdSandboxGitWrites([join(project, "build")]);
    try {
      const deferred = discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts });
      expect(deferred.map((layer) => layer.content)).toEqual(["generated rule"]);
      expect(gitCalls.checkIgnore).toBe(before);
      expect(verdicts.size).toBe(0);
    } finally {
      release();
    }
    expect(discoverDirectoryInstructions(project, join("build", "x.js"), new Set(), { gitIgnoreVerdicts: verdicts })).toEqual([]);
    expect(gitCalls.checkIgnore - before).toBe(1);
    expect([...verdicts.values()]).toEqual([true]);
  });
});
