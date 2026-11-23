import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertWindowsCoverage, planWindowsTests, pullRequestWindowsChanges } from "../../scripts/plan-windows-tests.js";
import { plannedWindowsFiles, WINDOWS_TEST_LISTS, WINDOWS_TEST_SHARDS, windowsTestFiles } from "../../scripts/run-windows-test-list.mjs";
import { readWindowsSources, windowsImportGraph, windowsRuntimeInputIndex } from "./windows-native-test-inventory.js";
import {
  assertWindowsRemovalRecords, windowsCoverageDepartures, WINDOWS_TEST_REMOVALS, type ReadWindowsVersion,
} from "../../scripts/windows-test-inventory.mjs";
import { windowsReaderDigest, windowsRuntimeInputScopes } from "../../scripts/windows-runtime-input-scopes.js";

const [permission, native, application] = WINDOWS_TEST_LISTS;
const inventories = {
  [permission]: windowsTestFiles(readFileSync(permission, "utf8")),
  [native]: windowsTestFiles(readFileSync(native, "utf8")),
  [application]: windowsTestFiles(readFileSync(application, "utf8")),
};
const permissionSuite = "src/shared/__tests__/tool-result-trim.test.ts";
const changed = "src/shared/test-change.ts";
const dependency = "src/shared/test-dependency.ts";
const readSources = () => new Map([
  [permissionSuite, 'import "../test-dependency.js";'],
  [dependency, 'export { value } from "./test-change.js";'],
  [changed, "export const value = 1;"],
]);

function plan(changes?: { status: string; file: string }[], event = "pull_request") {
  return planWindowsTests({ event, changes, inventories, readSources });
}

describe("Windows regression planning", () => {
  const modified = (file: string) => ({ file, status: "M", oldMode: "100644", newMode: "100644" });
  const removed = "src/core/__tests__/route-input.test.ts";
  const selected = (result: ReturnType<typeof planWindowsTests>) => result.shards.flatMap(shard => shard.files).sort();
  const core = () => selected(plan([]));

  it.each([permission, native])("runs the exact membership delta of %s and the core", list => {
    expect(Object.values(inventories).flat()).not.toContain(removed);
    const added = inventories[list][0] ?? "";
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(list)], inventories,
      readSources: () => { throw new Error("inventory-only changes should not scan the source graph"); },
      readVersion: (file, side) => file === list ? `${side === "before" ? removed : added}\n` : "export {};\n",
    });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...new Set([...core(), added, removed])].sort());
    const scheduled = WINDOWS_TEST_SHARDS.flatMap(shard => plannedWindowsFiles(list, inventories[list].join("\n"), result, shard));
    expect(scheduled).toContain(removed);
    expect(() => plannedWindowsFiles(list, inventories[list].join("\n"), { ...result, mode: "full" }, 1))
      .toThrow("Invalid Windows supplemental tests");
  });

  it("selects marker-only changes before a general source fallback", () => {
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(removed), modified(permissionSuite)], inventories,
      readSources: () => { throw new Error("marker-only changes should not scan the source graph"); },
      readVersion: (file, side) => (file === removed) === (side === "after") ? "// windows-permission\nexport {};\n" : "export {};\n",
    });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...new Set([...core(), removed, permissionSuite])].sort());
  });

  it.each([["U+2028", "\u2028"], ["bare CR", "\r"], ["U+2029", "\u2029"]])("treats executable code after %s as a source edit", (_name, terminator) => {
    const before = "// windows-permission: exercise the boundary\nexport {};\n";
    const after = before.replace("boundary", `boundary${terminator}globalThis.fixtureChanged = true;`);
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(permissionSuite)], inventories,
      readSources: () => new Map([[permissionSuite, after]]),
      readVersion: (_file, side) => side === "before" ? before : after,
    });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...new Set([...core(), permissionSuite])].sort());
  });

  it("retains full selection when a CI input changes with a list", () => {
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(permission), modified(".github/workflows/ci.yml")], inventories, readSources,
      readVersion: (file, side) => file === permission ? `${side === "before" ? removed : permissionSuite}\n` : null,
    });
    expect(result).toMatchObject({ mode: "full", reason: "full because .github/workflows/ci.yml affects CI globally", lists: inventories });
  });

  it.each(["push", "schedule", "workflow_dispatch"])("runs both complete inventories for %s", event => {
    expect(plan([], event)).toMatchObject({ mode: "full", lists: inventories });
  });

  it.each([".github/workflows/ci.yml", "config/test.ts", "scripts/tool.ts", "test/scripts/ci.test.ts", "package.json", "bun.lock", "patches/dep.patch"])(
    "runs both complete inventories when %s changes",
    file => expect(plan([{ status: "M", file }])).toMatchObject({ mode: "full", lists: inventories }),
  );

  it("keeps the explicit core when the diff is empty", () => {
    const result = plan([]);
    expect(result.mode).toBe("affected");
    expect([...new Set(Object.values(result.lists).flat())].sort()).toEqual([
      "src/main/__tests__/windows-acl-host.test.ts",
      "src/main/__tests__/windows-job-launcher.test.ts",
      "src/main/__tests__/windows-path-kind-launcher.test.ts",
      "src/permissions/__tests__/sandbox-control-writes-mxc.integration.test.ts",
      "src/sandbox/__tests__/runtime-grant-native.test.ts",
      "src/tools/__tests__/xlsx-edit-sandbox.integration.test.ts",
    ]);
  });

  it("tracks the changed file through transitive imports and keeps the core", () => {
    const result = plan([{ status: "M", file: changed }]);
    expect(result.mode).toBe("affected");
    expect(result.lists[permission]).toContain(permissionSuite);
    expect(result.lists[native]).toEqual(plan([]).lists[native]);
  });

  it.each([
    'import { spawn as run } from "node:child_process"; run(process.execPath, ["--import=tsx", "../test-change.ts"]);',
    'import { execFile as run } from "node:child_process"; run("node", ["--import=tsx", "../test-change.js"]);',
    'import { buildSync as bundle } from "esbuild"; bundle({ entryPoints: ["src/shared/test-change.ts"], bundle: true });',
    'import { readFileSync as read } from "node:fs"; read(new URL("../test-change.ts", import.meta.url), "utf8");',
    'import { existsSync, readFileSync, statSync } from "node:fs"; readFileSync("../test-change.ts");',
  ])("selects a suite that consumes changed code through %s", source => {
    const runtimeSources = () => new Map([[permissionSuite, source], [changed, "export const value = 1;"]]);
    const result = planWindowsTests({ event: "pull_request", changes: [{ status: "M", file: changed }], inventories, readSources: runtimeSources });
    expect(result.mode).toBe("affected");
    expect(result.lists[permission]).toContain(permissionSuite);
  });

  it.each([
    'import { spawn } from "node:child_process"; spawn("bun", [process.env.RUNTIME_SOURCE]);',
    'import { spawn } from "node:child_process"; const launch = spawn; launch("bun", [process.env.RUNTIME_SOURCE]);',
    'import { buildSync } from "esbuild"; buildSync({ entryPoints: [process.env.RUNTIME_SOURCE] });',
    'import { readFileSync } from "node:fs"; readFileSync(process.env.RUNTIME_SOURCE);',
  ])("keeps the owning suite when %s could reach a changed source", source => {
    const runtimeSources = () => new Map([[permissionSuite, source], [changed, "export const value = 1;"]]);
    const result = planWindowsTests({ event: "pull_request", changes: [{ status: "M", file: changed }], inventories, readSources: runtimeSources });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...core(), permissionSuite].sort());
  });

  it.each([
    'const n = "change"; await import(["..", "test-"].join("/") + n);',
    'const n = "change"; require(["..", "test-change.js"].join(n));',
    'const modules = import.meta.glob("../*.ts");',
    'const n = "../test-change.js"; await vi.importActual(n);',
  ])("keeps the suite that loads a module by a computed specifier: %s", source => {
    const runtimeSources = () => new Map([[permissionSuite, source], [changed, "export const value = 1;"]]);
    const result = planWindowsTests({ event: "pull_request", changes: [modified(changed)], inventories, readSources: runtimeSources });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...core(), permissionSuite].sort());
  });

  it("does not count a literal dynamic import as a computed module load", () => {
    const runtimeSources = () => new Map([[permissionSuite, 'await import("../other.js");'], [changed, "export const value = 1;"]]);
    const result = planWindowsTests({ event: "pull_request", changes: [modified(changed)], inventories, readSources: runtimeSources });
    expect(selected(result)).toEqual(core());
  });

  it("keeps the known importers of a shared reader and falls back when ownership cannot be established", () => {
    const otherSuite = "src/permissions/__tests__/sensitive-paths-canonicalize.test.ts";
    const reader = 'import { readFileSync } from "node:fs"; readFileSync(process.env.RUNTIME_SOURCE);';
    const runtimeSources = new Map(readSources()).set(dependency, reader)
      .set(otherSuite, 'import "../../shared/test-dependency.js";');
    const run = (file: string) => planWindowsTests({
      event: "pull_request", changes: [modified(file)], inventories, readSources: () => runtimeSources,
    });
    expect(run(changed).mode).toBe("affected");
    expect(selected(run(changed))).toEqual([...core(), permissionSuite, otherSuite].sort());
    runtimeSources.set(changed, reader);
    expect(run(changed)).toMatchObject({ mode: "full", reason: expect.stringContaining("no known suite owners") });
  });

  const readerDigest = (file: string, source: string, others: ReadonlyMap<string, string> = new Map()) => {
    const digest = windowsReaderDigest(file, windowsImportGraph(new Map([...others, [file, source]])));
    if (!digest) throw new Error(`No runtime tokens for ${file}`);
    return digest;
  };

  it.each([true, false])("uses a shared bundler's declared input only for its audited source (audited=%s)", audited => {
    const bundler = "src/plugins/isolation/__tests__/child-entry-bundle.ts";
    const entry = "src/plugins/isolation/plugin-child-main.ts";
    const auditedSource = 'import { build } from "esbuild"; build(options);';
    const runtimeSources = new Map(readSources()).set(entry, "export {};")
      .set(permissionSuite, 'import "../../plugins/isolation/__tests__/child-entry-bundle.js";')
      .set(bundler, audited ? auditedSource : 'import { build } from "esbuild"; build(entryOptions);');
    const inputScopes = { [bundler]: { digest: readerDigest(bundler, auditedSource), inputs: [entry] } };
    const run = (file: string) => planWindowsTests({
      event: "pull_request", changes: [modified(file)], inventories, inputScopes, readSources: () => runtimeSources,
    });
    // An edited reader may read anything, so its owning suites run until the scope is audited again.
    expect(selected(run(changed))).toEqual(audited ? core() : [...core(), permissionSuite].sort());
    expect(selected(run(entry))).toEqual([...core(), permissionSuite].sort());
  });

  it("treats a changed declared reader without an audited source as having unknown owners", () => {
    const reader = "src/shared/test-reader.ts";
    const auditedSource = 'import { readFileSync } from "node:fs"; readFileSync(process.env.RUNTIME_SOURCE);';
    const runtimeSources = new Map(readSources()).set(reader, `${auditedSource} readFileSync(process.env.OTHER_SOURCE);`);
    const inputScopes = { [reader]: { digest: readerDigest(reader, auditedSource), inputs: [] } };
    expect(planWindowsTests({
      event: "pull_request", changes: [modified(reader)], inventories, inputScopes, readSources: () => runtimeSources,
    })).toMatchObject({ mode: "full", reason: expect.stringContaining("no known suite owners") });
  });

  it.each([false, true])("keeps the packaging suite when the real input changes (computed path=%s)", computed => {
    // Only the suite and its input: fallback owners elsewhere in the tree cannot select it.
    const suite = "src/__tests__/packaging-discipline-source.test.ts";
    const input = "src/lib/log-file-sink.ts";
    const audited = readFileSync(suite, "utf8");
    const source = computed
      ? audited.replace(`readRepoFile("${input}")`, `readRepoFile(\`src/lib/\${"log-file-sink"}.ts\`)`) : audited;
    expect(source === audited).toBe(!computed);
    expect(inventories[permission]).toContain(suite);
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(input)], inventories,
      readSources: () => new Map([[suite, source], [input, readFileSync(input, "utf8")]]),
    });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...core(), suite].sort());
  });

  it("binds every declared runtime input scope to the audited reader and helper sources", () => {
    const files = Object.keys(windowsRuntimeInputScopes);
    expect(files.length).toBeGreaterThan(0);
    const graph = windowsImportGraph(readWindowsSources(process.cwd()));
    // Re-audit what a changed reader or one of its helpers can read, then record the digest printed here.
    const drifted = files.flatMap(file => {
      const digest = windowsReaderDigest(file, graph) ?? "missing";
      return digest === windowsRuntimeInputScopes[file]?.digest ? [] : [`${file}: ${digest}`];
    });
    expect(drifted).toEqual([]);
    for (const [file, scope] of Object.entries(windowsRuntimeInputScopes)) {
      for (const name of scope.readers ?? []) expect(readFileSync(file, "utf8")).toMatch(new RegExp(`export (?:async )?function ${name}\\b`, "u"));
    }
  }, 45_000);

  it("invalidates a declared scope when a helper two imports away changes", () => {
    const reader = "src/__tests__/support/test-reader.ts";
    const middle = "src/__tests__/support/test-paths.ts";
    const leaf = "src/__tests__/support/test-names.ts";
    const sources = new Map(readSources())
      .set(permissionSuite, 'import "../../__tests__/support/test-reader.js";')
      .set(reader, 'import { paths } from "./test-paths.js"; export const read = () => paths;')
      .set(middle, 'export { names as paths } from "./test-names.js";')
      .set(leaf, 'export const names = ["a"];');
    const inputScopes = { [reader]: { digest: readerDigest(reader, sources.get(reader) ?? "", sources), inputs: [] } };
    const run = () => selected(planWindowsTests({
      event: "pull_request", changes: [modified(changed)], inventories, inputScopes, readSources: () => sources,
    }));
    expect(run()).toEqual(core());
    sources.set(leaf, 'export const names = ["a", "b"];');
    expect(run()).toEqual([...core(), permissionSuite].sort());
  });

  it.each([
    ["a computed argument", 'import { readRepoFile } from "../../__tests__/test-helpers.js"; const n = "format"; readRepoFile(["src/shared/test", n].join("-"));', true],
    ["the reader passed as a value", 'import { readRepoFile } from "../../__tests__/test-helpers.js"; ["src/shared/test-change.ts"].map(readRepoFile);', true],
    ["a namespace call with a computed argument", 'import * as helpers from "../../__tests__/test-helpers.js"; helpers.readRepoFile(process.env.TARGET);', true],
    ["a literal argument", 'import { readRepoFile } from "../../__tests__/test-helpers.js"; readRepoFile("src/shared/test-change.ts");', false],
  ])("treats a caller of a bounded helper with %s as an unbounded reader", (_name, source, unbounded) => {
    const helper = "src/__tests__/test-helpers.ts";
    const helperSource = readFileSync(helper, "utf8");
    const other = "src/shared/test-other.ts";
    const sources = new Map(readSources()).set(helper, helperSource).set(permissionSuite, source).set(other, "export {};");
    const graph = windowsImportGraph(sources);
    const inputScopes = { [helper]: { digest: windowsReaderDigest(helper, graph) ?? "", inputs: [], readers: ["readRepoFile", "inspectFile"] } };
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(other)], inventories, inputScopes, readSources: () => sources,
    });
    expect(result.mode).toBe("affected");
    expect(selected(result).includes(permissionSuite)).toBe(unbounded);
  });

  it.each([
    ["src/ui/renderer/types.ts", (source: string) => `${source}\n`],
    ["src/permissions/__tests__/sensitive-paths-canonicalize.test.ts",
      (source: string) => source.replace("path produces an absolute resolved string", "path is absolute")],
  ] as const)("keeps a bounded edit to %s in affected mode with the committed inventories", (file, edit) => {
    const sources = readWindowsSources(process.cwd());
    const before = sources.get(file) ?? "";
    const after = edit(before);
    expect(before).not.toBe("");
    expect(after).not.toBe(before);
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(file)], inventories,
      readVersion: (_path, side) => side === "before" ? before : after,
      readSources: () => sources.set(file, after),
    });
    expect(result.mode).toBe("affected");
    const files = selected(result);
    expect(files.length).toBeLessThan(new Set(Object.values(inventories).flat()).size);
    if (file.endsWith(".test.ts")) expect(files).toContain(file);
  }, 45_000);

  const runtimeContracts = [
    ["src/plugins/__tests__/registry-atomicity.test.ts", "src/plugins/__tests__/fixtures/registry-process-child.ts"],
    ["src/permissions/__tests__/srt-win-integrity.test.ts", "src/permissions/__tests__/fixtures/srt-win-exit-order-child.ts"],
    ["src/shared/__tests__/ave-home-host-ownership.test.ts", "src/main/host-instance-lock.ts"],
  ] as const;
  it.each(runtimeContracts)("keeps %s when its real runtime input %s changes", (suite, target) => {
    // Expected paths come from the child/bundle call sites. The graph cannot choose the expected suite.
    const runtimeSources = new Map([suite, target].map(file => [file, readFileSync(file, "utf8")]));
    const module = windowsImportGraph(runtimeSources).get(suite);
    expect(module).toBeDefined();
    expect(windowsRuntimeInputIndex(runtimeSources)(module?.tokens ?? [])).toContain(target);
    expect(inventories[permission]).toContain(suite);
    const result = planWindowsTests({
      event: "pull_request", changes: [{ status: "M", file: target }], inventories, readSources: () => runtimeSources,
    });
    expect(result.lists[permission]).toContain(suite);
    expect(result.shards.flatMap(shard => shard.files)).toContain(suite);
  });

  it("uses a full plan for executable source-tree fixtures even without a discovered caller", () => {
    const file = "src/shared/__tests__/fixtures/computed.ts";
    expect(plan([{ status: "M", file }])).toMatchObject({ mode: "full", reason: expect.stringContaining("executable fixture") });
  });

  it("fails closed for missing history, absent source and deleted paths", () => {
    expect(pullRequestWindowsChanges(process.cwd(), "not-a-ref", "HEAD")).toBeUndefined();
    expect(plan()).toMatchObject({ mode: "full", lists: inventories });
    expect(plan([{ status: "M", file: "src/missing.ts" }]).mode).toBe("full");
    expect(plan([{ status: "D", file: changed }]).mode).toBe("full");
  });

  it("rejects an omitted affected test and an incomplete or out-of-inventory full plan", () => {
    expect(() => assertWindowsCoverage([permissionSuite], [])).toThrow(permissionSuite);
    expect(() => plannedWindowsFiles(permission, inventories[permission].join("\n"), {
      mode: "full", lists: { [permission]: [] },
    })).toThrow("Invalid Windows plan");
    expect(() => plannedWindowsFiles(permission, inventories[permission].join("\n"), {
      mode: "affected", lists: { [permission]: ["src/unknown.test.ts"] },
    })).toThrow("Invalid Windows plan");
  });

  it.each([{ changes: [] }, { changes: [{ status: "M", file: "package.json" }] }])("assigns each selected file to one nonempty shard (%j)", ({ changes }) => {
    const result = plan(changes);
    expect(result.shards.map(shard => shard.id)).toEqual(WINDOWS_TEST_SHARDS);
    expect(result.shards.every(shard => shard.files.length > 0)).toBe(true);
    const files = WINDOWS_TEST_SHARDS.flatMap(shard => WINDOWS_TEST_LISTS.flatMap(list =>
      plannedWindowsFiles(list, inventories[list].join("\n"), result, shard)));
    const expected = [...new Set(Object.values(result.lists).flat())].sort();
    expect(files.sort()).toEqual(expected);
    result.shards[0]?.files.pop();
    expect(() => plannedWindowsFiles(permission, inventories[permission].join("\n"), result, 1))
      .toThrow("Windows shards must cover every selected test exactly once");
  });

  it("balances by measured duration before file count", () => {
    const brief = plan([]);
    const worst = brief.shards[0]?.files[0];
    if (worst === undefined) throw new Error("No Windows tests assigned to the first shard");
    const result = planWindowsTests({ event: "pull_request", inventories, changes: [], readSources, durations: { [worst]: 100_000 } });
    expect(result.shards[0]?.files).toEqual([worst]);
    expect(result.shards[0]?.weightMs).toBe(101_000);
  });
});

describe("last Windows lane removal", () => {
  const file = "src/permissions/__tests__/sensitive-paths-canonicalize.test.ts";
  const source = readFileSync(file, "utf8");
  const updated = { ...inventories, [permission]: inventories[permission].filter(path => path !== file) };
  function versions(record?: string, priorRecord?: string): ReadWindowsVersion {
    return (path, side) => {
      if (path === WINDOWS_TEST_REMOVALS) return (side === "before" ? priorRecord : record) ?? "{}";
      if (path === file) return side === "before" ? source : source.replace("// windows-permission\n", "");
      const list = WINDOWS_TEST_LISTS.find(list => list === path);
      return list ? `${(side === "before" ? inventories : updated)[list].join("\n")}\n` : null;
    };
  }

  it("rejects a matched declaration and row removal without a new record", () => {
    expect(source).toMatch(/^\/\/ windows-permission\n/u);
    const readVersion = versions();
    const departures = windowsCoverageDepartures(readVersion);
    expect([...departures]).toEqual([[file, permission]]);
    expect(() => assertWindowsRemovalRecords(departures, readVersion)).toThrow(file);
    const reused = JSON.stringify({ [file]: { reason: "Previously removed coverage" } });
    expect(() => assertWindowsRemovalRecords(departures, versions(reused, reused))).toThrow(file);
  });

  const recordFor = (record: Record<string, unknown>) => JSON.stringify({ [file]: record });
  const reason = "An equivalent canonicalization suite covers the boundary";
  const surviving = inventories[native][0] ?? "";
  it.each([
    ["an empty reason", { reason: "" }],
    ["a whitespace reason", { reason: " \t 　" }],
    ["a zero-width reason", { reason: "​" }],
    ["a format-character reason", { reason: "‍⁠﻿" }],
    ["a Hangul filler reason", { reason: "ㅤ" }],
    ["a blank Braille reason", { reason: "⠀" }],
    ["a wildcard replacement", { reason, replacement: "*" }],
    ["a nonexistent replacement", { reason, replacement: "src/permissions/__tests__/missing-canonicalize.test.ts" }],
    ["a replacement outside every lane", { reason, replacement: "src/core/__tests__/route-input.test.ts" }],
    ["a padded replacement", { reason, replacement: ` ${surviving}` }],
    ["a dotted replacement", { reason, replacement: `./${surviving}` }],
    ["the departing suite as its own replacement", { reason, replacement: file }],
  ])("rejects a record with %s", (_name, record) => {
    expect(Object.values(inventories).flat()).not.toContain("src/core/__tests__/route-input.test.ts");
    const readVersion = versions(recordFor(record));
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).toThrow(file);
  });

  it("accepts a revised record when a restored suite leaves again", () => {
    // A base record for a departing suite means the suite had returned to a base lane.
    const prior = recordFor({ reason: "Previously removed coverage" });
    const readVersion = versions(recordFor({ reason: "The restored suite moved to the canonicalization audit" }), prior);
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).not.toThrow();
  });

  it.each([
    ["unchanged", "Previously removed coverage"],
    ["padded", "  Previously removed coverage "],
    ["zero-width-marked", "Previously​ removed coverage⁠"],
  ])("rejects an %s historical reason for a suite that leaves again", (_name, revised) => {
    const readVersion = versions(recordFor({ reason: revised }), recordFor({ reason: "Previously removed coverage" }));
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).toThrow(file);
  });

  it("accepts a replacement that a surviving Windows lane collects at head", () => {
    expect(surviving).not.toBe("");
    const readVersion = versions(recordFor({ reason, replacement: surviving }));
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).not.toThrow();
  });

  it("accepts every committed record against the lanes at head", () => {
    const records = JSON.parse(readFileSync(WINDOWS_TEST_REMOVALS, "utf8")) as Record<string, unknown>;
    const departures = new Map(Object.keys(records).map(path => [path, permission] as const));
    const head: ReadWindowsVersion = (path, side) => {
      if (path === WINDOWS_TEST_REMOVALS) return side === "after" ? JSON.stringify(records) : "{}";
      return WINDOWS_TEST_LISTS.includes(path as typeof permission) ? readFileSync(path, "utf8") : null;
    };
    expect(departures.size).toBeGreaterThan(0);
    expect(() => assertWindowsRemovalRecords(departures, head)).not.toThrow();
  });

  it.each([false, true])("runs the departing suite once with a new record (full=%s)", full => {
    const readVersion = versions(JSON.stringify({ [file]: { reason: "An equivalent canonicalization suite covers the boundary" } }));
    const departures = windowsCoverageDepartures(readVersion);
    expect(() => assertWindowsRemovalRecords(departures, readVersion)).not.toThrow();
    const changes = [file, permission, WINDOWS_TEST_REMOVALS, ...(full ? [".github/workflows/ci.yml"] : [])]
      .map(file => ({ file, status: "M", oldMode: "100644", newMode: "100644" }));
    const result = planWindowsTests({
      event: "pull_request", inventories: updated, changes, readVersion, coverageVersion: readVersion,
      departures, readSources: () => { throw new Error("No source scan expected"); },
    });
    expect(result.mode).toBe(full ? "full" : "affected");
    expect(result.departing).toEqual([file]);
    const selected = WINDOWS_TEST_SHARDS.flatMap(shard =>
      plannedWindowsFiles(permission, updated[permission].join("\n"), result, shard));
    expect(selected.filter(path => path === file)).toEqual([file]);
  });

  it("does not count a lane transfer between the three lists as a departure", () => {
    const original = versions();
    expect(windowsCoverageDepartures((path, side) => {
      const value = original(path, side);
      return path === application && side === "after" ? `${value ?? ""}${file}\n` : value;
    }).size).toBe(0);
  });
});
