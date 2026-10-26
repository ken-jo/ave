import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile, unlink, link, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as checkpoints from "../code-checkpoints.js";
import type { TurnChangeReview, TurnReviewResult } from "../../shared/turn-change-review.js";

let root: string;
let path: string;
let sessionId: string;
const context = () => ({ cwd: root, extraAllowedDirectories: [] });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const ledgerPath = () => join(root, "state/code-checkpoints/turns.json");
const loadLedger = async () => JSON.parse(await readFile(ledgerPath(), "utf8"));
const review = () => checkpoints.getTurnChangeReview(sessionId, "latest", context);
function available(result: TurnReviewResult): TurnChangeReview {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.review;
}
async function edit(text: string | null) {
  await checkpoints.checkpointFileMutation([{ path, content: text }], () => text === null ? unlink(path) : writeFile(path, text));
}
async function tracked(before: string | null, after: string | null) {
  if (before !== null) await writeFile(path, before);
  await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () => edit(after));
}
const execute = vi.fn(async (mutation: { path: string; content: string | null }) => {
  expect(checkpoints.isCodeReviewMutationActive()).toBe(true);
  checkpoints.validateCodeReviewToolInvocation(mutation.content === null ? "delete_file" : "write_file", mutation);
  await checkpoints.checkpointFileMutation([mutation], () => mutation.content === null ? unlink(mutation.path) : writeFile(mutation.path, mutation.content));
  return { ok: true };
});
function decide(current: TurnChangeReview, index: number, decision: "accept" | "reject" = "reject", run = execute) {
  return checkpoints.decideTurnChangeHunk({ sessionId, turnId: "latest", version: current.version,
    hunkId: current.files[0].hunks[index].id, decision }, context, run);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-turn-review-")));
  path = join(root, "source.txt");
  sessionId = randomUUID();
  vi.stubEnv("AVE_HOME", join(root, "state"));
  execute.mockClear();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("latest turn change review", () => {
  it("rejects independent exact-byte hunks and retains accepted changes across reload", async () => {
    await tracked("before\r\n한글\r\nold", "after\r\n한글\r\nnew");
    const initial = available(await review());
    expect(initial.files[0].hunks).toHaveLength(2);
    expect(initial.files[0].hunks[0]).toMatchObject({ oldText: "before\r\n", newText: "after\r\n" });
    const accepted = available(await decide(initial, 1, "accept"));
    expect(execute).not.toHaveBeenCalled();
    const rejected = available(await decide(accepted, 0));
    expect(await readFile(path, "utf8")).toBe("before\r\n한글\r\nnew");
    expect(available(await review())).toEqual(rejected);
    expect(rejected.files[0].hunks.map((hunk) => hunk.decision)).toEqual(["rejected", "accepted"]);
    expect(await decide(initial, 0)).toMatchObject({ ok: false, error: "turn-review-stale" });
    expect(await decide(rejected, 0)).toMatchObject({ ok: false, error: "turn-review-stale" });
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("before\r\n한글\r\nold");
  });

  it.each([[null, "created"], ["deleted", null], [null, ""], ["", null]] as const)("reverses existence changes %s to %s", async (before, after) => {
    await tracked(before, after);
    await decide(available(await review()), 0);
    if (before === null) await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(path, "utf8")).toBe(before);
  });

  it("refuses full-file divergence outside the changed lines", async () => {
    await tracked("old\nkeep\n", "new\nkeep\n");
    const initial = available(await review());
    await writeFile(path, "new\nexternal\n");
    expect(await decide(initial, 0)).toEqual({ ok: false, error: "turn-review-conflict", conflictingFiles: [path] });
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("new\nexternal\n");
  });

  it("checks the entire current file before first materialization", async () => {
    await tracked("old", "new");
    await writeFile(path, "external");
    expect(await review()).toMatchObject({ ok: false, error: "turn-review-conflict" });
    expect((await loadLedger()).turns[0].review).toBeUndefined();
  });

  it("never selects an older changed turn when the latest has no changes", async () => {
    await tracked("old", "new");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "empty" }, async () => {});
    expect(await review()).toMatchObject({ ok: false, error: "turn-review-unavailable" });
    expect(available(await checkpoints.getTurnChangeReview(sessionId, "empty", context)).files).toEqual([]);
  });

  it("refuses in-flight turns, missing turns and gapped edit chains", async () => {
    expect(await review()).toMatchObject({ ok: false, error: "turn-review-unavailable" });
    await writeFile(path, "before");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, async () => {
      await edit("middle");
      expect(await review()).toMatchObject({ ok: false, error: "turn-review-unavailable" });
      await writeFile(path, "external");
      await edit("after");
    });
    expect(await review()).toMatchObject({ ok: false, error: "turn-review-conflict" });
  });

  it("refuses binary and invalid text without disclosing content", async () => {
    await writeFile(path, Buffer.from([255, 0, 65]));
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () => edit("after"));
    expect(await review()).toMatchObject({ ok: false, error: "turn-review-unavailable" });
  });

  it("does not disclose sensitive paths from a modified ledger", async () => {
    await tracked("old", "new");
    const ledger = await loadLedger();
    ledger.turns[0].changes[0].path = join(root, ".env");
    await writeFile(ledgerPath(), JSON.stringify(ledger));
    expect(await review()).toEqual({ ok: false, error: "turn-review-write-denied" });
  });

  it("refuses hard-linked replacement files", async () => {
    await tracked("old", "new");
    const initial = available(await review());
    await link(path, join(root, "alias"));
    expect(await decide(initial, 0)).toMatchObject({ ok: false, error: "turn-review-conflict" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects altered hook effects and changed content at the effect boundary", async () => {
    await tracked("old", "new");
    const initial = available(await review());
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      expect(() => checkpoints.validateCodeReviewToolInvocation("write_file", { ...mutation, content: "altered" })).toThrow();
      expect(() => checkpoints.validateCodeReviewToolInvocation("edit_file", mutation)).toThrow();
      await writeFile(path, "external");
      await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      return { ok: true };
    });
    expect(await decide(initial, 0, "reject", run)).toMatchObject({ ok: false, error: "turn-review-conflict" });
    expect(await readFile(path, "utf8")).toBe("external");
  });

  it("reconciles an applied journal after a callback failure without replaying writes", async () => {
    await tracked("old", "new");
    const initial = available(await review());
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      throw new Error("Interrupted after effect");
    });
    expect(await decide(initial, 0, "reject", run)).toMatchObject({ ok: false, error: "turn-review-failed" });
    const resumed = available(await review());
    expect(resumed.files[0].hunks[0].decision).toBe("rejected");
    expect((await loadLedger()).turns[0].changes[0].afterHash).toBe(digest("old"));
    expect(run).toHaveBeenCalledOnce();
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
  });

  it("reconciles an applied rejection directly before an earlier rewind", async () => {
    await writeFile(path, "original");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "earlier" }, () => edit("middle"));
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () => edit("after"));
    const initial = available(await review());
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      throw new Error("Interrupted after effect");
    });
    expect(await decide(initial, 0, "reject", run)).toMatchObject({ ok: false });
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "earlier", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("original");
    expect((await loadLedger()).turns.every((item: { review?: unknown }) => item.review === undefined)).toBe(true);
  });

  it.each([true, false])("reconciles an interrupted rejection before a later authorized edit, applied=%s", async (applied) => {
    await tracked("original", "middle");
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      if (applied) await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      throw new Error("Interrupted decision");
    });
    expect(await decide(available(await review()), 0, "reject", run)).toMatchObject({ ok: false });
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "later" }, () => edit("later"));
    expect(available(await checkpoints.getTurnChangeReview(sessionId, "later", context)).files).toHaveLength(1);
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("original");
  });

  it("retains original mode for a governed deletion reversal", async () => {
    await writeFile(path, "original");
    await chmod(path, 0o755);
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () => edit(null));
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      expect(checkpoints.getCodeReviewReplacementMode(path)).toBe(0o755);
      expect(() => checkpoints.getCodeReviewReplacementMode(join(root, "other"))).toThrow();
      await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      return { ok: true };
    });
    expect((await decide(available(await review()), 0, "reject", run)).ok).toBe(true);
    expect(checkpoints.getCodeReviewReplacementMode(path)).toBeUndefined();
  });

  it("rechecks revoked write scope at the guarded effect boundary", async () => {
    await tracked("old", "new");
    const initial = available(await review());
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    let cwd = root;
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      cwd = elsewhere;
      await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      return { ok: true };
    });
    expect(await checkpoints.decideTurnChangeHunk({ sessionId, turnId: "latest", version: initial.version,
      hunkId: initial.files[0].hunks[0].id, decision: "reject" }, () => ({ cwd, extraAllowedDirectories: [] }), run))
      .toEqual({ ok: false, error: "turn-review-write-denied" });
    expect(await readFile(path, "utf8")).toBe("new");
  });

  it("reports an unknown post-effect outcome without claiming nothing changed", async () => {
    await tracked("old", "new");
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      await writeFile(path, "external after rejection");
      return { ok: true };
    });
    expect(await decide(available(await review()), 0, "reject", run)).toEqual({ ok: false, error: "turn-review-failed" });
    expect(await readFile(path, "utf8")).toBe("external after rejection");
  });

  it("serializes a competing decision and revokes inherited guards after the callback settles", async () => {
    await tracked("old", "new");
    const initial = available(await review());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let inheritedCheck: (() => Promise<void>) | undefined;
    const run = vi.fn(async (mutation: { path: string; content: string | null }) => {
      const { AsyncResource } = await import("node:async_hooks");
      const inherited = new AsyncResource("review-effect");
      inheritedCheck = () => inherited.runInAsyncScope(async () => {
        await expect(checkpoints.verifyCodeReviewMutation(path)).rejects.toThrow();
        inherited.emitDestroy();
      });
      entered();
      await barrier;
      await checkpoints.checkpointFileMutation([mutation], () => writeFile(path, mutation.content!));
      return { ok: true };
    });
    const first = decide(initial, 0, "reject", run);
    await started;
    const second = decide(initial, 0, "accept");
    release();
    expect((await first).ok).toBe(true);
    expect(await second).toEqual({ ok: false, error: "turn-review-stale" });
    await inheritedCheck!();
    expect(await readFile(path, "utf8")).toBe("old");
  });

  it("refuses a guard snapshot that completes after its callback settles", async () => {
    await tracked("old", "new");
    let lateVerify: Promise<string> | undefined;
    const run = vi.fn(async () => {
      lateVerify = checkpoints.verifyCodeReviewMutation(path).then(() => "allowed", () => "denied");
      return { ok: false };
    });
    expect((await decide(available(await review()), 0, "reject", run)).ok).toBe(false);
    expect(await lateVerify).toBe("denied");
    expect(await readFile(path, "utf8")).toBe("new");
  });

  it("clears an unapplied journal and refuses a divergent journal without retry", async () => {
    await tracked("old", "new");
    const initial = available(await review());
    expect(await decide(initial, 0, "reject", vi.fn(async () => ({ ok: false })))).toMatchObject({ ok: false });
    expect(available(await review()).files[0].hunks[0].decision).toBe("pending");
    const run = vi.fn(async () => { await writeFile(path, "external"); return { ok: false }; });
    expect(await decide(initial, 0, "reject", run)).toMatchObject({ ok: false });
    expect(await review()).toMatchObject({ ok: false, error: "turn-review-conflict" });
    expect(run).toHaveBeenCalledOnce();
  });
});
