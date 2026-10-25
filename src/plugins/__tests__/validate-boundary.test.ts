// Validation serves recorded host answers and must stay unreachable from the app runtime.
// Only the runtime factory and validator may open production protocol sessions; dynamic imports count.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildRuntimeImportGraph } from "../../../scripts/check-import-cycles.mjs";
import { isProductionSourceModule, SOURCE_ROOT, sourceDisplayPath } from "./test-helpers.js";

const SRC = SOURCE_ROOT;
const graph = buildRuntimeImportGraph(SRC);

const display = sourceDisplayPath;
const isProduction = isProductionSourceModule;

const DYNAMIC_IMPORT = /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu;

function dynamicImports(file: string): string[] {
  const targets: string[] = [];
  for (const match of readFileSync(file, "utf-8").matchAll(DYNAMIC_IMPORT)) {
    const base = resolve(dirname(file), match[1]!);
    const candidate = [base.replace(/\.js$/u, ".ts"), base.replace(/\.js$/u, ".tsx"), `${base}.ts`]
      .find((path) => graph.has(path) && existsSync(path));
    if (candidate) targets.push(candidate);
  }
  return targets;
}

function reachableFrom(entries: readonly string[]): Set<string> {
  const reached = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const target of graph.get(file) ?? []) queue.push(target);
    for (const target of dynamicImports(file)) queue.push(target);
  }
  return reached;
}

const VALIDATE_DIR = "plugins/validate/";
const SESSION_MODULE = join(SRC, "plugins", "isolation", "plugin-protocol-session.ts");
const FACTORY_MODULE = join(SRC, "plugins", "isolation", "out-of-process-plugin.ts");

describe("the validator's code stays out of the running app", () => {
  it("is reached from neither the main process, the boot sequence nor the plugin runtime", () => {
    const entries = [...graph.keys()].filter((file) => {
      const name = display(file);
      return isProduction(file)
        && (name === "main.ts" || name.startsWith("boot/") || name.startsWith("plugins/runtime/"));
    });
    expect(entries.map(display)).toContain("main.ts");
    expect(entries.map(display)).toContain("plugins/runtime/index.ts");
    const reached = [...reachableFrom(entries)].map(display);
    // Ensure the graph walk actually reaches the isolation factory.
    expect(reached).toContain("plugins/isolation/out-of-process-plugin.ts");
    expect(reached.filter((name) => name.startsWith(VALIDATE_DIR))).toEqual([]);
  });
});

describe("the protocol session has exactly two production callers", () => {
  it("is imported by the factory and the validation session and nothing else", () => {
    const importers = [...graph.entries()]
      .filter(([file, targets]) => isProduction(file) && targets.has(SESSION_MODULE))
      .map(([file]) => display(file))
      .sort();
    expect(importers).toEqual([
      "plugins/isolation/out-of-process-plugin.ts",
      "plugins/validate/validation-session.ts",
    ]);
  });
});

describe("no runtime caller observes a production child", () => {
  it("names observeChild only in the factory that defines it", () => {
    const naming = [...graph.keys()]
      .filter((file) => isProduction(file) && file !== FACTORY_MODULE)
      .filter((file) => /\bobserveChild\b/u.test(readFileSync(file, "utf-8")))
      .map(display);
    expect(naming).toEqual([]);
  });
});
