// Lock: every destructive or renaming capability of the download backends lives in its identity-bound primitive (mutate_entry,
// mutateEntry). The native scan forbids the capabilities themselves, not only their call spellings, in every file of both native
// backends except the fixture allow-list. The host rule is an import graph: only browser-download-files.ts may import mutating fs names,
// and it may reference them only inside mutateEntry. Each reviewer bypass form is a named fixture below that must turn the lock red.
// Residual, not detected: computed dynamic dispatch (a function pointer resolved at run time from a computed name, such as GetProcAddress
// or dlsym with a built string, or a host call through a computed key or a computed module specifier); a create disposition, open option
// or flag written as a bare number other than the delete-on-close spellings below (such as NtCreateFile disposition 0 or 5, or O_TRUNC's
// value); an open flag string built at run time; and code in modules outside these scanned files.
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { _descriptorFileOperationsForTest } from "../browser-download-files.js";

const ROOT = join(import.meta.dirname, "../../../..");
const NATIVE_DIRECTORIES = ["native/windows-path-kind", "native/macos-dir-ops"] as const;
// Test-only programs that model competing filesystem actors, and prose.
const NATIVE_FIXTURES = new Set(["native/windows-path-kind/pin-test.cpp", "native/windows-path-kind/README.md", "native/macos-dir-ops/README.md"]);
const PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  "native/windows-path-kind/dir-recovery.h": ["inline FileFailure mutate_entry("],
  "native/macos-dir-ops/dir-ops.c": ["static enum remove_result mutate_entry(", "static void swap_file("],
};
const HOST_OWNER = "src/main/browser/browser-download-files.ts";

const NATIVE_RULES: readonly (readonly [string, RegExp])[] = [
  ["raw mutation call", /\b(?:unlink(?:at)?|rename(?:at2?|atx_np|x_np)?|DeleteFile\w*|MoveFile\w*|RemoveDirectory\w*|ReplaceFile\w*|NtDeleteFile|ZwDeleteFile)\s*\(/gu],
  ["CRT or library name change", /(?:\b_w?(?:unlink|remove|rename)\b|\bremove\s*\(|std::filesystem::|\bfilesystem::)/gu],
  ["mutation name taken as a value", /(?:&\s*(?:::)?|=\s*(?:::)?)(?:_w?)?(?:unlink(?:at)?|rename(?:at2?|atx_np|x_np)?|remove|DeleteFile\w*|MoveFile\w*|RemoveDirectory\w*)\b(?!\s*\()/gu],
  // The job-object limit call configures process lifetime and takes no file handle.
  ["set-information capability", /\b(?!SetInformationJobObject\b)\w*Set\w*Information\w*\b/gu],
  ["information class type or numeric class", /\b(?:FILE_INFORMATION_CLASS|FILE_INFO_BY_HANDLE_CLASS)\b|\bFile(?:Disposition|Rename)Info\w*|\bFILE_(?:DISPOSITION|RENAME)_INFO\w*/gu],
  ["delete on close", /\b(?:FILE_DELETE_ON_CLOSE|FILE_FLAG_DELETE_ON_CLOSE)\b|\b0x0*1000\b|\b0x0*4000000\b|\b4096u?\b|\b1u?\s*<<\s*12\b/gu],
  ["truncating or superseding open", /\bFILE_(?:SUPERSEDE|OVERWRITE(?:_IF)?)\b|\b(?:CREATE_ALWAYS|TRUNCATE_EXISTING|O_TRUNC)\b/gu],
];
// Native entry points looked up by name outside the primitive: only these read-only ones.
const NATIVE_LOOKUPS = new Set(["NtCreateFile", "RtlNtStatusToDosError"]);
const FS_MODULE = /^(?:node:)?(?:original-)?fs(?:\/promises)?$/u;
const MUTATING_FS = /^(?:unlink|rm|rmdir|rename|writeFile|appendFile|truncate|ftruncate|copyFile|cp|link|symlink|lchown|utimes|lutimes)(?:Sync)?$|^createWriteStream$/u;
// An open flag string that truncates: w without x (wx creates exclusively).
const TRUNCATING_FLAG = /^[^x]*w[^x]*$/u;
const HOST_RAW = /\b(?:unlink(?:at|Sync)?|rm(?:dir|dirSync|Sync)?|rename(?:at2?|Sync|Exclusive)?|linuxRename)\s*\(/gu;

function removeFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing mutation boundary: ${signature}`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`missing end of mutation boundary: ${signature}`);
  return source.slice(0, start) + source.slice(end + 3);
}

function lineOf(code: string, index: number): string {
  const before = code.lastIndexOf("\n", index);
  const after = code.indexOf("\n", index);
  return code.slice(before + 1, after < 0 ? undefined : after).trim();
}

function nativeViolations(path: string, text: string): string[] {
  let source = text.replaceAll("\r\n", "\n");
  for (const signature of PRIMITIVES[path] ?? []) source = removeFunction(source, signature);
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/[^\n]*/gu, "");
  const violations: string[] = [];
  for (const match of code.matchAll(/\b\w+\s*<[^<>;]*>\s*\(\s*"(\w+)"/gu)) {
    if (!NATIVE_LOOKUPS.has(match[1] ?? "")) violations.push(`${path}: native lookup ${match[1]}: ${lineOf(code, match.index)}`);
  }
  const bare = code.replace(/L?"(?:[^"\\\n]|\\.)*"/gu, '""');
  for (const match of code.matchAll(/"((?:Nt|Zw)\w+)"/gu)) {
    if (!NATIVE_LOOKUPS.has(match[1] ?? "") && /Information|Delete/u.test(match[1] ?? "")) {
      violations.push(`${path}: native entry name ${match[1]}: ${lineOf(code, match.index)}`);
    }
  }
  for (const [rule, pattern] of NATIVE_RULES) {
    for (const match of bare.matchAll(pattern)) violations.push(`${path}: ${rule}: ${lineOf(bare, match.index)}`);
  }
  return violations;
}

function hostViolations(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const at = (node: ts.Node, what: string): void => {
    violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${what}: ${node.getText(source)}`);
  };
  const owner = path === HOST_OWNER;
  const mutating = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !FS_MODULE.test(statement.moduleSpecifier.text)) continue;
    const imports = statement.importClause;
    if (imports?.name || (imports?.namedBindings && ts.isNamespaceImport(imports.namedBindings))) at(statement, "whole fs module import");
    if (imports?.namedBindings && ts.isNamedImports(imports.namedBindings)) {
      for (const element of imports.namedBindings.elements) {
        if (!MUTATING_FS.test((element.propertyName ?? element.name).text)) continue;
        if (!owner) at(element, "mutating fs import outside the owner");
        mutating.add(element.name.text);
      }
    }
  }
  const walk = (node: ts.Node, inPrimitive: boolean): void => {
    const primitive = inPrimitive || (ts.isFunctionDeclaration(node) && node.name?.text === "mutateEntry");
    if (ts.isCallExpression(node)) {
      const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword || /^require\w*$/u.test(node.expression.getText(source));
      if (loads && node.arguments.some((arg) => ts.isStringLiteral(arg) && FS_MODULE.test(arg.text))) at(node, "fs module loaded at run time");
    }
    if (ts.isIdentifier(node) && mutating.has(node.text) && !primitive && !ts.isImportSpecifier(node.parent)) at(node, "mutating fs name outside mutateEntry");
    if (!primitive && ts.isIdentifier(node) && node.text === "O_TRUNC") at(node, "truncating open flag outside mutateEntry");
    if (!primitive && ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(source);
      if (/^open(?:Sync)?$/u.test(callee) && node.arguments.some((arg) => ts.isStringLiteralLike(arg) && TRUNCATING_FLAG.test(arg.text))) {
        at(node, "truncating open outside mutateEntry");
      }
      if (ts.isPropertyAccessExpression(node.expression) && callee === "truncate") at(node, "truncate through a handle outside mutateEntry");
    }
    ts.forEachChild(node, (child) => walk(child, primitive));
  };
  walk(source, false);
  const outside = owner ? removeIndentedFunction(text.replaceAll("\r\n", "\n"), "  function mutateEntry(") : text;
  for (const match of outside.matchAll(HOST_RAW)) violations.push(`${path}: raw mutation call: ${lineOf(outside, match.index)}`);
  return violations;
}

function removeIndentedFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing mutation boundary: ${signature}`);
  const end = source.indexOf("\n  }\n", start);
  if (end < 0) throw new Error(`missing end of mutation boundary: ${signature}`);
  return source.slice(0, start) + source.slice(end + 5);
}

function lockViolations(sources: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, text] of sources) {
    if (NATIVE_FIXTURES.has(path)) continue;
    violations.push(...(path.startsWith("native/") ? nativeViolations(path, text) : hostViolations(path, text)));
  }
  return violations;
}

function backendSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const add = (directory: string): void => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) add(path);
      else sources.set(path, readFileSync(join(ROOT, path), "utf8"));
    }
  };
  for (const directory of NATIVE_DIRECTORIES) add(directory);
  const browser = join(ROOT, "src/main/browser");
  for (const name of readdirSync(browser)) {
    if (/^browser-download.*\.ts$/u.test(name)) sources.set(relative(ROOT, join(browser, name)).replaceAll("\\", "/"), readFileSync(join(browser, name), "utf8"));
  }
  return sources;
}

it("keeps native name changes inside the verified entry primitives", () => {
  const sources = backendSources();
  expect([...sources.keys()]).toEqual(expect.arrayContaining([HOST_OWNER, "src/main/browser/browser-download-staging.ts",
    "native/windows-path-kind/dir-ops.h", "native/windows-path-kind/dir-recovery.h", "native/macos-dir-ops/dir-ops.c"]));
  expect(lockViolations(sources)).toEqual([]);
});

const insert = (path: string, after: string, added: string) => (sources: Map<string, string>): void => {
  const text = sources.get(path);
  if (text?.includes(after) !== true) throw new Error(`fixture anchor missing in ${path}`);
  sources.set(path, text.replace(after, `${after}${added}`));
};
const WINDOWS_OPS = "native/windows-path-kind/dir-ops.h";
const WINDOWS_ANCHOR = "\n#include \"dir-recovery.h\"\n\nnamespace dir_ops {\n";
const BYPASSES: readonly (readonly [string, (sources: Map<string, string>) => void, readonly RegExp[]])[] = [
  ["1 set-information lookup through a local alias with a numeric class", insert(WINDOWS_OPS, WINDOWS_ANCHOR,
    "inline void probe_a(HANDLE h) {\n  using Set = NTSTATUS(NTAPI*)(HANDLE, IO_STATUS_BLOCK*, void*, ULONG, FILE_INFORMATION_CLASS);\n" +
    "  const auto alias = ntdll_function<Set>(\"NtSetInformationFile\");\n  IO_STATUS_BLOCK io{};\n" +
    "  alias(h, &io, nullptr, 0, static_cast<FILE_INFORMATION_CLASS>(13));\n}\n"),
  [/native lookup NtSetInformationFile/u, /information class type or numeric class: .*static_cast<FILE_INFORMATION_CLASS>\(13\)/u]],
  ["2 delete-on-close open", insert(WINDOWS_OPS, WINDOWS_ANCHOR,
    "inline void probe_b(HANDLE dir, HANDLE& h) { open_relative(dir, L\"x\", DELETE, 0, kOpenExisting, 0x00001000 /*FILE_DELETE_ON_CLOSE*/, h); }\n"),
  [/delete on close: .*0x00001000/u]],
  ["3 function-pointer alias of the set-information call", insert(WINDOWS_OPS, WINDOWS_ANCHOR,
    "inline const auto probe_c = &::SetFileInformationByHandle;\n"),
  [/set-information capability: inline const auto probe_c/u]],
  ["4 CRT unlink, remove and rename names", insert(WINDOWS_OPS, WINDOWS_ANCHOR,
    "inline void probe_d() { _wunlink(L\"x\"); _wremove(L\"x\"); _wrename(L\"x\", L\"y\"); }\n"),
  [/CRT or library name change: inline void probe_d/u]],
  ["5 new native file outside the primitive", (sources) => { sources.set("native/windows-path-kind/probe.inl", "inline void probe_e() { DeleteFileW(L\"x\"); }\n"); },
    [/native\/windows-path-kind\/probe\.inl: raw mutation call/u]],
  ["6 whole fs module removal in the staging module", insert("src/main/browser/browser-download-staging.ts", "const log = createLogger(\"browser-download-staging\");\n",
    "import * as fs from \"node:fs\";\nexport function probeF(): void { fs.unlinkSync(\"x\"); }\n"),
  [/browser-download-staging\.ts:\d+ whole fs module import/u, /browser-download-staging\.ts: raw mutation call: .*fs\.unlinkSync/u]],
  ["7 identifier alias of a mutating import in the owner", insert(HOST_OWNER, "const log = createLogger(\"browser-download-files\");\n",
    "export function probeG(p: string): void { const probe = unlinkSync; probe(p); }\n"),
  [/browser-download-files\.ts:\d+ mutating fs name outside mutateEntry: unlinkSync/u]],
  ["8 delete on close as a decimal or a shift", insert(WINDOWS_OPS, WINDOWS_ANCHOR,
    "inline void probe_h(HANDLE dir, HANDLE& h) { open_relative(dir, L\"x\", DELETE, 0, kOpenExisting, 4096, h); open_relative(dir, L\"y\", DELETE, 0,\n" +
    "  kOpenExisting, 1u << 12, h); }\n"),
  [/delete on close: .*kOpenExisting, 4096, h\)/u, /delete on close: .*kOpenExisting, 1u << 12, h\)/u]],
  ["9 superseding and overwriting create dispositions", insert(WINDOWS_OPS, WINDOWS_ANCHOR,
    "inline const ULONG probe_i[] = {FILE_SUPERSEDE, FILE_OVERWRITE, FILE_OVERWRITE_IF};\n"),
  [/truncating or superseding open: inline const ULONG probe_i/u]],
  ["10 O_TRUNC in a native and a host open", (sources) => {
    insert(WINDOWS_OPS, WINDOWS_ANCHOR, "inline const int probe_j = O_WRONLY | O_TRUNC;\n")(sources);
    insert(HOST_OWNER, "const log = createLogger(\"browser-download-files\");\n",
      "export function probeJ(p: string): number { return openSync(p, constants.O_WRONLY | constants.O_TRUNC); }\n")(sources);
  }, [/truncating or superseding open: inline const int probe_j/u, /browser-download-files\.ts:\d+ truncating open flag outside mutateEntry: O_TRUNC/u]],
  ["11 the original-fs module", insert("src/main/browser/browser-download-staging.ts", "const log = createLogger(\"browser-download-staging\");\n",
    "import { unlinkSync as probeK } from \"original-fs\";\nexport function probeKUse(): void { probeK(\"x\"); }\n"),
  [/browser-download-staging\.ts:\d+ mutating fs import outside the owner: unlinkSync as probeK/u]],
  ["12 an open that truncates", insert("src/main/browser/browser-download-staging.ts", "const log = createLogger(\"browser-download-staging\");\n",
    "export function probeL(): number { return openSync(\"x\", \"w\"); }\n"),
  [/browser-download-staging\.ts:\d+ truncating open outside mutateEntry: openSync\("x", "w"\)/u]],
  ["13 a write stream", insert(HOST_OWNER, "const log = createLogger(\"browser-download-files\");\n",
    "import { createWriteStream } from \"node:fs\";\nexport function probeM(p: string): void { createWriteStream(p).end(); }\n"),
  [/browser-download-files\.ts:\d+ mutating fs name outside mutateEntry: createWriteStream/u]],
  ["14 a file handle's truncate", insert(HOST_OWNER, "const log = createLogger(\"browser-download-files\");\n",
    "export async function probeN(handle: { truncate(length: number): Promise<void> }): Promise<void> { await handle.truncate(0); }\n"),
  [/browser-download-files\.ts:\d+ truncate through a handle outside mutateEntry: handle\.truncate\(0\)/u]],
];

describe("each named bypass form turns the lock red", () => {
  it.each(BYPASSES)("%s", (_name, inject, expected) => {
    const sources = backendSources();
    inject(sources);
    const violations = lockViolations(sources);
    for (const pattern of expected) expect(violations.some((line) => pattern.test(line)), `${pattern} in ${JSON.stringify(violations)}`).toBe(true);
  });
});

describe.runIf(process.platform === "linux")("an exclusive recovery rename races with a name replacement", () => {
  it.each([false, true])("keeps unrelated entries at the rollback boundary: %s", async (replaceBeforeRollback) => {
    const root = mkdtempSync(join(process.env.AVE_TEST_TMP_ROOT ?? process.cwd(), "download-rename-boundary-"));
    try {
      const hidden = `.${"a".repeat(32)}.removing`;
      const target = "target";
      const saved = join(root, "original");
      const displaced = join(root, "displaced");
      writeFileSync(join(root, hidden), "original");
      const folder = { path: root, ...statSync(root, { bigint: true }) };
      const info = statSync(join(root, hidden), { bigint: true });
      const stamp = { dev: info.dev, ino: info.ino, evidence: { class: "birth" as const, value: String(info.birthtimeNs) } };
      const files = _descriptorFileOperationsForTest((from, to) => {
        if (from === hidden && to === target) {
          renameSync(join(root, hidden), saved);
          writeFileSync(join(root, hidden), "first replacement");
        } else if (from === target && to === hidden && replaceBeforeRollback) {
          renameSync(join(root, target), displaced);
          writeFileSync(join(root, target), "second replacement");
        }
      });
      await expect(files.recoverTarget(folder, hidden, target, stamp)).resolves.toBe("left");
      expect(readFileSync(saved, "utf8")).toBe("original");
      if (replaceBeforeRollback) {
        expect(readFileSync(displaced, "utf8")).toBe("first replacement");
        expect(readFileSync(join(root, target), "utf8")).toBe("second replacement");
        expect(readdirSync(root)).not.toContain(hidden);
      } else {
        expect(readFileSync(join(root, hidden), "utf8")).toBe("first replacement");
        expect(readdirSync(root)).not.toContain(target);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
