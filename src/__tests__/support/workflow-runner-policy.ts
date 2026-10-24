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

/** Every workflow allowed to run on `pull_request_target`, with the sha256
 *  (LF line endings) of the workflow file and of every repository file it
 *  executes, keyed by repository path. Such a workflow runs with the base
 *  repository's token and permissions while the pull request is a fork's, and
 *  the step lint above cannot see every channel a head reference can travel
 *  through. So a new or edited one fails until this list is updated, and the
 *  update is in the diff for a reviewer to see.
 *
 *  The executed files are derived by the gate ({@link pullRequestTargetExecutedFiles}),
 *  so the pinned set cannot go stale: a script the workflow starts to run, or
 *  a module one of them starts to import, fails as unpinned. cluster-detector
 *  checks out the live base SHA (never the pull request) into `.cluster-policy`
 *  and runs its scripts from there, so these files run as they are on the base
 *  branch; the pin makes every change to them, merged by anyone, a deliberate
 *  review point for code that runs with this workflow's token. */
export const PULL_REQUEST_TARGET_WORKFLOWS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "cluster-detector.yml": {
    ".github/workflows/cluster-detector.yml": "17639cbf71170c65865a07d577472d405233fafe99017ab22a8edb7a570abc56",
    "scripts/check-cluster-scope.mjs": "7ee8ae74cfbd607c571f8d8844f18d7fdaf016dd01c76a6ce8d621ef88318787",
    "scripts/check-cluster-sensitive-paths.mjs": "45b2179ebcc146834e0cc8433af2b19440ef28e37cbd5460ba5e01e4458b229c",
  },
};

/** The sha256 {@link PULL_REQUEST_TARGET_WORKFLOWS} pins for `source`. */
function workflowContentHash(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/gu, "\n")).digest("hex");
}

/** Every token in a `run:` script that ends in a script extension. Each must
 *  resolve to a repository file: one that does not (a typo, an absolute
 *  path, a path built from a variable) fails rather than going unpinned. */
const RUN_SCRIPT_TOKEN = /([^\s"'=();|&<>`]*\.(?:mjs|cjs|js|mts|cts|ts|sh|py|ps1))(?=$|[\s"';)|&<>`])/gmu;

/** The two spellings of the workspace root a script path may start with,
 *  resolved to the repository root. */
const WORKSPACE_ROOT = /\$\{\{\s*github\.workspace\s*\}\}|\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE\b/gu;

/** An interpreter or launcher invocation in a `run:` script. */
const INTERPRETER = /(?:^|[\s;&|(`])(node|bun|npm|npx|pnpm|yarn|tsx|deno|python3?|bash|sh|pwsh|powershell)(?=$|\s)/mu;

/** package.json indirection: a package manager running a script, a binary
 *  or an install (whose lifecycle scripts run too). Never followed. */
const PACKAGE_SCRIPT = /(?:^|[\s;&|(`])(?:npm|npx|pnpm|yarn|bunx)(?=$|\s)|(?:^|[\s;&|(`])bun\s+(?!\S+\.(?:mjs|cjs|js|mts|cts|ts)(?=$|[\s"';)|&]))/mu;

/** A static relative import or require in a JavaScript or TypeScript module. */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gmu;

/** In a pinned module, code this derivation cannot follow: a dynamic import
 *  or require whose target is not a string literal, a child process started
 *  on an interpreter (or on this Node), and `fork`. */
const UNFOLLOWABLE_MODULE_CODE =
  /\bimport\s*\(\s*(?!["'])|\brequire\s*\(\s*(?!["'])|\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(?:["'`](?:node|bun|deno|tsx|python3?|bash|sh|pwsh|powershell)["'`]|process\.(?:execPath|argv0))|\bfork\s*\(/u;

/** In a pinned module, code that runs something this check cannot pin: a
 *  shell command string (`exec`/`execSync`), a child process whose program is
 *  not a string literal, a worker, a shell, or code built from a string. */
const UNPINNABLE_MODULE_CODE: readonly (readonly [RegExp, string])[] = [
  [/(?:^|[^.\w$]|\b(?:child_process|childProcess|cp)\.)exec(?:Sync)?\s*\(/mu, "runs a shell command string (exec/execSync)"],
  [/(?:^|[^.\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?!["'])/mu, "starts a child process whose program is not a string literal"],
  [/\bnew\s+Worker\s*\(/u, "starts a worker"],
  [/\bshell\s*:\s*true\b/u, "runs a child process through a shell"],
  [/(?:^|[^.\w$])eval\s*\(/mu, "evaluates a string as code"],
  [/\bnew\s+Function\s*\(/u, "builds a function from a string"],
];

/** The gh subcommands a pull_request_target workflow may run, in a `run:`
 *  step or a pinned module: read-only API calls and pull request reads. */
function allowedGhSubcommand(first: string | undefined, second: string | undefined): boolean {
  return first === "api" || (first === "pr" && (second === "view" || second === "diff"));
}

/** Every gh invocation in a script, with its first two arguments. */
const RUN_GH = /(?:^|[\s;&|(`$])gh(?=$|\s)(?:[ \t]+([^\s;&|)]+))?(?:[ \t]+([^\s;&|)]+))?/gmu;

/** A remote download piped into an interpreter. */
const PIPED_DOWNLOAD = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|node|python3?|deno|bun|pwsh)(?=$|[\s;&|)])/mu;

/** A child process started on gh in a module: its args array literal, or the
 *  identifier that holds it. */
const MODULE_GH_CALL = /(?:^|[^.\w$])(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["']gh["']\s*,\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/gmu;

/** The first two string elements of an array literal's text. */
function leadingStrings(array: string): [string | undefined, string | undefined] {
  const match = /^\[\s*["']([^"']*)["']\s*(?:,\s*["']([^"']*)["'])?/u.exec(array);
  return [match?.[1], match?.[2]];
}

/** The gh calls in `content` that run anything but an allowed subcommand. An
 *  args identifier counts only when the same function (no `function` or `=>`
 *  between) declares it from an array literal. */
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

/** In a pinned shell script, a `source` or `.` include. */
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

/** The repository files a workflow executes, sorted, the workflow itself
 *  first, and every way the derivation could not follow one. It fails closed:
 *
 *  - every script path a `run:` step names must resolve to a repository file
 *    (an actions/checkout `path:` prefix and the workspace root map back to
 *    the repository root); an absolute or variable-built path is a problem;
 *  - a `run:` step that invokes an interpreter or launcher must resolve at
 *    least one file;
 *  - package.json indirection (`npm run`, `yarn <script>`, `npx`, an install)
 *    is a problem outright; package.json is never followed;
 *  - every local action's action.yml is included;
 *  - every static relative import of an included module is included,
 *    transitively, and must resolve; a non-literal dynamic import or require,
 *    or a child process started on an interpreter, in an included module is a
 *    problem, as is a `source` in an included shell script.
 *
 *  `readFile` answers a repository path's content, or undefined when there is
 *  no such file. */
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
    // A path-like token without an extension (`./bin/check`,
    // `.cluster-policy/tools/run`) may be an executable; it must resolve to a
    // repository file, which is then pinned.
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

/** The allow-list violations of one workflow, if it runs on
 *  pull_request_target: unlisted, or its pinned files differ from the files
 *  it executes, or one of them changed since it was listed. */
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
