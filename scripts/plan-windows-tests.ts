import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isInventorySource, readWindowsSources, windowsImportGraph } from "../test/scripts/windows-native-test-inventory.js";
import { WINDOWS_TEST_LISTS, WINDOWS_TEST_SHARDS, windowsTestFiles } from "./run-windows-test-list.mjs";

const ALWAYS_RUN = [
  "src/main/__tests__/windows-acl-host.test.ts",
  "src/main/__tests__/windows-job-launcher.test.ts",
  "src/main/__tests__/windows-path-kind-launcher.test.ts",
  "src/sandbox/__tests__/runtime-grant-native.test.ts",
  "src/permissions/__tests__/sandbox-control-writes-mxc.integration.test.ts",
  "src/tools/__tests__/xlsx-edit-sandbox.integration.test.ts",
] as const;
const GLOBAL_INPUT = /^(?:\.github\/|config\/|scripts\/|test\/(?:scripts|fixtures)\/|patches\/|native\/|resources\/|src\/(?:__tests__|i18n\/testing)\/vitest-|(?:package\.json|bun\.lock|\.bun-version|(?:vitest|tsconfig)[^/]*)$)/u;
type Change = { status: string; file: string };
type Inventory = Record<(typeof WINDOWS_TEST_LISTS)[number], string[]>;

export function pullRequestWindowsChanges(root: string, base: string, head: string): Change[] | undefined {
  function git(...args: string[]) {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  }
  try {
    if (git("rev-parse", "--is-shallow-repository").trim() !== "false") return undefined;
    const commit = (ref: string) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
    if (!base || !head) return undefined;
    const target = commit(head);
    const ancestor = git("merge-base", commit(base), target).trim();
    const raw = git("diff", "--no-renames", "--name-status", "-z", ancestor, target, "--");
    const fields = raw.split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0) return undefined;
    const changes: Change[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const [status, file] = fields.slice(index, index + 2);
      if (!status || !file) return undefined;
      changes.push({ status, file });
    }
    return changes;
  } catch {
    return undefined;
  }
}

function affectedFiles(sources: ReadonlyMap<string, string>, changed: Iterable<string>): Set<string> {
  const importers = new Map<string, string[]>();
  for (const [file, { dependencies }] of windowsImportGraph(sources)) {
    // Both actual and mocked callers are relevant when the dependency changes.
    for (const dependency of dependencies) {
      const parents = importers.get(dependency.file) ?? [];
      parents.push(file);
      importers.set(dependency.file, parents);
    }
  }
  const affected = new Set(changed);
  for (const file of affected) for (const importer of importers.get(file) ?? []) affected.add(importer);
  return affected;
}

export function assertWindowsCoverage(required: Iterable<string>, planned: Iterable<string>): void {
  const covered = new Set(planned);
  for (const file of required) if (!covered.has(file)) throw new Error(`Missing affected Windows test: ${file}`);
}

export function planWindowsTests({
  event, inventories, changes, readSources, durations = {},
}: {
  event: string;
  inventories: Inventory;
  changes?: Change[] | undefined;
  readSources: () => ReadonlyMap<string, string>;
  durations?: Record<string, number>;
}) {
  const eligible = new Set(Object.values(inventories).flat());
  for (const file of ALWAYS_RUN) if (!eligible.has(file)) throw new Error(`Missing Windows core test: ${file}`);
  const global = changes?.find(({ file }) => GLOBAL_INPUT.test(file));
  const unknown = changes?.find(({ file, status }) => !/^[AM]$/u.test(status) || !isInventorySource(file));
  let reason = event !== "pull_request" ? `full for ${event}`
    : changes === undefined ? "full because the PR diff is unavailable"
    : global ? `full because ${global.file} affects CI globally`
    : unknown ? `full because ${unknown.file} cannot be traced in the current import graph` : "affected imports and Windows core";
  let affected: Set<string> | undefined;
  if (reason === "affected imports and Windows core" && changes !== undefined) {
    try {
      if (changes.length === 0) affected = new Set();
      else {
        const sources = readSources();
        if (changes.some(({ file }) => !sources.has(file))) throw new Error("PR source is absent from the checkout");
        affected = affectedFiles(sources, changes.map(({ file }) => file));
      }
    } catch (error) {
      reason = `full because the import graph is unavailable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
    }
  }
  const changedTests = [...eligible].filter(file => affected === undefined || affected.has(file));
  const required = new Set([...ALWAYS_RUN, ...changedTests]);
  const lists = {
    [WINDOWS_TEST_LISTS[0]]: inventories[WINDOWS_TEST_LISTS[0]].filter(file => required.has(file)),
    [WINDOWS_TEST_LISTS[1]]: inventories[WINDOWS_TEST_LISTS[1]].filter(file => required.has(file)),
    [WINDOWS_TEST_LISTS[2]]: inventories[WINDOWS_TEST_LISTS[2]].filter(file => required.has(file)),
  };
  assertWindowsCoverage(required, Object.values(lists).flat());
  return { mode: affected === undefined ? "full" : "affected", reason, lists,
    affectedCount: affected === undefined ? 0 : changedTests.length, shards: balanceWindowsTests(required, durations) };
}

export function windowsChecksRequired(plan: ReturnType<typeof planWindowsTests>, platformChecks: string | undefined): boolean {
  return plan.mode === "full" || platformChecks !== "false" || plan.affectedCount > 0;
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
  const plan = planWindowsTests({
    event, readSources: () => readWindowsSources(root),
    durations: JSON.parse(readFileSync(resolve(root, "config/windows-test-times.json"), "utf8")).files,
    changes: event === "pull_request" ? pullRequestWindowsChanges(root, base, head) : undefined,
    inventories: { [WINDOWS_TEST_LISTS[0]]: load(WINDOWS_TEST_LISTS[0]), [WINDOWS_TEST_LISTS[1]]: load(WINDOWS_TEST_LISTS[1]), [WINDOWS_TEST_LISTS[2]]: load(WINDOWS_TEST_LISTS[2]) },
  });
  const summary = windowsPlanSummary(plan);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `windows_checks=${windowsChecksRequired(plan, process.env.AVE_CI_PLATFORM_CHECKS)}\n`);
  }
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
}
