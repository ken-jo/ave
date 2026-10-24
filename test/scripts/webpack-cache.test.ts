import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Configuration, Stats } from "webpack";

const require = createRequire(import.meta.url);
const webpack = require("webpack") as typeof import("webpack");
function loadConfigs(minifier?: string): Configuration[] {
  const previous = process.env.AVE_BUILD_MINIFIER;
  if (minifier === undefined) delete process.env.AVE_BUILD_MINIFIER;
  else process.env.AVE_BUILD_MINIFIER = minifier;
  const path = resolve("webpack.config.cjs");
  delete require.cache[path];
  try {
    return require(path) as Configuration[];
  } finally {
    if (previous === undefined) delete process.env.AVE_BUILD_MINIFIER;
    else process.env.AVE_BUILD_MINIFIER = previous;
    delete require.cache[path];
  }
}
const configs = loadConfigs("esbuild");
function findRenderer(configurations: Configuration[]): Configuration {
  const config = configurations.find((candidate) => candidate.name === "renderer");
  if (!config) throw new Error("Renderer build configuration is missing");
  return config;
}
const renderer = findRenderer(configs);

function filesystemCache(config: Configuration) {
  if (!config.cache || typeof config.cache !== "object" || config.cache.type !== "filesystem") throw new Error("Filesystem cache is missing");
  return config.cache;
}
const roots: string[] = [];
const CACHE_FIXTURE_TIME = 1_577_836_800;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(valueName = "value.js") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-build-cache-")));
  roots.push(root);
  const entry = join(root, "entry.js");
  const value = join(root, valueName);
  const output = join(root, "output");
  writeFileSync(entry, 'export async function read() { return (await import("./value.js")).value; }\n');
  writeFileSync(value, 'export const value = "before";\n');
  utimesSync(value, CACHE_FIXTURE_TIME, CACHE_FIXTURE_TIME);
  return { root, entry, value, output };
}

async function build(config: Configuration): Promise<Stats> {
  const compiler = webpack(config);
  return new Promise((done, fail) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return fail(error ?? closeError);
        if (!stats || stats.hasErrors()) return fail(new Error(stats?.toString("errors-only") ?? "Build statistics are missing"));
        done(stats);
      });
    });
  });
}

function configuration(files: ReturnType<typeof fixture>, cacheDirectory: string, rendererConfig = renderer): Configuration {
  return {
    ...rendererConfig,
    mode: "production",
    entry: files.entry,
    cache: { ...filesystemCache(rendererConfig), cacheDirectory },
    output: {
      ...rendererConfig.output,
      path: files.output,
      filename: "entry.mjs",
      chunkFilename: "[name].[contenthash:8].mjs",
      library: { type: "module" },
      clean: true,
    },
  };
}

function cached(stats: Stats, file: string) {
  return stats.toJson({ all: false, modules: true, cachedModules: true, groupModulesByCacheStatus: false, groupModulesByType: false, groupModulesByPath: false })
    .modules?.find((module) => module.nameForCondition === file)?.cached;
}

function readOutput(output: string): string {
  const result = spawnSync(process.execPath, [
    "--input-type=module", "-e",
    "const { read } = await import(process.argv[1]); process.stdout.write(await read());",
    pathToFileURL(join(output, "entry.mjs")).href,
  ], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("build cache", () => {
  it("reuses a restored cache and rebuilds changed source despite identical timestamps and size", async () => {
    const files = fixture();
    const seed = join(files.root, "seed-cache");
    await build(configuration(files, seed));
    expect(readOutput(files.output)).toBe("before");
    const restored = join(files.root, "restored-cache");
    cpSync(seed, restored, { recursive: true, preserveTimestamps: true });
    rmSync(files.output, { recursive: true });
    const warm = await build(configuration(files, restored));
    expect(cached(warm, files.value)).toBe(true);
    expect(readOutput(files.output)).toBe("before");

    const original = statSync(files.value);
    writeFileSync(files.value, 'export const value = "after!";\n');
    utimesSync(files.value, original.atime, original.mtime);
    expect(statSync(files.value).size).toBe(original.size);
    expect(statSync(files.value).mtimeMs).toBe(original.mtimeMs);
    const changed = await build(configuration(files, restored));
    expect(cached(changed, files.value)).toBe(false);
    expect(readOutput(files.output)).toBe("after!");
  });

  it("rebuilds restored transforms when the real compiler options change", async () => {
    const files = fixture("value.ts");
    mkdirSync(join(files.root, "src/shared"), { recursive: true });
    for (const path of ["webpack.config.cjs", "bun.lock", "src/shared/preload-bundles.json"]) {
      cpSync(resolve(path), join(files.root, path));
    }
    symlinkSync(resolve("node_modules"), join(files.root, "node_modules"), "junction");
    symlinkSync(resolve("scripts"), join(files.root, "scripts"), "junction");
    const input = join(files.root, "tsconfig.json");
    const options = JSON.parse(readFileSync(resolve("tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
    options.compilerOptions.useDefineForClassFields = false;
    writeFileSync(input, `${JSON.stringify(options)}\n`);
    utimesSync(input, CACHE_FIXTURE_TIME, CACHE_FIXTURE_TIME);
    const source = `let touched = "own";
      class Base { set value(value: number) { touched = "setter"; } }
      class Child extends Base { value = 1; }
      new Child();
      export const value = touched;\n`;
    writeFileSync(files.value, source);
    const production = findRenderer(require(join(files.root, "webpack.config.cjs")) as Configuration[]);
    const seed = join(files.root, "seed-cache");
    const config = configuration(files, seed, production);
    await build(config);
    expect(readOutput(files.output)).toBe("setter");
    const restored = join(files.root, "restored-cache");
    cpSync(seed, restored, { recursive: true, preserveTimestamps: true });
    filesystemCache(config).cacheDirectory = restored;
    expect(cached(await build(config), files.value)).toBe(true);
    const original = statSync(input);
    options.compilerOptions.useDefineForClassFields = true;
    writeFileSync(input, `${JSON.stringify(options)} \n`);
    utimesSync(input, original.atime, original.mtime);
    expect(statSync(input).size).toBe(original.size);
    expect(statSync(input).mtimeMs).toBe(original.mtimeMs);
    expect(readFileSync(files.value, "utf8")).toBe(source);
    expect(cached(await build(config), files.value)).toBe(false);
    expect(readOutput(files.output)).toBe("own");
  });

  it("persists production cache separately from installed dependencies with bounded restore keys", () => {
    const workflow = parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ id?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }> }>;
    };
    const steps = workflow.jobs["build-and-test"]!.steps;
    const cache = steps.find((step) => step.id === "webpack-cache");
    expect(cache?.with?.path).toBe("ave/.cache/webpack");
    const key = cache?.with?.key ?? "";
    for (const input of ["runner.os", "runner.arch", "ave/bun.lock", "ave/patches/**", "ave/webpack.config.cjs", "ave/tsconfig*.json", "ave/src/**"]) {
      expect(key).toContain(input);
    }
    const restores = cache?.with?.["restore-keys"]?.trim().split("\n") ?? [];
    expect(restores).toHaveLength(2);
    for (const prefix of restores) {
      expect(prefix).toContain("runner.os");
      expect(prefix).toContain("runner.arch");
      expect(prefix).toContain("ave/bun.lock");
      expect(prefix).toContain("ave/patches/**");
      expect(prefix.endsWith("-")).toBe(true);
    }
    expect(steps.findIndex((step) => step.id === "webpack-cache")).toBeLessThan(steps.findIndex((step) => step.run === "bun run build"));
    expect(steps.find((step) => step.run === "bun run build")?.env?.NODE_ENV).not.toBe("development");
    expect(steps.find((step) => step.run === "bun run build")?.env?.AVE_BUILD_MINIFIER).toBe("esbuild");
    for (const config of configs) {
      expect(config.mode).toBe("production");
      expect(filesystemCache(config).cacheDirectory).toBe(resolve(".cache/webpack"));
    }
  });

  it("keeps distribution minification as the default and refuses an unknown selection", () => {
    const defaults = findRenderer(loadConfigs());
    expect(defaults.optimization?.minimize).toBe(true);
    expect(defaults.optimization?.minimizer).toBeUndefined();
    expect(findRenderer(loadConfigs("terser")).optimization).toEqual(defaults.optimization);
    expect(filesystemCache(defaults).version).not.toBe(filesystemCache(renderer).version);
    expect(() => loadConfigs("unknown")).toThrow("AVE_BUILD_MINIFIER must be terser or esbuild");
  });
});
