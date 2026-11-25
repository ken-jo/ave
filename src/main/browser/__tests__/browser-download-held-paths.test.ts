import { readFileSync } from "node:fs";
import { ts } from "ts-morph";
import { expect, it } from "vitest";

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/u;
const TWO_PATHS = /^(?:copyFile|cp|link|rename|symlink)(?:Sync)?$/u;

// These calls bind the directory itself or locate an executable. They never address a part, hidden name, or record.
const DIRECTORY_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  heldFileOperations: ["existsSync(helper)"],
  holdDescriptor: ["openSync(directory.path,", "fstatSync(fd,", "closeSync(fd)"],
  holding: ["closeSync(alsoFd)", "closeSync(fd)"],
  holdingSync: ["closeSync(fd)"],
  prepareBrowserDownloadStaging: ["realpathSync(aveHome())", "mkdirSync(namespace,", "lstatSync(namespace,", "realpathSync(namespace)", "fchmodSync(fd,"],
  withVerifiedRoot: ["openSync(root.path,", "lstatSync(root.path,", "fstatSync(fd,", "closeSync(fd)"],
  bindDestination: ["realpathSync(dirname(chosen))", "lstatSync(path,"],
  // An early Save-dialog check of the final destination. The held move or copy checks it again before publication.
  lstatEntry: ["lstatSync(path,"],
};

it("keeps staging and recovery filesystem operations inside held directories", () => {
  const violations: string[] = [];
  for (const name of ["browser-download-files.ts", "browser-download-staging.ts"]) {
    const source = ts.createSourceFile(name, readFileSync(new URL(`../${name}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const bindings = new Set<string>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !FS_MODULE.test(statement.moduleSpecifier.text)) continue;
      const imports = statement.importClause;
      if (imports?.name) namespaces.add(imports.name.text);
      if (imports?.namedBindings && ts.isNamespaceImport(imports.namedBindings)) namespaces.add(imports.namedBindings.name.text);
      if (imports?.namedBindings && ts.isNamedImports(imports.namedBindings)) {
        for (const element of imports.namedBindings.elements) if (!element.isTypeOnly) bindings.add(element.name.text);
      }
    }
    const walk = (node: ts.Node, owner: string): void => {
      if (owner !== "descriptorFileOperations" && ts.isFunctionDeclaration(node) && node.name) owner = node.name.text;
      if (ts.isCallExpression(node)) {
        const call = node.expression;
        let access = call;
        while (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) access = access.expression;
        const method = ts.isPropertyAccessExpression(call) ? call.name.text
          : ts.isElementAccessExpression(call) && ts.isStringLiteral(call.argumentExpression) ? call.argumentExpression.text : call.getText(source);
        const loadsFs = (call.kind === ts.SyntaxKind.ImportKeyword || method === "require") &&
          node.arguments.some((arg) => ts.isStringLiteral(arg) && FS_MODULE.test(arg.text));
        const isFs = loadsFs || ts.isIdentifier(call) && bindings.has(call.text) || namespaces.has(access.getText(source));
        const args = node.arguments.map((arg) => arg.getText(source));
        const paths = TWO_PATHS.test(method) ? 2 : 1;
        const held = args.length >= paths && args.slice(0, paths).every((arg) => arg.startsWith("inHeld(") || arg.startsWith("heldThrough("));
        if (isFs && owner !== "descriptorFileOperations" && !held &&
            !DIRECTORY_OPERATIONS[owner]?.some((allowed) => node.getText(source).startsWith(allowed))) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${name}:${line} ${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, (child) => walk(child, owner));
    };
    walk(source, "");
  }
  expect(violations).toEqual([]);
});
