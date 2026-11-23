// windows-permission
/** Windows-only test cases run in CI only when their file is named in the Windows permission job (.github/workflows/ci.yml); the Linux and macOS shards skip them. A file that gates
 * cases on win32 but is missing from that list never runs anywhere, so this pins the list against the tree. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsRegressionFiles } from "../../.github/scripts/check-windows-workflow.mjs";
import { conditionalGates } from "./windows-test-gates.js";
import { nativeBackedTestFiles, readWindowsSources, windowsNativeInventory } from "./windows-native-test-inventory.js";
import { isCollectedVitestFile } from "../../scripts/lib/vitest-collection.mjs";
import { windowsPermissionInventory } from "../../scripts/windows-test-inventory.mjs";

const root = resolve(import.meta.dirname, "../..");
const STEP_NAME = "Run Windows permission regressions";
const EMPTY_WINDOWS_WORKFLOW = "jobs: { windows-permission-tests: { runs-on: windows-latest, steps: [] } }";
const NATIVE_TEST_LIST = "config/windows-native-tests.txt";
const PERMISSION_TEST_LIST = "config/windows-permission-tests.txt";
const windowsTestLists = new Map([NATIVE_TEST_LIST, PERMISSION_TEST_LIST, "config/windows-application-tests.txt"]
  .map(file => [file, readFileSync(join(root, file), "utf8")]));
const REQUIRED_SECURITY_SUITES = [
  // Boot, settings and transport callers reach native stores without platform guards.
  "src/boot/steps/__tests__/terminal-scrollback-setup.test.ts",
  "src/data/__tests__/settings-permission-store-independence.test.ts",
  "src/ipc/handlers/__tests__/permissions.test.ts",
  "src/main/terminal/__tests__/terminal-scrollback.test.ts",
  "src/api/__tests__/local-api.test.ts",
  "src/cli/__tests__/http-client.test.ts",
  "src/engine/__tests__/conversation-loop-project.test.ts",
  "src/permissions/__tests__/allowed-directories-nfd-root.test.ts",
  "src/permissions/__tests__/mxc-extension-admission.test.ts",
  "src/permissions/__tests__/mxc-sdk-packaging.test.ts",
  "src/permissions/__tests__/asrt-linux-runtime-probe.test.ts",
  // Home-content review must also cover case-insensitive filesystems.
  "src/ipc/domains/__tests__/permissions.test.ts",
  "src/permissions/__tests__/encoded-bypass-battery.test.ts",
  "src/permissions/__tests__/literal-proof.test.ts",
  "src/permissions/__tests__/literal-rule-identity.test.ts",
  "src/permissions/__tests__/permission-lane-budgets.test.ts",
  "src/permissions/__tests__/permission-nested-semantics.test.ts",
  "src/permissions/__tests__/permission-ordinary-performance.test.ts",
  "src/permissions/__tests__/permission-static-evaluation.test.ts",
  "src/permissions/__tests__/permission-visible-literal-regressions.test.ts",
  "src/permissions/__tests__/powershell-catalogue-parity.test.ts",
  "src/permissions/__tests__/powershell-data-roles.test.ts",
  "src/permissions/__tests__/powershell-dispatch-upload.test.ts",
  "src/permissions/__tests__/powershell-network-rules.test.ts",
  "src/permissions/__tests__/shell-exfiltration.test.ts",
  "src/permissions/__tests__/powershell-exfiltration.test.ts",
  "src/permissions/__tests__/rules-store-and-decision.test.ts",
  "src/permissions/__tests__/shell-sandbox-rules.test.ts",
  "src/permissions/__tests__/egress-ask.test.ts",
  "src/permissions/__tests__/execution-router.test.ts",
  "src/permissions/__tests__/scoped-rules.test.ts",
  "src/permissions/judge/__tests__/judge-dispatch.test.ts",
  "src/main/__tests__/document-open.test.ts",
  // Its fixture home must stay under the test temp root, which only a restricted Windows lane checks.
  "src/boot/__tests__/bootstrap-integration.test.ts",
] as const;

const nativeInventory = new WeakMap<ReadonlyMap<string, string>, Map<string, string[]>>();
function listProblems(sources: Map<string, string>, workflow: string, inventories = windowsTestLists): string[] {
  const listed = new Set(windowsRegressionFiles(workflow, inventories));
  let native = nativeInventory.get(sources);
  if (native === undefined) {
    native = nativeBackedTestFiles(sources);
    nativeInventory.set(sources, native);
  }
  return [...sources].flatMap(([file, source]) => {
    if (!isCollectedVitestFile(file)) return [];
    const gates = conditionalGates(source);
    const unknown = gates.filter((gate) => gate.classification === "unclassifiable")
      .map((gate) => `${file}:${gate.line}: unclassifiable argument: ${gate.argument}`);
    const required = REQUIRED_SECURITY_SUITES.some((suite) => suite === file)
      || file.endsWith(".windows.test.ts") || gates.some((gate) => gate.classification === "win32-only") || native.has(file);
    return [...unknown, ...(required && !listed.has(file) ? [`${file}: missing from ${STEP_NAME}`] : [])];
  }).sort();
}

describe("Windows CI test list", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const listed = windowsRegressionFiles(workflow, windowsTestLists);
  const sources = readWindowsSources(root);

  it("matches the generated native list in both directions", () => {
    expect(windowsTestLists.get(NATIVE_TEST_LIST)).toBe(windowsNativeInventory(sources));
  });

  it("matches the permission declarations in both directions", () => {
    expect(windowsTestLists.get(PERMISSION_TEST_LIST)).toBe(windowsPermissionInventory(sources));
  });

  it("collects only permission declarations in the header of runnable suites", () => {
    const files = new Map([
      ["src/main/__tests__/declared.test.ts", "// windows-native\n// windows-permission: exercise permission checks\nimport './fixture.js';"],
      ["src/main/__tests__/body.test.ts", "import './fixture.js';\n// windows-permission"],
      ["src/main/__tests__/native.test.ts", "// windows-native"],
      ["src/main/__tests__/support.ts", "export {};"],
    ]);
    expect(windowsPermissionInventory(files)).toBe("src/main/__tests__/declared.test.ts\n");
  });

  it.each([
    "src/main/window-input.test.ts",
    "src/main/__tests__/fixtures/runtime-input.ts",
    "src/main/__tests__/fixtures/nested/runtime-input.test.ts",
    "test/e2e/declared.spec.ts",
  ])("rejects either inventory marker outside Vitest collection at %s", file => {
    expect(isCollectedVitestFile(file)).toBe(false);
    for (const marker of ["windows-permission", "windows-native"]) {
      const sources = new Map([[file, `// ${marker}\nexport {};\n`]]);
      expect(() => windowsPermissionInventory(sources)).toThrow(file);
      expect(() => windowsNativeInventory(sources)).toThrow(file);
    }
  });

  it("keeps the real junction, symlink, reparse-point and ACL regressions in the native inventory", () => {
    const native = new Set(windowsTestLists.get(NATIVE_TEST_LIST)?.trim().split("\n"));
    for (const file of [
      "src/main/__tests__/skill-store.test.ts",
      "src/permissions/__tests__/sandbox-write-policy-hosted.test.ts",
      "src/permissions/__tests__/windows-acl-policy-budget.test.ts",
      "src/plugins/__tests__/registry-manifest-path-trust.test.ts",
      "src/tools/__tests__/file-tools-read-binding.test.ts",
      "src/tools/__tests__/grep-search-read-binding.test.ts",
      "src/tools/__tests__/preview-document-input.test.ts",
      "src/tools/__tests__/structured-file-transfers.test.ts",
    ]) expect(native.has(file), file).toBe(true);
  });

  it("names only files that exist", () => {
    expect(listed.filter((file) => !sources.has(file))).toEqual([]);
    expect(listed).toContain("test/scripts/windows-ci-test-list.test.ts");
  });

  it("does not count test paths mentioned only in workflow comments", () => {
    const file = "test/example.windows.test.ts";
    const mentioned = workflow.replace(
      "run: node .github/scripts/run-in-job.mjs bun run scripts/run-windows-test-list.mjs config/windows-permission-tests.txt",
      `run: node .github/scripts/run-in-job.mjs bun run scripts/run-windows-test-list.mjs config/windows-permission-tests.txt # ${file}`,
    );
    expect(mentioned).not.toBe(workflow);
    expect(listProblems(new Map([[file, ""]]), mentioned)).toEqual([`${file}: missing from ${STEP_NAME}`]);
  });

  it.each([
    "false", `\${{ false }}`, `\${{ (false) }}`, "steps.docs-impact.outputs.docs_only == 'true'", undefined,
  ])("rejects an unexpected Windows regression condition %s", (condition) => {
    const disabled = "test/alice.windows.test.ts";
    const enabled = "test/bob.windows.test.ts";
    const stepName = "Run Windows native import regressions";
    const conditional = `
jobs:
  windows-permission-tests:
    runs-on: windows-latest
    steps:
      - name: ${stepName}${condition === undefined ? "" : `\n        if: ${condition}`}
        run: bun run test -- ${disabled}
      - name: Run Windows appearance regressions
        if: steps.docs-impact.outputs.docs_only != 'true'
        run: bun run test -- ${enabled}
`;
    expect(() => windowsRegressionFiles(conditional, windowsTestLists))
      .toThrow(`windows-permission-tests: ${stepName}: expected if: steps.docs-impact.outputs.docs_only != 'true'`);
  });

  it("names every file with win32-only cases", () => {
    expect(listProblems(sources, workflow)).toEqual([]);
  });
  it.each(["boot/steps", "ipc/handlers", "data"])("requires an indirect native caller in %s", (area) => {
    const file = `src/${area}/__tests__/indirect.test.ts`;
    const module = `src/${area}/store.ts`;
    const indirect = new Map([
      [file, 'import { read } from "../store.js"; it("reads", () => read());'],
      [module, 'export { read } from "../../shared/windows-native-host.js";'],
      ["src/shared/windows-native-host.ts", "export const read = () => {};"],
    ]);
    // Resolve each area's different depth without making the test platform-specific.
    indirect.set(module, `export { read } from "${"../".repeat(area.split("/").length)}shared/windows-native-host.js";`);
    expect(listProblems(indirect, workflow)).toEqual([`${file}: missing from ${STEP_NAME}`]);
  });

  it("requires an actual-module import through an indirect native re-export", () => {
    const file = "src/data/__tests__/actual-store.test.ts";
    const indirect = new Map([
      [file, 'const { read } = await vi.importActual("../store.js"); it("reads", () => read());'],
      ["src/data/store.ts", 'export { read } from "../shared/windows-native-host.js";'],
      ["src/shared/windows-native-host.ts", "export const read = () => {};"],
    ]);
    expect(listProblems(indirect, workflow)).toEqual([`${file}: missing from ${STEP_NAME}`]);
  });

  it("names every unconditional security suite", () => {
    expect(REQUIRED_SECURITY_SUITES.filter((file) => !sources.has(file))).toEqual([]);
    expect(REQUIRED_SECURITY_SUITES.filter((file) => !listed.includes(file))).toEqual([]);
  });

  function withoutRegressionSuite(file: string) {
    const inventories = new Map(windowsTestLists);
    for (const list of [PERMISSION_TEST_LIST, NATIVE_TEST_LIST]) {
      inventories.set(list, (inventories.get(list) ?? "").split("\n").filter(line => line.trim() !== file).join("\n"));
    }
    return listProblems(sources, workflow, inventories);
  }

  it.each(REQUIRED_SECURITY_SUITES)("rejects removal of an unconditional security suite: %s", (file) => {
    expect(withoutRegressionSuite(file)).toEqual([`${file}: missing from ${STEP_NAME}`]);
  });

  it("rejects removal of the executable location tests from the workflow string", () => {
    const file = "src/main/__tests__/codex-executable-location.test.ts";
    expect(withoutRegressionSuite(file))
      .toEqual([`${file}: missing from ${STEP_NAME}`]);
  });
});

describe("conditional Windows gates", () => {
  it("detects comparisons through a local platform constant", () => {
    expect(conditionalGates(`
      import { platform as hostPlatform } from "node:os";
      const HOST = process.platform;
      const WINDOWS = "win32";
      const TARGET = WINDOWS;
      it.runIf(HOST === TARGET);
      it.runIf(hostPlatform() === TARGET);
    `).map((gate) => gate.classification)).toEqual(["win32-only", "win32-only"]);
  });

  it("detects redundant parentheses", () => {
    expect(conditionalGates('test.concurrent.runIf((process.platform === "win32"))("case", () => {});')[0]?.classification).toBe("win32-only");
  });

  it("detects a negative platform alias used by skipIf", () => {
    expect(conditionalGates('const notWindows = process.platform !== "win32"; test.skipIf(notWindows)("case", () => {});')[0]?.classification).toBe("win32-only");
  });

  it("allows other platforms and tests skipped on Windows", () => {
    expect(conditionalGates('it.runIf(process.platform === "darwin"); suite.skipIf(process.platform === "win32");').map((gate) => gate.classification))
      .toEqual(["not-win32-only", "not-win32-only"]);
  });

  it("reports opaque calls with their complete argument and line", () => {
    expect(conditionalGates('\nit.runIf(someHelper())("case", () => {});')).toEqual([
      { line: 2, argument: "someHelper()", classification: "unclassifiable" },
    ]);
    expect(listProblems(new Map([["test/example.test.ts", '\nit.runIf(someHelper())']]), EMPTY_WINDOWS_WORKFLOW))
      .toEqual(["test/example.test.ts:2: unclassifiable argument: someHelper()"]);
  });

  it("classifies known capability calls identically inline and through constants", () => {
    expect(conditionalGates(`
      const available = canCreateSymlinks();
      const installed = existsSync(path);
      const root = process.getuid?.() === 0;
      it.skipIf(!canCreateSymlinks());
      it.skipIf(!available);
      it.skipIf(!canCreateSymlinks(process.platform === "win32" ? "junction" : "dir"));
      test.runIf(existsSync(path));
      test.runIf(installed);
      describe.skipIf(process.getuid?.() === 0);
      describe.skipIf(root);
    `).map((gate) => gate.classification)).toEqual([
      "not-win32-only", "not-win32-only", "not-win32-only", "not-win32-only", "not-win32-only", "not-win32-only", "not-win32-only",
    ]);
  });

  it("classifies receipt availability while retaining platform requirements", () => {
    expect(conditionalGates(`
      const available = hasNativeSrtWinBuildReceipt();
      const alias = available;
      it.runIf(hasNativeSrtWinBuildReceipt());
      it.runIf(alias);
      it.skipIf(!hasNativeSrtWinBuildReceipt());
      it.runIf(process.platform === "win32" && hasNativeSrtWinBuildReceipt());
      it.runIf(process.platform === "win32" && alias);
      it.skipIf(process.platform !== "win32" || !hasNativeSrtWinBuildReceipt());
      it.skipIf(process.platform !== "win32" || !alias);
      it.skipIf(process.platform === "win32" && !hasNativeSrtWinBuildReceipt());
      it.runIf(process.platform === "win32" && someHelper());
    `).map((gate) => gate.classification)).toEqual([
      "not-win32-only", "not-win32-only", "not-win32-only",
      "win32-only", "win32-only", "win32-only", "win32-only",
      "not-win32-only", "unclassifiable",
    ]);
    expect(listProblems(new Map([["test/example.test.ts",
      'it.runIf(process.platform === "win32" && hasNativeSrtWinBuildReceipt());',
    ]]), EMPTY_WINDOWS_WORKFLOW))
      .toEqual([`test/example.test.ts: missing from ${STEP_NAME}`]);
  });

  it("rejects unknown capability calls identically inline and through constants", () => {
    expect(conditionalGates(`
      const available = someHelper();
      const enabled = someHelper() === true;
      it.runIf(someHelper());
      it.runIf(available);
      test.skipIf(someHelper() === true);
      test.skipIf(enabled);
      it.runIf((someHelper)());
      it.runIf(Boolean(available));
      it.runIf(available.trim());
    `).map((gate) => gate.classification)).toEqual([
      "unclassifiable", "unclassifiable", "unclassifiable", "unclassifiable",
      "unclassifiable", "unclassifiable", "unclassifiable",
    ]);
  });

  it("rejects unknown member calls while allowing value methods", () => {
    expect(conditionalGates(`
      function supported() { return process.platform === "win32"; }
      const capability = { check: supported };
      it.runIf(capability.check());
      it.runIf(capability?.check());
      it.runIf(process.env.KEY?.trim());
      it.runIf(fs.existsSync(path));
    `).map((gate) => gate.classification)).toEqual(["unclassifiable", "unclassifiable", "not-win32-only", "not-win32-only"]);
  });

  it("rejects an unknown capability hidden behind a named alias", () => {
    expect(listProblems(new Map([["test/example.test.ts", [
      "const available = someHelper();",
      "const alias = available;",
      "it.skipIf(alias);",
    ].join("\n")]]), EMPTY_WINDOWS_WORKFLOW))
      .toEqual(["test/example.test.ts:3: unclassifiable argument: alias"]);
  });

  it("models platform-restricting helpers inline and through constants", () => {
    expect(conditionalGates(`
      const disabled = shouldSkipNativeSandboxTests();
      it.skipIf(shouldSkipNativeSandboxTests());
      it.skipIf(disabled);
      it.runIf(!shouldSkipNativeSandboxTests());
      it.runIf(!disabled);
      it.skipIf(shouldSkipNativeSandboxTests("linux"));
      it.runIf(!shouldSkipNativeSandboxTests("win32"));
      it.runIf(process.platform === "win32" && !shouldSkipNativeSandboxTests("linux"));
      it.skipIf(shouldSkipNativeSandboxTests(someHelper()));
    `).map((gate) => gate.classification)).toEqual([
      "not-win32-only", "not-win32-only", "not-win32-only", "not-win32-only",
      "not-win32-only", "not-win32-only", "win32-only", "unclassifiable",
    ]);
  });

  it("classifies unknown calls only when they cannot change the verdict", () => {
    expect(conditionalGates(`
      const available = someHelper();
      const alias = available;
      it.runIf(process.platform === "darwin" && /version/.test(spawnSync("sh")));
      it.runIf(process.platform === "darwin" && someHelper());
      it.runIf(process.platform === "darwin" && alias);
      it.runIf(someHelper());
      it.runIf(alias);
      it.runIf(unresolved);
      it.runIf(process.platform === "win32" && someHelper());
    `).map((gate) => gate.classification)).toEqual([
      "not-win32-only", "not-win32-only", "not-win32-only", "unclassifiable",
      "unclassifiable", "not-win32-only", "unclassifiable",
    ]);
  });

  it("treats value comparisons as features", () => {
    expect(conditionalGates(`
      it.runIf(shell !== undefined);
      it.runIf(process.platform === "win32" && shell !== undefined);
    `).map((gate) => gate.classification)).toEqual(["not-win32-only", "win32-only"]);
  });

  it("models launcher availability through its undefined comparison", () => {
    expect(conditionalGates(`
      const launcher = electronControlLauncher();
      const available = launcher !== undefined || sandboxCasesRequired();
      it.runIf(available);
      it.skipIf(available);
      it.runIf(process.platform === "win32" && available);
      it.runIf(process.platform === "win32" && hasExecutable("node"));
    `).map((gate) => gate.classification)).toEqual(["not-win32-only", "not-win32-only", "win32-only", "win32-only"]);
  });

  it("combines platform requirements according to whether tests run or skip", () => {
    expect(conditionalGates(`
      const enabled = process.env.FEATURE;
      const disabled = process.env.DISABLED;
      it.runIf(process.platform === "win32" && enabled);
      it.runIf(process.platform === "win32" || enabled);
      describe.skipIf(process.platform !== "win32" || disabled);
      suite.skipIf(process.platform !== "win32" && disabled);
      test.runIf(!(process.platform === "win32"));
      it.runIf(process.env.FEATURE === "1");
    `).map((gate) => gate.classification)).toEqual([
      "win32-only", "not-win32-only", "win32-only", "not-win32-only", "not-win32-only", "not-win32-only",
    ]);
  });

  it("balances nested calls and ignores comments and string fixtures", () => {
    expect(conditionalGates(`
      // it.runIf(someHelper());
      const fixture = 'it.runIf(someHelper())';
      const enabled = process.env.FEATURE;
      describe.concurrent.runIf(\n ((os.platform() === 'win32'))\n && enabled /* ) */);
      it.skipIf(check("a)b", nested()));
    `).map(({ argument, classification }) => ({ argument, classification }))).toEqual([
      { argument: "\n ((os.platform() === 'win32'))\n && enabled /* ) */", classification: "win32-only" },
      { argument: 'check("a)b", nested())', classification: "unclassifiable" },
    ]);
  });

  it("resolves aliases within their own lexical scopes", () => {
    expect(conditionalGates(`
      const HOST = process.platform;
      { const HOST = "darwin"; it.runIf(HOST === "win32"); }
      it.runIf(HOST === "win32");
    `).map((gate) => gate.classification)).toEqual(["not-win32-only", "win32-only"]);
  });

  it("keeps the Windows filename convention without conditional cases", () => {
    expect(listProblems(new Map([["test/example.windows.test.ts", ""]]), EMPTY_WINDOWS_WORKFLOW))
      .toEqual([`test/example.windows.test.ts: missing from ${STEP_NAME}`]);
  });

  it("classifies named capabilities while retaining platform requirements", () => {
    expect(conditionalGates(`
      const available = canCreateSymlinks();
      const HOST = process.platform;
      const enabled = HOST === "win32" && available;
      it.runIf(enabled);
      test.skipIf(!available);
      test.runIf(unknownHost === "win32");
    `).map((gate) => gate.classification)).toEqual(["win32-only", "not-win32-only", "unclassifiable"]);
  });

  it("extracts every conditional call in a builder chain", () => {
    expect(conditionalGates('const disabled = process.env.DISABLED; suite.runIf(process.platform === "win32").concurrent.skipIf(disabled)("case", () => {});')
      .map((gate) => gate.classification)).toEqual(["win32-only", "not-win32-only"]);
  });

  it("ignores regex literals and template text while scanning expressions", () => {
    expect(conditionalGates('const pattern = /}it.runIf(fake)\\(/; const text = `literal ${"}"} it.runIf(fake)`; it.runIf(os.platform() === "win32");')
      .map((gate) => gate.classification)).toEqual(["win32-only"]);
  });
});
