import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_ATTEMPTS } from "../../lib/transient-fs-lock-retry.js";

const faults = vi.hoisted(() => ({
  readCode: "", reads: 0, remainingReads: Infinity, readBarrier: undefined as Promise<void> | undefined,
  imageWrites: 0, failImage: false, failIndex: false, commitError: "",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const overrides = {
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (basename(String(args[0])) === "turns.json" && faults.readCode && faults.remainingReads-- > 0) {
        faults.reads += 1;
        await faults.readBarrier;
        throw Object.assign(new Error("ledger read failed"), { code: faults.readCode });
      }
      return actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (faults.failImage && /image-.*\.tmp$/.test(String(args[0])) && ++faults.imageWrites === 2) {
        throw Object.assign(new Error("image write failed"), { code: "ENOSPC" });
      }
      if (faults.failIndex && /turns\.json\..*\.tmp$/.test(String(args[0]))) {
        throw Object.assign(new Error("index write failed"), { code: "ENOSPC" });
      }
      return actual.open(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (faults.commitError && basename(String(args[1])).startsWith(faults.commitError)) {
        faults.commitError = "";
        throw Object.assign(new Error("commit durability failed"), { code: "ENOSPC" });
      }
    },
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
const retrySleep = vi.hoisted(() => ({ impl: undefined as ((ms: number) => Promise<void>) | undefined }));
vi.mock("../../shared/abortable-deadline.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shared/abortable-deadline.js")>(),
  sleep: async (ms: number) => retrySleep.impl?.(ms),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  promises: await import("node:fs/promises"),
}));

import { _pendingUnavailableCountForTest, checkpointFileMutation, decideTurnChangeHunk, deleteCodeCheckpoints, getTurnChangeReview, restoreCodeCheckpoint, withCodeCheckpoint } from "../code-checkpoints.js";
import { CODE_CHECKPOINT_POLICY } from "../../shared/code-rewind.js";
import { createCodeCheckpointEdit } from "../../__tests__/support/code-checkpoint-turn.js";

let root: string;
let file: string;
let ledger: string;
let sessionId: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-checkpoint-storage-")));
  vi.stubEnv("AVE_HOME", join(root, "state"));
  file = join(root, "source.txt");
  ledger = join(root, "state", "code-checkpoints", "turns.json");
  sessionId = randomUUID();
  Object.assign(faults, { readCode: "", reads: 0, remainingReads: Infinity, imageWrites: 0, failImage: false, failIndex: false });
  await writeFile(file, "original");
});
afterEach(async () => {
  faults.readCode = "";
  faults.failImage = false;
  faults.failIndex = false;
  faults.readBarrier = undefined;
  faults.commitError = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const turn = (messageId: string, run = async () => {}) => withCodeCheckpoint({ sessionId, messageId }, run);
const edit = createCodeCheckpointEdit(() => file);
const restore = (message: string) => restoreCodeCheckpoint(sessionId, message, { cwd: root, extraAllowedDirectories: [] });

describe("checkpoint storage recovery", () => {
  it("refuses review metadata failures before requesting a governed effect", async () => {
    await turn("review", () => edit("agent"));
    const context = () => ({ cwd: root, extraAllowedDirectories: [] });
    faults.failIndex = true;
    expect(await getTurnChangeReview(sessionId, "review", context)).toMatchObject({ ok: false, error: "turn-review-failed" });
    faults.failIndex = false;
    const result = await getTurnChangeReview(sessionId, "review", context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const execute = vi.fn(async () => ({ ok: true }));
    faults.failIndex = true;
    expect(await decideTurnChangeHunk({ sessionId, turnId: "review", version: result.review.version,
      hunkId: result.review.files[0].hunks[0].id, decision: "reject" }, context, execute)).toMatchObject({ ok: false, error: "turn-review-failed" });
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("agent");
  });

  it("retains an applied rejection journal when its decision save fails", async () => {
    await turn("review", () => edit("agent"));
    const context = () => ({ cwd: root, extraAllowedDirectories: [] });
    const result = await getTurnChangeReview(sessionId, "review", context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const execute = vi.fn(async (mutation: { path: string; content: string | null }) => {
      await checkpointFileMutation([mutation], () => writeFile(mutation.path, mutation.content!));
      faults.failIndex = true;
      return { ok: true };
    });
    expect(await decideTurnChangeHunk({ sessionId, turnId: "review", version: result.review.version,
      hunkId: result.review.files[0].hunks[0].id, decision: "reject" }, context, execute)).toMatchObject({ ok: false, error: "turn-review-failed" });
    expect(await readFile(file, "utf8")).toBe("original");
    expect(JSON.parse(await readFile(ledger, "utf8")).turns[0].review.pending).toBeDefined();
    faults.failIndex = false;
    const recovered = await getTurnChangeReview(sessionId, "review", context);
    expect(recovered.ok && recovered.review.files[0].hunks[0].decision).toBe("rejected");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not report accepted bookkeeping when its ledger save fails", async () => {
    await turn("review", () => edit("agent"));
    const context = () => ({ cwd: root, extraAllowedDirectories: [] });
    const result = await getTurnChangeReview(sessionId, "review", context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    faults.failIndex = true;
    const execute = vi.fn(async () => ({ ok: true }));
    expect(await decideTurnChangeHunk({ sessionId, turnId: "review", version: result.review.version,
      hunkId: result.review.files[0].hunks[0].id, decision: "accept" }, context, execute)).toMatchObject({ ok: false, error: "turn-review-failed" });
    expect(execute).not.toHaveBeenCalled();
    faults.failIndex = false;
    const recovered = await getTurnChangeReview(sessionId, "review", context);
    expect(recovered.ok && recovered.review.files[0].hunks[0].decision).toBe("pending");
  });

  it("bounds deferred turns during persistent read errors and persists unavailable ranges on recovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = randomUUID();
    await withCodeCheckpoint({ sessionId: other, messageId: "other" }, async () => {});
    await turn("old", () => edit("agent"));
    faults.readCode = "EACCES";
    const count = CODE_CHECKPOINT_POLICY.maxSessionTurns * 3;
    for (let i = 0; i < count; i++) await turn(`failed-${i}`, () => edit(`edit-${i}`));
    expect(_pendingUnavailableCountForTest(sessionId)).toBe(CODE_CHECKPOINT_POLICY.maxSessionTurns);
    faults.readCode = "";
    await turn("recovered");
    expect(_pendingUnavailableCountForTest(sessionId)).toBe(0);
    const history = JSON.parse(await readFile(ledger, "utf8"));
    const recovered = history.turns.filter((item: { sessionId: string }) => item.sessionId === sessionId);
    expect(recovered).toHaveLength(CODE_CHECKPOINT_POLICY.maxSessionTurns);
    const failed = recovered.filter((item: { messageId: string }) => item.messageId.startsWith("failed-"));
    expect(failed.map((item: { messageId: string }) => item.messageId)).toEqual(
      Array.from({ length: CODE_CHECKPOINT_POLICY.maxSessionTurns - 1 }, (_, i) => `failed-${count - CODE_CHECKPOINT_POLICY.maxSessionTurns + 1 + i}`),
    );
    expect(failed.every((item: { unavailable: boolean; changes: unknown[] }) => item.unavailable && item.changes.length === 0)).toBe(true);
    for (const message of ["old", "failed-0", `failed-${count - 1}`]) {
      expect(await restore(message)).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    }
    expect(await restore("recovered")).toEqual({ ok: true });
    expect(await restoreCodeCheckpoint(other, "other", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe(`edit-${count - 1}`);
    warn.mockRestore();
  });

  it("keeps deferred failures isolated by namespace and session and clears a deleted session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const other = randomUUID();
    await withCodeCheckpoint({ sessionId: other, messageId: "other" }, async () => {});
    faults.readCode = "EACCES";
    await turn("failed");
    expect(_pendingUnavailableCountForTest(sessionId)).toBe(1);
    vi.stubEnv("AVE_HOME", join(root, "alice"));
    expect(_pendingUnavailableCountForTest(sessionId)).toBe(0);
    faults.readCode = "";
    await turn("separate");
    vi.stubEnv("AVE_HOME", join(root, "state"));
    expect(_pendingUnavailableCountForTest(sessionId)).toBe(1);
    await deleteCodeCheckpoints(sessionId);
    expect(_pendingUnavailableCountForTest(sessionId)).toBe(0);
    expect(await restoreCodeCheckpoint(other, "other", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
  });

  it.skipIf(process.platform !== "win32")("can wait on a lock retry scheduled after an exhausted fake clock", async () => {
    await turn("seed");
    let release!: () => void;
    faults.readBarrier = new Promise<void>((resolve) => { release = resolve; });
    faults.readCode = "EBUSY";
    faults.remainingReads = 1;
    let sleeping!: () => void;
    const sleepStarted = new Promise<void>((resolve) => { sleeping = resolve; });
    vi.useFakeTimers();
    const sleep = vi.fn((ms: number) => {
      sleeping();
      return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
    });
    retrySleep.impl = sleep;
    let settled = false;
    const pending = turn("delayed").then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      release();
      await Promise.race([sleepStarted, pending]);
      expect(sleep).toHaveBeenCalled();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(settled).toBe(true);
    } finally {
      release();
      await vi.runAllTimersAsync();
      await pending;
      retrySleep.impl = undefined;
      vi.useRealTimers();
    }
  });

  it.each(["EBUSY", "EPERM", "EACCES", "EIO"])("preserves the ledger and permits the turn after a persistent %s read error", async (code) => {
    await turn("old", () => edit("agent"));
    const before = await readFile(ledger, "utf8");
    const warn = vi.spyOn(console, "warn");
    faults.readCode = code;
    await turn("unreadable", () => edit("new"));
    expect(await readFile(file, "utf8")).toBe("new");
    expect(await readFile(ledger, "utf8")).toBe(before);
    expect((await readdir(join(root, "state", "code-checkpoints"))).some((name) => name.endsWith(".bak"))).toBe(false);
    expect(faults.reads).toBeGreaterThanOrEqual(code === "EIO" || process.platform !== "win32" ? 1 : BACKGROUND_ATTEMPTS);
    expect(warn.mock.calls.flat().join(" ")).toContain("read error");
    faults.readCode = "";
    expect(await restore("unreadable")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    const history = JSON.parse(await readFile(ledger, "utf8"));
    expect(history.turns.some((item: { messageId: string }) => item.messageId === "old")).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("retries a short read lock without losing history or the current checkpoint", async () => {
    await turn("old", () => edit("agent"));
    faults.readCode = "EBUSY";
    faults.remainingReads = 1;
    await turn("retry", () => edit("new"));
    expect(faults.reads).toBe(1);
    expect(await restore("retry")).toEqual({ ok: true });
    expect(await restore("old")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("continues a mutation after a ledger read fails inside an admitted turn", async () => {
    await turn("old", () => edit("agent"));
    await turn("unreadable", async () => {
      const before = await readFile(ledger, "utf8");
      faults.readCode = "EBUSY";
      await edit("new");
      expect(await readFile(ledger, "utf8")).toBe(before);
      faults.readCode = "";
    });
    expect(await readFile(file, "utf8")).toBe("new");
    expect(await restore("unreadable")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    expect(JSON.parse(await readFile(ledger, "utf8")).turns.map((item: { messageId: string }) => item.messageId)).toEqual(["old", "unreadable"]);
  });

  it.each(["image", "index"])("keeps a failed legacy %s write retryable and removes its partial images", async (stage) => {
    await turn("seed");
    await writeFile(file, "agent");
    const original = Buffer.from("original").toString("base64");
    const legacy = JSON.stringify([{
      sessionId, messageId: "legacy", unavailable: false, consumed: false,
      changes: [file, join(root, "second.txt")].map((path) => ({ path, before: original, mode: 0o600,
        afterHash: createHash("sha256").update("agent").digest("hex") })),
    }]);
    await writeFile(join(root, "second.txt"), "agent");
    await writeFile(ledger, legacy);
    const warn = vi.spyOn(console, "warn");
    faults.failImage = stage === "image";
    faults.failIndex = stage === "index";
    faults.imageWrites = 0;
    await turn("failed", async () => {
      expect(await readFile(ledger, "utf8")).toBe(legacy);
      expect(await readdir(join(root, "state", "code-checkpoints"))).toEqual(["turns.json"]);
      faults.imageWrites = 0;
    });
    expect(await readFile(ledger, "utf8")).toBe(legacy);
    expect(await readdir(join(root, "state", "code-checkpoints"))).toEqual(["turns.json"]);
    expect(warn.mock.calls.flat().join(" ")).toContain("read error");
    faults.failImage = false;
    faults.failIndex = false;
    await turn("retry");
    expect(JSON.parse(await readFile(ledger, "utf8")).version).toBe(2);
    expect(await restore("failed")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    const recovered = JSON.parse(await readFile(ledger, "utf8")).turns[0];
    expect(recovered.messageId).toBe("legacy");
    expect(recovered.changes).toHaveLength(2);
    expect(JSON.parse(await readFile(join(root, "state", "code-checkpoints", recovered.changes[0].before), "utf8"))).toBe(original);
  });

  it.each(["image-", "turns.json"])("recovers a migration after a committed %s write reports a durability error", async (target) => {
    await turn("seed");
    const legacySession = randomUUID();
    const legacy = JSON.stringify([{
      sessionId: legacySession, messageId: "legacy", unavailable: false, consumed: false,
      changes: [{ path: file, before: Buffer.from("original").toString("base64"), mode: 0o600,
        afterHash: createHash("sha256").update("agent").digest("hex") }],
    }]);
    await writeFile(file, "agent");
    await writeFile(ledger, legacy);
    faults.commitError = target;
    await turn("failed", async () => {
      if (target === "image-") {
        expect(await readFile(ledger, "utf8")).toBe(legacy);
        expect(await readdir(join(root, "state", "code-checkpoints"))).toEqual(["turns.json"]);
      } else {
        const committed = JSON.parse(await readFile(ledger, "utf8"));
        const image = committed.turns[0].changes[0].before;
        expect(JSON.parse(await readFile(join(root, "state", "code-checkpoints", image), "utf8"))).toBe(Buffer.from("original").toString("base64"));
      }
    });
    expect(await restoreCodeCheckpoint(legacySession, "legacy", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("original");
  });
});
