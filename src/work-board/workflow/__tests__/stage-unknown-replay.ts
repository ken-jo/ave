import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHostGit, type HostGit, HostGitError } from "../host-git.js";
import { RUN_FILE } from "../workspace-layout.js";
import { stageOf, writeUnder as write } from "./stage-fixtures.js";
import { type GitFixture, gitFixture, sealed, stageRoot } from "./stage-git-fixture.js";

/** How a git call gives no answer: by its exit, or by throwing as the host's git does for a process that could not run or finish. */
export type FailureKind = "exit 128" | "exit 1 with stderr" | "thrown";
const THROWN = ["timeout", "terminated", "not-text"] as const;

/** A git call by its command and leading switches, values that differ from run to run left out. */
const signatureOf = (args: readonly string[]): string => args.slice(0, 3).map(arg => /^[0-9a-f]{40}$|[/\\:]|^Collect /u.test(arg) ? "*" : arg).join(" ");

interface Outcome { kind?: string; conflictFiles?: number; seeded?: boolean; ignoredSeeded?: boolean; recordsGone: boolean; registrations: number }
type Lifecycle = (fx: GitFixture, git: HostGit, stop: () => void) => Promise<Outcome>;

const registrationsOf = (fx: GitFixture): number => {
  const admin = join(fx.repo, ".git", "worktrees");
  return existsSync(admin) ? readdirSync(admin).length : 0;
};

/** Opens a run on a repository whose configuration requires a filter no file uses, seals two stages that conflict, joins them and
 * releases the run. */
const gitRun: Lifecycle = async (fx, git, stop) => {
  fx.userGit(fx.repo, "config", "filter.unused.required", "true");
  const handle = fx.start({ git });
  const open = await handle.provider.open(handle.run, fx.repo);
  if (!open.ok) { stop(); return { recordsGone: true, registrations: 0 }; }
  let conflictFiles: number | undefined;
  try {
    write(await stageRoot(handle, "s1"), "a.txt", "from s1\n");
    write(await stageRoot(handle, "s2"), "a.txt", "from s2\n");
    await sealed(handle, "s1");
    await sealed(handle, "s2");
    const joined = await handle.provider.integrate(handle.run, "j1", ["s1", "s2"]);
    if (!joined.ok && joined.conflict.reason === "merge-conflict") conflictFiles = joined.conflict.files.length;
  } catch { /* a refusal is an answer */ }
  await handle.provider.release(handle.run, "all").catch(() => undefined);
  stop();
  return { kind: open.workspace.kind, ...(conflictFiles === undefined ? {} : { conflictFiles }), recordsGone: !existsSync(join(open.workspace.runRoot, RUN_FILE)), registrations: registrationsOf(fx) };
};

/** Opens a run on a work tree with no commit yet, seeds a stage from all of it, and releases the run: an ignored file is never seeded. */
const folderInRepo: Lifecycle = async (fx, git, stop) => {
  const project = join(fx.base, "unborn");
  write(project, "kept.txt", "kept\n");
  write(project, "debug.log", "ignored\n");
  write(project, ".gitignore", "*.log\n");
  fx.userGit(project, "init", "-q");
  const handle = fx.start({ git }, 7, project);
  const open = await handle.provider.open(handle.run, project);
  if (!open.ok) { stop(); return { recordsGone: true, registrations: 0 }; }
  let seeded = false;
  let ignoredSeeded = false;
  try {
    const prepared = await handle.provider.prepare(handle.run, stageOf("s1", { inputFiles: [{ from: "project", paths: ["**"] }] }), 1);
    if (prepared.ok) [seeded, ignoredSeeded] = [existsSync(join(prepared.workspace.root, "kept.txt")), existsSync(join(prepared.workspace.root, "debug.log"))];
  } catch { /* a refusal is an answer */ }
  await handle.provider.release(handle.run, "all").catch(() => undefined);
  stop();
  return { kind: open.workspace.kind, seeded, ignoredSeeded, recordsGone: !existsSync(join(open.workspace.runRoot, RUN_FILE)), registrations: 0 };
};

/** Opens two runs on a repository; a discard takes the first apart and a sweep the second. */
const discardAndSweep: Lifecycle = async (fx, git, stop) => {
  const handles = [fx.start({ git }, 7), fx.start({ git }, 8)];
  const roots: string[] = [];
  for (const handle of handles) {
    const open = await handle.provider.open(handle.run, fx.repo);
    if (!open.ok) { stop(); return { recordsGone: roots.every(root => !existsSync(join(root, RUN_FILE))), registrations: 0 }; }
    roots.push(open.workspace.runRoot);
  }
  const [first, second] = handles as [ReturnType<GitFixture["start"]>, ReturnType<GitFixture["start"]>];
  const removable = new Set([first.run.runId, second.run.runId]);
  const cleaner = fx.start({ git, removable: async () => run => removable.has(run.runId) });
  await cleaner.provider.discard(new Map([[first.run.runId, { projectRoot: fx.repo, itemId: 7 }]]), () => false).catch(() => undefined);
  await cleaner.provider.sweep([], new Map([[second.run.runId, fx.repo]])).catch(() => undefined);
  stop();
  return { kind: "git", recordsGone: roots.every(root => !existsSync(join(root, RUN_FILE))), registrations: registrationsOf(fx) };
};

const LIFECYCLES = { "git run": gitRun, "folder in a repository": folderInRepo, "discard and sweep": discardAndSweep } as const;
type LifecycleName = keyof typeof LIFECYCLES;

/** Runs `name` on a fixture of its own, with git failing the call `fails` names in the way `kind` says. */
async function lifecycle(name: LifecycleName, fails: (call: string) => boolean, kind: FailureKind, reason: typeof THROWN[number] = "timeout", seen?: string[]): Promise<Outcome> {
  const fx = gitFixture();
  try {
    const real = createHostGit({ env: fx.env });
    const made = new Map<string, number>();
    const call = (signature: string): string => {
      const nth = (made.get(signature) ?? 0) + 1;
      made.set(signature, nth);
      const key = `${signature} #${nth}`;
      seen?.push(key);
      return key;
    };
    // Off once the lifecycle ends: the fixture's own release then takes apart what is left.
    let failing = true;
    const thrown = (): HostGitError => new HostGitError(reason, "fixture: no answer");
    const git: HostGit = {
      floorHolds: real.floorHolds,
      drivers: (cwd, worktree) => failing && fails(call("drivers")) ? Promise.reject(kind === "thrown" ? thrown() : new HostGitError("unavailable", "fixture: no answer")) : real.drivers(cwd, worktree),
      run: (cwd, args, options) => {
        if (!failing || !fails(call(signatureOf(args)))) return real.run(cwd, args, options);
        if (kind === "thrown") return Promise.reject(thrown());
        return Promise.resolve(kind === "exit 128" ? { code: 128, stdout: "", stderr: "fatal: fixture" } : { code: 1, stdout: "", stderr: "error: fixture" });
      },
    };
    return await LIFECYCLES[name](fx, git, () => { failing = false; });
  } finally {
    await fx.done();
  }
}

/** Every git call each lifecycle makes, by signature and how often it was made before: each may be the one whose answer is missing. */
export function controlCalls(): Promise<Record<LifecycleName, string[]>> {
  return Object.keys(LIFECYCLES).reduce(async (done, name) => {
    const calls = await done;
    const seen: string[] = [];
    const outcome = await lifecycle(name as LifecycleName, () => false, "exit 128", undefined, seen);
    expect(outcome, name).toMatchObject(name === "folder in a repository" ? { kind: "folder", seeded: true, ignoredSeeded: false } : name === "git run" ? { kind: "git", conflictFiles: 1, recordsGone: true, registrations: 0 } : { recordsGone: true, registrations: 0 });
    return { ...calls, [name]: seen.sort() };
  }, Promise.resolve({} as Record<LifecycleName, string[]>));
}

/** Registers a case for each listed call of each lifecycle, failing in the way `kind` says; a thrown failure takes each reason in turn. */
export function replayEach(kind: FailureKind, calls: Record<LifecycleName, readonly string[]>): void {
  const cases = (Object.entries(calls) as [LifecycleName, readonly string[]][]).flatMap(([name, list]) => list.map(failed => [name, failed] as const))
    .map(([name, failed], index) => ({ name, failed, reason: THROWN[index % THROWN.length] as typeof THROWN[number] }));
  it.each(cases)(`${kind}${kind === "thrown" ? " ($reason)" : ""} at $name, $failed: no repository's run becomes a plain folder's, no conflict one of no file, no ignored file is seeded, and no registration's record is lost`, async ({ name, failed, reason }) => {
    const outcome = await lifecycle(name, candidate => candidate === failed, kind, reason);
    if (name !== "folder in a repository") expect.soft(outcome.kind ?? "git").toBe("git");
    // A merge that git itself refused leaves no conflicted file to tell of; any other missing answer may not hide one.
    if (name === "git run" && !failed.startsWith("merge --no-edit")) expect.soft(outcome.conflictFiles ?? 1).toBeGreaterThan(0);
    expect.soft(outcome.ignoredSeeded ?? false).toBe(false);
    if (outcome.recordsGone) expect.soft(outcome.registrations).toBe(0);
  });
}

/** What `controlCalls` saw at the head this was pinned at; the control test fails when a lifecycle's calls change. */
export const CALLS: Record<LifecycleName, readonly string[]> = {
  "git run": [
    "add -A #1",
    "add -A #2",
    "check-attr -z --stdin #1",
    "commit -q --no-verify #1",
    "commit -q --no-verify #2",
    "config --file - #1",
    "config --file - #10",
    "config --file - #11",
    "config --file - #12",
    "config --file - #13",
    "config --file - #14",
    "config --file - #15",
    "config --file - #16",
    "config --file - #17",
    "config --file - #18",
    "config --file - #19",
    "config --file - #2",
    "config --file - #20",
    "config --file - #21",
    "config --file - #22",
    "config --file - #23",
    "config --file - #3",
    "config --file - #4",
    "config --file - #5",
    "config --file - #6",
    "config --file - #7",
    "config --file - #8",
    "config --file - #9",
    "config --get user.email #1",
    "config --get user.email #2",
    "config --get user.email #3",
    "config --get user.name #1",
    "config --get user.name #2",
    "config --get user.name #3",
    "diff --cached --name-only #1",
    "diff --cached --name-only #2",
    "diff --cached --quiet #1",
    "diff --cached --quiet #2",
    "diff --name-only -z #1",
    "diff --quiet --no-ext-diff #1",
    "drivers #1",
    "drivers #2",
    "drivers #3",
    "drivers #4",
    "drivers #5",
    "drivers #6",
    "drivers #7",
    "drivers #8",
    "drivers #9",
    "ls-files -z #1",
    "ls-files -z #2",
    "ls-files -z #3",
    "merge --abort #1",
    "merge --no-edit --no-stat #1",
    "merge --no-edit --no-stat #2",
    "merge-base --is-ancestor --end-of-options #1",
    "merge-base --is-ancestor --end-of-options #2",
    "reset --hard -q #1",
    "reset --hard -q #2",
    "reset --hard -q #3",
    "rev-parse --path-format=absolute --git-common-dir #1",
    "rev-parse --path-format=absolute --git-common-dir #10",
    "rev-parse --path-format=absolute --git-common-dir #11",
    "rev-parse --path-format=absolute --git-common-dir #12",
    "rev-parse --path-format=absolute --git-common-dir #13",
    "rev-parse --path-format=absolute --git-common-dir #14",
    "rev-parse --path-format=absolute --git-common-dir #15",
    "rev-parse --path-format=absolute --git-common-dir #16",
    "rev-parse --path-format=absolute --git-common-dir #17",
    "rev-parse --path-format=absolute --git-common-dir #18",
    "rev-parse --path-format=absolute --git-common-dir #19",
    "rev-parse --path-format=absolute --git-common-dir #2",
    "rev-parse --path-format=absolute --git-common-dir #20",
    "rev-parse --path-format=absolute --git-common-dir #21",
    "rev-parse --path-format=absolute --git-common-dir #22",
    "rev-parse --path-format=absolute --git-common-dir #23",
    "rev-parse --path-format=absolute --git-common-dir #3",
    "rev-parse --path-format=absolute --git-common-dir #4",
    "rev-parse --path-format=absolute --git-common-dir #5",
    "rev-parse --path-format=absolute --git-common-dir #6",
    "rev-parse --path-format=absolute --git-common-dir #7",
    "rev-parse --path-format=absolute --git-common-dir #8",
    "rev-parse --path-format=absolute --git-common-dir #9",
    "rev-parse --show-toplevel #1",
    "rev-parse --verify --end-of-options #1",
    "rev-parse --verify --end-of-options #2",
    "rev-parse --verify --quiet #1",
    "rev-parse --verify HEAD^{commit} #1",
    "rev-parse --verify HEAD^{commit} #2",
    "show-ref --exists MERGE_HEAD #1",
    "show-ref --exists MERGE_HEAD #2",
    "symbolic-ref -q HEAD #1",
    "update-ref --end-of-options * #1",
    "update-ref -d --end-of-options #1",
    "worktree add --detach #1",
    "worktree add --detach #2",
    "worktree add --no-checkout #1",
  ],
  "folder in a repository": [
    "check-ignore -z --stdin #1",
    "rev-parse --show-toplevel #1",
    "rev-parse --verify --quiet #1",
    "show-ref --exists * #1",
    "symbolic-ref -q HEAD #1",
  ],
  "discard and sweep": [
    "config --file - #1",
    "config --file - #10",
    "config --file - #11",
    "config --file - #12",
    "config --file - #13",
    "config --file - #14",
    "config --file - #2",
    "config --file - #3",
    "config --file - #4",
    "config --file - #5",
    "config --file - #6",
    "config --file - #7",
    "config --file - #8",
    "config --file - #9",
    "drivers #1",
    "drivers #2",
    "drivers #3",
    "drivers #4",
    "reset --hard -q #1",
    "reset --hard -q #2",
    "rev-parse --path-format=absolute --git-common-dir #1",
    "rev-parse --path-format=absolute --git-common-dir #10",
    "rev-parse --path-format=absolute --git-common-dir #11",
    "rev-parse --path-format=absolute --git-common-dir #12",
    "rev-parse --path-format=absolute --git-common-dir #13",
    "rev-parse --path-format=absolute --git-common-dir #14",
    "rev-parse --path-format=absolute --git-common-dir #2",
    "rev-parse --path-format=absolute --git-common-dir #3",
    "rev-parse --path-format=absolute --git-common-dir #4",
    "rev-parse --path-format=absolute --git-common-dir #5",
    "rev-parse --path-format=absolute --git-common-dir #6",
    "rev-parse --path-format=absolute --git-common-dir #7",
    "rev-parse --path-format=absolute --git-common-dir #8",
    "rev-parse --path-format=absolute --git-common-dir #9",
    "rev-parse --show-toplevel #1",
    "rev-parse --show-toplevel #2",
    "rev-parse --verify --quiet #1",
    "rev-parse --verify --quiet #2",
    "symbolic-ref -q HEAD #1",
    "symbolic-ref -q HEAD #2",
    "update-ref --end-of-options * #1",
    "update-ref --end-of-options * #2",
    "update-ref -d --end-of-options #1",
    "update-ref -d --end-of-options #2",
    "worktree add --no-checkout #1",
    "worktree add --no-checkout #2",
  ],
};
