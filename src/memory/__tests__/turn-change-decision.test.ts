import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as checkpoints from "../code-checkpoints.js";
import { parseTurnReviewDecision, type TurnReviewDecision } from "../../shared/turn-change-review.js";
import * as accessPolicy from "../../tools/file-access-policy.js";
import { availableReview as available, createCurrentTurnReview, createProjectScope } from "../../__tests__/support/code-checkpoint-turn.js";

/** Keep or undo the latest turn's changes per hunk, per file and per turn, on the checkpoint images. */
let root: string;
let path: string;
let sessionId: string;
const context = createProjectScope(() => root);
const review = createCurrentTurnReview(() => sessionId, context);
const decide = (decision: TurnReviewDecision) => checkpoints.decideTurnChange(sessionId, "latest", context, decision);
async function agentTurn(messageId: string, edits: Array<[string, string | null]>) {
  await checkpoints.withCodeCheckpoint({ sessionId, messageId }, async () => {
    for (const [target, text] of edits) {
      await checkpoints.checkpointFileMutation([{ path: target, content: text }], () => text === null ? unlink(target) : writeFile(target, text));
    }
  });
}
/** The checkpoint ledger this test's turns are saved in. */
function ledgerPath(): string {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "turns.json") found.push(join(dir, entry.name));
    }
  };
  walk(join(root, "state"));
  expect(found).toHaveLength(1);
  return found[0] as string;
}
const BEFORE = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
const AFTER = "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-turn-decision-")));
  path = join(root, "source.txt");
  sessionId = randomUUID();
  vi.stubEnv("AVE_HOME", join(root, "state"));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("undo", () => {
  it("writes back one hunk and leaves the other change and the rewind image as they were", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    const initial = available(await review()).files[0];
    expect(initial.hunks.map((hunk) => hunk.newText)).toEqual(["ONE\n", "EIGHT\n"]);
    expect(initial.decidable).toBe(true);

    const after = available(await decide({ action: "undo", scope: "hunk", path: "source.txt", hunkId: initial.hunks[0].id }));
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n");
    expect(after.files[0].hunks.map((hunk) => [hunk.oldText, hunk.newText])).toEqual([["eight\n", "EIGHT\n"]]);
    expect(after.files[0]).toMatchObject({ added: 1, removed: 1, countsKnown: true, decidable: true });

    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(BEFORE);
  });

  it("does not write back over a file another program saved while the ledger was being written", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    // The write guard is asked at each check; its third call is the one made at the effect, after the ledger was saved.
    let calls = 0;
    vi.spyOn(accessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 3) writeFileSync(path, "saved by another program\n");
      return null;
    });
    expect(await decide({ action: "undo", scope: "file", path: "source.txt" })).toEqual({ ok: false, error: "turn-review-stale" });
    expect(await readFile(path, "utf8")).toBe("saved by another program\n");
  });

  it("says an undo stopped part-way when a later file is refused, and keeps the record true for the file already undone", async () => {
    const second = join(root, "second.txt");
    await writeFile(path, BEFORE);
    await writeFile(second, "alpha\n");
    await agentTurn("latest", [[path, AFTER], [second, "beta\n"]]);
    // Two files are judged twice before the ledger is saved. At the effects the first file is asked about twice (the
    // fifth and sixth questions) and replaced; the seventh opens the second file's last check.
    let calls = 0;
    vi.spyOn(accessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 7) writeFileSync(second, "saved by another program\n");
      return null;
    });
    // Not an ordinary refusal: one file was already put back.
    expect(await decide({ action: "undo", scope: "turn" })).toEqual({ ok: false, error: "turn-review-partial" });
    vi.restoreAllMocks();
    expect(await readFile(path, "utf8")).toBe(BEFORE);
    expect(await readFile(second, "utf8")).toBe("saved by another program\n");
    // The first file's record describes it as it is: nothing is left of it to review.
    const after = available(await review());
    expect(after.files.map((file) => file.path)).not.toContain("source.txt");
    expect(await readdir(root)).toEqual(expect.not.arrayContaining([expect.stringMatching(/^\.ave-restore-/u)]));
  });

  it("still says an undo stopped part-way when the record cannot be put right afterwards", async () => {
    const second = join(root, "second.txt");
    await writeFile(path, BEFORE);
    await writeFile(second, "alpha\n");
    await agentTurn("latest", [[path, AFTER], [second, "beta\n"]]);
    // As above, the second file changes before its last check, after the first was put back; and the ledger can no longer
    // be written, because a folder now stands at its name.
    const ledger = ledgerPath();
    let calls = 0;
    vi.spyOn(accessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 7) {
        writeFileSync(second, "saved by another program\n");
        renameSync(ledger, `${ledger}.aside`);
        mkdirSync(join(ledger, "blocked"), { recursive: true });
      }
      return null;
    });
    try {
      expect(await decide({ action: "undo", scope: "turn" })).toEqual({ ok: false, error: "turn-review-partial" });
    } finally {
      vi.restoreAllMocks();
    }
    expect(await readFile(path, "utf8")).toBe(BEFORE);
    expect(await readFile(second, "utf8")).toBe("saved by another program\n");
  });

  it("says the undo happened when the review to answer with cannot be read after the file was put back", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    // The fourth question is the last one, directly before the file is replaced; the conversation moves on right after
    // it, so the undo happens and only the review read for the answer finds the conversation changed.
    let calls = 0;
    let current = true;
    vi.spyOn(accessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 4) current = false;
      return null;
    });
    const liveContext = () => {
      if (!current) throw new Error("turn-review-context-changed");
      return context();
    };
    expect(await checkpoints.decideTurnChange(sessionId, "latest", liveContext, { action: "undo", scope: "file", path: "source.txt" }))
      .toEqual({ ok: false, error: "turn-review-applied" });
    expect(calls).toBe(4);
    expect(await readFile(path, "utf8")).toBe(BEFORE);
  });

  it("answers a refusal that changed no file as a refusal, also for several files", async () => {
    const second = join(root, "second.txt");
    await writeFile(path, BEFORE);
    await writeFile(second, "alpha\n");
    await agentTurn("latest", [[path, AFTER], [second, "beta\n"]]);
    // The first file's own last check finds it changed, before anything was replaced.
    let calls = 0;
    vi.spyOn(accessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 5) writeFileSync(path, "saved by another program\n");
      return null;
    });
    expect(await decide({ action: "undo", scope: "turn" })).toEqual({ ok: false, error: "turn-review-stale" });
    expect(await readFile(second, "utf8")).toBe("beta\n");
  });

  it("does not undo once the conversation moved on while the file was being read for the last check", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    // The third question opens the last check and still finds the conversation current; it changes while that check
    // reads the file. Only a question asked after the read, directly before the file is replaced, can see it.
    let calls = 0;
    let current = true;
    vi.spyOn(accessPolicy, "ensureFileAccess").mockImplementation(() => {
      if (++calls === 3) queueMicrotask(() => { current = false; });
      return null;
    });
    const liveContext = () => {
      if (!current) throw new Error("turn-review-context-changed");
      return context();
    };
    expect(await checkpoints.decideTurnChange(sessionId, "latest", liveContext, { action: "undo", scope: "file", path: "source.txt" }))
      .toEqual({ ok: false, error: "turn-review-stale" });
    expect(await readFile(path, "utf8")).toBe(AFTER);
  });

  it("does not undo once the conversation has moved on while the ledger was being written", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    let calls = 0;
    let current = true;
    vi.spyOn(accessPolicy, "ensureFileAccess").mockImplementation(() => {
      // After the last check before the ledger is saved: the next question, at the effect, finds the conversation changed.
      if (++calls === 2) current = false;
      return null;
    });
    const liveContext = () => {
      if (!current) throw new Error("turn-review-context-changed");
      return context();
    };
    expect(await checkpoints.decideTurnChange(sessionId, "latest", liveContext, { action: "undo", scope: "file", path: "source.txt" }))
      .toEqual({ ok: false, error: "turn-review-stale" });
    expect(await readFile(path, "utf8")).toBe(AFTER);
    // The turn's record still describes the file on disk.
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(BEFORE);
  });

  it("removes the file from the review once every hunk is undone", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    let current = available(await review());
    while (current.files.length > 0) {
      current = available(await decide({ action: "undo", scope: "hunk", path: "source.txt", hunkId: current.files[0].hunks[0].id }));
    }
    expect(await readFile(path, "utf8")).toBe(BEFORE);
  });

  it("undoes a whole file and keeps its mode", async () => {
    await writeFile(path, BEFORE);
    await chmod(path, 0o640);
    await agentTurn("latest", [[path, AFTER]]);
    expect(available(await decide({ action: "undo", scope: "file", path: "source.txt" })).files).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(BEFORE);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it("removes a file the turn created and restores a file the turn deleted", async () => {
    const created = join(root, "created.txt");
    const deleted = join(root, "deleted.txt");
    await writeFile(deleted, "gone\n");
    await agentTurn("latest", [[created, "new\n"], [deleted, null]]);
    const initial = available(await review());
    const createdHunk = initial.files.filter((file) => file.path === "created.txt")[0].hunks[0];
    // A created file exists or not as a whole: undoing its one hunk removes it.
    await decide({ action: "undo", scope: "hunk", path: "created.txt", hunkId: createdHunk.id });
    await expect(readFile(created)).rejects.toMatchObject({ code: "ENOENT" });
    expect(available(await decide({ action: "undo", scope: "file", path: "deleted.txt" })).files).toEqual([]);
    expect(await readFile(deleted, "utf8")).toBe("gone\n");
  });

  it("undoes every file of the turn at once", async () => {
    const other = join(root, "other.txt");
    await writeFile(path, BEFORE);
    await writeFile(other, "a\n");
    await agentTurn("latest", [[path, AFTER], [other, "b\n"]]);
    expect(available(await decide({ action: "undo", scope: "turn" })).files).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(BEFORE);
    expect(await readFile(other, "utf8")).toBe("a\n");
  });

  it("refuses when the file changed since the turn and writes nothing", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    const hunkId = available(await review()).files[0].hunks[0].id;
    await writeFile(path, `${AFTER}changed outside\n`);
    expect(await decide({ action: "undo", scope: "hunk", path: "source.txt", hunkId })).toEqual({ ok: false, error: "turn-review-stale" });
    expect(await decide({ action: "undo", scope: "turn" })).toEqual({ ok: false, error: "turn-review-stale" });
    expect(await readFile(path, "utf8")).toBe(`${AFTER}changed outside\n`);
  });

  it("refuses a hunk the current review does not contain", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    expect(await decide({ action: "undo", scope: "hunk", path: "source.txt", hunkId: "0".repeat(64) })).toEqual({ ok: false, error: "turn-review-stale" });
    expect(await readFile(path, "utf8")).toBe(AFTER);
  });

  it("refuses when the write policy denies the file, and changes neither the file nor the review", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    const before = available(await review());
    vi.spyOn(accessPolicy, "ensureFileAccess").mockReturnValue({ isError: true, output: "denied" });
    expect(await decide({ action: "undo", scope: "file", path: "source.txt" })).toEqual({ ok: false, error: "turn-review-write-denied" });
    vi.restoreAllMocks();
    vi.stubEnv("AVE_HOME", join(root, "state"));
    expect(await readFile(path, "utf8")).toBe(AFTER);
    expect(available(await review())).toEqual(before);
  });

  it("keeps the checkpoint chain intact for the next turn and for a rewind across both turns", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("first", [[path, AFTER]]);
    const first = await checkpoints.getTurnChangeReview(sessionId, "first", context, { currentDetails: true });
    await checkpoints.decideTurnChange(sessionId, "first", context, { action: "undo", scope: "hunk", path: "source.txt", hunkId: available(first).files[0].hunks[0].id });
    const undone = await readFile(path, "utf8");
    await agentTurn("latest", [[path, `${undone}nine\n`]]);
    expect(available(await review()).files[0].hunks.map((hunk) => hunk.newText)).toEqual(["nine\n"]);
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "first", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(BEFORE);
  });
});

describe("keep", () => {
  it("marks one hunk kept without writing, and it stays kept when another hunk is undone", async () => {
    await writeFile(path, BEFORE);
    await agentTurn("latest", [[path, AFTER]]);
    const initial = available(await review()).files[0];
    const kept = available(await decide({ action: "keep", scope: "hunk", path: "source.txt", hunkId: initial.hunks[1].id }));
    expect(kept.files[0].hunks.map((hunk) => hunk.kept)).toEqual([false, true]);
    expect(await readFile(path, "utf8")).toBe(AFTER);
    // Undoing the first hunk shifts nothing the kept hunk is anchored on.
    const after = available(await decide({ action: "undo", scope: "hunk", path: "source.txt", hunkId: kept.files[0].hunks[0].id }));
    expect(after.files[0].hunks).toHaveLength(1);
    expect(after.files[0].hunks[0]).toMatchObject({ newText: "EIGHT\n", kept: true });
    expect(available(await review()).files[0].hunks[0].kept).toBe(true);
  });

  it("keeps a whole file and a whole turn", async () => {
    const other = join(root, "other.txt");
    await writeFile(path, BEFORE);
    await writeFile(other, "a\n");
    await agentTurn("latest", [[path, AFTER], [other, "b\n"]]);
    const file = available(await decide({ action: "keep", scope: "file", path: "source.txt" }));
    expect(file.files.map((entry) => entry.hunks.every((hunk) => hunk.kept))).toEqual([true, false]);
    const turn = available(await decide({ action: "keep", scope: "turn" }));
    expect(turn.files.every((entry) => entry.hunks.every((hunk) => hunk.kept))).toBe(true);
    expect(await readFile(path, "utf8")).toBe(AFTER);
    // Keeping is a review mark; the rewind image is untouched.
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe(BEFORE);
  });
});

describe("parseTurnReviewDecision", () => {
  it("accepts exactly the three scopes and refuses everything else", () => {
    const hunkId = "a".repeat(64);
    const turnId = "turn-1";
    expect(parseTurnReviewDecision({ action: "undo", scope: "hunk", path: "a.ts", hunkId, turnId, extra: 1 })).toEqual({ action: "undo", scope: "hunk", path: "a.ts", hunkId, turnId });
    expect(parseTurnReviewDecision({ action: "keep", scope: "file", path: "a.ts", turnId })).toEqual({ action: "keep", scope: "file", path: "a.ts", turnId });
    expect(parseTurnReviewDecision({ action: "keep", scope: "turn", path: "ignored", turnId })).toEqual({ action: "keep", scope: "turn", turnId });
    // A decision that does not name the reviewed turn is refused, whatever its scope.
    for (const unbound of [{ action: "keep", scope: "turn" }, { action: "undo", scope: "file", path: "a.ts" }, { action: "undo", scope: "hunk", path: "a.ts", hunkId },
      { action: "undo", scope: "turn", turnId: "" }, { action: "undo", scope: "turn", turnId: 7 }]) {
      expect(parseTurnReviewDecision(unbound)).toBeNull();
    }
    for (const bad of [null, "undo", {}, { action: "delete", scope: "turn", turnId }, { action: "undo", scope: "file", turnId }, { action: "undo", scope: "file", path: "", turnId },
      { action: "undo", scope: "hunk", path: "a.ts", hunkId: "nope", turnId }, { action: "undo", scope: "line", path: "a.ts", turnId }]) {
      expect(parseTurnReviewDecision(bad)).toBeNull();
    }
  });
});
