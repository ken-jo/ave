import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCiJobs } from "../../scripts/report-ci-budget.mjs";

const start = "2026-01-01T00:00:00Z";
const end = "2026-01-01T00:10:00Z";
test("parallel jobs consume their sum, not their shared wall time", () => {
  const jobs = [1, 2].map((id) => ({ id, started_at: start, completed_at: end, conclusion: "success" }));
  assert.deepEqual(summarizeCiJobs(jobs), { minutes: 20, active: 0, missing: 0 });
});
test("a running reporter uses elapsed time and marks the lower bound", () => {
  assert.deepEqual(summarizeCiJobs([{ id: 1, started_at: start }], Date.parse(end)), { minutes: 10, active: 1, missing: 0 });
});
test("cancelled work counts, duplicate API entries do not, and skips cost nothing", () => {
  const job = { id: 1, started_at: start, completed_at: end, conclusion: "cancelled" };
  assert.deepEqual(summarizeCiJobs([job, job, { id: 2, conclusion: "skipped" }]), { minutes: 10, active: 0, missing: 0 });
});
test("queued, corrupt and reversed timings are reported rather than counted as zero", () => {
  const jobs = [{ id: 1 }, { id: 2, started_at: "bad", completed_at: end }, { id: 3, started_at: end, completed_at: start }];
  assert.deepEqual(summarizeCiJobs(jobs), { minutes: 0, active: 0, missing: 3 });
});
