import { parse as parseYaml } from "yaml";
import { readsAnySecret } from "./workflow-secret-policy.js";

/**
 * The fork-safety rule for `.github/workflows/`, shared by the suites that pin
 * workflow structure.
 *
 * In a public repository anyone can open a pull request from a fork, and
 * GitHub also sends `pull_request_target`, `issue_comment`, review and other
 * events for it to this repository. A job such an event starts must never land
 * on a self-hosted runner (a fork's package.json postinstall would run on the
 * owner's machine) and must never hand fork code a write token or a secret.
 *
 * Events are trusted by allow-list, so an event added later counts as
 * fork-reachable until it is listed here: push, schedule, workflow_dispatch
 * and repository_dispatch need write access to the repository.
 *
 * A workflow with any fork-reachable trigger takes, for every job, either a
 * GitHub-hosted label or exactly {@link forkSafeRunsOn}: the runner a repo
 * variable names for a trusted event, the hosted label otherwise. That one
 * expression is the shared form; Actions has no cross-workflow expression
 * reuse, so this check is what keeps the copies identical.
 *
 * This check reads the workflow files on the default branch. A fork pull
 * request runs its own edited copy, so the repository setting that holds fork
 * workflows for approval stays the boundary against a hostile workflow edit.
 */

/** Events only a user with write access can start. */
export const TRUSTED_EVENTS: ReadonlySet<string> = new Set([
  "push",
  "schedule",
  "workflow_dispatch",
  "repository_dispatch",
]);

/** GitHub-hosted labels a fork-reachable job may name. */
const HOSTED_LABELS: ReadonlySet<string> = new Set([
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "windows-latest",
  "windows-2025",
  "macos-latest",
  "macos-15",
]);

/** True for the events whose job may take the self-hosted runner: a trusted
 *  event, or a pull request whose head branch is in this repository and that
 *  Dependabot did not open (GitHub runs Dependabot pull requests as fork
 *  runs). */
export const TRUSTED_RUNNER_GUARD =
  "(contains(fromJSON('[\"push\",\"schedule\",\"workflow_dispatch\"]'), github.event_name)"
  + " || contains(fromJSON('[\"pull_request\",\"pull_request_target\"]'), github.event_name)"
  + " && github.event.pull_request.head.repo.full_name == github.repository"
  + " && github.event.pull_request.user.login != 'dependabot[bot]')";

/** The one runs-on form a fork-reachable job may use besides a hosted label. */
export function forkSafeRunsOn(variable: string, hosted: string): string {
  return `\${{ ${TRUSTED_RUNNER_GUARD} && vars.${variable} && fromJSON(vars.${variable}) || '${hosted}' }}`;
}

type Step = { uses?: unknown; with?: Record<string, unknown>; run?: unknown; if?: unknown; env?: unknown };
type Job = { "runs-on"?: unknown; uses?: unknown; permissions?: unknown; if?: unknown; env?: unknown; steps?: Step[] };

/** Text that names the pull request's own code: the head commit, branch or
 *  repository from the event payload (`github.event.pull_request.head.*`, or
 *  `.pull_request.head` read from `$GITHUB_EVENT_PATH`), the head branch
 *  (`github.head_ref`, `$GITHUB_HEAD_REF`), a `refs/pull/...` ref or a
 *  `pull/<n>/head|merge` refspec. */
const PULL_REQUEST_CODE_REFERENCE =
  /pull_request\.head\b|\bgithub\.head_ref\b|\bGITHUB_HEAD_REF\b|\brefs\/pull\/|(?:^|[\s:'"+])pull\/\S[^\n]*?\/(?:head|merge)\b/imu;

/** A git or gh invocation anywhere in a script. */
const GIT_OR_GH = /\b(?:git|gh)\b/u;

/** True when a `run:` step could fetch or check out pull request code: the
 *  step's script, its own env or the env it inherits from the job and the
 *  workflow names that code anywhere (so a variable set on one line, or in
 *  `env:`, and used on another counts), and the script invokes git or gh
 *  anywhere, or runs `gh pr checkout`. Deliberately strict: the whole step
 *  is one unit. */
function runStepFetchesPullRequestCode(step: Step, inherited: readonly unknown[]): boolean {
  if (typeof step.run !== "string" || !GIT_OR_GH.test(step.run)) return false;
  // `gh pr checkout` needs no reference: the pull request number is enough.
  if (/\bgh\s+pr\s+checkout\b/u.test(step.run)) return true;
  const scope = [step.run, JSON.stringify([step.env ?? null, ...inherited])].join("\n");
  return PULL_REQUEST_CODE_REFERENCE.test(scope);
}

/** True when the workflow reads the `secrets` context anywhere, in any form. */
function workflowReadsSecrets(workflow: { jobs: Record<string, Job> } & Record<string, unknown>): boolean {
  if (readsAnySecret(workflow)) return true;
  return Object.values(workflow.jobs).some((job) =>
    readsAnySecret(job.if, true) || (job.steps ?? []).some((step) => readsAnySecret(step.if, true)));
}

/** The events a workflow's `on:` names, whatever its form. */
export function workflowEvents(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on !== null && typeof on === "object") return Object.keys(on);
  throw new Error("workflow has no `on:` triggers");
}

function runnerProblem(runsOn: unknown): string | null {
  if (typeof runsOn !== "string") return "runs-on is not a single label or the fork-safe expression";
  if (HOSTED_LABELS.has(runsOn)) return null;
  const match = /^\$\{\{ .* && vars\.(AVE_[A-Z]+_RUNNER) && fromJSON\(vars\.\1\) \|\| '([^']+)' \}\}$/u.exec(runsOn);
  if (match && runsOn === forkSafeRunsOn(match[1] as string, match[2] as string)) {
    return HOSTED_LABELS.has(match[2] as string) ? null : `falls back to ${match[2]}, not a hosted label`;
  }
  return `runs-on ${runsOn} is not a hosted label or the fork-safe expression`;
}

function grantsWrite(permissions: unknown): boolean {
  if (typeof permissions === "string") return permissions !== "read-all" && permissions !== "{}";
  if (permissions === null || typeof permissions !== "object") return false;
  return Object.values(permissions).some((level) => level === "write");
}

/** Every violation of the fork-safety rule in one workflow, as
 *  `<name>:<job> <reason>`; empty for a compliant or trusted-only workflow. */
export function forkRunnerViolations(source: string, name: string): string[] {
  const workflow = parseYaml(source, { merge: true }) as {
    on?: unknown;
    permissions?: unknown;
    env?: unknown;
    jobs?: Record<string, Job>;
  };
  if (workflow.jobs === undefined) throw new Error(`${name} has no jobs`);
  const events = workflowEvents(workflow.on);
  const untrusted = events.filter((event) => !TRUSTED_EVENTS.has(event));
  if (untrusted.length === 0) return [];
  const privileged = events.includes("pull_request_target");
  const violations: string[] = [];
  if (workflow.permissions === "write-all") violations.push(`${name} grants write-all`);
  if (privileged && grantsWrite(workflow.permissions)) {
    violations.push(`${name} grants a write permission to pull_request_target`);
  }
  if (privileged && workflowReadsSecrets(workflow as { jobs: Record<string, Job> })) {
    violations.push(`${name} reads a secret under pull_request_target`);
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job.uses !== undefined) {
      violations.push(`${name}:${id} calls a reusable workflow this check cannot read`);
      continue;
    }
    const problem = runnerProblem(job["runs-on"]);
    if (problem) violations.push(`${name}:${id} ${problem}`);
    if (workflow.permissions === undefined && job.permissions === undefined) {
      violations.push(`${name}:${id} has no permissions block`);
    }
    if (job.permissions === "write-all") violations.push(`${name}:${id} grants write-all`);
    if (privileged && grantsWrite(job.permissions)) {
      violations.push(`${name}:${id} grants a write permission to pull_request_target`);
    }
    if (!privileged) continue;
    for (const step of job.steps ?? []) {
      if (runStepFetchesPullRequestCode(step, [job.env ?? null, workflow.env ?? null])) {
        violations.push(`${name}:${id} fetches pull request code in a run step under pull_request_target`);
      }
      if (typeof step.uses !== "string" || !step.uses.startsWith("actions/checkout@")) continue;
      const inputs = step.with ?? {};
      const ref = String(inputs.ref ?? "");
      if (inputs.ref === undefined || /head|merge|github\.ref|pull_request/iu.test(ref) || "repository" in inputs) {
        violations.push(`${name}:${id} checks out pull request code under pull_request_target`);
      }
      if (inputs["persist-credentials"] !== false) {
        violations.push(`${name}:${id} keeps checkout credentials under pull_request_target`);
      }
    }
  }
  return violations;
}
