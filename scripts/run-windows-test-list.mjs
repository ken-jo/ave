import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand, splitArgumentsWithinBudget } from "./hooks/spawn-command.mjs";

export function windowsTestFiles(text) {
  const files = [...new Set(text.replace(/^\uFEFF/u, "").split(/\r?\n/u).map(line => line.trim()).filter(Boolean))];
  if (files.length === 0) throw new Error("Windows test list is empty");
  for (const file of files) {
    if (!/^(?:src|test)\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
      || file.split("/").some(part => part === "." || part === "..") || /^test\/(?:e2e|screenshots|smoke)\//u.test(file)) {
      throw new Error(`Invalid unit test path: ${file}`);
    }
  }
  return files;
}

/** Keep every selected suite while respecting the native command-line bound. */
export function windowsTestCommands(text, bun = "bun.exe") {
  const files = windowsTestFiles(text);
  const argsFor = chunk => ["run", "test:vitest", "--", "run", ...chunk];
  return [["run", "test:prepare"], ...splitArgumentsWithinBudget(bun, files.map(file => `./${file}`), argsFor).map(argsFor)];
}

export function plannedWindowsFiles(inventory, text, plan) {
  const full = new Set(windowsTestFiles(text));
  const selected = plan.lists?.[inventory];
  if (!Array.isArray(selected) || (plan.mode !== "full" && plan.mode !== "affected")
    || new Set(selected).size !== selected.length || selected.some(file => !full.has(file))
    || (plan.mode === "full" && selected.length !== full.size)) {
    throw new Error(`Invalid Windows plan for ${inventory}`);
  }
  return selected;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error("Expected one Windows test list file");
  const inventory = process.argv[2];
  const text = readFileSync(resolve(inventory), "utf8");
  const planPath = process.env.AVE_WINDOWS_TEST_PLAN;
  const files = planPath === undefined ? windowsTestFiles(text)
    : plannedWindowsFiles(inventory, text, JSON.parse(readFileSync(planPath, "utf8")));
  if (files.length === 0) console.log(`No selected Windows tests in ${inventory}`);
  else runWindowsTests(files);
}

function runWindowsTests(files) {
  const bun = process.platform === "win32" ? "bun.exe" : "bun";
  const commands = windowsTestCommands(files.join("\n"), bun);
  runCommand(bun, commands[0], { cwd: process.cwd(), label: "windows-tests" });
  let failures = 0;
  for (const args of commands.slice(1)) {
    try { runCommand(bun, args, { cwd: process.cwd(), label: "windows-tests" }); }
    catch (error) { failures++; console.error(error.message); }
  }
  if (failures > 0) throw new Error(`${failures} Windows test batch(es) failed`);
}
