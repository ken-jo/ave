/** Windows-only test cases run in CI only when their file is named in the Windows permission job (.github/workflows/ci.yml); the Linux and macOS shards skip them. A file that gates
 * cases on win32 but is missing from that list never runs anywhere, so this pins the list against the tree. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { conditionalGates } from "./windows-test-gates.js";

const root = resolve(import.meta.dirname, "../..");
const STEP_NAME = "Run Windows permission regressions";
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const REQUIRED_SECURITY_SUITES = [
  "src/permissions/__tests__/shell-exfiltration.test.ts",
  "src/permissions/__tests__/powershell-exfiltration.test.ts",
  "src/permissions/__tests__/rules-store-and-decision.test.ts",
  "src/permissions/__tests__/shell-sandbox-rules.test.ts",
  "src/permissions/__tests__/egress-ask.test.ts",
  "src/permissions/__tests__/execution-router.test.ts",
  "src/permissions/__tests__/scoped-rules.test.ts",
  "src/permissions/judge/__tests__/judge-dispatch.test.ts",
  "src/main/__tests__/document-open.test.ts",
] as const;
function windowsJobFiles(workflow: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${STEP_NAME}`);
  if (start < 0) throw new Error(`ci.yml has no "${STEP_NAME}" step`);
  const files: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s/.test(line)) break;
    const token = line.trim();
    if (TEST_FILE_RE.test(token)) files.push(token);
  }
  return files;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return testFiles(path);
    return TEST_FILE_RE.test(name) ? [relative(root, path).split("\\").join("/")] : [];
  });
}

function listProblems(sources: Map<string, string>, workflow: string): string[] {
  const listed = windowsJobFiles(workflow);
  return [...sources].flatMap(([file, source]) => {
    const gates = conditionalGates(source);
    const unknown = gates.filter((gate) => gate.classification === "unclassifiable")
      .map((gate) => `${file}:${gate.line}: unclassifiable argument: ${gate.argument}`);
    const required = REQUIRED_SECURITY_SUITES.some((suite) => suite === file)
      || file.endsWith(".windows.test.ts") || gates.some((gate) => gate.classification === "win32-only");
    return [...unknown, ...(required && !listed.includes(file) ? [`${file}: missing from ${STEP_NAME}`] : [])];
  }).sort();
}

describe("Windows CI test list", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const listed = windowsJobFiles(workflow);
  const sources = new Map(["src", "test"].flatMap((dir) => testFiles(join(root, dir)))
    .map((file) => [file, readFileSync(join(root, file), "utf8")]));

  it("names only files that exist", () => {
    expect(listed.filter((file) => !testFiles(join(root, file.split("/")[0]!)).includes(file))).toEqual([]);
  });

  it("names every file with win32-only cases", () => {
    expect(listProblems(sources, workflow)).toEqual([]);
  });

  it("names every unconditional security suite", () => {
    expect(REQUIRED_SECURITY_SUITES.filter((file) => !sources.has(file))).toEqual([]);
    expect(REQUIRED_SECURITY_SUITES.filter((file) => !listed.includes(file))).toEqual([]);
  });

  it.each(REQUIRED_SECURITY_SUITES)("rejects removal of an unconditional security suite: %s", (file) => {
    const withoutSuite = workflow.split("\n").filter((line) => line.trim() !== file).join("\n");
    expect(listProblems(sources, withoutSuite)).toEqual([`${file}: missing from ${STEP_NAME}`]);
  });

  it("rejects removal of the executable location tests from the workflow string", () => {
    const file = "src/main/__tests__/codex-executable-location.test.ts";
    expect(listProblems(sources, workflow.split("\n").filter((line) => line.trim() !== file).join("\n")))
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
    expect(listProblems(new Map([["test/example.test.ts", '\nit.runIf(someHelper())']]), `- name: ${STEP_NAME}\n`))
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
    ].join("\n")]]), `- name: ${STEP_NAME}\n`))
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
    expect(listProblems(new Map([["test/example.windows.test.ts", ""]]), `- name: ${STEP_NAME}\n`))
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
