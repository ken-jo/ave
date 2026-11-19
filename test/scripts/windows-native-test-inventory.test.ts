import { describe, expect, it } from "vitest";
import { nativeBackedTestFiles } from "./windows-native-test-inventory.js";

const SUITE = "src/data/__tests__/store.test.ts";
const STORE = "src/data/store.ts";
const NATIVE = "src/shared/windows-native-host.ts";
function sources(test: string, store = 'export { read } from "../shared/windows-native-host.js";'): Map<string, string> {
  return new Map([[SUITE, test], [STORE, store], [NATIVE, "export const read = () => {};"]]);
}

describe("Windows native test inventory", () => {
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
    '() => ({ read: vi.fn(), require: vi.fn() })',
    '() => { const require = vi.fn(); return { read: vi.fn(), require }; }',
    '() => ({ read: vi.fn(), value: loader.require })',
    '() => ({ read: vi.fn(), value: "require" /* require("../../shared/windows-native-host.js") */ })',
  ])("excludes a complete factory whose require token is not a module load: %s", factory => {
    const source = `vi.mock("../../shared/windows-native-host.js", ${factory}); import { read } from "../store.js"; read();`;
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(false);
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
  ])("retains a factory with a possible module-load invocation: %s", invocation => {
    const source = `vi.mock("../../shared/windows-native-host.js", () => ({ read: () => ${invocation}.read() })); import { read } from "../store.js"; read();`;
    expect(nativeBackedTestFiles(sources(source)).has(SUITE)).toBe(true);
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
