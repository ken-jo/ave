import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, unlink, link, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as checkpoints from "../code-checkpoints.js";
import type { TurnChangeReview, TurnReviewResult } from "../../shared/turn-change-review.js";
import * as accessPolicy from "../../tools/file-access-policy.js";

let root: string;
let path: string;
let sessionId: string;
const context = () => ({ cwd: root, extraAllowedDirectories: [] });
const ledgerPath = () => join(root, "state/code-checkpoints/turns.json");
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
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-turn-review-")));
  path = join(root, "source.txt");
  sessionId = randomUUID();
  vi.stubEnv("AVE_HOME", join(root, "state"));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("readonly latest turn change review", () => {
  it("returns relative exact-byte hunks and deterministic IDs without changing checkpoint storage or files", async () => {
    await tracked("before\r\n한글\r\nold", "after\r\n한글\r\nnew");
    const ledger = await readFile(ledgerPath(), "utf8");
    const names = await readdir(join(root, "state/code-checkpoints"));
    const initial = available(await review());
    expect(initial).toEqual(available(await review()));
    expect(initial).not.toHaveProperty("version");
    expect(initial.files[0]).toMatchObject({ path: "source.txt", bytes: Buffer.byteLength("after\r\n한글\r\nnew"), lineCount: 3, referenceable: true });
    expect(initial.files[0].hunks).toHaveLength(2);
    expect(initial.files[0].hunks[0]).toMatchObject({ oldText: "before\r\n", newText: "after\r\n", startLine: 1, endLine: 1 });
    expect(initial.files[0].hunks[0]).not.toHaveProperty("decision");
    expect(await readFile(ledgerPath(), "utf8")).toBe(ledger);
    expect(await readdir(join(root, "state/code-checkpoints"))).toEqual(names);
    expect(await readFile(path, "utf8")).toBe("after\r\n한글\r\nnew");
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("before\r\n한글\r\nold");
  });

  it("reads with file-reference scope even when write policy denies the file", async () => {
    await tracked("old", "new");
    const policy = vi.spyOn(accessPolicy, "ensureFileAccess").mockReturnValue({ isError: true, output: "denied" });
    expect(available(await review()).files[0].path).toBe("source.txt");
    expect(policy).not.toHaveBeenCalled();
  });

  it.each([[null, "created", true, 1], ["deleted", null, false, 0], [null, "", false, 0], ["", null, false, 0]] as const)("shows existence changes %s to %s without mutation", async (before, after, referenceable, lineCount) => {
    await tracked(before, after);
    expect(available(await review()).files[0]).toMatchObject({ path: "source.txt", referenceable, lineCount, bytes: Buffer.byteLength(after ?? ""), hunks: [{ oldText: before ?? "", newText: after ?? "" }] });
    if (after === null) await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(path, "utf8")).toBe(after);
  });

  it("combines continuous edits against the first original", async () => {
    await writeFile(path, "original");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, async () => { await edit("middle"); await edit("after"); });
    expect(available(await review()).files[0].hunks).toMatchObject([{ oldText: "original", newText: "after" }]);
  });

  it("omits edits whose final bytes equal the original", async () => {
    await writeFile(path, "original");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, async () => { await edit("middle"); await edit("original"); });
    expect(available(await review()).files).toEqual([]);
  });

  it("does not expose a current location after whole-file deletion", async () => {
    await tracked("first\nsecond\n", null);
    expect(available(await review()).files[0]).toMatchObject({ referenceable: false, lineCount: 0,
      hunks: [{ oldText: "first\nsecond\n", newText: "", startLine: 1, endLine: 1 }] });
  });

  it("refuses review while a tracked child can still change files", async () => {
    await tracked("old", "new");
    const release = await checkpoints.trackCodeCheckpointChild(sessionId);
    try { expect(await review()).toEqual({ ok: false, error: "turn-review-unavailable" }); }
    finally { release(); }
  });

  it("never selects an older changed turn when the latest has no changes", async () => {
    await tracked("old", "new");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "empty" }, async () => {});
    expect(await review()).toEqual({ ok: false, error: "turn-review-unavailable" });
    expect(available(await checkpoints.getTurnChangeReview(sessionId, "empty", context)).files).toEqual([]);
  });

  it("refuses missing, active and discontinuous turns", async () => {
    expect(await review()).toEqual({ ok: false, error: "turn-review-unavailable" });
    await writeFile(path, "before");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, async () => {
      await edit("middle");
      expect(await review()).toEqual({ ok: false, error: "turn-review-unavailable" });
      await writeFile(path, "external");
      await edit("after");
    });
    expect(await review()).toEqual({ ok: false, error: "turn-review-stale" });
  });

  it("refuses full-file divergence outside the changed lines", async () => {
    await tracked("old\nkeep\n", "new\nkeep\n");
    await writeFile(path, "new\nexternal\n");
    expect(await review()).toEqual({ ok: false, error: "turn-review-stale" });
  });

  it("refuses binary and invalid text without disclosing content", async () => {
    await writeFile(path, Buffer.from([255, 0, 65]));
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () => edit("after"));
    expect(await review()).toEqual({ ok: false, error: "turn-review-unavailable" });
  });

  it("does not disclose sensitive or out-of-workspace paths from a modified ledger", async () => {
    await tracked("old", "new");
    const original = await readFile(ledgerPath(), "utf8");
    for (const denied of [join(root, ".env"), join(root, "..", "outside.txt")]) {
      const ledger = JSON.parse(original);
      ledger.turns[0].changes[0].path = denied;
      await writeFile(ledgerPath(), JSON.stringify(ledger));
      expect(await review()).toEqual({ ok: false, error: "turn-review-unavailable" });
    }
  });

  it("refuses changed identity and revoked read scope", async () => {
    await tracked("old", "new");
    await link(path, join(root, "alias"));
    expect(await review()).toEqual({ ok: false, error: "turn-review-stale" });
    await unlink(join(root, "alias"));
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    expect(await checkpoints.getTurnChangeReview(sessionId, "latest", () => ({ cwd: elsewhere, extraAllowedDirectories: [] }))).toEqual({ ok: false, error: "turn-review-unavailable" });
  });

  it("rechecks scope after asynchronous capture work", async () => {
    await tracked("old", "new");
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    let calls = 0;
    expect(await checkpoints.getTurnChangeReview(sessionId, "latest", () => ({ cwd: ++calls > 2 ? elsewhere : root, extraAllowedDirectories: [] })))
      .toEqual({ ok: false, error: "turn-review-unavailable" });
  });

  it("does not quarantine or rewrite malformed review storage", async () => {
    await tracked("old", "new");
    await writeFile(ledgerPath(), "invalid ledger");
    const names = await readdir(join(root, "state/code-checkpoints"));
    expect(await review()).toEqual({ ok: false, error: "turn-review-failed" });
    expect(await readFile(ledgerPath(), "utf8")).toBe("invalid ledger");
    expect(await readdir(join(root, "state/code-checkpoints"))).toEqual(names);
  });
});
