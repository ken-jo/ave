import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import remarkGfm from "remark-gfm";
import { MARKDOWN_REMARK_PLUGINS, remarkKoreanAdjacentStrong } from "../markdown-plugins.js";

// All markdown consumers must import the shared remark configuration; source scans reject private option copies.

describe("MARKDOWN_REMARK_PLUGINS shared config", () => {
  it("exposes the shared plugin entries", () => {
    expect(MARKDOWN_REMARK_PLUGINS).toBeDefined();
    expect(MARKDOWN_REMARK_PLUGINS).toHaveLength(2);
  });

  it("plugin is remark-gfm with singleTilde disabled", () => {
    const list = MARKDOWN_REMARK_PLUGINS as Array<[unknown, { singleTilde: boolean }] | unknown>;
    expect(Array.isArray(list[0])).toBe(true);
    const gfm = list[0] as [unknown, { singleTilde: boolean }];
    expect(gfm[0]).toBe(remarkGfm);
    expect(gfm[1]).toEqual({ singleTilde: false });
  });

  it("includes the Korean adjacent strong normalizer", () => {
    expect(MARKDOWN_REMARK_PLUGINS?.[1]).toBe(remarkKoreanAdjacentStrong);
  });
});

/** Scan consumers for private remark-gfm imports or inline options so shared markdown configuration cannot be bypassed. */
function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        if (name === "node_modules" || name === "dist") continue;
        stack.push(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
  }
  return out;
}

describe("MARKDOWN_REMARK_PLUGINS — SoT drift guard (issue #507)", () => {
  // Normalize separators so the allowlist matches on Windows + POSIX.
  const ALLOWLIST = new Set(
    [
      "src/ui/renderer/utils/markdown-plugins.ts",
      "src/ui/renderer/utils/__tests__/markdown-plugins.test.ts",
    ].map((p) => p.replace(/\\/g, "/")),
  );

  it("no source file outside the SoT imports remark-gfm directly", () => {
    const files = listSourceFiles("src").map((f) => f.replace(/\\/g, "/"));
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      const text = readFileSync(file, "utf-8");
      // Match either ESM import or require(). Bare `remark-gfm` mentions in comments still count as a smell — strip line/block
      // comments first.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (/\bremark-gfm\b/.test(stripped) || /\bremarkGfm\b/.test(stripped)) {
        violations.push(file);
      }
    }
    expect(violations, "remark-gfm must only be referenced from the MARKDOWN_REMARK_PLUGINS SoT").toEqual([]);
  });

  it("no renderer component inlines remarkPlugins={[...]} arrays", () => {
    // Catches the regression mode the constant test cannot catch: a consumer
    // that passes its own array literal to <ReactMarkdown remarkPlugins={[…]}>
    // (bypassing MARKDOWN_REMARK_PLUGINS) is detectable without LSP because
    // valid call sites use the named import directly:
    //   <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
    const files = listSourceFiles("src/ui/renderer").map((f) => f.replace(/\\/g, "/"));
    const inline: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      const text = readFileSync(file, "utf-8");
      if (/remarkPlugins\s*=\s*\{\s*\[/.test(text)) inline.push(file);
    }
    expect(inline, "remarkPlugins must reference MARKDOWN_REMARK_PLUGINS, not an inline array").toEqual([]);
  });
});
