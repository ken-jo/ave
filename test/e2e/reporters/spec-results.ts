import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";

type CaseResult = {
  id: string;
  title: string;
  file: string;
  line: number;
  status: "pending" | "running" | TestResult["status"];
  annotations: TestCase["annotations"];
  retry?: number;
  durationMs?: number;
  errors?: string[];
};

/** Persist collection and each completed case independently of a clean runner exit. */
export default class SpecResultsReporter implements Reporter {
  private readonly path: string;
  private startedAt = Date.now();
  private status: string = "collecting";
  private shard: FullConfig["shard"] = null;
  private projects: Array<{ name: string; retries: number }> = [];
  private workers = 0;
  private cases = new Map<string, CaseResult>();
  private errors: string[] = [];

  constructor(options: { outputFile?: string } = {}) {
    this.path = resolve(options.outputFile ?? process.env.AVE_E2E_SPEC_RESULTS ?? "test-results/spec-results.json");
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.status = "running";
    this.shard = config.shard;
    this.projects = config.projects.map(project => ({ name: project.name, retries: project.retries }));
    this.workers = config.workers;
    for (const test of suite.allTests()) {
      this.cases.set(test.id, {
        id: test.id,
        title: test.titlePath().join(" › "),
        file: relative(config.rootDir, test.location.file).replaceAll("\\", "/"),
        line: test.location.line,
        status: "pending",
        annotations: [...test.annotations],
      });
    }
    this.write();
  }

  onTestBegin(test: TestCase): void {
    this.caseFor(test).status = "running";
    this.write();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    Object.assign(this.caseFor(test), {
      status: result.status,
      retry: result.retry,
      durationMs: result.duration,
      errors: result.errors.map(error => error.message ?? error.value ?? "Unknown test error"),
      annotations: [...test.annotations],
    });
    this.write();
  }

  onError(error: { message?: string; value?: string }): void {
    this.errors.push(error.message ?? error.value ?? "Unknown runner error");
    this.write();
  }

  onEnd(result: FullResult): void {
    this.status = result.status;
    this.write();
  }

  private caseFor(test: TestCase): CaseResult {
    const result = this.cases.get(test.id);
    if (!result) throw new Error(`Uncollected test: ${test.id}`);
    return result;
  }

  private write(): void {
    const cases = [...this.cases.values()];
    const specs = [...new Set(cases.map(test => test.file))].sort().map(file => {
      const tests = cases.filter(test => test.file === file);
      const counts: Record<string, number> = {};
      for (const test of tests) counts[test.status] = (counts[test.status] ?? 0) + 1;
      return { file, counts, tests };
    });
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    const snapshot = {
      status: this.status,
      shard: this.shard,
      projects: this.projects,
      workers: this.workers,
      commit: process.env.GITHUB_SHA ?? null,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      selectedTests: cases.length,
      completedTests: cases.filter(test => test.status !== "pending" && test.status !== "running").length,
      complete: this.status !== "collecting" && cases.every(test => test.status !== "pending" && test.status !== "running"),
      wallMs: Date.now() - this.startedAt,
      errors: this.errors,
      specs,
    };
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(temporaryPath, this.path);
  }
}
