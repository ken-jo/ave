import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Sum runner occupancy, not the elapsed time of parallel workflow branches.
// The reporting job itself is still running: its duration is a lower bound.
export function summarizeCiJobs(jobs, now = Date.now()) {
  let seconds = 0;
  let active = 0;
  let missing = 0;
  for (const job of new Map(jobs.map((entry) => [entry.id, entry])).values()) {
    if (job.conclusion === "skipped") continue;
    const start = Date.parse(job.started_at);
    const end = job.completed_at ? Date.parse(job.completed_at) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { missing += 1; continue; }
    seconds += (end - start) / 1000;
    if (!job.completed_at) active += 1;
  }
  return { minutes: seconds / 60, active, missing };
}

async function report() {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_TOKEN: token, GITHUB_STEP_SUMMARY: summary } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !/^\d+$/u.test(runId ?? "") || !token || !summary) {
    throw new Error("CI timing report requires repository, run, token and summary");
  }
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CI timing request failed (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data.jobs) || !Number.isInteger(data.total_count)) throw new Error("CI timing response is invalid");
    jobs.push(...data.jobs);
    if (jobs.length >= data.total_count) break;
    if (data.jobs.length === 0 || page >= 20) throw new Error("CI timing pagination is incomplete");
  }
  const { minutes, active, missing } = summarizeCiJobs(jobs);
  const status = missing ? "Incomplete timing data" : minutes >= 60 ? "Patch runner budget exceeded" : "Below the 60-minute patch runner target so far";
  appendFileSync(summary, `\n### Runner budget\n\n${status}: **${minutes.toFixed(2)} runner minutes**.\n\n${active} job(s) still active; ${missing} job(s) without usable timing. This is a lower bound until active jobs and post-job cleanup finish. Full verification runs are reported against the same target but keep all required tests.\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  report().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
