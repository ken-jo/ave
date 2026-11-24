import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand, splitArgumentsWithinBudget } from "./hooks/spawn-command.mjs";
import { collectedVitestFiles, isCollectedVitestFile } from "./lib/vitest-collection.mjs";

// Windows runs every collected suite. Shard IDs are fixed; the planner assigns
// each suite to exactly one of them, so a new suite needs no list edit.
export const WINDOWS_TEST_SHARDS = [1, 2, 3, 4, 5, 6];

/** Keep every selected suite while respecting the native command-line bound. */
export function windowsTestCommands(files, bun = "bun.exe") {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Windows test shard is empty");
  if (new Set(files).size !== files.length) throw new Error("Windows test shard repeats a suite");
  for (const file of files) {
    if (typeof file !== "string" || !isCollectedVitestFile(file) || file.split("/").some(part => part === "." || part === "..")) {
      throw new Error(`Invalid unit test path: ${file}`);
    }
  }
  const argsFor = chunk => ["run", "test:vitest", "--", "run", ...chunk];
  return [["run", "test:prepare"], ...splitArgumentsWithinBudget(bun, files.map(file => `./${file}`), argsFor).map(argsFor)];
}

/**
 * Check that a plan assigns every collected suite to exactly one fixed,
 * non-empty shard. The reference is the caller's own checkout, not the plan.
 */
export function assertWindowsPlan(plan, collected) {
  const shards = plan?.shards;
  if (!Array.isArray(shards) || shards.length !== WINDOWS_TEST_SHARDS.length
    || !shards.every((shard, index) => shard?.id === WINDOWS_TEST_SHARDS[index] && Array.isArray(shard.files) && shard.files.length > 0)) {
    throw new Error(`Windows plan must have non-empty shards ${WINDOWS_TEST_SHARDS.join(", ")} in order`);
  }
  const expected = new Set(collected);
  if (expected.size !== collected.length) throw new Error("Collected Windows suites repeat a path");
  const seen = new Set();
  for (const file of shards.flatMap(shard => shard.files)) {
    if (seen.has(file)) throw new Error(`Windows plan assigns a suite twice: ${file}`);
    if (!expected.has(file)) throw new Error(`Windows plan names an uncollected suite: ${file}`);
    seen.add(file);
  }
  const missing = collected.filter(file => !seen.has(file));
  if (missing.length) throw new Error(`Windows plan omits ${missing.length} collected suite(s), first ${missing[0]}`);
}

/** The files of one shard after the plan is checked against the checkout at root. */
export function windowsShardFiles(plan, shard, root) {
  if (!WINDOWS_TEST_SHARDS.includes(shard)) throw new Error(`Invalid Windows test shard: ${shard}`);
  assertWindowsPlan(plan, collectedVitestFiles(root));
  return plan.shards.find(bucket => bucket.id === shard).files;
}

function runWindowsTests(files) {
  const bun = process.platform === "win32" ? "bun.exe" : "bun";
  const commands = windowsTestCommands(files, bun);
  runCommand(bun, commands[0], { cwd: process.cwd(), label: "windows-tests" });
  let failures = 0;
  for (const args of commands.slice(1)) {
    try { runCommand(bun, args, { cwd: process.cwd(), label: "windows-tests" }); }
    catch (error) { failures++; console.error(error.message); }
  }
  if (failures > 0) throw new Error(`${failures} Windows test batch(es) failed`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error("The Windows shard runner takes its plan and shard from the environment");
  const { AVE_WINDOWS_TEST_PLAN: planPath, AVE_WINDOWS_TEST_SHARD: shard } = process.env;
  if (!planPath || !/^[1-9]\d*$/u.test(shard ?? "")) throw new Error("A Windows test shard requires AVE_WINDOWS_TEST_PLAN and AVE_WINDOWS_TEST_SHARD");
  const files = windowsShardFiles(JSON.parse(readFileSync(planPath, "utf8")), Number(shard), process.cwd());
  console.log(`Windows shard ${shard}: ${files.length} suite(s), ${availableParallelism()} logical CPU(s)`);
  runWindowsTests(files);
}
