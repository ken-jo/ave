import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WINDOWS_TEST_LISTS, WINDOWS_TEST_SHARDS, windowsTestFiles } from "./run-windows-test-list.mjs";
import { isCollectedVitestFile } from "./lib/vitest-collection.mjs";
import { assertWindowsRemovalRecords, windowsCoverageDepartures, type ReadWindowsVersion } from "./windows-test-inventory.mjs";

type Inventory = Record<(typeof WINDOWS_TEST_LISTS)[number], string[]>;

function readGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function readCoverageVersions(root: string, base: string, head: string): ReadWindowsVersion {
  const refs = [base, head].map(ref => readGit(root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim());
  return (path, side) => {
    const ref = refs[side === "before" ? 0 : 1];
    const entry = readGit(root, "ls-tree", "-z", ref ?? "", "--", path);
    if (entry === "") return null;
    if (!/^100644 blob /u.test(entry)) throw new Error(`Expected a regular file for Windows coverage: ${path}`);
    return readGit(root, "show", `${ref}:${path}`);
  };
}

export function planWindowsTests(inventories: Inventory, durations: Record<string, number> = {}) {
  const files = new Set(WINDOWS_TEST_LISTS.flatMap(list => inventories[list]));
  for (const file of files) {
    if (!isCollectedVitestFile(file)) throw new Error(`Windows inventory names an uncollected test: ${file}`);
  }
  return { lists: inventories, shards: balanceWindowsTests(files, durations) };
}

function balanceWindowsTests(files: ReadonlySet<string>, durations: Record<string, number>) {
  const fallbackMs = 1000;
  // Per-file reports exclude collection and startup. Keep a per-file
  // floor so a shard cannot accumulate an unlimited number of tiny suites.
  const weight = (file: string) => fallbackMs + (durations[file] ?? fallbackMs);
  const shards = WINDOWS_TEST_SHARDS.map(id => ({ id, files: [] as string[], weightMs: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, "en"))) {
    const shard = shards.reduce((lightest, candidate) => candidate.weightMs < lightest.weightMs ? candidate : lightest);
    shard.files.push(file);
    shard.weightMs += weight(file);
  }
  return shards;
}

export function windowsPlanSummary(plan: ReturnType<typeof planWindowsTests>): string {
  const selected = new Set(Object.values(plan.lists).flat());
  return [
    "### Windows regression plan", "",
    `${selected.size} distinct files selected. All committed inventories.`, "",
    ...WINDOWS_TEST_LISTS.map(list => `- ${list}: ${plan.lists[list].length} files`), "",
    ...plan.shards.map(({ id, files, weightMs }) => `- Shard ${id}: ${files.length} files, ${(weightMs / 1000).toFixed(1)} weighted seconds`), "",
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [output] = process.argv.slice(2);
  if (!output) throw new Error("Expected a Windows plan output file");
  const root = resolve(import.meta.dirname, "..");
  let summary = "";
  // The build job checks departures against the first parent of the PR merge.
  if (process.env.GITHUB_EVENT_NAME === "pull_request" && process.env.GITHUB_ACTIONS === "true") {
    const readVersion = readCoverageVersions(root, "HEAD^1", "HEAD");
    const departures = windowsCoverageDepartures(readVersion);
    assertWindowsRemovalRecords(departures, readVersion);
    if (departures.size) summary += "### Departing Windows suites\n\n" + [...departures.keys()].map(file => "- " + file).join("\n") + "\n\n";
  }
  const load = (file: string) => windowsTestFiles(readFileSync(resolve(root, file), "utf8"));
  const [permission, native, application] = WINDOWS_TEST_LISTS;
  const plan = planWindowsTests({ [permission]: load(permission), [native]: load(native), [application]: load(application) },
    JSON.parse(readFileSync(resolve(root, "config/windows-test-times.json"), "utf8")).files);
  summary += windowsPlanSummary(plan);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(plan, null, 2) + "\n");
}
