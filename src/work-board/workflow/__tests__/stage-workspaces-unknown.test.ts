import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHostGit, type HostGit } from "../host-git.js";
import { RUN_FILE } from "../workspace-layout.js";
import { writeUnder as write } from "./stage-fixtures.js";
import { type GitFixture, gitFixture, sealed, stageRoot } from "./stage-git-fixture.js";

vi.mock("../../../lib/logger.js", () => {
  const quiet = (): void => undefined;
  return { createLogger: () => ({ warn: quiet, info: quiet, debug: quiet, error: quiet }) };
});

/** A git call by its command and leading switches, values that differ from run to run left out. */
const signatureOf = (args: readonly string[]): string => args.slice(0, 3).map(arg => /^[0-9a-f]{40}$|[/\\:]|^Collect /u.test(arg) ? "*" : arg).join(" ");

/** Every git call the lifecycle makes, by signature and how often it was made before: each may be the one whose answer is missing. */
const CALLS: readonly string[] = [
  "add -A #1",
  "add -A #2",
  "commit -q --no-verify #1",
  "commit -q --no-verify #2",
  "config --file * #1",
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
  "rev-parse --verify --quiet #2",
  "rev-parse --verify --quiet #3",
  "rev-parse --verify HEAD^{commit} #1",
  "rev-parse --verify HEAD^{commit} #2",
  "symbolic-ref -q HEAD #1",
  "update-ref --end-of-options * #1",
  "update-ref -d --end-of-options #1",
  "worktree add --detach #1",
  "worktree add --detach #2",
  "worktree add --no-checkout #1",
];

/** Opens a run on a repository, seals two stages that conflict, joins them and releases the run, with git failing the call `fails` names. */
async function lifecycle(fx: GitFixture, fails: (call: string) => boolean, seen?: string[]): Promise<{ kind?: string; conflictFiles?: number; recordGone: boolean; registrations: number }> {
  const real = createHostGit({ env: fx.env });
  const made = new Map<string, number>();
  const call = (signature: string): string => {
    const nth = (made.get(signature) ?? 0) + 1;
    made.set(signature, nth);
    const key = `${signature} #${nth}`;
    seen?.push(key);
    return key;
  };
  // Off once the release ran: the fixture's own release then takes apart what is left.
  let failing = true;
  const git: HostGit = {
    drivers: (cwd, worktree) => failing && fails(call("drivers")) ? Promise.reject(new Error("fixture: no answer")) : real.drivers(cwd, worktree),
    run: (cwd, args, options) => failing && fails(call(signatureOf(args))) ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: fixture" }) : real.run(cwd, args, options),
  };
  const handle = fx.start({ git });
  const open = await handle.provider.open(handle.run, fx.repo);
  if (!open.ok) { failing = false; return { recordGone: true, registrations: 0 }; }
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
  failing = false;
  const admin = join(fx.repo, ".git", "worktrees");
  return { kind: open.workspace.kind, ...(conflictFiles === undefined ? {} : { conflictFiles }), recordGone: !existsSync(join(open.workspace.runRoot, RUN_FILE)), registrations: existsSync(admin) ? readdirSync(admin).length : 0 };
}

it("the lifecycle makes exactly the git calls listed, so a new one is replayed failing too", async () => {
  const seen: string[] = [];
  const control = gitFixture();
  try {
    expect(await lifecycle(control, () => false, seen)).toEqual({ kind: "git", conflictFiles: 1, recordGone: true, registrations: 0 });
  } finally {
    await control.done();
  }
  expect([...seen].sort()).toEqual([...CALLS].sort());
});

it.each(CALLS)("a missing answer to %s makes no repository's run a plain folder's, no conflict one of no file, and loses no registration's record", async (failed) => {
  const fx = gitFixture();
  try {
    const outcome = await lifecycle(fx, candidate => candidate === failed);
    expect.soft(outcome.kind ?? "git").toBe("git");
    // A merge that git itself refused leaves no conflicted file to tell of; any other missing answer may not hide one.
    if (!failed.startsWith("merge --no-edit")) expect.soft(outcome.conflictFiles ?? 1).toBeGreaterThan(0);
    if (outcome.recordGone) expect.soft(outcome.registrations).toBe(0);
  } finally {
    await fx.done();
  }
});
