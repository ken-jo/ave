import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { readsAnySecret, workflowExpressions } from "./workflow-secret-policy.js";

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

type Step = { id?: unknown; uses?: unknown; with?: Record<string, unknown>; run?: unknown; if?: unknown; env?: unknown };
type Job = {
  "runs-on"?: unknown;
  uses?: unknown;
  permissions?: unknown;
  if?: unknown;
  env?: unknown;
  outputs?: unknown;
  steps?: Step[];
};

/** Text that names the pull request's own code: anything under the head of
 *  the event payload (`github.event.pull_request.head.*`, or
 *  `.pull_request.head` read from `$GITHUB_EVENT_PATH`), a `.head` field or
 *  pipe read from a pull request the API returned (`.head.sha`,
 *  `.head.repo.clone_url`, jq `'.head | .sha'`), the head branch
 *  (`github.head_ref`, `$GITHUB_HEAD_REF`), a `refs/pull/...` ref or a
 *  `pull/<n>/head|merge` refspec. */
const PULL_REQUEST_CODE_REFERENCE =
  /pull_request\.head\b|(?:^|[\s'"(|])\.head\s*(?:\||\.[A-Za-z_])|\bgithub\.head_ref\b|\bGITHUB_HEAD_REF\b|\brefs\/pull\/|(?:^|[\s:'"+])pull\/\S[^\n]*?\/(?:head|merge)\b/imu;

/** A git or gh invocation anywhere in a script. */
const GIT_OR_GH = /\b(?:git|gh)\b/u;

/** A script that writes a value a later step reads: an output, the job's
 *  environment or its PATH. */
const RUNNER_FILE_WRITE = /\bGITHUB_(OUTPUT|ENV|PATH)\b/gu;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

/** True when an expression in `value` (or any string nested in it) reads the
 *  `steps` context in a way that can carry a tainted step's value: exactly
 *  `steps.<id>.outputs.<name>` of a tainted id, or, while any step is
 *  tainted, any other shape (`toJSON(steps)`, `steps.a.outputs['x']`,
 *  `steps['a']`, `steps.*.outputs.x`, `steps.a.outcome`). Context and
 *  property names are case-insensitive, as in Actions. */
function readsTaintedSteps(value: unknown, tainted: ReadonlySet<string>): boolean {
  if (tainted.size === 0) return false;
  if (typeof value === "string") {
    for (const tokens of workflowExpressions(value, false)) {
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index]?.toLowerCase() !== "steps" || tokens[index - 1] === ".") continue;
        const [dot1, id, dot2, outputs, dot3, output] = tokens.slice(index + 1, index + 7);
        const exact = dot1 === "." && dot2 === "." && dot3 === "."
          && IDENTIFIER.test(id ?? "") && outputs?.toLowerCase() === "outputs" && IDENTIFIER.test(output ?? "");
        if (!exact || tainted.has((id as string).toLowerCase())) return true;
      }
    }
    return false;
  }
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((child) => readsTaintedSteps(child, tainted));
}

/** The pull_request_target violations of one job's steps. A lint, not the
 *  boundary: {@link pullRequestTargetAllowListViolations} is.
 *
 *  A step "names pull request code" when its script, its own env, the env it
 *  inherits from the job and the workflow, or (for an action) its `with:`
 *  names {@link PULL_REQUEST_CODE_REFERENCE}, or reads a tainted step's
 *  outputs ({@link readsTaintedSteps}). The whole step is one unit, so a
 *  variable set on one line, or in `env:`, and used on another counts.
 *
 *  - A run step that names pull request code and invokes git or gh anywhere,
 *    or that runs `gh pr checkout`, is refused.
 *  - An action other than actions/checkout (which has its own rule) whose
 *    `with:` or env names pull request code is refused: actions/github-script
 *    given `head.sha` can fetch and run it.
 *  - A step that names pull request code and writes `$GITHUB_ENV` or
 *    `$GITHUB_PATH` is refused outright: every later step inherits those.
 *  - One that writes `$GITHUB_OUTPUT` taints its outputs; a later run step
 *    that reads them and invokes git or gh is refused as above, an action that
 *    reads them is refused, and a step that reads them and writes an output
 *    taints its own in turn. A job output that maps a tainted step output is
 *    refused, since this check does not follow `needs.<job>.outputs`.
 *
 *  Reading a tainted output in an `if:` is allowed: a condition only gates.
 *
 *  What this cannot see: a value passed through any other channel, such as a
 *  file one step writes (`$RUNNER_TEMP/sha`, the workspace, a cache or an
 *  artifact) and a later step reads with `cat`; a command that fetches code
 *  without git or gh (curl of a tarball, a package manager); a reference
 *  built from pieces at run time. The allow-list of pull_request_target
 *  workflows, pinned by content hash, is what covers those: no such workflow
 *  changes without a reviewed update to the list. */
function pullRequestCodeStepViolations(job: Job, inheritedEnv: readonly unknown[]): string[] {
  const reasons: string[] = [];
  const tainted = new Set<string>();
  for (const step of job.steps ?? []) {
    const run = typeof step.run === "string" ? step.run : "";
    const isAction = typeof step.uses === "string";
    const actionInputs = isAction ? JSON.stringify(step.with ?? null) : "";
    const scope = [run, JSON.stringify([step.env ?? null, ...inheritedEnv]), actionInputs].join("\n");
    const readsTainted = readsTaintedSteps([run, step.env ?? null, step.with ?? null], tainted);
    const namesCode = PULL_REQUEST_CODE_REFERENCE.test(scope) || readsTainted;
    if (run !== "" && GIT_OR_GH.test(run) && (/\bgh\s+pr\s+checkout\b/u.test(run) || namesCode)) {
      reasons.push("fetches pull request code in a run step under pull_request_target");
    }
    if (isAction && readsTainted) {
      reasons.push("passes a pull request reference from an earlier step to an action under pull_request_target");
    } else if (isAction && !(step.uses as string).startsWith("actions/checkout@")
      && PULL_REQUEST_CODE_REFERENCE.test([actionInputs, JSON.stringify(step.env ?? null)].join("\n"))) {
      reasons.push("passes pull request code to an action under pull_request_target");
    }
    if (!namesCode) continue;
    const writes = new Set([...run.matchAll(RUNNER_FILE_WRITE)].map((match) => match[1]));
    if (writes.has("ENV") || writes.has("PATH")) {
      reasons.push("exports a pull request reference through $GITHUB_ENV or $GITHUB_PATH under pull_request_target");
    }
    if (writes.has("OUTPUT") && typeof step.id === "string") {
      tainted.add(step.id.toLowerCase());
    }
  }
  if (job.outputs !== undefined && readsTaintedSteps(job.outputs, tainted)) {
    reasons.push("maps a pull request reference to a job output under pull_request_target");
  }
  return reasons;
}

/** Every workflow allowed to run on `pull_request_target`, with the sha256 of
 *  its content (LF line endings). Such a workflow runs with the base
 *  repository's token and permissions while the pull request is a fork's, and
 *  the step lint above cannot see every channel a head reference can travel
 *  through. So a new or edited one fails until this list is updated, and the
 *  update is in the diff for a reviewer to see. */
export const PULL_REQUEST_TARGET_WORKFLOWS: Readonly<Record<string, string>> = {
  "cluster-detector.yml": "7cf172ed8cf163f70285c44dec8d86b75e5cec61083fabdb8141f1fb588dad34",
};

/** The sha256 {@link PULL_REQUEST_TARGET_WORKFLOWS} pins for `source`. */
export function workflowContentHash(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/gu, "\n")).digest("hex");
}

/** The allow-list violation of one workflow, if it runs on
 *  pull_request_target and is unlisted or edited since it was listed. */
export function pullRequestTargetAllowListViolations(source: string, name: string): string[] {
  const workflow = parseYaml(source, { merge: true }) as { on?: unknown };
  if (!workflowEvents(workflow.on).includes("pull_request_target")) return [];
  const why = "pull_request_target runs with base-repo permissions; update the allow-list "
    + "(PULL_REQUEST_TARGET_WORKFLOWS in workflow-runner-policy.ts) only after a security review";
  const pinned = PULL_REQUEST_TARGET_WORKFLOWS[name];
  if (pinned === undefined) return [`${name} is not on the pull_request_target allow-list: ${why}`];
  const actual = workflowContentHash(source);
  if (actual !== pinned) {
    return [`${name} changed since its pull_request_target review (sha256 ${actual}, allow-list ${pinned}): ${why}`];
  }
  return [];
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
