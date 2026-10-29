import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkpointFileMutation, isCodeCheckpointAvailable, restoreCodeCheckpoint, trackCodeCheckpointChild, withCodeCheckpoint } from "../code-checkpoints.js";

let root: string;
let file: string;
let sessionId: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-checkpoint-children-")));
  vi.stubEnv("AVE_HOME", join(root, "state"));
  file = join(root, "source.txt");
  sessionId = randomUUID();
  await writeFile(file, "original");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const edit = (messageId: string, content: string) => withCodeCheckpoint({ sessionId, messageId }, () =>
  checkpointFileMutation([{ path: file, content }], () => writeFile(file, content)));
const restore = (messageId: string) => restoreCodeCheckpoint(sessionId, messageId, { cwd: root, extraAllowedDirectories: [] });
const unavailable = { ok: false, error: "code-checkpoint-unavailable" };

describe("checkpoint origin child count", () => {
  it("does not release another live child when a release is repeated", async () => {
    await edit("before", "agent");
    const releaseFirst = await trackCodeCheckpointChild(sessionId);
    const releaseSecond = await trackCodeCheckpointChild(sessionId);
    try {
      releaseFirst();
      releaseFirst();
      expect(await restore("before")).toEqual(unavailable);
      await edit("overlap", "overlap");
      expect(await restore("overlap")).toEqual(unavailable);
    } finally { releaseSecond(); }
    await edit("after", "after");
    expect(await restore("after")).toEqual({ ok: true });
  });

  it("blocks existing restore points without an in-flight parent and restores after the child ends", async () => {
    await edit("before", "agent");
    const release = await trackCodeCheckpointChild(sessionId);
    try { expect(await restore("before")).toEqual(unavailable); }
    finally { release(); }
    expect(await restore("before")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("keeps the session blocked until both children end and isolates other sessions", async () => {
    await edit("before", "agent");
    const releaseFirst = await trackCodeCheckpointChild(sessionId);
    const releaseSecond = await trackCodeCheckpointChild(sessionId);
    releaseFirst();
    try {
      const other = randomUUID();
      await withCodeCheckpoint({ sessionId: other, messageId: "other" }, async () => {});
      expect(await restoreCodeCheckpoint(other, "other", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
      await edit("overlap", "overlap");
      expect(await restore("overlap")).toEqual(unavailable);
    } finally { releaseSecond(); }
    expect(await restore("overlap")).toEqual(unavailable);
    await edit("after", "after");
    expect(await restore("after")).toEqual({ ok: true });
  });

  it("downgrades a parent already in flight when a child starts", async () => {
    await withCodeCheckpoint({ sessionId, messageId: "active" }, async () => {
      expect(await isCodeCheckpointAvailable([file])).toBe(true);
      await checkpointFileMutation([{ path: file, content: "agent" }], () => writeFile(file, "agent"));
      const release = await trackCodeCheckpointChild(sessionId);
      expect(await isCodeCheckpointAvailable([file])).toBe(false);
      release();
      expect(await isCodeCheckpointAvailable([file])).toBe(false);
    });
    expect(await restore("active")).toEqual(unavailable);
    await withCodeCheckpoint({ sessionId, messageId: "after-child" }, async () => {
      expect(await isCodeCheckpointAvailable([file])).toBe(true);
    });
  });
});
