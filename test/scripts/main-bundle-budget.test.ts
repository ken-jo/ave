import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type OutputFile } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  MAIN_BUNDLE_BUDGETS,
  analyzeMainBundleMetafile,
  assertMainBundleBudget,
  createMainBundleBudgets,
  createMainBundleManifest,
  formatMainBundleBudget,
  formatMainBundleSummary,
  findUnexpectedMainBundleRootScripts,
  isSafeMainBundleManifestPath,
} from "../../scripts/lib/main-bundle-budget.mjs";
import { MAIN_BUNDLE_EXTERNALS } from "../../scripts/lib/main-bundle-externals.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const syntheticMetafile = {
  outputs: {
    "/repo/dist/main.js": {
      bytes: 100,
      entryPoint: "/repo/src/main.ts",
      imports: [
        { path: "./chunks/shared.js", kind: "import-statement" },
        { path: "./chunks/boot.js", kind: "dynamic-import" },
        { path: "electron", kind: "import-statement", external: true },
      ],
    },
    "/repo/dist/chunks/shared.js": { bytes: 50, imports: [] },
    "/repo/dist/chunks/boot.js": {
      bytes: 200,
      entryPoint: "/repo/src/boot.ts",
      imports: [{ path: "./async-shared.js", kind: "import-statement" }],
    },
    "/repo/dist/chunks/async-shared.js": { bytes: 20, imports: [] },
    "/repo/dist/chunks/locale.js": { bytes: 30, imports: [] },
  },
};

function staticallyLoadedOutputs(
  result: { metafile: Metafile; outputFiles: OutputFile[] },
  entryPoint: string,
) {
  const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, value]) => [
    isAbsolute(path) ? path : resolve(REPO_ROOT, path), value,
  ]));
  const files = new Map(result.outputFiles.map((file) => [file.path, file]));
  const entry = [...outputs].find(([, value]) => value.entryPoint === entryPoint);
  expect(entry).toBeDefined();
  const initial = new Set<string>();
  const pending = [entry![0]];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (initial.has(path)) continue;
    initial.add(path);
    for (const imported of outputs.get(path)!.imports) {
      if (imported.external || imported.kind !== "import-statement") continue;
      const absolute = resolve(REPO_ROOT, imported.path);
      pending.push(outputs.has(absolute) ? absolute : resolve(dirname(path), imported.path));
    }
  }
  return { outputs, files, initial };
}

describe("main bundle budget", () => {
  it("derives the total ceiling from startup budgets and a fixed lazy allowance", () => {
    expect(MAIN_BUNDLE_BUDGETS).toEqual({
      entryBytes: 1_700_000,
      initialBytes: 8_000_000,
      lazyAllowanceBytes: 4_300_000,
      totalBytes: 14_000_000,
    });
    const inputs = { entryBytes: 100, initialBytes: 150, lazyAllowanceBytes: 150 };
    expect(createMainBundleBudgets(inputs).totalBytes).toBe(400);
    expect(createMainBundleBudgets({ ...inputs, entryBytes: 120 }).totalBytes).toBe(420);
    expect(createMainBundleBudgets({ ...inputs, initialBytes: 200 }).totalBytes).toBe(450);
    expect(createMainBundleBudgets({ ...inputs, lazyAllowanceBytes: 200 }).totalBytes).toBe(450);
    expect(Object.isFrozen(createMainBundleBudgets(inputs))).toBe(true);
  });

  it("rejects invalid allowances and unsafe derived ceilings", () => {
    for (const lazyAllowanceBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createMainBundleBudgets({ entryBytes: 100, initialBytes: 150, lazyAllowanceBytes }))
        .toThrow(/lazyAllowanceBytes/);
    }
    expect(() => createMainBundleBudgets({
      entryBytes: Number.MAX_SAFE_INTEGER, initialBytes: 150, lazyAllowanceBytes: 150,
    })).toThrow(/totalBytes/);
  });

  it("identifies startup and lazy output shares when the derived total trips", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts", requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    const budgets = createMainBundleBudgets({ entryBytes: 100, initialBytes: 150, lazyAllowanceBytes: 150 });
    expect(() => assertMainBundleBudget(measurement, budgets)).not.toThrow();
    const grown = structuredClone(syntheticMetafile);
    grown.outputs["/repo/dist/chunks/locale.js"].bytes += 1;
    const lazyGrowth = analyzeMainBundleMetafile(grown, {
      entryPoint: "/repo/src/main.ts", requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(() => assertMainBundleBudget(lazyGrowth, budgets))
      .toThrow(/totalBytes 401 exceeds 400[\s\S]*entry=100[\s\S]*initial shared=50[\s\S]*lazy\/other=251/);
    expect(formatMainBundleSummary(measurement, budgets))
      .toContain("Total ceiling = entry budget (100) + initial budget (150) + lazy allowance (150)");
  });

  it("loads the round loop and its turn-only helpers on the first turn, not at startup", async () => {
    const result = await build({
      absWorkingDir: REPO_ROOT, outdir: resolve(REPO_ROOT, "dist/turn-boundary-probe"),
      stdin: {
        contents: 'export { runTurn } from "./src/engine/turn/run-turn.ts";',
        resolveDir: REPO_ROOT, sourcefile: "turn-main.ts", loader: "ts",
      },
      bundle: true, splitting: true, format: "esm", platform: "node", target: "node22",
      preserveSymlinks: true, minify: true, keepNames: true,
      write: false, metafile: true, external: [...MAIN_BUNDLE_EXTERNALS],
    });
    const { outputs, initial } = staticallyLoadedOutputs(result, "turn-main.ts");
    const measurement = analyzeMainBundleMetafile(result.metafile, {
      entryPoint: "turn-main.ts",
      requiredAsyncEntryPoint: resolve(REPO_ROOT, "src/engine/turn/query-loop.ts"),
    });
    expect(measurement.requiredAsyncEntryIsInitial).toBe(false);
    const eagerInputs = [...initial].flatMap((path) => Object.entries(outputs.get(path)!.inputs)
      .filter(([, value]) => value.bytesInOutput > 0)
      .map(([input]) => input.replaceAll("\\", "/")));
    // Turn-time work is excluded from startup.
    const deferredInputs = [
      "engine/turn/query-loop.ts", "engine/turn/stream-collector.ts", "engine/turn/round-llm-settings.ts",
      "engine/llm/vendor-capabilities.ts", "engine/llm/reasoning-plan.ts", "shared/model-capability-settings.ts",
    ];
    expect(eagerInputs.filter((input) => deferredInputs.some((path) => input.endsWith(path)))).toEqual([]);
  });


  it("keeps refresh writers out of emitted startup code shared with the deferred refresh", async () => {
    const outdir = resolve(REPO_ROOT, "dist/catalog-boundary-probe");
    const result = await build({
      absWorkingDir: REPO_ROOT, outdir,
      stdin: {
        contents: 'export { selectBootModelCatalog } from "./src/core/model-catalog/bundled.ts"; export const loadRefresh = () => import("./src/core/model-catalog/refresh.ts");',
        resolveDir: REPO_ROOT, sourcefile: "catalog-main.ts", loader: "ts",
      },
      bundle: true, splitting: true, format: "esm", platform: "node", target: "node22",
      preserveSymlinks: true, minify: true, keepNames: true,
      write: false, metafile: true, external: [...MAIN_BUNDLE_EXTERNALS],
    });
    const { outputs, files, initial } = staticallyLoadedOutputs(result, "catalog-main.ts");
    const actualBytes = [...initial].reduce((sum, path) => sum + files.get(path)!.contents.length, 0);
    const measurement = analyzeMainBundleMetafile(result.metafile, {
      entryPoint: "catalog-main.ts",
      requiredAsyncEntryPoint: resolve(REPO_ROOT, "src/core/model-catalog/refresh.ts"),
    });
    expect(measurement.initialBytes).toBe(actualBytes);
    expect(measurement.requiredAsyncEntryIsInitial).toBe(false);
    const eagerInputs = [...initial].flatMap((path) => Object.entries(outputs.get(path)!.inputs)
      .filter(([, value]) => value.bytesInOutput > 0)
      .map(([input]) => input.replaceAll("\\", "/")));
    const deferredInputs = ["core/model-catalog/refresh-cache.ts", "core/model-catalog/document-builder.ts", "shared/model-catalog/normalize.ts"];
    expect(eagerInputs.filter((input) => deferredInputs.some((path) => input.endsWith(path)))).toEqual([]);
    const initialText = [...initial].map((path) => files.get(path)!.text).join("\n");
    const writers = ["readModelCatalogCheck", "writeModelCatalogCheck", "prepareModelCatalogCache", "storeModelCatalog", "writeModelCatalogPointer", "withModelCatalogCacheLock", "buildModelCatalogDocument", "formatCatalogJson", "normalizeModelsDevProviders"];
    expect(writers.filter((name) => initialText.includes(JSON.stringify(name)))).toEqual([]);
  });

  it("counts only statically reachable outputs in the initial load", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });

    expect(measurement).toMatchObject({
      entryBytes: 100,
      initialBytes: 150,
      asyncBytes: 250,
      totalBytes: 400,
      initialFiles: 2,
      totalFiles: 5,
      hasRequiredAsyncBoundary: true,
      requiredAsyncEntryIsInitial: false,
    });
  });

  it("fails closed on a missing split or any exceeded byte budget", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(() => assertMainBundleBudget(measurement, {
      entryBytes: 99,
      initialBytes: 149,
      totalBytes: 399,
    })).toThrow(/entryBytes 100 exceeds 99[\s\S]*initialBytes 150 exceeds 149[\s\S]*totalBytes 400 exceeds 399/);
    expect(() => assertMainBundleBudget(
      { ...measurement, hasRequiredAsyncBoundary: false },
      { entryBytes: 100, initialBytes: 150, totalBytes: 400 },
    )).toThrow(/required boot entry has no async bundle boundary/);
  });

  it("passes at each ceiling and fails one byte over it, independently", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    const atLimit = { entryBytes: 100, initialBytes: 150, totalBytes: 400 };
    expect(() => assertMainBundleBudget(measurement, atLimit)).not.toThrow();
    for (const key of ["entryBytes", "initialBytes", "totalBytes"] as const) {
      expect(() => assertMainBundleBudget(measurement, { ...atLimit, [key]: atLimit[key] - 1 }))
        .toThrow(new RegExp(`${key} ${atLimit[key]} exceeds ${atLimit[key] - 1}[\\s\\S]*raise the ceiling in scripts/lib/main-bundle-budget\\.mjs`));
    }
  });

  it("fails when a ceiling itself is missing or not a positive integer", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    const budgets = { entryBytes: 1_000, initialBytes: 1_000, totalBytes: 1_000 };
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, "1000"]) {
      expect(() => assertMainBundleBudget(measurement, { ...budgets, totalBytes: bad }))
        .toThrow(/budget totalBytes is not a positive integer/);
    }
    expect(() => assertMainBundleBudget(measurement, undefined))
      .toThrow(/budget entryBytes is not a positive integer/);
  });

  it("catches a constant-total move of lazy code into the startup graph", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    const budgets = { entryBytes: 1_000, initialBytes: 200, totalBytes: 400 };
    expect(() => assertMainBundleBudget(measurement, budgets)).not.toThrow();
    expect(() => assertMainBundleBudget(
      { ...measurement, initialBytes: 250, asyncBytes: 150 },
      budgets,
    )).toThrow(/initialBytes 250 exceeds 200/);
  });

  it("summarizes measurement, ceiling and headroom for the CI job summary", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    const summary = formatMainBundleSummary(measurement, {
      entryBytes: 200,
      initialBytes: 1_500,
      totalBytes: 1_600,
    });
    expect(summary).toContain("| entry | 100 | 200 | 50.0% |");
    expect(summary).toContain("| initial | 150 | 1,500 | 90.0% |");
    expect(summary).toContain("| total | 400 | 1,600 | 75.0% |");
    expect(summary).toContain("| async (lazy) | 250 | — | — |");
  });

  it("summarizes an exceeded or invalid ceiling without throwing", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    const summary = formatMainBundleSummary(measurement, {
      entryBytes: 80,
      initialBytes: 150,
    });
    expect(summary).toContain("| entry | 100 | 80 | -25.0% |");
    expect(summary).toContain("| initial | 150 | 150 | 0.0% |");
    expect(summary).toContain("| total | 400 | invalid | invalid |");
  });

  it("reports a structural failure and an invalid ceiling in one error", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(() => assertMainBundleBudget(
      { ...measurement, hasRequiredAsyncBoundary: false },
      { entryBytes: 1_000, initialBytes: 1_000 },
    )).toThrow(/required boot entry has no async bundle boundary[\s\S]*budget totalBytes is not a positive integer/);
  });

  it("rejects a static boot edge even when an unrelated dynamic import remains", () => {
    const metafile = structuredClone(syntheticMetafile);
    metafile.outputs["/repo/dist/main.js"].imports = [
      { path: "./chunks/shared.js", kind: "import-statement" },
      { path: "./chunks/boot.js", kind: "import-statement" },
      { path: "./chunks/locale.js", kind: "dynamic-import" },
    ];
    expect(analyzeMainBundleMetafile(metafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    }).hasRequiredAsyncBoundary).toBe(false);
  });

  it("rejects boot when a dynamic edge is shadowed by a transitive static edge", () => {
    const metafile = structuredClone(syntheticMetafile);
    metafile.outputs["/repo/dist/chunks/shared.js"].imports = [
      { path: "./boot.js", kind: "import-statement" },
    ];
    const measurement = analyzeMainBundleMetafile(metafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(measurement).toMatchObject({
      hasRequiredAsyncBoundary: true,
      requiredAsyncEntryIsInitial: true,
    });
    expect(() => assertMainBundleBudget(measurement, {
      entryBytes: 1_000,
      initialBytes: 1_000,
      totalBytes: 1_000,
    })).toThrow(/boot entry remains statically reachable/);
  });

  it("rejects real esbuild factoring that moves boot into an initial shared chunk", async () => {
    const modules = new Map([
      ["v:main.ts", 'import { shared } from "v:shared.ts"; void shared; void import("v:boot.ts");'],
      ["v:shared.ts", 'export { boot as shared } from "v:boot.ts";'],
      ["v:boot.ts", 'export const boot = "loaded";'],
    ]);
    const result = await build({
      entryPoints: ["v:main.ts"],
      bundle: true,
      splitting: true,
      format: "esm",
      outdir: "/virtual-out",
      write: false,
      metafile: true,
      plugins: [{
        name: "virtual-main-bundle",
        setup(esbuild) {
          esbuild.onResolve({ filter: /^v:/ }, ({ path }) => ({ path, namespace: "virtual" }));
          esbuild.onLoad({ filter: /.*/, namespace: "virtual" }, ({ path }) => ({
            contents: modules.get(path),
            loader: "ts",
          }));
        },
      }],
    });
    const entryPoints = Object.values(result.metafile.outputs)
      .map((output) => output.entryPoint)
      .filter((entryPoint): entryPoint is string => typeof entryPoint === "string");
    const mainEntryPoint = entryPoints.find((entryPoint) => entryPoint.includes("main.ts"));
    const bootEntryPoint = entryPoints.find((entryPoint) => entryPoint.includes("boot.ts"));
    expect(mainEntryPoint).toBeDefined();
    expect(bootEntryPoint).toBeDefined();

    const measurement = analyzeMainBundleMetafile(result.metafile, {
      entryPoint: mainEntryPoint!,
      requiredAsyncEntryPoint: bootEntryPoint!,
    });
    expect(measurement).toMatchObject({
      hasRequiredAsyncBoundary: true,
      requiredAsyncEntryIsInitial: true,
    });
    expect(() => assertMainBundleBudget(measurement, {
      entryBytes: Number.MAX_SAFE_INTEGER,
      initialBytes: Number.MAX_SAFE_INTEGER,
      totalBytes: Number.MAX_SAFE_INTEGER,
    })).toThrow(/boot entry remains statically reachable/);
  });

  it("reports the measured legacy initial-load reduction", () => {
    const measurement = analyzeMainBundleMetafile(syntheticMetafile, {
      entryPoint: "/repo/src/main.ts",
      requiredAsyncEntryPoint: "/repo/src/boot.ts",
    });
    expect(formatMainBundleBudget(measurement)).toContain("legacy-initial-reduction=");
  });

  it("creates a sorted package manifest for every emitted main file", () => {
    expect(createMainBundleManifest(syntheticMetafile, { outdir: "/repo/dist" })).toEqual({
      schemaVersion: 1,
      entry: "main.js",
      files: [
        { path: "chunks/async-shared.js", bytes: 20 },
        { path: "chunks/boot.js", bytes: 200 },
        { path: "chunks/locale.js", bytes: 30 },
        { path: "chunks/shared.js", bytes: 50 },
        { path: "main.js", bytes: 100 },
      ],
    });
  });

  it("creates the same manifest when esbuild reports paths relative to its working directory", () => {
    const metafile = {
      outputs: {
        "dist/main.js": { bytes: 100 },
        "dist/chunks/shared.js": { bytes: 50 },
      },
    };
    expect(createMainBundleManifest(metafile, {
      outdir: "/repo/dist",
      absWorkingDir: "/repo",
    })).toEqual({
      schemaVersion: 1,
      entry: "main.js",
      files: [
        { path: "chunks/shared.js", bytes: 50 },
        { path: "main.js", bytes: 100 },
      ],
    });
  });
  it("permits only intentional root main-process entrypoints in package manifests", () => {
    expect(isSafeMainBundleManifestPath("main.js")).toBe(true);
    expect(isSafeMainBundleManifestPath("subscription-grok-tool-policy-hook.js")).toBe(true);
    expect(isSafeMainBundleManifestPath("subscription-tool-mcp-server.js")).toBe(true);
    expect(isSafeMainBundleManifestPath("mxc-extension-supervisor.js")).toBe(true);
    expect(isSafeMainBundleManifestPath("mxc-packaged-probe.js")).toBe(true);
    expect(isSafeMainBundleManifestPath("chunks/shared-AB12cd.js")).toBe(true);

    expect(isSafeMainBundleManifestPath("unexpected-root.js")).toBe(false);
    expect(isSafeMainBundleManifestPath("main.mjs")).toBe(false);
    expect(isSafeMainBundleManifestPath("nested/entry.js")).toBe(false);
    expect(isSafeMainBundleManifestPath("chunks/../main.js")).toBe(false);
  });

  it("finds stale packaged root scripts outside the main bundle manifest", () => {
    const manifestPaths = [
      "main.js",
      "subscription-grok-tool-policy-hook.js",
      "subscription-tool-mcp-server.js",
    ];

    const unexpected = findUnexpectedMainBundleRootScripts(
      [
        "main.js",
        "subscription-grok-tool-policy-hook.js",
        "subscription-tool-mcp-server.js",
        "stale-helper.js",
        "stale-helper.JS",
        "chunks/shared.js",
        "nested/helper.js",
        "main.mjs",
      ],
      manifestPaths,
    );
    expect(unexpected).toEqual([
      "stale-helper.js",
      "stale-helper.JS",
    ]);

    const packageFootprint = readFileSync(resolve("scripts/check-package-footprint.mjs"), "utf8");
    expect(packageFootprint).toContain("findUnexpectedMainBundleRootScripts(");
  });

  it("pins logical esbuild paths so checkout layout cannot change the bundle budget", () => {
    const buildSource = readFileSync(resolve("scripts/build-main-esbuild.mjs"), "utf8");
    expect(buildSource).toContain("absWorkingDir: repoRoot,");
    expect(buildSource).toContain("preserveSymlinks: true,");
  });

  it("keeps window creation ahead of asynchronous boot loading", () => {
    const mainSource = readFileSync(resolve("src/main.ts"), "utf8");
    expect(mainSource).not.toMatch(/^import .* from "\.\/boot\.js";$/m);
    const createWindowAt = mainSource.indexOf("createWindow({");
    const loadBootAt = mainSource.indexOf('import("./desktop-boot.js")');
    const attachStartupAt = mainSource.indexOf("loadMainStartupDependencies(", createWindowAt);
    // First-boot arguments must demonstrate overlapping certificate work.
    const loadCorporateCaAt = mainSource.indexOf("ensureCorporateCaInjected", loadBootAt);
    expect(createWindowAt).toBeGreaterThan(-1);
    expect(createWindowAt).toBeLessThan(attachStartupAt);
    expect(createWindowAt).toBeLessThan(loadBootAt);
    expect(attachStartupAt).toBeLessThan(loadBootAt);
    expect(loadBootAt).toBeLessThan(loadCorporateCaAt);
  });
});
