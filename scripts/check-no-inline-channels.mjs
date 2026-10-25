#!/usr/bin/env node
// Require shared channel constants at every IPC, preload and external-surface boundary.
// Scan directories dynamically so new modules cannot escape the gate.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  SyntaxKind,
} from "typescript/unstable/ast";
import { parseSourceFiles } from "./lib/ts7-ast.mjs";

const rootArgIndex = process.argv.indexOf("--root");
const ROOT = rootArgIndex >= 0
  ? resolve(process.argv[rootArgIndex + 1] ?? "")
  : process.cwd();

const tsModulesIn = (dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dir}/${f}`);

const TARGETS = [
  ...tsModulesIn("src/ipc/domains"),
  "src/preload.ts",
  ...tsModulesIn("src/preload"),
  // Consumers use the shared contract; only the contract defines wire literals.
  ...tsModulesIn("src/api"),
  ...tsModulesIn("src/sdk"),
  ...tsModulesIn("src/cli"),
  // This sandboxed preload lives outside the scanned preload directory.
  "src/plugin-preload.ts",
  // This sandboxed preload also lives outside the scanned preload directory.
  "src/floating-dock-preload.ts",
  "src/boot/bootstrap-status.ts",
  "src/boot/plugins.ts",
  "src/boot/steps/ipc-bridge.ts",
  "src/boot/steps/post-boot.ts",
];

function isCliCommandName(node, rel) {
  if (rel !== "src/cli/commands.ts" || !isPropertyAssignment(node.parent)) return false;
  const propertyName = node.parent.name;
  if (!(isIdentifier(propertyName) || isStringLiteral(propertyName))
      || propertyName.text !== "name") return false;

  const command = node.parent.parent;
  if (!isObjectLiteralExpression(command) || !isArrayLiteralExpression(command.parent)) {
    return false;
  }
  const array = command.parent;
  const initializer = isAsExpression(array.parent) ? array.parent : array;
  const declaration = initializer.parent;
  return isVariableDeclaration(declaration)
    && isIdentifier(declaration.name)
    && declaration.name.text === "CLI_COMMANDS";
}

function isInlineChannel(value, node, rel) {
  return value.startsWith("ave:")
    || (value.startsWith("marketplace:") && !isCliCommandName(node, rel))
    || value.startsWith("window:");
}

function staticText(node) {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (isTemplateExpression(node)) return node.head.text;
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

let violations = 0;
const targets = [];
for (const rel of TARGETS) {
  const abs = join(ROOT, rel);
  try {
    targets.push({ rel, abs, content: readFileSync(abs, "utf8") });
  } catch (err) {
    console.error(`[no-inline-channels] cannot read ${rel}: ${err.message}`);
    process.exit(1);
  }
}
const sources = parseSourceFiles(targets.map((target) => target.abs));
for (const { rel, abs, content } of targets) {
  const source = sources.get(abs);
  if (!source) {
    console.error(`[no-inline-channels] cannot parse ${rel}`);
    process.exit(1);
  }
  const lines = content.split("\n");
  const visit = (node) => {
    const value = staticText(node);
    if (value !== undefined && isInlineChannel(value, node, rel)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      console.error(
        `[no-inline-channels] ${rel}:${line + 1} inline channel literal — use CHANNELS.* from src/contract/`,
      );
      console.error(`    ${lines[line]?.trim() ?? ""}`);
      violations += 1;
    }
    node.forEachChild(visit);
  };
  visit(source);
}

if (violations > 0) {
  console.error(
    `[no-inline-channels] FAIL — ${violations} inline channel literal(s); route them through src/contract/app-contract.ts`,
  );
  process.exit(1);
}
console.log("[no-inline-channels] OK");
