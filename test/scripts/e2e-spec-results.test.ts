import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import SpecResultsReporter from "../e2e/reporters/spec-results.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function collectedCase(id: string, file: string): TestCase {
  return { id, titlePath: () => [file, id], location: { file, line: 7 }, annotations: [] } as unknown as TestCase;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "e2e-report-"));
  directories.push(root);
  const path = join(root, "output", "spec-results.json");
  const reporter = new SpecResultsReporter({ outputFile: path });
  const tests: [TestCase, TestCase, TestCase] = [collectedCase("first", join(root, "one.spec.ts")), collectedCase("second", join(root, "one.spec.ts")), collectedCase("third", join(root, "two.spec.ts"))];
  reporter.onBegin({ rootDir: root, shard: { current: 3, total: 32 }, workers: 1, projects: [{ name: "background", retries: 0 }] } as FullConfig, { allTests: () => tests } as unknown as Suite);
  return { reporter, tests, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

function result(status: TestResult["status"], errors: TestResult["errors"] = []): TestResult {
  return { status, retry: 0, duration: 12, errors } as TestResult;
}

describe("incremental per-spec evidence", () => {
  it("retains pending and running cases without requiring runner completion", () => {
    const { reporter, tests, read } = setup();
    expect(read().selectedTests).toBe(3);
    expect(read().specs.map((spec: { counts: unknown }) => spec.counts)).toEqual([{ pending: 2 }, { pending: 1 }]);
    reporter.onTestEnd(tests[0], result("passed"));
    reporter.onTestBegin(tests[1]);
    // No onEnd: the last durable snapshot remains useful after process interruption.
    const snapshot = read();
    expect(snapshot.status).toBe("running");
    expect(snapshot.complete).toBe(false);
    expect(snapshot.completedTests).toBe(1);
    expect(snapshot.shard).toEqual({ current: 3, total: 32 });
    expect(snapshot.projects).toEqual([{ name: "background", retries: 0 }]);
    expect(snapshot.specs[0].counts).toEqual({ passed: 1, running: 1 });
    expect(snapshot.specs[1].counts).toEqual({ pending: 1 });
  });

  it("keeps actual skips and failures separate from runner-level errors", () => {
    const { reporter, tests, read } = setup();
    reporter.onTestEnd(tests[0], result("passed"));
    reporter.onTestEnd(tests[1], result("failed", [{ message: "Expected the owned card" }]));
    tests[2].annotations.push({ type: "skip", description: "Live model opt-in is absent" });
    reporter.onTestEnd(tests[2], result("skipped"));
    reporter.onError({ message: "Worker cleanup did not finish" });
    reporter.onEnd({ status: "failed" } as FullResult);
    const snapshot = read();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.complete).toBe(true);
    expect(snapshot.completedTests).toBe(3);
    expect(snapshot.specs[0].counts).toEqual({ passed: 1, failed: 1 });
    expect(snapshot.specs[0].tests[1]).toMatchObject({ retry: 0, durationMs: 12, errors: ["Expected the owned card"] });
    expect(snapshot.specs[1].counts).toEqual({ skipped: 1 });
    expect(snapshot.specs[1].tests[0].annotations).toEqual([{ type: "skip", description: "Live model opt-in is absent" }]);
    expect(snapshot.errors).toEqual(["Worker cleanup did not finish"]);
  });

  it("remains incomplete after the final test ends when runner shutdown is interrupted", () => {
    const { reporter, tests, read } = setup();
    for (const test of tests) reporter.onTestEnd(test, result("passed"));
    // Worker shutdown can hang after every test ends, without reaching onEnd.
    const snapshot = read();
    expect(snapshot.status).toBe("running");
    expect(snapshot.completedTests).toBe(snapshot.selectedTests);
    expect(snapshot.complete).toBe(false);
  });
});
