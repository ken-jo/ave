/**
 * Project AGENTS.md discovery leaf — unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
      // Windows without privilege can't symlink — skip the assertion there.
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
});
