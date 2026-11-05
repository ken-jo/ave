import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCiJobs } from "../../scripts/report-ci-budget.mjs";

const start = "2026-01-01T00:00:00Z";
const end = "2026-01-01T00:10:00Z";
test("parallel jobs consume their sum, not their shared wall time", () => {
  const jobs = [1, 2].map((id) => ({ id, started_at: start, completed_at: end, conclusion: "success" }));
  assert.equal(summarizeCiJobs(jobs).minutes, 20);
  assert.equal(summarizeCiJobs(jobs).roundedMinutes, 20);
});
test("a running reporter uses elapsed time and marks the lower bound", () => {
  const result = summarizeCiJobs([{ id: 1, started_at: start }], Date.parse(end));
  assert.equal(result.minutes, 10);
  assert.equal(result.active, 1);
});
test("cancelled work counts, duplicate API entries do not, and skips cost nothing", () => {
  const job = { id: 1, started_at: start, completed_at: end, conclusion: "cancelled" };
  const result = summarizeCiJobs([job, job, { id: 2, conclusion: "skipped" }]);
  assert.equal(result.minutes, 10);
  assert.equal(result.roundedMinutes, 10);
  assert.equal(result.active + result.missing + result.queued, 0);
});
test("queued, corrupt and reversed timings are reported rather than counted as zero", () => {
  const jobs = [{ id: 1 }, { id: 2, started_at: "bad", completed_at: end }, { id: 3, started_at: end, completed_at: start }];
  assert.equal(summarizeCiJobs(jobs).minutes, 0);
  assert.equal(summarizeCiJobs(jobs).missing, 3);
});
test("rounding is per job rather than on the aggregate and runner types remain separate", () => {
  const jobs = ["ubuntu-24.04-arm", "windows-2025", "macos-15"].map((label, id) => ({
    id, labels: [label], started_at: start, completed_at: "2026-01-01T00:01:01Z", conclusion: "success",
  }));
  const result = summarizeCiJobs(jobs);
  assert.equal(result.minutes, 183 / 60);
  assert.equal(result.roundedMinutes, 6);
  for (const runner of ["Linux", "Windows", "macOS"]) assert.equal(result.byRunner[runner].roundedMinutes, 2);
});
test("queued work has no allocated duration, but unfinished and repeated attempts remain visible", () => {
  const result = summarizeCiJobs([
    { id: 1, status: "queued", started_at: start },
    { id: 2, started_at: start, completed_at: "2026-01-01T00:00:01Z", conclusion: "failure" },
    { id: 3, started_at: start, labels: ["self-hosted", "windows-2025"] },
  ], Date.parse("2026-01-01T00:00:02Z"));
  assert.equal(result.minutes, 3 / 60);
  assert.equal(result.roundedMinutes, 2);
  assert.equal(result.queued, 1);
  assert.equal(result.active, 1);
  assert.equal(result.byRunner["self-hosted"].jobs, 1);
});
