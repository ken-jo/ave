import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Sum runner occupancy, not the elapsed time of parallel workflow branches.
// The reporting job itself is still running: its duration is a lower bound.
export function summarizeCiJobs(jobs, now = Date.now()) {
  let seconds = 0;
  let roundedMinutes = 0;
  let active = 0;
  let missing = 0;
  let queued = 0;
  const byRunner = {};
  for (const job of new Map(jobs.map((entry) => [entry.id, entry])).values()) {
    if (job.conclusion === "skipped") continue;
    if (["queued", "waiting", "pending"].includes(job.status)) { queued += 1; continue; }
    const start = Date.parse(job.started_at);
    const end = job.completed_at ? Date.parse(job.completed_at) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { missing += 1; continue; }
    const duration = (end - start) / 1000;
    const rounded = Math.ceil(duration / 60);
    seconds += duration;
    roundedMinutes += rounded;
    const labels = job.labels ?? [];
    const runner = labels.includes("self-hosted") ? "self-hosted"
      : labels.some(label => /^windows-/i.test(label)) ? "Windows"
      : labels.some(label => /^macos-/i.test(label)) ? "macOS"
      : labels.some(label => /^ubuntu-/i.test(label)) ? "Linux" : "unknown";
    const row = byRunner[runner] ??= { minutes: 0, roundedMinutes: 0, jobs: 0 };
    row.minutes += duration / 60;
    row.roundedMinutes += rounded;
    row.jobs += 1;
    if (!job.completed_at) active += 1;
  }
  return { minutes: seconds / 60, roundedMinutes, byRunner, active, missing, queued };
}

async function report() {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_TOKEN: token, GITHUB_STEP_SUMMARY: summary } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !/^\d+$/u.test(runId ?? "") || !token || !summary) {
    throw new Error("CI timing report requires repository, run, token and summary");
  }
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`, {
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
  const { minutes, roundedMinutes, byRunner, active, missing, queued } = summarizeCiJobs(jobs);
  const status = missing ? "Incomplete timing data" : roundedMinutes >= 60 ? "Observed rounded-job budget exceeded"
    : active || queued ? "Rounded-job budget still provisional" : "Below the 60 rounded-job-minute target";
  const rows = Object.entries(byRunner).map(([runner, row]) => `| ${runner} | ${row.jobs} | ${row.minutes.toFixed(2)} | ${row.roundedMinutes} |`).join("\n");
  appendFileSync(summary, `\n### Runner budget\n\n${status}.\n\nRaw job sum: **${minutes.toFixed(2)} minutes**. Per-job whole-minute sum: **${roundedMinutes} minutes**.\n\n| Runner | Jobs | Raw minutes | Rounded minutes |\n|---|---:|---:|---:|\n${rows}\n\n${active} job(s) still active; ${queued} queued; ${missing} without usable timing. This includes all attempts of this run and remains a lower bound until active jobs and post-job cleanup finish. Rounded minutes are before runner-specific rates, not an invoice or included-compute deduction. Standard hosted jobs in public repositories are exempt from compute charges. Full verification keeps every required test even when the target is exceeded.\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  report().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
