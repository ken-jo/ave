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
 * Every job in every workflow runs on a pinned GitHub-hosted label: the
 * repository registers no self-hosted runner, and a job that named one would
 * reopen the path for a fork pull request. A matrix runner counts only when
 * every matrix entry names a hosted label.
 *
 * This check reads the workflow files on the default branch. A fork pull
 * request runs its own edited copy, so registering no self-hosted runner is
 * what keeps an edited `runs-on` from reaching one.
 */

/** Events only a user with write access can start. */
export const TRUSTED_EVENTS: ReadonlySet<string> = new Set([
  "push",
  "schedule",
  "workflow_dispatch",
  "repository_dispatch",
]);

/** The GitHub-hosted labels a job may name: pinned images, and ubuntu-latest
 *  for the Linux-only gates that do not ship or test a platform build. */
const HOSTED_LABELS: ReadonlySet<string> = new Set([
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "windows-2025",
  "macos-15",
]);

type Step = { id?: unknown; uses?: unknown; with?: Record<string, unknown>; run?: unknown; if?: unknown; env?: unknown };
type Job = {
  "runs-on"?: unknown;
  uses?: unknown;
  permissions?: unknown;
  if?: unknown;
  env?: unknown;
  outputs?: unknown;
  steps?: Step[];
  strategy?: { matrix?: Record<string, unknown> };
};

/** Text that names the pull request's own code: the head commit, branch or
 *  repository from the event payload (`github.event.pull_request.head.*`, or
 *  `.pull_request.head` read from `$GITHUB_EVENT_PATH`, or `.head.sha` /
 *  `.head.ref` read from a pull request the API returned), the head branch
 *  (`github.head_ref`, `$GITHUB_HEAD_REF`), a `refs/pull/...` ref or a
 *  `pull/<n>/head|merge` refspec. */
const PULL_REQUEST_CODE_REFERENCE =
  /pull_request\.head\b|(?:^|[\s'"(|])\.head\.(?:sha|ref)\b|\bgithub\.head_ref\b|\bGITHUB_HEAD_REF\b|\brefs\/pull\/|(?:^|[\s:'"+])pull\/\S[^\n]*?\/(?:head|merge)\b/imu;

/** A git or gh invocation anywhere in a script. */
const GIT_OR_GH = /\b(?:git|gh)\b/u;

/** A script that writes a value a later step reads: an output, the job's
 *  environment or its PATH. */
const RUNNER_FILE_WRITE = /\bGITHUB_(OUTPUT|ENV|PATH)\b/gu;

/** The pull_request_target violations of one job's steps.
 *
 *  A step "names pull request code" when its script, its own env, the env it
 *  inherits from the job and the workflow, or (for an action) its `with:`
 *  names {@link PULL_REQUEST_CODE_REFERENCE}, or reads `steps.<id>.outputs`
 *  of a tainted step. The whole step is one unit, so a variable set on one
 *  line, or in `env:`, and used on another counts.
 *
 *  - A run step that names pull request code and invokes git or gh anywhere,
 *    or that runs `gh pr checkout`, is refused.
 *  - A step that names pull request code and writes `$GITHUB_ENV` or
 *    `$GITHUB_PATH` is refused outright: every later step inherits those.
 *  - One that writes `$GITHUB_OUTPUT` taints its outputs; a later run step
 *    that reads them and invokes git or gh is refused as above, an action that
 *    reads them is refused, and a step that reads them and writes an output
 *    taints its own in turn. A job output that maps a tainted step output is
 *    refused, since this check does not follow `needs.<job>.outputs`.
 *
 *  Reading a tainted output in an `if:` is allowed: a condition only gates. */
function pullRequestCodeStepViolations(job: Job, inheritedEnv: readonly unknown[]): string[] {
  const reasons: string[] = [];
  const tainted = new Set<string>();
  const readsTainted = (text: string): boolean =>
    [...tainted].some((id) => text.includes(`steps.${id}.outputs.`));
  for (const step of job.steps ?? []) {
    const run = typeof step.run === "string" ? step.run : "";
    const actionInputs = typeof step.uses === "string" ? JSON.stringify(step.with ?? null) : "";
    const scope = [run, JSON.stringify([step.env ?? null, ...inheritedEnv]), actionInputs].join("\n");
    const namesCode = PULL_REQUEST_CODE_REFERENCE.test(scope) || readsTainted(scope);
    if (run !== "" && GIT_OR_GH.test(run) && (/\bgh\s+pr\s+checkout\b/u.test(run) || namesCode)) {
      reasons.push("fetches pull request code in a run step under pull_request_target");
    }
    if (typeof step.uses === "string" && readsTainted(actionInputs + JSON.stringify(step.env ?? null))) {
      reasons.push("passes a pull request reference from an earlier step to an action under pull_request_target");
    }
    if (!namesCode) continue;
    const writes = new Set([...run.matchAll(RUNNER_FILE_WRITE)].map((match) => match[1]));
    if (writes.has("ENV") || writes.has("PATH")) {
      reasons.push("exports a pull request reference through $GITHUB_ENV or $GITHUB_PATH under pull_request_target");
    }
    if (writes.has("OUTPUT") && typeof step.id === "string") {
      tainted.add(step.id);
    }
  }
  if (job.outputs !== undefined && readsTainted(JSON.stringify(job.outputs))) {
    reasons.push("maps a pull request reference to a job output under pull_request_target");
  }
  return reasons;
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

/** The labels `${{ matrix.<key> }}` can take: every value of that key in the
 *  matrix, its `include` entries among them; null when the matrix cannot be
 *  read statically (a computed matrix or key). */
function matrixLabels(job: Job, key: string): unknown[] | null {
  const matrix = job.strategy?.matrix;
  if (matrix === null || typeof matrix !== "object") return null;
  const values: unknown[] = [];
  const direct = matrix[key];
  if (Array.isArray(direct)) values.push(...direct);
  else if (direct !== undefined) return null;
  const include = matrix.include;
  if (include !== undefined) {
    if (!Array.isArray(include)) return null;
    for (const entry of include) {
      if (entry !== null && typeof entry === "object" && key in entry) values.push((entry as Record<string, unknown>)[key]);
    }
  }
  return values.length > 0 ? values : null;
}

function runnerProblem(job: Job): string | null {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return "runs-on is not a single hosted label";
  if (HOSTED_LABELS.has(runsOn)) return null;
  const matrixKey = /^\$\{\{ matrix\.([A-Za-z_][A-Za-z0-9_-]*) \}\}$/u.exec(runsOn)?.[1];
  if (matrixKey !== undefined) {
    const labels = matrixLabels(job, matrixKey);
    if (labels === null) return `runs-on ${runsOn} is not a static matrix of hosted labels`;
    const foreign = labels.filter((label) => typeof label !== "string" || !HOSTED_LABELS.has(label));
    return foreign.length === 0 ? null : `matrix runner ${JSON.stringify(foreign)} is not a hosted label`;
  }
  return `runs-on ${runsOn} is not a hosted label`;
}

function grantsWrite(permissions: unknown): boolean {
  if (typeof permissions === "string") return permissions !== "read-all" && permissions !== "{}";
  if (permissions === null || typeof permissions !== "object") return false;
  return Object.values(permissions).some((level) => level === "write");
}

/** Every violation of the runner and fork-safety rules in one workflow, as
 *  `<name>:<job> <reason>`; empty for a compliant workflow. */
export function workflowRunnerViolations(source: string, name: string): string[] {
  const workflow = parseYaml(source, { merge: true }) as {
    on?: unknown;
    permissions?: unknown;
    env?: unknown;
    jobs?: Record<string, Job>;
  };
  if (workflow.jobs === undefined) throw new Error(`${name} has no jobs`);
  const events = workflowEvents(workflow.on);
  const violations: string[] = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job.uses !== undefined) continue;
    const problem = runnerProblem(job);
    if (problem) violations.push(`${name}:${id} ${problem}`);
  }
  if (events.every((event) => TRUSTED_EVENTS.has(event))) return violations;
  const privileged = events.includes("pull_request_target");
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
    if (workflow.permissions === undefined && job.permissions === undefined) {
      violations.push(`${name}:${id} has no permissions block`);
    }
    if (job.permissions === "write-all") violations.push(`${name}:${id} grants write-all`);
    if (privileged && grantsWrite(job.permissions)) {
      violations.push(`${name}:${id} grants a write permission to pull_request_target`);
    }
    if (!privileged) continue;
    for (const reason of pullRequestCodeStepViolations(job, [job.env ?? null, workflow.env ?? null])) {
      violations.push(`${name}:${id} ${reason}`);
    }
    for (const step of job.steps ?? []) {
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
