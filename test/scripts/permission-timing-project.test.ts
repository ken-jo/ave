import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "vite";
import { describe, expect, it } from "vitest";
import type { ViteUserConfig } from "vitest/config";

const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, fileURLToPath(new URL("../../config/vitest.analysis.config.ts", import.meta.url)));
if (loaded === null) throw new Error("Missing test configuration");
const config: ViteUserConfig = loaded.config;

const TIMING_FILES = [
  "src/permissions/__tests__/permission-adversarial-performance.test.ts",
  "src/permissions/__tests__/permission-decision-cost.test.ts",
];

interface ProjectTest {
  name?: string;
  include?: string[];
  exclude?: string[];
  setupFiles?: string | string[];
}

function project(name: string): ProjectTest {
  for (const entry of config.test?.projects ?? []) {
    if (typeof entry === "object" && entry !== null && "test" in entry && entry.test?.name === name) {
      return { name, include: entry.test.include, exclude: entry.test.exclude, setupFiles: entry.test.setupFiles };
    }
  }
  throw new Error(`Missing test project ${name}`);
}

function inventory(test: ProjectTest): string[] {
  return [...new Set((test.include ?? []).flatMap((pattern) => globSync(pattern, {
    cwd: config.root,
    exclude: test.exclude ?? [],
  })).map((file) => file.replace(/\\/g, "/")))].sort();
}

describe("permission timing project discovery", () => {
  it("preserves the complete ordinary test inventory without duplicates", () => {
    const node = project("node");
    const timing = project("permission-timing");
    const before = inventory({ ...node, exclude: node.exclude?.filter((pattern) => !TIMING_FILES.includes(pattern)) });
    const ordinary = inventory(node);
    const measured = inventory(timing);
    expect(measured).toEqual(TIMING_FILES);
    expect(ordinary.filter((file) => measured.includes(file))).toEqual([]);
    expect([...ordinary, ...measured].sort()).toEqual(before);
    expect(inventory(project("jsdom")).some((file) => TIMING_FILES.includes(file))).toBe(false);
  });

  it("retains the ordinary node environment setup for timing cases", () => {
    expect(project("permission-timing").setupFiles).toEqual(project("node").setupFiles);
  });
});
