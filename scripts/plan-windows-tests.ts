import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  hasUnverifiedWindowsRuntimeInput, isInventorySource, readWindowsSources, windowsImportGraph, windowsRuntimeInputIndex,
} from "../test/scripts/windows-native-test-inventory.js";
import { WINDOWS_TEST_LISTS, WINDOWS_TEST_SHARDS, windowsTestFiles } from "./run-windows-test-list.mjs";
import { parseGitRawDiff } from "./hooks/pre-push-ref-updates.mjs";
import { isCollectedVitestFile } from "./hooks/pre-push-source-policy.mjs";
import {
  assertWindowsRemovalRecords, windowsCoverageDepartures, windowsInventoryDiff, type ReadWindowsVersion, type WindowsInventoryPath,
} from "./windows-test-inventory.mjs";

const ALWAYS_RUN = [
  "src/main/__tests__/windows-acl-host.test.ts",
  "src/main/__tests__/windows-job-launcher.test.ts",
  "src/main/__tests__/windows-path-kind-launcher.test.ts",
  "src/sandbox/__tests__/runtime-grant-native.test.ts",
  "src/permissions/__tests__/sandbox-control-writes-mxc.integration.test.ts",
  "src/tools/__tests__/xlsx-edit-sandbox.integration.test.ts",
] as const;
const GLOBAL_INPUT = /^(?:\.github\/|config\/|scripts\/|test\/(?:scripts|fixtures)\/|patches\/|native\/|resources\/|src\/(?:__tests__|i18n\/testing)\/vitest-|(?:package\.json|bun\.lock|\.bun-version|(?:vitest|tsconfig)[^/]*)$)/u;
type Change = { status: string; file: string; oldMode?: string; newMode?: string };
type Inventory = Record<(typeof WINDOWS_TEST_LISTS)[number], string[]>;

function readGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function pullRequestWindowsChanges(root: string, base: string, head: string) {
  function git(...args: string[]) {
    return readGit(root, ...args);
  }
  try {
    if (git("rev-parse", "--is-shallow-repository").trim() !== "false") return undefined;
    const commit = (ref: string) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
    if (!base || !head) return undefined;
    const target = commit(head);
    const ancestor = git("merge-base", commit(base), target).trim();
    const entries = parseGitRawDiff(git("diff", "--no-renames", "--raw", "-z", ancestor, target, "--"));
    if (!entries) return undefined;
    const readVersion: ReadWindowsVersion = (file, side) => {
      try { return git("show", `${side === "before" ? ancestor : target}:${file}`); } catch { return null; }
    };
    return { changes: entries.map(({ status, path: file, oldMode, newMode }) => ({ status, file, oldMode, newMode })), readVersion };
  } catch {
    return undefined;
  }
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

function affectedFiles(sources: ReadonlyMap<string, string>, changed: ReadonlySet<string>, eligible: ReadonlySet<string>) {
  const graph = windowsImportGraph(sources);
  const indexInput = windowsRuntimeInputIndex(sources);
  const importers = new Map<string, string[]>();
  const forward = new Map<string, Set<string>>();
  const directInputs = new Set<string>();
  for (const [file, { dependencies, tokens }] of graph) {
    const inputs = indexInput(tokens);
    if (eligible.has(file) && [...inputs].some(input => changed.has(input))) directInputs.add(file);
    // Mocked importers and code consumed outside module loading are relevant.
    const targets = new Set([...dependencies.map(dependency => dependency.file), ...inputs]);
    forward.set(file, targets);
    for (const target of targets) {
      const parents = importers.get(target) ?? [];
      parents.push(file);
      importers.set(target, parents);
    }
  }
  const reachable = new Set(eligible);
  for (const file of reachable) {
    const module = graph.get(file);
    if (module && hasUnverifiedWindowsRuntimeInput(module.tokens)) {
      throw new Error(`a runtime source input in ${file} could not be bounded`);
    }
    for (const target of forward.get(file) ?? []) reachable.add(target);
  }
  const affected = new Set(changed);
  for (const file of affected) for (const importer of importers.get(file) ?? []) affected.add(importer);
  return { affected, directInputs };
}

export function assertWindowsCoverage(required: Iterable<string>, planned: Iterable<string>): void {
  const covered = new Set(planned);
  for (const file of required) if (!covered.has(file)) throw new Error(`Missing affected Windows test: ${file}`);
}

export function planWindowsTests({
  event, inventories, changes, readVersion, readSources, durations = {}, departures = new Map(), coverageVersion,
}: {
  event: string;
  inventories: Inventory;
  changes?: Change[] | undefined;
  readVersion?: ReadWindowsVersion | undefined;
  readSources: () => ReadonlyMap<string, string>;
  durations?: Record<string, number>;
  departures?: ReadonlyMap<string, WindowsInventoryPath>;
  coverageVersion?: ReadWindowsVersion;
}) {
  const eligible = new Set(Object.values(inventories).flat());
  for (const file of ALWAYS_RUN) if (!eligible.has(file)) throw new Error(`Missing Windows core test: ${file}`);
  const inventoryDiff = windowsInventoryDiff((changes ?? []).map(entry => ({ ...entry, path: entry.file })), readVersion, isCollectedVitestFile);
  const ordinary = inventoryDiff.ordinary;
  const global = ordinary.find(({ file }) => GLOBAL_INPUT.test(file));
  const fixture = ordinary.find(({ file }) => /\/__tests__\/fixtures\//u.test(file));
  const unknown = ordinary.find(({ file, status }) => !/^[AM]$/u.test(status) || !isInventorySource(file));
  let reason = event !== "pull_request" ? `full for ${event}`
    : changes === undefined ? "full because the PR diff is unavailable"
    : global ? `full because ${global.file} affects CI globally`
    : fixture ? `full because ${fixture.file} may be launched as an executable fixture`
    : unknown ? `full because ${unknown.file} cannot be traced in the current import graph` : "affected imports and Windows core";
  let affected: Set<string> | undefined;
  let directInputs = new Set<string>();
  if (reason === "affected imports and Windows core" && changes !== undefined) {
    try {
      if (ordinary.length === 0) affected = new Set();
      else {
        const sources = readSources();
        if (ordinary.some(({ file }) => !sources.has(file))) throw new Error("PR source is absent from the checkout");
        ({ affected, directInputs } = affectedFiles(sources, new Set(ordinary.map(({ file }) => file)), eligible));
      }
    } catch (error) {
      reason = `full because the import graph is unavailable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
    }
  }
  const supplemental: Partial<Inventory> = {};
  const departing = [];
  for (const [file, list] of departures) {
    if (eligible.has(file) || typeof coverageVersion?.(file, "after") !== "string") continue;
    if (!isCollectedVitestFile(file)) throw new Error(`Departing Windows suite cannot be collected: ${file}`);
    supplemental[list] ??= [];
    supplemental[list].push(file);
    departing.push(file);
  }
  if (affected && inventoryDiff.changed) {
    const deleted = new Set(ordinary.filter(({ status }) => status === "D").map(({ file }) => file));
    for (const [file, inventoriesChanged] of inventoryDiff.suites) {
      if (deleted.has(file)) continue;
      affected.add(file);
      if (eligible.has(file) || departing.includes(file)) continue;
      const inventory = [...inventoriesChanged][0];
      if (!inventory || !isCollectedVitestFile(file) || typeof readVersion?.(file, "after") !== "string") {
        throw new Error(`Windows inventory names an unavailable test: ${file}`);
      }
      supplemental[inventory] ??= [];
      supplemental[inventory].push(file);
    }
    if (ordinary.length === 0) reason = "Windows inventory membership changes and Windows core";
  }
  const changedTests = [...eligible].filter(file => affected === undefined || affected.has(file));
  const required = new Set([...ALWAYS_RUN, ...changedTests, ...Object.values(supplemental).flat()]);
  const lists = {
    [WINDOWS_TEST_LISTS[0]]: [...inventories[WINDOWS_TEST_LISTS[0]].filter(file => required.has(file)), ...(supplemental[WINDOWS_TEST_LISTS[0]] ?? [])],
    [WINDOWS_TEST_LISTS[1]]: [...inventories[WINDOWS_TEST_LISTS[1]].filter(file => required.has(file)), ...(supplemental[WINDOWS_TEST_LISTS[1]] ?? [])],
    [WINDOWS_TEST_LISTS[2]]: [...inventories[WINDOWS_TEST_LISTS[2]].filter(file => required.has(file)), ...(supplemental[WINDOWS_TEST_LISTS[2]] ?? [])],
  };
  // Direct runtime witnesses are recorded before graph traversal.
  assertWindowsCoverage([...required, ...directInputs], Object.values(lists).flat());
  return { mode: affected === undefined ? "full" : "affected", reason, lists,
    ...(Object.keys(supplemental).length ? { supplemental } : {}),
    ...(departing.length ? { departing } : {}),
    shards: balanceWindowsTests(required, durations) };
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
  assertWindowsCoverage(files, shards.flatMap(shard => shard.files));
  return shards;
}

export function windowsPlanSummary(plan: ReturnType<typeof planWindowsTests>): string {
  const selected = new Set(Object.values(plan.lists).flat());
  return [
    "### Windows regression plan", "",
    `${selected.size} distinct files selected. Reason: ${plan.reason}.`, "",
    ...WINDOWS_TEST_LISTS.map(list => `- ${list}: ${plan.lists[list].length} files`), "",
    ...plan.shards.map(({ id, files, weightMs }) => `- Shard ${id}: ${files.length} files, ${(weightMs / 1000).toFixed(1)} weighted seconds`), "",
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [output, base = process.env.AVE_WINDOWS_PR_BASE ?? "", head = process.env.AVE_WINDOWS_PR_HEAD ?? "HEAD"] = process.argv.slice(2);
  if (!output) throw new Error("Expected a Windows plan output file");
  const root = resolve(import.meta.dirname, "..");
  const event = process.env.GITHUB_EVENT_NAME ?? "pull_request";
  const load = (file: string) => windowsTestFiles(readFileSync(resolve(root, file), "utf8"));
  const diff = event === "pull_request" ? pullRequestWindowsChanges(root, base, head) : undefined;
  // CI runs the merged tree. Compare it to its first parent so the guard
  // measures the coverage that this PR would actually remove from its base.
  const coverageVersion = event === "pull_request" && process.env.GITHUB_ACTIONS === "true"
    ? readCoverageVersions(root, "HEAD^1", "HEAD") : diff?.readVersion;
  const departures = coverageVersion ? windowsCoverageDepartures(coverageVersion) : new Map<string, WindowsInventoryPath>();
  if (departures.size) {
    const summary = `### Departing Windows suites\n\n${[...departures.keys()].map(file => `- \`${file}\``).join("\n")}\n\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  if (coverageVersion) assertWindowsRemovalRecords(departures, coverageVersion);
  const plan = planWindowsTests({
    event, ...diff, departures, ...(coverageVersion ? { coverageVersion } : {}), readSources: () => readWindowsSources(root),
    durations: JSON.parse(readFileSync(resolve(root, "config/windows-test-times.json"), "utf8")).files,
    inventories: { [WINDOWS_TEST_LISTS[0]]: load(WINDOWS_TEST_LISTS[0]), [WINDOWS_TEST_LISTS[1]]: load(WINDOWS_TEST_LISTS[1]), [WINDOWS_TEST_LISTS[2]]: load(WINDOWS_TEST_LISTS[2]) },
  });
  const summary = windowsPlanSummary(plan);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
}
