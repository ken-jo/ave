import { createRequire } from "node:module";
import { platform } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { nativeBackedTestFiles } from "./windows-native-test-inventory.js";

const require = createRequire(import.meta.url);
vi.mock("node:os", () => ({ platform: () => Reflect.apply({ require }.require, null, ["node:os"]).platform() }));

const SUITE = "src/data/__tests__/store.test.ts";
const STORE = "src/data/store.ts";
const NATIVE = "src/shared/windows-native-host.ts";
function sources(test: string, store = 'export { read } from "../shared/windows-native-host.js";'): Map<string, string> {
  return new Map([[SUITE, test], [STORE, store], [NATIVE, "export const read = () => {};"]]);
}

describe("Windows native test inventory", () => {
  it("selects a mock flow that reaches the actual module through a loader property value", () => {
    expect(platform()).toBe(process.platform);
    const source = 'vi.mock("../../shared/windows-native-host.js", () => ({ read: () => Reflect.apply({ require }.require, null, ["../../shared/windows-native-host.js"]).read() })); import { read } from "../store.js"; read();';
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(true);
  });

  it.each([
    'import { read } from "../store.js"; read();',
    'const { read } = await import("../store.js"); read();',
    'const { read } = await vi.importActual("../store.js"); read();',
    'const { read } = require("../store.js"); read();',
  ])("follows runtime imports and re-exports: %s", source => {
    expect(nativeBackedTestFiles(sources(source)).get(SUITE)).toEqual([SUITE, STORE, NATIVE]);
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
    expect(nativeBackedTestFiles(sources(source, `exports.read = () => ${invocation}.read();`)).get(SUITE)).toEqual([SUITE, STORE, NATIVE]);
  });
  it("erases type-only imports before walking dependencies", () => {
    expect([...nativeBackedTestFiles(sources('import type { read } from "../store.js"; type Reader = typeof read;'))]).toEqual([]);
  });
  it("cuts a completely mocked native dependency even when its importer is indirect", () => {
    const source = 'vi.mock("../../shared/windows-native-host.js", () => ({ read: vi.fn() })); import { read } from "../store.js"; read();';
    expect([...nativeBackedTestFiles(sources(source))]).toEqual([]);
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
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(false);
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
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(true);
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
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(true);
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
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(true);
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
    expect(nativeBackedTestFiles(sources(factory)).has(SUITE)).toBe(true);
    const call = `${loader}("../../shared/windows-native-host.js").read();`;
    expect(nativeBackedTestFiles(sources(call)).get(SUITE)).toEqual([SUITE, NATIVE]);
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
    expect(nativeBackedTestFiles(sources(`${mock} import { read } from "../store.js"; read();`)).has(SUITE)).toBe(true);
  });
  it.each([
    'vi.mock("../../shared/windows-native-host.js", () => require("../../shared/windows-native-host.js"));',
    'vi.mock("../../shared/windows-native-host.js", () => ({ read: vi.fn() }));',
  ])("retains a real require edge alongside a module mock: %s", mock => {
    const source = `${mock} const { read } = require("../../shared/windows-native-host.js"); read();`;
    expect(nativeBackedTestFiles(sources(source)).get(SUITE)).toEqual([SUITE, NATIVE]);
  });
  it("ignores import-shaped comments, strings and regular expressions", () => {
    const source = '// import "../store.js";\nconst text = "import(\'../store.js\')"; const pattern = /import/;';
    expect([...nativeBackedTestFiles(sources(source))]).toEqual([]);
  });
  it("recognizes a new Windows module without extending a suite inventory", () => {
    const modules = sources('import "../store.js";', 'import "../shared/windows-new-boundary.js";');
    modules.set("src/shared/windows-new-boundary.ts", "export const enabled = true;");
    expect(nativeBackedTestFiles(modules).get(SUITE)?.at(-1)).toBe("src/shared/windows-new-boundary.ts");
  });
});
