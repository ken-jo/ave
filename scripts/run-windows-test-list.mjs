import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand, splitArgumentsWithinBudget } from "./hooks/spawn-command.mjs";
import { WINDOWS_TEST_LISTS, windowsTestFiles } from "./windows-test-inventory.mjs";

export const WINDOWS_TEST_SHARDS = [1, 2, 3];
export { WINDOWS_TEST_LISTS, windowsTestFiles } from "./windows-test-inventory.mjs";

/** Keep every selected suite while respecting the native command-line bound. */
export function windowsTestCommands(text, bun = "bun.exe") {
  const files = windowsTestFiles(text);
  const argsFor = chunk => ["run", "test:vitest", "--", "run", ...chunk];
  return [["run", "test:prepare"], ...splitArgumentsWithinBudget(bun, files.map(file => `./${file}`), argsFor).map(argsFor)];
}

export function plannedWindowsFiles(inventory, text, plan, shard) {
  const full = new Set(windowsTestFiles(text));
  const selected = plan.lists?.[inventory];
  if (!Array.isArray(selected) || selected.length !== full.size
    || new Set(selected).size !== selected.length || selected.some(file => !full.has(file))) {
    throw new Error(`Invalid Windows plan for ${inventory}`);
  }
  if (shard === undefined) return selected;
  const all = new Set(Object.values(plan.lists).flat());
  const assignments = plan.shards?.flatMap(bucket => bucket.files);
  if (!Array.isArray(assignments) || plan.shards.length !== WINDOWS_TEST_SHARDS.length
    || !plan.shards.every((bucket, index) => bucket.id === WINDOWS_TEST_SHARDS[index] && Array.isArray(bucket.files) && bucket.files.length > 0)
    || assignments.length !== all.size || new Set(assignments).size !== all.size || assignments.some(file => !all.has(file))) {
    throw new Error("Windows shards must cover every selected test exactly once");
  }
  const files = plan.shards.find(bucket => bucket.id === shard)?.files;
  if (!files) throw new Error(`Invalid Windows test shard: ${shard}`);
  const owners = new Map();
  for (const list of WINDOWS_TEST_LISTS) {
    if (!Array.isArray(plan.lists[list])) throw new Error(`Missing Windows inventory: ${list}`);
    for (const file of plan.lists[list]) if (!owners.has(file)) owners.set(file, list);
  }
  return files.filter(file => owners.get(file) === inventory);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error("Expected one Windows test list file");
  const inventory = process.argv[2];
  const text = readFileSync(resolve(inventory), "utf8");
  const planPath = process.env.AVE_WINDOWS_TEST_PLAN;
  const shard = process.env.AVE_WINDOWS_TEST_SHARD;
  if (shard !== undefined && planPath === undefined) throw new Error("A Windows test shard requires its plan");
  const files = planPath === undefined ? windowsTestFiles(text)
    : plannedWindowsFiles(inventory, text, JSON.parse(readFileSync(planPath, "utf8")), shard === undefined ? undefined : Number(shard));
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
