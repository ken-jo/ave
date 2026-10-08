/**
 * The validator's code stays out of the running app, and the protocol
 * session keeps exactly two production callers
 * (`docs/design/plugin-hostapi-protocol.md` §9.7, S1).
 *
 *  - Nothing the main process, the boot sequence or the plugin runtime loads
 *    reaches `src/plugins/validate/`: the validation host serves recorded
 *    answers, and a running app that reached it would be serving them too.
 *  - Among production modules, `plugin-protocol-session.ts` is imported by
 *    the factory and by the validation session and by nothing else, so a
 *    child is either spawned confined by the factory or handed over by the
 *    validator — there is no third way to open the protocol on one.
 *  - `observeChild` is named by no production module but the factory that
 *    defines it, so no runtime caller observes a child or ends its input.
 *
 * The graph is the one `scripts/check-import-cycles.mjs` builds — the same
 * resolver, the same runtime-only edges — with the dynamic `import("…")` of a
 * reached module added, so a lazy import cannot step around the first rule.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeImportGraph } from "../../../scripts/check-import-cycles.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const graph = buildRuntimeImportGraph(SRC);

/** `src`-relative and `/`-separated, so a failure names a file readably on every platform. */
function display(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

/** A module the app ships: not a test, a test helper or a probe. */
function isProduction(file: string): boolean {
  const name = display(file);
  return !/(^|\/)__tests__\//u.test(name)
    && !/(^|\/)__probes__\//u.test(name)
    && !/\.test\.tsx?$/u.test(name);
}

const DYNAMIC_IMPORT = /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu;

/** The local modules `file` loads with a dynamic `import("./…")`. */
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

/** Every module reachable from `entries` at runtime. */
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
    // The factory IS reached, so the walk goes through the isolation directory.
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
