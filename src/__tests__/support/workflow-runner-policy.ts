import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { readsAnySecret, workflowExpressions } from "./workflow-secret-policy.js";

/** Fork-reachable jobs must never receive private runners, write tokens, or secrets. Treat unlisted events as untrusted. */

export const TRUSTED_EVENTS: ReadonlySet<string> = new Set([
  "push",
  "schedule",
  "workflow_dispatch",
  "repository_dispatch",
]);

/** Allow only pinned hosted images and the Linux-only latest image. */
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

/** Recognize pull-request head references from event payloads, API responses, branches, and refspecs. */
const PULL_REQUEST_CODE_REFERENCE =
  /pull_request\.head\b|(?:^|[\s'"(|])\.head\s*(?:\||\.[A-Za-z_])|\bgithub\.head_ref\b|\bGITHUB_HEAD_REF\b|\brefs\/pull\/|(?:^|[\s:'"+])pull\/\S[^\n]*?\/(?:head|merge)\b/imu;

const GIT_OR_GH = /\b(?:git|gh)\b/u;

const RUNNER_FILE_WRITE = /\bGITHUB_(OUTPUT|ENV|PATH)\b/gu;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

/** Propagate step-output taint case-insensitively; unsupported steps expressions are tainted while any step is tainted. */
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

/** Reject head-code execution and tainted environment or output flows. This lint cannot track files or assembled references; content pins enforce the boundary. */
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

/** Pin privileged workflow bytes and every executed repository file; reject newly executed or imported files until pinned. */
export const PULL_REQUEST_TARGET_WORKFLOWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "cluster-detector.yml": {
    ".github/workflows/cluster-detector.yml": "17639cbf71170c65865a07d577472d405233fafe99017ab22a8edb7a570abc56",
    "scripts/check-cluster-scope.mjs": "7ee8ae74cfbd607c571f8d8844f18d7fdaf016dd01c76a6ce8d621ef88318787",
    "scripts/check-cluster-sensitive-paths.mjs": "45b2179ebcc146834e0cc8433af2b19440ef28e37cbd5460ba5e01e4458b229c",
  },
};

function workflowContentHash(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/gu, "\n")).digest("hex");
}

/** Every script token must resolve to a repository file; reject dynamic or absolute paths. */
const RUN_SCRIPT_TOKEN = /([^\s"'=();|&<>`]*\.(?:mjs|cjs|js|mts|cts|ts|sh|py|ps1))(?=$|[\s"';)|&<>`])/gmu;

const WORKSPACE_ROOT = /\$\{\{\s*github\.workspace\s*\}\}|\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE\b/gu;

const INTERPRETER = /(?:^|[\s;&|(`])(node|bun|npm|npx|pnpm|yarn|tsx|deno|python3?|bash|sh|pwsh|powershell)(?=$|\s)/mu;

/** Do not follow package-manager indirection or lifecycle scripts. */
const PACKAGE_SCRIPT = /(?:^|[\s;&|(`])(?:npm|npx|pnpm|yarn|bunx)(?=$|\s)|(?:^|[\s;&|(`])bun\s+(?!\S+\.(?:mjs|cjs|js|mts|cts|ts)(?=$|[\s"';)|&]))/mu;

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gmu;

/** Reject dynamic module targets and interpreter child processes that cannot be pinned. */
const UNFOLLOWABLE_MODULE_CODE =
  /\bimport\s*\(\s*(?!["'])|\brequire\s*\(\s*(?!["'])|\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(?:["'`](?:node|bun|deno|tsx|python3?|bash|sh|pwsh|powershell)["'`]|process\.(?:execPath|argv0))|\bfork\s*\(/u;

/** Reject shell commands, dynamic programs, workers, and generated code that cannot be pinned. */
const UNPINNABLE_MODULE_CODE: readonly (readonly [RegExp, string])[] = [
  [/(?:^|[^.\w$]|\b(?:child_process|childProcess|cp)\.)exec(?:Sync)?\s*\(/mu, "runs a shell command string (exec/execSync)"],
  [/(?:^|[^.\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?!["'])/mu, "starts a child process whose program is not a string literal"],
  [/\bnew\s+Worker\s*\(/u, "starts a worker"],
  [/\bshell\s*:\s*true\b/u, "runs a child process through a shell"],
  [/(?:^|[^.\w$])eval\s*\(/mu, "evaluates a string as code"],
  [/\bnew\s+Function\s*\(/u, "builds a function from a string"],
];

/** Privileged workflows may use only read-only CLI API and pull-request subcommands. */
function allowedGhSubcommand(first: string | undefined, second: string | undefined): boolean {
  return first === "api" || (first === "pr" && (second === "view" || second === "diff"));
}

const RUN_GH = /(?:^|[\s;&|(`$])gh(?=$|\s)(?:[ \t]+([^\s;&|)]+))?(?:[ \t]+([^\s;&|)]+))?/gmu;

const PIPED_DOWNLOAD = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|node|python3?|deno|bun|pwsh)(?=$|[\s;&|)])/mu;

const MODULE_GH_CALL = /(?:^|[^.\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["']gh["']\s*,\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/gmu;

function leadingStrings(array: string): [string | undefined, string | undefined] {
  const match = /^\[\s*["']([^"']*)["']\s*(?:,\s*["']([^"']*)["'])?/u.exec(array);
  return [match?.[1], match?.[2]];
}

/** Resolve argument identifiers only within the same function and only from literal arrays. */
function moduleGhProblems(content: string): string[] {
  const problems: string[] = [];
  for (const match of content.matchAll(MODULE_GH_CALL)) {
    const argument = match[1] as string;
    let array: string | undefined;
    if (argument.startsWith("[")) {
      array = argument;
    } else {
      const before = content.slice(0, match.index);
      const scopeStart = Math.max(before.lastIndexOf("function"), before.lastIndexOf("=>"));
      const declarations = [...before.slice(scopeStart).matchAll(
        new RegExp(`\\b(?:const|let|var)\\s+${argument.replace(/\$/gu, "\\$")}\\s*=\\s*(\\[[^\\]]*\\])`, "gu"),
      )];
      array = declarations.at(-1)?.[1];
    }
    const [first, second] = array === undefined ? [undefined, undefined] : leadingStrings(array);
    if (!allowedGhSubcommand(first, second)) {
      problems.push(`runs gh ${[first, second].filter(Boolean).join(" ") || `with ${argument}`}, which is not gh api, gh pr view or gh pr diff`);
    }
  }
  return problems;
}

const SHELL_INCLUDE = /(?:^|[\s;&|])(?:source|\.)\s+\S/mu;

function normalizeRepoPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`${path} leaves the repository`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/** Fail closed on unresolved scripts, launcher targets, package-manager indirection, local actions, and transitive imports. */
export function pullRequestTargetExecutedFiles(
  name: string,
  source: string,
  readFile: (path: string) => string | undefined,
): { files: string[]; problems: string[] } {
  const workflow = parseYaml(source, { merge: true }) as { jobs?: Record<string, Job> };
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const checkoutRoots = steps
    .filter((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"))
    .map((step) => (typeof step.with?.path === "string" ? normalizeRepoPath(step.with.path) : ""))
    .filter((root) => root !== "");
  const found = new Set<string>();
  const problems: string[] = [];
  const queue: string[] = [];
  const add = (path: string): void => {
    if (found.has(path)) return;
    found.add(path);
    queue.push(path);
  };
  steps.forEach((step, index) => {
    const label = `${name} step ${index + 1}`;
    if (typeof step.uses === "string" && step.uses.startsWith("./")) {
      const dir = normalizeRepoPath(step.uses);
      const action = [`${dir}/action.yml`, `${dir}/action.yaml`].find((path) => readFile(path) !== undefined);
      if (action === undefined) problems.push(`${label} uses ${step.uses}, which has no action.yml`);
      else add(action);
    }
    if (typeof step.run !== "string") return;
    const run = step.run.replace(WORKSPACE_ROOT, ".");
    if (PACKAGE_SCRIPT.test(run)) {
      problems.push(`${label} runs a package manager, whose package.json scripts this check does not follow`);
    }
    if (PIPED_DOWNLOAD.test(run)) {
      problems.push(`${label} pipes a download into an interpreter`);
    }
    for (const match of run.matchAll(RUN_GH)) {
      if (!allowedGhSubcommand(match[1], match[2])) {
        problems.push(`${label} runs gh ${[match[1], match[2]].filter(Boolean).join(" ")}, which is not gh api, gh pr view or gh pr diff`);
      }
    }
    let resolved = 0;
    // Extensionless path tokens may be executables and must also resolve to pinned files.
    for (const token of run.split(/[\s"'=();|&<>`]+/u)) {
      const pathLike = token.startsWith("./") || token.startsWith("../")
        || checkoutRoots.some((root) => token.startsWith(`${root}/`));
      const last = token.slice(token.lastIndexOf("/") + 1);
      if (!pathLike || /\.[A-Za-z0-9]+$/u.test(last)) continue;
      let path: string | undefined;
      try {
        path = normalizeRepoPath(token);
      } catch {
        path = undefined;
      }
      const root = path === undefined ? undefined : checkoutRoots.find((prefix) => (path as string).startsWith(`${prefix}/`));
      if (path !== undefined && root !== undefined) path = path.slice(root.length + 1);
      if (path === undefined || token.includes("$") || readFile(path) === undefined) {
        problems.push(`${label} names ${token}, which does not resolve to a repository file`);
        continue;
      }
      resolved += 1;
      add(path);
    }
    for (const match of run.matchAll(RUN_SCRIPT_TOKEN)) {
      const token = match[1] as string;
      if (token.startsWith("/") || token.includes("$")) {
        problems.push(`${label} names ${token}, which does not resolve to a repository file`);
        continue;
      }
      let path: string;
      try {
        path = normalizeRepoPath(token);
      } catch {
        problems.push(`${label} names ${token}, which leaves the repository`);
        continue;
      }
      const root = checkoutRoots.find((prefix) => path.startsWith(`${prefix}/`));
      if (root !== undefined) path = path.slice(root.length + 1);
      if (readFile(path) === undefined) {
        problems.push(`${label} names ${token}, which does not resolve to a repository file`);
        continue;
      }
      resolved += 1;
      add(path);
    }
    const interpreter = INTERPRETER.exec(run)?.[1];
    if (interpreter !== undefined && resolved === 0) {
      problems.push(`${label} runs ${interpreter} on no repository file this check can pin`);
    }
  });
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const content = readFile(file) as string;
    if (/\.(?:sh|bash)$/u.test(file) && SHELL_INCLUDE.test(content)) {
      problems.push(`${file} sources another file, which this check does not follow`);
    }
    if (!/\.(?:mjs|cjs|js|mts|cts|ts)$/u.test(file)) continue;
    if (UNFOLLOWABLE_MODULE_CODE.test(content)) {
      problems.push(`${file} loads or starts code through a non-literal import or an interpreter, which this check does not follow`);
    }
    for (const [pattern, what] of UNPINNABLE_MODULE_CODE) {
      if (pattern.test(content)) problems.push(`${file} ${what}, which this check does not follow`);
    }
    for (const problem of moduleGhProblems(content)) problems.push(`${file} ${problem}`);
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    for (const match of content.matchAll(RELATIVE_IMPORT)) {
      const target = normalizeRepoPath(`${dir}/${match[1] as string}`);
      if (readFile(target) === undefined) {
        problems.push(`${file} imports ${match[1]}, which resolves to no file`);
        continue;
      }
      add(target);
    }
  }
  return { files: [`.github/workflows/${name}`, ...[...found].sort()], problems };
}

/** Privileged workflows must match their allow-list entry and complete executed-file hashes. */
export function pullRequestTargetAllowListViolations(
  source: string,
  name: string,
  readFile: (path: string) => string | undefined,
): string[] {
  const workflow = parseYaml(source, { merge: true }) as { on?: unknown };
  if (!workflowEvents(workflow.on).includes("pull_request_target")) return [];
  const why = "pull_request_target runs with base-repo permissions; update the allow-list "
    + "(PULL_REQUEST_TARGET_WORKFLOWS in workflow-runner-policy.ts) only after a security review";
  const pinned = PULL_REQUEST_TARGET_WORKFLOWS[name];
  if (pinned === undefined) return [`${name} is not on the pull_request_target allow-list: ${why}`];
  const workflowPath = `.github/workflows/${name}`;
  const read = (path: string): string | undefined => (path === workflowPath ? source : readFile(path));
  const { files: executed, problems } = pullRequestTargetExecutedFiles(name, source, read);
  const violations: string[] = problems.map((problem) => `${problem}: ${why}`);
  const unpinned = executed.filter((path) => !(path in pinned));
  if (unpinned.length > 0) violations.push(`${name} executes files the allow-list does not pin (${unpinned.join(", ")}): ${why}`);
  const stale = Object.keys(pinned).filter((path) => !executed.includes(path));
  if (stale.length > 0) violations.push(`${name} no longer executes pinned files (${stale.join(", ")}): ${why}`);
  for (const path of executed) {
    const expected = pinned[path];
    if (expected === undefined) continue;
    const actual = workflowContentHash(read(path) as string);
    if (actual !== expected) {
      violations.push(`${path} changed since its pull_request_target review of ${name} (sha256 ${actual}, allow-list ${expected}): ${why}`);
    }
  }
  return violations;
}

function workflowReadsSecrets(workflow: { jobs: Record<string, Job> } & Record<string, unknown>): boolean {
  if (readsAnySecret(workflow)) return true;
  return Object.values(workflow.jobs).some((job) =>
    readsAnySecret(job.if, true) || (job.steps ?? []).some((step) => readsAnySecret(step.if, true)));
}

export function workflowEvents(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on !== null && typeof on === "object") return Object.keys(on);
  throw new Error("workflow has no `on:` triggers");
}

/** Computed runner matrices are unverifiable; enumerate every static value including include entries. */
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
