#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const keepCoverage = process.env.AVE_KEEP_COVERAGE_REPORTS === "1";
const reportsDir =
  process.env.AVE_COVERAGE_REPORTS_DIR ??
  mkdtempSync(join(tmpdir(), "ave-vitest-coverage-"));
const ownsReportsDir = !process.env.AVE_COVERAGE_REPORTS_DIR;
const discardsReports = ownsReportsDir && !keepCoverage;
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";

try {
  const prepare = spawnSync(bunCommand, ["run", "test:prepare"], {
    stdio: "inherit",
  });
  if (prepare.status !== 0) {
    process.exitCode = prepare.status ?? 1;
  } else {
    const coverage = spawnSync(
      process.execPath,
      [
        join("scripts", "run-vitest-under-electron.mjs"),
        "run",
        "--coverage",
        "--silent",
        `--coverage.reportsDirectory=${reportsDir}`,
        // The gate reads coverage-summary.json and the log shows the text
        // summary; the HTML report the config also asks for would be written
        // into a directory this script deletes, so it is not generated here.
        // A kept or caller-owned reports directory gets the config's full set.
        ...(discardsReports ? ["--coverage.reporter=json-summary", "--coverage.reporter=text-summary"] : []),
      ],
      { stdio: "inherit" },
    );
    if (coverage.status !== 0) {
      process.exitCode = coverage.status ?? 1;
    } else {
      const summary = join(reportsDir, "coverage-summary.json");
      const gate = spawnSync(
        process.execPath,
        ["scripts/check-test-coverage.mjs", summary],
        { stdio: "inherit" },
      );
      process.exitCode = gate.status ?? 1;
    }
  }
} finally {
  if (discardsReports) {
    rmSync(reportsDir, { recursive: true, force: true });
  }
}
