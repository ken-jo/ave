import { globSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { expect, it } from "vitest";
import { WINDOWS_MEMORY_CLASS_A_FILES } from "./support/windows-memory-class-a.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SELECTORS = new Set([
  "src/ipc/domains/chat.ts",
  "src/ipc/domains/settings.ts",
  "src/boot/services.ts",
  "src/boot.ts",
  "src/data/settings-store.ts",
  "src/data/settings-normalization.ts",
  "src/ui/renderer/App.tsx",
]);
const ADMISSION_MODULES = new Set([
  "src/shared/admission-commit",
  "src/permissions/windows-background-features",
  "src/permissions/windows-confinement-evidence",
]);
// These shared paths already guard their Windows admission calls.
const EXISTING_EDGES = new Set([
  "src/boot/steps/sandbox-init.ts -> src/permissions/windows-background-features",
  "src/boot/steps/sandbox-init.ts -> src/permissions/windows-confinement-evidence",
  "src/permissions/confined-child.ts -> src/permissions/windows-confinement-evidence",
  "src/permissions/egress-host-listener.ts -> src/shared/admission-commit",
  "src/permissions/mxc-extension-admission.ts -> src/permissions/windows-confinement-evidence",
  "src/permissions/mxc-extension-channel.ts -> src/shared/admission-commit",
  "src/permissions/mxc-extension-process.ts -> src/shared/admission-commit",
  "src/permissions/mxc-extension-process.ts -> src/permissions/windows-confinement-evidence",
  "src/permissions/mxc-policy-pipe.ts -> src/shared/admission-commit",
  "src/permissions/mxc-supervisor-service.ts -> src/shared/admission-commit",
  "src/plugins/isolation/child-loopback-link.ts -> src/shared/admission-commit",
  "src/tools/mxc-shell-launch.ts -> src/permissions/windows-confinement-evidence",
  "src/tools/shell-tools.ts -> src/permissions/windows-confinement-evidence",
]);

const portable = (path: string) => path.replaceAll("\\", "/");
const modulePath = (path: string) => path.replace(/\.[cm]?[jt]sx?$/, "");
const isWindowsImplementation = (path: string) => /(?:-win32|Win32)$/.test(basename(path));
const isWindowsModule = (path: string) => isWindowsImplementation(path) || ADMISSION_MODULES.has(path);

function moduleSpecifier(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) return node.arguments[0];
  return undefined;
}

function targets(file: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(resolve(ROOT, file), "utf8"), ts.ScriptTarget.Latest);
  const dependencies = new Set<string>();
  function visit(node: ts.Node): void {
    const specifier = moduleSpecifier(node);
    if (specifier && ts.isStringLiteralLike(specifier) && /^\.{1,2}\//.test(specifier.text)) {
      const target = resolve(ROOT, dirname(file), specifier.text);
      dependencies.add(modulePath(portable(relative(ROOT, target))));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return dependencies;
}

it("keeps Windows admission dependencies out of the POSIX implementations", () => {
  const illegal = WINDOWS_MEMORY_CLASS_A_FILES.flatMap(file =>
    [...targets(file)].filter(isWindowsModule).map(target => `${file} -> ${target}`));
  expect(illegal).toEqual([]);
});

it("restricts Windows implementation imports to Windows modules and their outer selectors", () => {
  const illegal = globSync("src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", { cwd: ROOT })
    .map(portable)
    .filter(file => !file.split("/").includes("__tests__") && !/\.(?:test|spec)\.[^/]+$/.test(file))
    .filter(file => !isWindowsModule(modulePath(file)) && !SELECTORS.has(file))
    .flatMap(file => [...targets(file)].filter(isWindowsModule)
      .map(target => `${file} -> ${target}`)
      .filter(edge => !EXISTING_EDGES.has(edge)));
  expect(illegal.sort()).toEqual([]);
});
