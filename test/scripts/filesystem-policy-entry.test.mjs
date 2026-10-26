import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isCallExpression, isFunctionDeclaration, isIdentifier, isPropertyAccessExpression, isStringLiteral } from "typescript/unstable/ast";
import { parseSourceTexts } from "../../scripts/lib/ts7-ast.mjs";

const SOURCE_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const texts = new Map();
const nativeModules = [];
const producers = [
  ["permissions/asrt-sandbox.ts", "buildSandboxConfig", "admitFilesystemPolicy"],
  ["permissions/asrt-sandbox.ts", "buildPerCommandSandboxCustomConfig", "admitFilesystemPolicy"],
  ["permissions/asrt-sandbox.ts", "grantWindowsWorkerFilesystemAccess", "admitFilesystemPolicy"],
  ["permissions/worker-spawn.ts", "spawnWorker", "grantWindowsWorkerFilesystemAccess"],
  ["permissions/windows-acl-grant-holder.ts", "holdWindowsFilesystemGrant", "grantWindowsWorkerFilesystemAccess"],
  ["sandbox/wrap-bundled-command.ts", "spawnWindowsBundledProcess", "holdWindowsFilesystemGrant"],
];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.tsx?$/.test(entry.name)) {
      const module = relative(SOURCE_ROOT, path).replace(/\\/g, "/");
      const text = readFileSync(path, "utf8");
      if (text.includes("grantWindowsAcl")) nativeModules.push(module);
      if (text.includes("grantWindowsAcl") || producers.some(([file]) => file === module) || module === "plugins/isolation/out-of-process-plugin.ts") texts.set(module, text);
    }
  }
}
walk(SOURCE_ROOT);
const sources = parseSourceTexts(texts);
assert.equal(sources.size, texts.size, "Every boundary source must parse");
function descendants(node) {
  const nodes = [];
  const visit = child => { nodes.push(child); child.forEachChild(visit); };
  visit(node);
  return nodes;
}
function callsIn(module, name) {
  const declaration = descendants(sources.get(module)).find(node => isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${module}: ${name}`);
  return descendants(declaration).filter(isCallExpression).map(call => isIdentifier(call.expression) ? call.expression.text
    : isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined);
}
test("native ACL grants have one producer admitted before pinning and account lookup", () => {
  assert.deepEqual(nativeModules, ["permissions/asrt-sandbox.ts"]);
  const references = descendants(sources.get(nativeModules[0])).filter(node => (isIdentifier(node) || isStringLiteral(node)) && node.text === "grantWindowsAcl");
  // One import binding and one call: aliasing, namespace calls and additional native producers change this inventory.
  assert.equal(references.length, 2);
  const calls = callsIn(nativeModules[0], "grantWindowsWorkerFilesystemAccess");
  assert.equal(calls.filter(name => name === "grantWindowsAcl").length, 1);
  for (const effect of ["pinWindowsFilesystemConfig", "getWindowsSandboxUserStatus", "grantWindowsAcl"]) {
    assert.ok(calls.indexOf("admitFilesystemPolicy") >= 0 && calls.indexOf("admitFilesystemPolicy") < calls.indexOf(effect), effect);
  }
});
for (const [module, producer, recipient] of producers) {
  test(`${producer} routes through ${recipient}`, () => {
    const calls = callsIn(module, producer);
    assert.ok(calls.includes(recipient));
    if (producer.startsWith("build")) assert.ok(calls.indexOf(recipient) < calls.indexOf("buildMandatorySandboxWritePolicy"));
  });
}
test("the plugin holder uses the admitted grant chain", () => {
  const calls = descendants(sources.get("plugins/isolation/out-of-process-plugin.ts")).filter(isCallExpression);
  assert.equal(calls.filter(call => isIdentifier(call.expression) && call.expression.text === "holdWindowsFilesystemGrant").length, 1);
});
