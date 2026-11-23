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

/** Opens a run on a repository, seals two stages that conflict, joins them and releases the run, with git failing every call `fails` names. */
async function lifecycle(fx: GitFixture, fails: (signature: string) => boolean, seen?: Set<string>): Promise<{ kind?: string; conflictFiles?: number; recordGone: boolean; registrations: number }> {
  const real = createHostGit({ env: fx.env });
  // Off once the release ran: the fixture's own release then takes apart what is left.
  let failing = true;
  const git: HostGit = {
    drivers: (cwd, worktree) => failing && fails("drivers") ? Promise.reject(new Error("fixture: no answer")) : real.drivers(cwd, worktree),
    run: (cwd, args, call) => {
      const signature = signatureOf(args);
      seen?.add(signature);
      return failing && fails(signature) ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: fixture" }) : real.run(cwd, args, call);
    },
  };
  seen?.add("drivers");
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

it("no git call whose answer is missing makes a repository's run a plain folder's, a conflict one of no file, or its registrations lose their record", async () => {
  const seen = new Set<string>();
  const control = gitFixture();
  try {
    expect(await lifecycle(control, () => false, seen)).toEqual({ kind: "git", conflictFiles: 1, recordGone: true, registrations: 0 });
  } finally {
    await control.done();
  }
  for (const signature of seen) {
    const fx = gitFixture();
    try {
      const outcome = await lifecycle(fx, candidate => candidate === signature);
      expect.soft(outcome.kind ?? "git", signature).toBe("git");
      // A merge that git itself refused leaves no conflicted file to tell of; any other missing answer may not hide one.
      if (!signature.startsWith("merge --no-edit")) expect.soft(outcome.conflictFiles ?? 1, signature).toBeGreaterThan(0);
      if (outcome.recordGone) expect.soft(outcome.registrations, signature).toBe(0);
    } finally {
      await fx.done();
    }
  }
}, 600_000);
