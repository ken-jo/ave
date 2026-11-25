import { createRequire, isBuiltin } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildRuntimeImportGraph, normalizeDisplayPath } from "../../scripts/check-import-cycles.mjs";

it("keeps Node built-ins out of the renderer's static source imports", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const configs = createRequire(import.meta.url)("../../webpack.config.cjs") as {
    name: string;
    entry: Record<string, string>;
  }[];
  const renderer = configs.find((config) => config.name === "renderer");
  if (!renderer) throw new Error("Renderer entries are missing from the bundler config");

  const entrypoints = [
    ...Object.values(renderer.entry),
    resolve(root, "src/ui/renderer/components/ToolApprovalContent.tsx"),
    resolve(root, "src/shared/shell-execution-environment.ts"),
  ];
  const graph = buildRuntimeImportGraph(resolve(root, "src"), { includeBuiltins: true });
  const display = (file: string) => normalizeDisplayPath(relative(root, file));
  const violations: string[] = [];

  for (const entrypoint of entrypoints) {
    const visited = new Set([entrypoint]);
    const pending = [{ file: entrypoint, chain: [display(entrypoint)] }];
    for (const { file, chain } of pending) {
      const imports = graph.get(file);
      if (!imports) throw new Error(`Source missing from the import graph: ${display(file)}`);

      for (const target of imports) {
        if (target.startsWith("node:") || isBuiltin(target)) {
          violations.push([...chain, target].join(" -> "));
        } else if (!visited.has(target)) {
          visited.add(target);
          pending.push({ file: target, chain: [...chain, display(target)] });
        }
      }
    }
  }

  expect(violations, violations.join("\n")).toEqual([]);
});
