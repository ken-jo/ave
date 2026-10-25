/** Scan source because module-load path constants cannot be tested by setting AVE_HOME after import. */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

const SRC_ROOT = pathResolve(__dirname, "../..");

// Only aveHome may compose the real home root directly.
const ALLOWED_FILE = pathResolve(SRC_ROOT, "shared/ave-home.ts");

const VIOLATION_PATTERNS: RegExp[] = [
  /(?:join|resolve|pathResolve|path\.join|path\.resolve)\(\s*(?:os\.)?homedir\(\)\s*,\s*"\.ave"/,
  /\$\{\s*(?:os\.)?homedir\(\)\s*\}\/\.ave/,
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      // Test scaffolding may compose synthetic home paths.
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(p, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      acc.push(p);
    }
  }
  return acc;
}

describe("issue #735 — homedir() + '.ave' composition is centralized in aveHome()", () => {
  it("no source file outside src/shared/ave-home.ts composes ~/.ave paths directly", () => {
    const files = walk(SRC_ROOT);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      if (file === ALLOWED_FILE) continue;
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        if (VIOLATION_PATTERNS.some((rx) => rx.test(line))) {
          violations.push({ file, line: idx + 1, text: line.trim() });
        }
      });
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line}\n    ${v.text}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} files composing ~/.ave paths directly via homedir(). ` +
          `Use aveHome() from src/shared/ave-home.ts instead so AVE_HOME env override is honored.\n${msg}`,
      );
    }

    expect(violations).toEqual([]);
  });
});
