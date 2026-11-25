// Chunk argument lists below the Windows command-line limit without dropping files.
import { describe, expect, it } from "vitest";

import {
  COMMAND_LINE_BUDGET_CHARS,
  commandLineLength,
  splitArgumentsWithinBudget,
} from "../../scripts/hooks/spawn-command.mjs";

const directRun = (chunk: string[]) => ["run", "test:vitest", "--", "run", ...chunk];

// Pad the final file argument to reach the exact command-line boundary.
function filesTotalling(command: string, prefix: string[], target: number): string[] {
  const files: string[] = [];
  let length = commandLineLength(command, prefix);
  for (let index = 0; ; index += 1) {
    const file = `./src/feature/__tests__/generated-${String(index).padStart(5, "0")}.test.ts`;
    const remaining = target - length;
    if (remaining < (file.length + 3) * 2) {
      const last = `./src/feature/__tests__/${"x".repeat(remaining - 3 - "./src/feature/__tests__/.test.ts".length)}.test.ts`;
      files.push(last);
      length += last.length + 3;
      break;
    }
    files.push(file);
    length += file.length + 3;
  }
  expect(length).toBe(target);
  return files;
}

describe("command-line budget", () => {
  it("is a fixed budget well under the Windows CreateProcess limit", () => {
    expect(COMMAND_LINE_BUDGET_CHARS).toBe(16_384);
    expect(COMMAND_LINE_BUDGET_CHARS).toBeLessThan(32_767);
  });

  it("keeps a list exactly at the budget in one spawn and splits it one character over", () => {
    const atBoundary = filesTotalling("bun", directRun([]), COMMAND_LINE_BUDGET_CHARS);
    expect(commandLineLength("bun", directRun(atBoundary))).toBe(COMMAND_LINE_BUDGET_CHARS);
    expect(splitArgumentsWithinBudget("bun", atBoundary, directRun)).toEqual([atBoundary]);

    const over = [...atBoundary.slice(0, -1), `${atBoundary.at(-1)!.slice(0, -3)}x.ts`];
    expect(commandLineLength("bun", directRun(over))).toBe(COMMAND_LINE_BUDGET_CHARS + 1);
    const chunks = splitArgumentsWithinBudget("bun", over, directRun);
    expect(chunks).toHaveLength(2);
    expect(chunks.flat()).toEqual(over);
  });

  it("covers a 50 KB list exactly once, in order, with every chunk inside the budget", () => {
    const files = filesTotalling("bun", directRun([]), 50_000);
    const chunks = splitArgumentsWithinBudget("bun", files, directRun);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.flat()).toEqual(files);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(commandLineLength("bun", directRun(chunk))).toBeLessThanOrEqual(COMMAND_LINE_BUDGET_CHARS);
    }
  });

  it("measures each chunk with its own per-chunk arguments and yields nothing for an empty list", () => {
    const withReport = (chunk: string[], index: number) => [`--outputFile=/r/${"i".repeat(index)}.json`, ...chunk];
    const files = filesTotalling("bun", [], 40_000);
    const chunks = splitArgumentsWithinBudget("bun", files, withReport);
    expect(chunks.flat()).toEqual(files);
    chunks.forEach((chunk, index) =>
      expect(commandLineLength("bun", withReport(chunk, index))).toBeLessThanOrEqual(COMMAND_LINE_BUDGET_CHARS));
    expect(splitArgumentsWithinBudget("bun", [], directRun)).toEqual([]);
  });

  it("throws on an argument that cannot fit even alone instead of dropping it", () => {
    expect(() => splitArgumentsWithinBudget("bun", ["./ok.test.ts", `./${"y".repeat(COMMAND_LINE_BUDGET_CHARS)}.test.ts`], directRun))
      .toThrow("[command-line-budget-exceeded]");
  });
});
