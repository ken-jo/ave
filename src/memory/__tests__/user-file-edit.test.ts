import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { tmpdir } from "node:os";
import * as checkpoints from "../code-checkpoints.js";
import { availableReview as available, createProjectScope } from "../../__tests__/support/code-checkpoint-turn.js";

/** Text the person saves from the in-app editor, and what the checkpoints say about the file afterwards. */
let root: string;
let path: string;
let sessionId: string;
const context = createProjectScope(() => root);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const allowed = (): boolean => false;
const save = (expected: string, next: string, denied: (path: string) => boolean = allowed) =>
  checkpoints.saveUserFileEdit(path, sha(expected), Buffer.from(next), denied);
async function agentTurn(messageId: string, text: string) {
  await checkpoints.withCodeCheckpoint({ sessionId, messageId }, () =>
    checkpoints.checkpointFileMutation([{ path, content: text }], () => writeFile(path, text)));
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-user-edit-")));
  path = join(root, "notes.txt");
  sessionId = randomUUID();
  vi.stubEnv("AVE_HOME", join(root, "state"));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

describe("reading a file to edit", () => {
  it("returns the bytes and the hash a save must still find", async () => {
    await writeFile(path, "hello\n");
    const read = await checkpoints.readUserEditableFile(path);
    expect(read).toMatchObject({ ok: true, hash: sha("hello\n") });
    if (read.ok) expect(read.bytes.toString("utf8")).toBe("hello\n");
  });

  it("tells a missing file from one that cannot be edited in place", async () => {
    expect(await checkpoints.readUserEditableFile(path)).toEqual({ ok: false, error: "not-found" });
    await writeFile(path, "shared\n");
    await link(path, join(root, "second-name.txt"));
    expect(await checkpoints.readUserEditableFile(path)).toEqual({ ok: false, error: "not-editable" });
    await writeFile(join(root, "target.txt"), "x\n");
    await symlink(join(root, "target.txt"), join(root, "alias.txt"));
    expect(await checkpoints.readUserEditableFile(join(root, "alias.txt"))).toEqual({ ok: false, error: "not-editable" });
  });
});

describe("saving an edit", () => {
  it("replaces the file, keeps its mode and leaves no temporary file behind", async () => {
    await writeFile(path, "old\n");
    await chmod(path, 0o640);
    expect(await save("old\n", "new\n")).toEqual({ ok: true, hash: sha("new\n") });
    expect(await readFile(path, "utf8")).toBe("new\n");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readdir(root)).toEqual(expect.not.arrayContaining([expect.stringMatching(/^\.ave-restore-/u)]));
  });

  it("refuses when the file no longer holds what the edit started from, and writes nothing", async () => {
    await writeFile(path, "old\n");
    await writeFile(path, "changed elsewhere\n");
    expect(await save("old\n", "mine\n")).toEqual({ ok: false, error: "changed" });
    expect(await readFile(path, "utf8")).toBe("changed elsewhere\n");
  });

  it("refuses when the file was removed meanwhile instead of creating it again", async () => {
    expect(await save("old\n", "mine\n")).toEqual({ ok: false, error: "changed" });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a path the write guard denies", async () => {
    await writeFile(path, "old\n");
    expect(await save("old\n", "mine\n", () => true)).toEqual({ ok: false, error: "denied" });
    expect(await readFile(path, "utf8")).toBe("old\n");
  });

  it("refuses a file with a second hard link, which a replace would split from its other name", async () => {
    await writeFile(path, "old\n");
    await link(path, join(root, "second-name.txt"));
    expect(await save("old\n", "mine\n")).toEqual({ ok: false, error: "not-editable" });
    expect(await readFile(join(root, "second-name.txt"), "utf8")).toBe("old\n");
  });
});

describe("checkpoints after an edit", () => {
  it("keeps the covering turn truthful: the review shows the saved file and a rewind restores the turn's before-image", async () => {
    await writeFile(path, "one\ntwo\nthree\n");
    await agentTurn("latest", "one\nTWO\nthree\n");
    expect(await save("one\nTWO\nthree\n", "one\nTWO\nthree\nfour by hand\n")).toMatchObject({ ok: true });

    const review = available(await checkpoints.getTurnChangeReview(sessionId, "latest", context, { currentDetails: true }));
    expect(review.files).toHaveLength(1);
    expect(review.files[0].hunks.map((hunk) => hunk.newText).join("")).toContain("four by hand\n");
    expect(review.files[0]).toMatchObject({ added: 2, removed: 1, countsKnown: true });

    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("records nothing for a file no turn changed, and a rewind leaves the person's edit alone", async () => {
    const other = join(root, "agent.txt");
    await writeFile(other, "a\n");
    await writeFile(path, "mine\n");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () =>
      checkpoints.checkpointFileMutation([{ path: other, content: "b\n" }], () => writeFile(other, "b\n")));
    expect(await save("mine\n", "mine, edited\n")).toMatchObject({ ok: true });

    const review = available(await checkpoints.getTurnChangeReview(sessionId, "latest", context, { currentDetails: true }));
    expect(review.files.map((file) => file.path)).toEqual(["agent.txt"]);
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(other, "utf8")).toBe("a\n");
    expect(await readFile(path, "utf8")).toBe("mine, edited\n");
  });

  // The guard is asked at each check; its third call is the one made at the effect, after the ledger was saved.
  function atTheEffect(then: () => boolean): (path: string) => boolean {
    let calls = 0;
    return () => (++calls === 3 ? then() : false);
  }

  it("does not overwrite a file another program saved while the ledger was being written", async () => {
    await writeFile(path, "one\ntwo\n");
    await agentTurn("latest", "one\nTWO\n");
    const saved = await save("one\nTWO\n", "one\nTWO\nmine\n", atTheEffect(() => { writeFileSync(path, "saved by another program\n"); return false; }));
    expect(saved).toEqual({ ok: false, error: "changed" });
    expect(await readFile(path, "utf8")).toBe("saved by another program\n");
    expect(await readdir(root)).toEqual(expect.not.arrayContaining([expect.stringMatching(/^\.ave-restore-/u)]));
  });

  it("does not use a grant that was withdrawn while the ledger was being written, and puts the ledger back", async () => {
    await writeFile(path, "one\ntwo\n");
    await agentTurn("latest", "one\nTWO\n");
    expect(await save("one\nTWO\n", "one\nTWO\nmine\n", atTheEffect(() => true))).toEqual({ ok: false, error: "denied" });
    expect(await readFile(path, "utf8")).toBe("one\nTWO\n");
    // The turn's record describes the file that is still on disk: its review reads cleanly and a rewind is not refused.
    const review = available(await checkpoints.getTurnChangeReview(sessionId, "latest", context, { currentDetails: true }));
    expect(review.files[0]).toMatchObject({ added: 1, removed: 1, countsKnown: true });
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
  });

  it("does not use a grant withdrawn while the file was being read for the last check", async () => {
    await writeFile(path, "one\ntwo\n");
    await agentTurn("latest", "one\nTWO\n");
    // The third answer opens the last check, which then reads the file; the grant goes while that read is pending, so
    // only a question asked after the read, directly before the file is replaced, can see it.
    let calls = 0;
    let granted = true;
    const saved = await save("one\nTWO\n", "one\nTWO\nmine\n", () => {
      if (++calls === 3) queueMicrotask(() => { granted = false; });
      return !granted;
    });
    expect(saved).toEqual({ ok: false, error: "denied" });
    expect(calls).toBe(4);
    expect(await readFile(path, "utf8")).toBe("one\nTWO\n");
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
  });

  it("does not write through a folder that became a link while the ledger was being written", async () => {
    const folder = join(root, "notes");
    const elsewhere = join(root, "elsewhere");
    await mkdir(folder);
    await mkdir(elsewhere);
    const inside = join(folder, "a.txt");
    await writeFile(inside, "v1\n");
    await writeFile(join(elsewhere, "a.txt"), "v1\n");
    await checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () =>
      checkpoints.checkpointFileMutation([{ path: inside, content: "v2\n" }], () => writeFile(inside, "v2\n")));
    await writeFile(join(elsewhere, "a.txt"), "v2\n");
    const result = await checkpoints.saveUserFileEdit(inside, sha("v2\n"), Buffer.from("mine\n"), atTheEffect(() => {
      renameSync(folder, join(root, "notes-moved"));
      symlinkSync(elsewhere, folder);
      return false;
    }));
    expect(result.ok).toBe(false);
    expect(await readFile(join(elsewhere, "a.txt"), "utf8")).toBe("v2\n");
    expect(await readFile(join(root, "notes-moved", "a.txt"), "utf8")).toBe("v2\n");
  });

  it("gives a later turn the saved text as its before-image", async () => {
    await writeFile(path, "v1\n");
    expect(await save("v1\n", "v2 by hand\n")).toMatchObject({ ok: true });
    await agentTurn("latest", "v3 by agent\n");
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("v2 by hand\n");
  });

  it("waits for a tool's capture and write to finish, so an edit never lands between them", async () => {
    await writeFile(path, "start\n");
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const turn = checkpoints.withCodeCheckpoint({ sessionId, messageId: "latest" }, () =>
      checkpoints.checkpointFileMutation([{ path, content: "agent\n" }], async () => { entered(); await held; await writeFile(path, "agent\n"); }));
    await writing;
    // Started while the tool holds its section: it must see the tool's content, not the content it started from.
    const edit = save("start\n", "by hand\n");
    release();
    await turn;
    expect(await edit).toEqual({ ok: false, error: "changed" });
    expect(await readFile(path, "utf8")).toBe("agent\n");
    expect(await checkpoints.restoreCodeCheckpoint(sessionId, "latest", context)).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("start\n");
  });
});
