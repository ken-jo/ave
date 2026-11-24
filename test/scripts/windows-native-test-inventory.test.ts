import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { nativeBackedTestFiles, windowsImportGraph } from "./windows-native-test-inventory.js";

const require = createRequire(import.meta.url);
vi.mock("node:os", () => ({
  platform: () => Reflect.apply({ require }.require, null, ["node:os"]).platform(),
  tmpdir: () => Reflect.apply({ require }.require, null, ["node:os"]).tmpdir(),
}));

const SUITE = "src/data/__tests__/store.test.ts";
const STORE = "src/data/store.ts";
const NATIVE = "src/shared/windows-native-host.ts";
function sources(test: string, store = 'export { read } from "../shared/windows-native-host.js";'): Map<string, string> {
  return new Map([[SUITE, test], [STORE, store], [NATIVE, "export const read = () => {};"]]);
}

it("selects an actual platform-dependent filesystem output reached through an exported function", () => {
  const builder = `
    import { chmodSync, writeFileSync } from "node:fs";
    export function materialize(file, options = {}) { return write(file, options); }
    export function status() { return true; }
    function write(file, options) {
      writeFileSync(file, "checked");
      if ((options.platform ?? process.platform) !== "win32") chmodSync(file, 0o700);
      return file;
    }
  `;
  const fixture = 'import { readFileSync } from "node:fs"; import { materialize, status } from "../store.js"; ';
  expect(nativeBackedTestFiles(sources(`${fixture}expect(readFileSync(materialize(file))).toEqual(bytes);`, builder)).get(SUITE))
    .toEqual([SUITE, STORE]);
  for (const source of [
    `${fixture}expect(readFileSync(file)).toEqual(bytes); status();`,
    `${fixture}expect(readFileSync(materialize(file, { platform: "win32" }))).toEqual(bytes);`,
    `${fixture}vi.mock("../store.js", () => ({ materialize: vi.fn() })); readFileSync(materialize(file));`,
    `${fixture}vi.mock("node:fs", () => ({ readFileSync: vi.fn() })); readFileSync(materialize(file));`,
  ]) expect(nativeBackedTestFiles(sources(source, builder)).has(SUITE)).toBe(false);
});

// Check the import parser independently of the evidence used to select Windows tests.
function nativeImportChains(modules: Map<string, string>): Map<string, string[]> {
  const graph = windowsImportGraph(modules);
  const chains = new Map<string, string[]>();
  for (const [file, suite] of graph) {
    if (!file.endsWith(".test.ts")) continue;
    const queue = [[file]];
    const seen = new Set([file]);
    for (const chain of queue) {
      const current = chain.at(-1);
      if (current === undefined) throw new Error("Empty import chain");
      if (current.includes("/windows-")) { chains.set(file, chain); break; }
      for (const { file: dependency, actual } of graph.get(current)?.dependencies ?? []) {
        if (seen.has(dependency) || (!actual && suite.mocks.has(dependency))) continue;
        seen.add(dependency);
        queue.push([...chain, dependency]);
      }
    }
  }
  return chains;
}

describe("Windows runtime imports", () => {
  it("retains a real platform-dependent rename followed by a byte read", () => {
    const consumer = 'import { produce } from "../store.js"; import { readFileSync } from "node:fs"; expect(readFileSync(produce(from, to), "utf8")).toBe("payload");';
    const rename = 'import { renameSync } from "node:fs"; export function produce(from, to) { if (process.platform === "win32") renameSync(from, to); return to; }';
    expect(nativeBackedTestFiles(sources(consumer, rename)).get(SUITE)).toEqual([SUITE, STORE]);
  });

  it("retains real replacement and read-back across a class method holding a host descriptor", () => {
    const holder = `
      import { openSync, closeSync } from "node:fs";
      import { platform as host } from "node:process";
      export class Archive {
        save(path, onOpen) {
          const fd = openSync(path, host === "win32" ? "r+" : "r");
          try { onOpen(); } finally { closeSync(fd); }
        }
        status() { return "idle"; }
      }
    `;
    const imports = 'import { readFileSync, renameSync as replace } from "node:fs"; import { Archive } from "../store.js"; ';
    const call = 'new Archive().save(active, () => { try { replace(other, active); } catch {} }); expect(readFileSync(archive)).toEqual(bytes);';
    expect(nativeBackedTestFiles(sources(`${imports}${call}`, holder)).get(SUITE)).toEqual([SUITE, STORE]);
    for (const source of [
      `${imports}new Archive().status(); replace(other, active); readFileSync(archive);`,
      `${imports}vi.mock("node:fs", () => ({ renameSync: vi.fn(), readFileSync: vi.fn() })); ${call}`,
      `${imports}vi.mock("../store.js", () => ({ Archive: vi.fn() })); ${call}`,
      `${imports}vi.mock("node:process", () => ({ platform: "win32" })); ${call}`,
      `${imports}import { it } from "vitest"; it("replace", () => {
        new Archive().save(active, () => replace(other, active));
      }); it("read unrelated file", () => readFileSync(unrelated));`,
    ]) expect(nativeBackedTestFiles(sources(source, holder)).has(SUITE)).toBe(false);
  });

  it("requires a test-local descriptor to stay open during a real rename", () => {
    const imports = 'import { openSync, closeSync, renameSync, readFileSync } from "node:fs"; ';
    const opened = `${imports}const fd = openSync(active, "r"); `;
    expect(nativeBackedTestFiles(sources(`${opened}try { renameSync(other, active); } finally { closeSync(fd); } readFileSync(active);`)).has(SUITE)).toBe(true);
    expect(nativeBackedTestFiles(sources(`${opened}closeSync(fd); renameSync(other, active); readFileSync(active);`)).has(SUITE)).toBe(false);
  });

  it.each([
    'import { createRequire } from "node:module"; const load = createRequire(new URL("../../main/anchor.cjs", import.meta.url)); load("./windows-probe.cjs").read();',
    'import { createRequire as factory } from "node:module"; const anchor = new URL("../../main/", import.meta.url); const loader = factory(anchor); const load = loader; const { read } = load("./windows-probe.cjs"); read();',
    'import * as mod from "node:module"; const factory = mod.createRequire; factory(new URL("../../main/anchor.cjs", import.meta.url))("./windows-probe.cjs").read();',
    'const { createRequire: factory } = require("module"); const load = factory(new URL("../../main/anchor.cjs", import.meta.url)); load("./windows-probe.cjs").read();',
  ])("resolves a loader against its actual anchor: %s", source => {
    const file = "src/core/__tests__/probe.test.ts", target = "src/main/windows-probe.cjs";
    const modules = new Map([[file, source], [target, "exports.read = () => 'checked';"]]);
    expect(windowsImportGraph(modules).get(file)?.dependencies).toContainEqual(expect.objectContaining({ file: target, actual: true }));
    expect(nativeBackedTestFiles(modules).get(file)).toEqual([file, target]);
  });

  it.each([
    'const load = createRequire(platformAnchor()); load("./safe.js");',
    'const load = createRequire(import.meta.url); const alias = wrap(load); alias("./safe.js");',
    'const load = createRequire(import.meta.url); const box = { load }; box.load("./safe.js");',
    'const load = createRequire(import.meta.url); load(id);',
  ])("retains a test whose real loader cannot be resolved: %s", source => {
    expect(nativeBackedTestFiles(sources(`import { createRequire } from "node:module"; ${source}`)).has(SUITE)).toBe(true);
  });

  it("does not attribute an unrelated same-name function to the module loader", () => {
    const source = 'function createRequire(anchor) { return () => anchor; } createRequire(opaque)("./safe.js");';
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(false);
  });

  it("does not resolve an anchored binding named require relative to its caller", () => {
    const file = "src/core/__tests__/probe.test.ts", target = "src/main/windows-probe.cjs";
    const other = "src/core/__tests__/windows-probe.cjs";
    const source = 'import { createRequire } from "node:module"; const require = createRequire(new URL("../../main/anchor.cjs", import.meta.url)); require("./windows-probe.cjs").read();';
    const modules = new Map([[file, source], [target, "exports.read = () => 'checked';"], [other, "exports.read = () => 'wrong';"]]);
    expect(windowsImportGraph(modules).get(file)?.dependencies.map(edge => edge.file)).toEqual(["node:module", target]);
  });

  it("selects a mock flow that reaches the actual module through a loader property value", () => {
    expect(platform()).toBe(process.platform);
    const source = 'vi.mock("../../shared/windows-native-host.js", () => ({ read: () => Reflect.apply({ require }.require, null, ["../../shared/windows-native-host.js"]).read() })); import { read } from "../store.js"; read();';
    expect(nativeImportChains(sources(source)).has(SUITE)).toBe(true);
  });

  it.each([
    'import { read } from "../store.js"; read();',
    'const { read } = await import("../store.js"); read();',
    'const { read } = await vi.importActual("../store.js"); read();',
    'const { read } = require("../store.js"); read();',
  ])("follows runtime imports and re-exports: %s", source => {
    expect(nativeImportChains(sources(source)).get(SUITE)).toEqual([SUITE, STORE, NATIVE]);
  });
  it.each([
    'require("../shared/windows-native-host.js")',
    'require?.("../shared/windows-native-host.js")',
    'module.require("../shared/windows-native-host.js")',
    'module.require?.("../shared/windows-native-host.js")',
    'globalThis.require("../shared/windows-native-host.js")',
    'loader?.require("../shared/windows-native-host.js")',
    'module["require"]("../shared/windows-native-host.js")',
    "module['require']?.('../shared/windows-native-host.js')",
    'module?.[`require`]("../shared/windows-native-host.js")',
  ])("follows a transitive module-loading helper: %s", invocation => {
    const source = 'const { read } = require("../store.js"); read();';
    expect(nativeImportChains(sources(source, `exports.read = () => ${invocation}.read();`)).get(SUITE)).toEqual([SUITE, STORE, NATIVE]);
  });
  it("erases type-only imports before walking dependencies", () => {
    expect([...nativeImportChains(sources('import type { read } from "../store.js"; type Reader = typeof read;'))]).toEqual([]);
  });
  it("cuts a completely mocked native dependency even when its importer is indirect", () => {
    const source = 'vi.mock("../../shared/windows-native-host.js", () => ({ read: vi.fn() })); import { read } from "../store.js"; read();';
    expect([...nativeImportChains(sources(source))]).toEqual([]);
  });
  it.each([
    '() => ({ require: vi.fn(), read: vi.fn() })',
    '() => ({ read: vi.fn(), require: vi.fn() })',
    '() => { return { require: vi.fn(), read: vi.fn() }; }',
    '() => { const mock = { require: vi.fn(), read: vi.fn() }; return mock; }',
    '() => ({ read: vi.fn(), value: { require: x } })',
    '() => ({ read: wrap({ require: x }) })',
    '() => ([{ require: x }])',
    '() => ({ read: flag ? { require: x } : { require: y } })',
    '() => ({ read: [{ value: x }, { require: y }] })',
    '() => ({ read: vi.fn(), values: ["require", `require`] })',
    '() => { if ({ require: x }) consume(); return { read: vi.fn() }; }',
    '() => ({ read: ({ value = { require: x } }) => value })',
    '() => { return flag ? fallback : { require: x }; }',
    '() => { return wrap({ nested: { require: x } }); }',
    '() => ({ read: vi.fn(), value: `require` })',
    '() => ({ read: vi.fn(), value: "require" /* require("../../shared/windows-native-host.js") */ })',
  ])("excludes a complete factory with only object keys or require text: %s", factory => {
    const source = `vi.mock("../../shared/windows-native-host.js", ${factory}); import { read } from "../store.js"; read();`;
    expect(nativeImportChains(sources(source)).has(SUITE)).toBe(false);
  });
  it.each([
    '() => ({ read: vi.fn(), require })',
    '() => ({ require: load } = module)',
    '() => ({ read: ({ require: load }) => load(moduleName) })',
    `() => ({ read: () => \`value: \${require}\` })`,
    '() => { const require = vi.fn(); return { read: vi.fn(), require }; }',
    '() => { const require = vi.fn(); return { read: vi.fn() }; }',
    '() => ({ read: vi.fn(), value: loader.require })',
    '() => ({ read: vi.fn(), value: loader?.require })',
    '() => ({ read: () => Reflect.apply(module.require, module, [moduleName]).read() })',
    '() => ({ read: () => Reflect.apply({ require }.require, null, [moduleName]).read() })',
    '() => ({ read: () => [module.require][0].call(module, moduleName).read() })',
    '() => { const load = module.require; return { read: () => load.call(module, moduleName).read() }; }',
    '() => { const { require: load } = module; return { read: () => load.call(module, moduleName).read() }; }',
    '() => ({ read: ({ require: load }, value) => load(value) })',
    '() => ({ read({ require: load }) { return load(moduleName); } })',
    '() => ({ read: function ({ require: load }) { return load(moduleName); } })',
    '() => { const { nested: { require: load } } = module; return { read: load }; }',
    '() => { const [{ require: load }] = modules; return { read: load }; }',
    '() => ({ read: ({ nested: { require: load } }) => load(moduleName) })',
    '() => ({ read: ([{ require: load }]) => load(moduleName) })',
    '() => { label: { require: consume(); } return { read: vi.fn() }; }',
    '() => { switch (value) { case flag ? a : b: { require: consume(); } } return { read: vi.fn() }; }',
    '() => ({ read: flag ? require : fallback })',
    '() => { require: consume(); return { read: vi.fn() }; }',
    '() => ({ read: () => { require: consume(); } })',
    '() => { if (flag) { require: consume(); } return { read: vi.fn() }; }',
    '() => { try { require: consume(); } finally {} return { read: vi.fn() }; }',
    '() => { do { require: consume(); } while (flag); return { read: vi.fn() }; }',
    '() => { if (flag) {} else { require: consume(); } return { read: vi.fn() }; }',
    '() => { try {} finally { require: consume(); } return { read: vi.fn() }; }',
    '() => { consume(); { require: consume(); } return { read: vi.fn() }; }',
    '() => { { require: consume(); } return { read: vi.fn() }; }',
    '() => { {} { require: consume(); } return { read: vi.fn() }; }',
  ])("selects shorthand, member, binding and loader values with accepted over-selection: %s", factory => {
    const source = `vi.mock("../../shared/windows-native-host.js", ${factory}); import { read } from "../store.js"; read();`;
    expect(nativeImportChains(sources(source)).has(SUITE)).toBe(true);
  });
  it.each([
    'require.call(null, moduleName)',
    'require.apply(null, [moduleName])',
    'require.bind(null)(moduleName)',
    '(0, require)(moduleName)',
    'consume(require)',
    'require.resolve(moduleName)',
    'require?.("../../shared/windows-native-host.js")',
    'module.require("../../shared/windows-native-host.js")',
    'module.require?.(moduleName)',
    'globalThis.require("../../shared/windows-native-host.js")',
    'loader.require("../../shared/windows-native-host.js")',
    'loader?.require("../../shared/windows-native-host.js")',
    'require (moduleName)',
    '(require)("../../shared/windows-native-host.js")',
    'require`../../shared/windows-native-host.js`',
    'module["require"](moduleName)',
    "x['require']",
    'x[`require`]',
    'module?.["require"]?.(moduleName)',
  ])("retains a factory with a possible module-load invocation: %s", invocation => {
    const source = `vi.mock("../../shared/windows-native-host.js", () => ({ read: () => ${invocation}.read() })); import { read } from "../store.js"; read();`;
    expect(nativeImportChains(sources(source)).has(SUITE)).toBe(true);
  });
  it.each([
    '() => { for ({ require: x } of xs) consume(x); return {}; }',
    '() => { for ({ require: x } in xs) consume(x); return {}; }',
    '() => ({ read: async () => { for await ({ require: x } of xs) consume(x); } })',
    '() => { for ({ require: x } of xs) { consume(x); } return {}; }',
    '() => { for ([{ require: x }] of xs) consume(x); return {}; }',
    '() => { let load; for ({ require: load } of [module]) consume(load); return { read: () => load.call(module, moduleName).read() }; }',
    '() => { for ({ require: x } in xs) { consume(x); } return {}; }',
    '() => ({ read: async () => { for await ([{ require: x }] of xs) { consume(x); } } })',
    '() => { let x; ({ require: x } = module); return { read: x }; }',
    '() => { let x; ([{ require: x }] = modules); return { read: x }; }',
  ])("retains destructuring targets regardless of loop body punctuation: %s", factory => {
    const source = `vi.mock("../../shared/windows-native-host.js", ${factory}); import { read } from "../store.js"; read();`;
    expect(nativeImportChains(sources(source)).has(SUITE)).toBe(true);
  });
  it.each([
    '1["require"]',
    '1["require"]?.',
    "1['require']",
    "1['require']?.",
    '1[`require`]',
    '1[`require`]?.',
    '0x1["require"]',
    '.5["require"]',
    '1e2["require"]',
    '1n["require"]',
    '1_000["require"]',
  ])("retains numeric computed loaders and records their literal edges: %s", loader => {
    const factory = `vi.mock("../../shared/windows-native-host.js", () => ({ read: () => ${loader}(moduleName).read() })); import { read } from "../store.js"; read();`;
    expect(nativeImportChains(sources(factory)).has(SUITE)).toBe(true);
    const call = `${loader}("../../shared/windows-native-host.js").read();`;
    expect(nativeImportChains(sources(call)).get(SUITE)).toEqual([SUITE, NATIVE]);
  });
  it.each([
    'vi.mock("../../shared/windows-native-host.js");',
    'vi.mock("../../shared/windows-native-host.js", async original => ({ ...await original() }));',
    'vi.mock("../../shared/windows-native-host.js", async () => ({ ...await vi.importActual("../../shared/windows-native-host.js") }));',
    'vi.mock("../../shared/windows-native-host.js", () => require("../../shared/windows-native-host.js"));',
    'vi.mock("../../shared/windows-native-host.js", () => ({ read: () => require(moduleName).read() }));',
    'vi.mock("../../shared/windows-native-host.js", () => ({})); vi.unmock("../../shared/windows-native-host.js");',
    'vi.doMock("../../shared/windows-native-host.js", () => ({}));',
  ])("retains native coverage when a mock does not replace every runtime path: %s", mock => {
    expect(nativeImportChains(sources(`${mock} import { read } from "../store.js"; read();`)).has(SUITE)).toBe(true);
  });
  it.each([
    'vi.mock("../../shared/windows-native-host.js", () => require("../../shared/windows-native-host.js"));',
    'vi.mock("../../shared/windows-native-host.js", () => ({ read: vi.fn() }));',
  ])("retains a real require edge alongside a module mock: %s", mock => {
    const source = `${mock} const { read } = require("../../shared/windows-native-host.js"); read();`;
    expect(nativeImportChains(sources(source)).get(SUITE)).toEqual([SUITE, NATIVE]);
  });
  it("ignores import-shaped comments, strings and regular expressions", () => {
    const source = '// import "../store.js";\nconst text = "import(\'../store.js\')"; const pattern = /import/;';
    expect([...nativeImportChains(sources(source))]).toEqual([]);
  });
  it("recognizes a new Windows module without extending a suite inventory", () => {
    const modules = sources('import "../store.js";', 'import "../shared/windows-new-boundary.js";');
    modules.set("src/shared/windows-new-boundary.ts", "export const enabled = true;");
    expect(nativeImportChains(modules).get(SUITE)?.at(-1)).toBe("src/shared/windows-new-boundary.ts");
  });
  it.each([0, 128])("keeps ordered shortest chains through cycles and suite mock cuts with %s extra modules", extra => {
    const first = "src/data/__tests__/first.test.ts";
    const second = "src/data/__tests__/second.test.ts";
    const alternate = "src/data/alternate.ts";
    const modules = new Map([
      [first, 'vi.mock("../store.js", () => ({})); import "../store.js"; import "../alternate.js";'],
      [second, 'import "../store.js"; import "../alternate.js";'],
      [STORE, 'import "./alternate.js"; export { read } from "../shared/windows-native-host.js";'],
      [alternate, 'import "./store.js"; export { read } from "../shared/windows-native-host.js";'],
      [NATIVE, "export const read = () => {};"],
    ]);
    for (let i = 0; i < extra; i++) modules.set(`src/data/unused-${i}.ts`, `export const value = ${i};`);
    expect([...nativeImportChains(modules)]).toEqual([
      [first, [first, alternate, NATIVE]],
      [second, [second, STORE, NATIVE]],
    ]);
  });

  it.each([0, 128])("rejects malformed source with %s extra modules", extra => {
    const modules = sources("const = ;");
    for (let i = 0; i < extra; i++) modules.set(`src/data/unused-${i}.ts`, "");
    expect(() => nativeBackedTestFiles(modules)).toThrow(/Expected/);
  });

  it.each<{ fault: string; replyTimeoutMs?: number }>([
    { fault: "startup", replyTimeoutMs: 100 },
    { fault: "crash", replyTimeoutMs: 250 },
    { fault: "exit", replyTimeoutMs: 100 },
    { fault: "stall" },
    { fault: "construction" },
    { fault: "preload" },
  ])("bounds worker $fault and releases its resources", async ({ fault, replyTimeoutMs }) => {
    const root = mkdtempSync(join(tmpdir(), "inventory-worker-"));
    try {
      const entry = join(root, "inventory.cjs");
      const preload = join(root, "preload.cjs");
      writeFileSync(preload, [
        'if (!require("node:worker_threads").isMainThread) throw new Error("Unexpected worker preload");',
        "globalThis.inventoryPreloadLoaded = true;",
      ].join("\n"));
      const inventoryPath = fileURLToPath(new URL("./windows-native-test-inventory.ts", import.meta.url));
      const source = readFileSync(inventoryPath, "utf8");
      const productionReplyTimeoutMs = 5000;
      const cleanupGraceMs = 1000;
      const preloadBatchCount = 3;
      const scan = replyTimeoutMs === undefined
        ? "nativeBackedTestFiles(modules)"
        : `scanNativeBackedTestFiles(modules, ${replyTimeoutMs})`;
      const bundled = buildSync({
        stdin: {
          // Only the fault subprocess bundle can call the private scanner with a shorter deadline.
          contents: replyTimeoutMs === undefined ? source : `${source}\nexport { scanNativeBackedTestFiles };\n`,
          loader: "ts",
          resolveDir: dirname(inventoryPath),
          sourcefile: inventoryPath,
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
        external: ["esbuild", "typescript/unstable/*"],
        define: { "import.meta.url": JSON.stringify(import.meta.url) },
        banner: { js: `
require = require("node:module").createRequire(${JSON.stringify(inventoryPath)});
const threads = require("node:worker_threads");
const fault = ${JSON.stringify(fault)};
const workers = [], exits = [], closures = [], flags = [], observedErrors = [], observedExits = [];
const terminations = [];
let batches = 0;
let closedPorts = 0;
let stallLiveAtTermination = false;
let armedAt;
const ready = ${replyTimeoutMs !== undefined || fault === "stall"} ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
const receive = threads.receiveMessageOnPort;
threads.receiveMessageOnPort = port => {
  const response = receive(port);
  if (response?.message.results) {
    batches++;
    if (fault === "preload") process.send(batches);
  }
  return response;
};
const BaseWorker = threads.Worker, BaseChannel = threads.MessageChannel;
threads.MessageChannel = class extends BaseChannel {
  constructor() {
    super();
    for (const port of [this.port1, this.port2]) closures.push(new Promise(resolve => port.once("close", () => {
      closedPorts++;
      resolve();
    })));
  }
};
threads.Worker = class extends BaseWorker {
  constructor(code, options) {
    flags.push(options.execArgv);
    if (fault === "construction") throw new Error("Controlled worker construction failure");
    if (fault === "startup") code = "const = ;";
    if (fault === "exit") {
      // Install the interceptor only in the evaluated payload, where the explicit exit originates.
      code = [
        'const exit = process.exit.bind(process);',
        'process.exit = code => {',
        '  if (code !== 0) return exit(code);',
        '  const onExit = status => { if (status === 0) arm(); };',
        '  process.once("exit", onExit);',
        '  try { return exit(code); } catch (error) { process.removeListener("exit", onExit); throw error; }',
        '};',
        "process.exit(0);",
      ].join("\\n");
    }
    if (fault === "stall") code = "setInterval(() => {}, 1000); arm();";
    if (fault === "crash") code = code.replace("port.postMessage({ results });", "port.postMessage({ results }); if (i === 0) process.exit(23);");
    if (ready) {
      options.workerData.ready = ready;
      const setup = [
        'const { ready } = require("node:worker_threads").workerData;',
        'const arm = () => { Atomics.store(ready, 0, 1); Atomics.notify(ready, 0); };',
      ];
      if (fault === "startup") {
        setup.push('process.once("uncaughtExceptionMonitor", error => { if (error.name === "SyntaxError") arm(); });');
      } else if (fault === "crash") {
        setup.push('process.once("exit", code => { if (code === 23) arm(); });');
      } else if (fault === "stall") {
        setup.push('process.once("exit", () => Atomics.store(ready, 0, 2));');
      }
      code = [
        ...setup,
        'eval(' + JSON.stringify(code) + ');',
      ].join("\\n");
    }
    super(code, options);
    workers.push(this);
    this.on("error", error => observedErrors.push(error.name));
    this.exited = new Promise(resolve => this.once("exit", code => {
      observedExits.push(code);
      resolve();
    }));
    exits.push(this.exited);
    // The scanner starts its short clock when this constructor returns. For a crash, the
    // real first reply is already queued when the worker reaches its exit handler.
    if (ready && fault !== "stall" && Atomics.wait(ready, 0, 0, ${productionReplyTimeoutMs}) !== "timed-out") {
      armedAt = performance.now();
    }
  }

  terminate() {
    if (fault === "stall") {
      stallLiveAtTermination = this.threadId !== -1 && Atomics.load(ready, 0) === 1;
    }
    // Armed failure hooks are already exiting. Let Node deliver their real events before forcing cleanup.
    const termination = armedAt === undefined ? super.terminate() : Promise.race([
      this.exited,
      new Promise(resolve => setTimeout(resolve, ${cleanupGraceMs}).unref()),
    ]).then(() => super.terminate());
    terminations.push(termination);
    return termination;
  }
};` },
        footer: { js: `
const modules = new Map([["src/__tests__/demo.test.ts", 'import { read } from "../windows-boundary"; read();'], ["src/windows-boundary.ts", "export function read() {}"]]);
for (let i = 2; i < 260; i++) modules.set("src/pad" + i + ".ts", "");
const started = performance.now();
let error, result;
try { result = [...module.exports.${scan}]; } catch (caught) { error = caught.message; }
const elapsedMs = performance.now() - (armedAt ?? started);
(async () => {
  await Promise.all(terminations);
  const closed = await Promise.race([
    Promise.all([...exits, ...closures]).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), ${cleanupGraceMs}).unref()),
  ]);
  console.log(JSON.stringify({
    error, result, elapsedMs, closed, liveWorkers: workers.filter(worker => worker.threadId !== -1).length,
    armed: armedAt !== undefined, observedErrors, observedExits, flags, batches,
    closedPorts, terminationRequests: terminations.length, stallLiveAtTermination,
    stallExitedOnItsOwn: fault === "stall" && Atomics.load(ready, 0) === 2,
    preloadLoaded: globalThis.inventoryPreloadLoaded === true }));
})();` },
      });
      writeFileSync(entry, bundled.outputFiles[0].text);
      const child = spawn(process.execPath, [...(fault === "preload" ? ["--require", preload] : []), entry], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        env: { ...process.env, NODE_PATH: undefined },
      });
      const watchdogMs = fault === "preload" ? productionReplyTimeoutMs + cleanupGraceMs : 8000;
      const outcome = await new Promise<{
        status: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string; progress: number;
      }>((resolve, reject) => {
        let stdout = "", stderr = "";
        let progress = 0;
        let timedOut = false;
        let watchdog: NodeJS.Timeout;
        const resetWatchdog = () => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, watchdogMs);
        };
        resetWatchdog();
        // Only the expected batch sequence extends the watchdog, outside the synchronous scanner.
        child.on("message", message => {
          if (fault === "preload" && progress < preloadBatchCount && message === progress + 1) {
            progress++;
            resetWatchdog();
          }
        });
        child.stdout?.setEncoding("utf8").on("data", data => { stdout += data; });
        child.stderr?.setEncoding("utf8").on("data", data => { stderr += data; });
        child.once("error", error => {
          clearTimeout(watchdog);
          reject(error);
        });
        child.once("close", (status, signal) => {
          clearTimeout(watchdog);
          resolve({ status, signal, timedOut, stdout, stderr, progress });
        });
      });
      expect(outcome.timedOut, `Child watchdog expired at batch count ${outcome.progress}`).toBe(false);
      expect(outcome.signal, outcome.stderr).toBeNull();
      expect(outcome.status, outcome.stderr).toBe(0);
      const receipt = JSON.parse(outcome.stdout.trim());
      expect(receipt.flags).toEqual([[]]);
      expect(receipt.closed).toBe(true);
      expect(receipt.closedPorts).toBe(2);
      expect(receipt.liveWorkers).toBe(0);
      expect(receipt.terminationRequests).toBe(fault === "construction" ? 0 : 1);
      expect(receipt.observedErrors).toEqual(fault === "startup" ? ["SyntaxError"] : []);
      if (fault === "preload") {
        expect(receipt.preloadLoaded).toBe(true);
        expect(receipt.error).toBeUndefined();
        expect(receipt.result).toEqual([["src/__tests__/demo.test.ts", ["src/__tests__/demo.test.ts", "src/windows-boundary.ts"]]]);
        expect(receipt.batches).toBe(preloadBatchCount);
        expect(outcome.progress).toBe(preloadBatchCount);
      } else if (fault === "construction") {
        expect(receipt.error).toBe("Controlled worker construction failure");
        expect(receipt.observedExits).toEqual([]);
      } else {
        if (fault === "startup") expect(receipt.observedExits).toEqual([1]);
        if (fault === "exit") expect(receipt.observedExits).toEqual([0]);
        if (fault === "crash") expect(receipt.observedExits).toEqual([23]);
        if (fault === "stall") {
          expect(receipt.stallLiveAtTermination).toBe(true);
          expect(receipt.stallExitedOnItsOwn).toBe(false);
          expect(receipt.observedExits).toEqual([1]);
        }
        if (replyTimeoutMs !== undefined) expect(receipt.armed).toBe(true);
        const expectedTimeoutMs = replyTimeoutMs ?? productionReplyTimeoutMs;
        expect(receipt.error).toBe(`Source transform worker stalled or exited before replying within ${expectedTimeoutMs}ms`);
        expect(receipt.elapsedMs).toBeGreaterThanOrEqual(expectedTimeoutMs);
        expect(receipt.elapsedMs).toBeLessThan(replyTimeoutMs === undefined ? 6500 : 2500);
        expect(receipt.batches).toBe(fault === "crash" ? 1 : 0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Windows native evidence", () => {
  it.each([
    'import { read } from "../../shared/windows-native-host.js"; read();',
    'const { read: load } = await import("../../shared/windows-native-host.js"); await load();',
    'import * as host from "../../shared/windows-native-host.js"; host.read();',
    'import { read } from "../store.js"; read();',
    'test.runIf(process.platform === "win32")("native case", () => run());',
    'if (process.platform === "win32") run();',
    'import { spawnSync } from "node:child_process"; spawnSync("ave-path-kind.exe", ["--pin"]);',
    'import { execFileSync } from "node:child_process"; const helper = join(directory, "wxc-exec.exe"); execFileSync(helper, []);',
    'import os from "node:os"; if (os.platform() === "win32") run();',
    'import { platform } from "node:os"; if (platform() === "win32") run();',
    'import { platform as host } from "node:os"; const current = host(); if (current === "win32") run();',
    'const platform = process.platform; if ("win32" === platform) run();',
    'import os from "node:os"; let platform = os.platform(); if (platform === "win32") run();',
    'import { spawn as launch } from "node:child_process"; launch("wxc-exec.exe", []);',
    'import { execFile as launch } from "node:child_process"; launch("icacls.exe", []);',
    'import fs from "node:fs"; fs.symlinkSync(target, link, "junction");',
    'import { symlink as link } from "node:fs/promises"; await link(target, path, "dir");',
    'import { promises as fs } from "node:fs"; await fs.readlink(path);',
    '// windows-native: the fixture launches the helper through the application\nrunFixture();',
  ])("includes a concrete native witness %s", source => {
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(true);
  });

  it.each([
    'import { read } from "../../shared/windows-native-host.js"; expect(true).toBe(true);',
    'import "../../shared/windows-native-host.js";',
    'await import("../../shared/windows-native-host.js");',
    'import { unrelated } from "../store.js"; unrelated();',
    'vi.mock("../../shared/windows-native-host.js", () => ({ read: vi.fn() })); import { read } from "../store.js"; read();',
    'Object.defineProperty(process, "platform", { value: "win32" }); if (process.platform === "win32") run();',
    'setProcessPlatform("win32"); if (process.platform === "win32") run();',
    'vi.mock("node:child_process", () => ({ spawnSync: vi.fn() })); spawnSync("ave-path-kind.exe");',
    'import { spawn as launch } from "node:child_process"; vi.mock("node:child_process", () => ({ spawn: vi.fn() })); launch("wxc-exec.exe");',
    'import fs from "node:fs"; vi.mock("node:fs", () => ({ default: { symlinkSync: vi.fn() } })); fs.symlinkSync(target, link, "junction");',
    'import { platform as host } from "node:os"; vi.mock("node:os", () => ({ platform: () => "win32" })); if (host() === "win32") run();',
    'const text = "if (process.platform === win32)"; const tool = "ave-path-kind.exe";',
    'run();\n// windows-native',
  ])("excludes an import, stub or mention without native evidence %s", source => {
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(false);
  });

  it("matches the called one-hop wrapper and leaves other exports out", () => {
    const wrapper = 'import { read } from "../shared/windows-native-host.js"; export function load() { return read(); } export function status() { return "ready"; }';
    expect(nativeBackedTestFiles(sources('import { load } from "../store.js"; load();', wrapper)).get(SUITE))
      .toEqual([SUITE, STORE, NATIVE]);
    expect(nativeBackedTestFiles(sources('import { status } from "../store.js"; status();', wrapper)).has(SUITE)).toBe(false);
  });
});
