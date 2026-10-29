import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalFileEvidence } from "../../main/terminal/changed-file-evidence.js";
import { checkpointFileMutation, markCodeCheckpointUnavailable, withCodeCheckpoint } from "../code-checkpoints.js";
import { copyPath } from "../../tools/guarded-file-transfer.js";
import { MoveFileTool, WriteFileTool } from "../../tools/file-tools.js";
import type { ToolExecutionContext } from "../../tools/types.js";

let directory: string;
let sessionId: string;
let context: ToolExecutionContext;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ave-write-provenance-")));
  sessionId = randomUUID();
  context = { cwd: directory, extraAllowedDirectories: [], metadata: { sessionId } };
  vi.stubEnv("AVE_HOME", join(directory, "state"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const turn = <T>(run: () => Promise<T>) => withCodeCheckpoint({ sessionId, messageId: randomUUID() }, run);
const snapshot = () => terminalFileEvidence.snapshot(directory, []);

describe("successful native mutation provenance", () => {
  it("records a successful native file write with real original bytes", async () => {
    const path = join(directory, "run.sh");
    await writeFile(path, "before\n");
    await turn(() => checkpointFileMutation([{ path, content: "after\n" }], () => writeFile(path, "after\n")));
    expect((await snapshot()).files.find(file => file.path === path)).toMatchObject({ sessionIds: [sessionId], diff: { before: "before\n", after: "after\n" } });
  });

  it("does not attribute failed mutations", async () => {
    const path = join(directory, "run.sh");
    await writeFile(path, "before\n");
    await expect(turn(() => checkpointFileMutation([{ path, content: "after\n" }], async () => { throw new Error("write refused"); }))).rejects.toThrow("write refused");
    expect((await snapshot()).files).toEqual([]);
  });

  it("does not attribute an explicit refused result", async () => {
    const path = join(directory, "run.sh");
    await writeFile(path, "before\n");
    await turn(() => checkpointFileMutation([{ path, content: "after\n" }], async () => ({ isError: true })));
    expect((await snapshot()).files).toEqual([]);
  });

  it("records mutations even when restore checkpoints are unavailable", async () => {
    const path = join(directory, "run.sh");
    await turn(async () => {
      await markCodeCheckpointUnavailable();
      await checkpointFileMutation([{ path, content: "created\n" }], () => writeFile(path, "created\n"));
    });
    expect((await snapshot()).files.find(file => file.path === path)?.diff).toEqual({ before: "", after: "created\n" });
  });

  it("records real tool writes outside a restore turn and ignores rejected overwrites", async () => {
    const path = join(directory, "run.sh");
    expect((await new WriteFileTool().execute({ path, content: "created\n" }, context)).isError).toBe(false);
    expect((await snapshot()).files.find(file => file.path === path)?.diff).toEqual({ before: "", after: "created\n" });
    const unknown = join(directory, "user.sh");
    await writeFile(unknown, "user\n");
    expect((await new WriteFileTool().execute({ path: unknown, content: "refused\n" }, context)).isError).toBe(true);
    expect((await snapshot()).files.some(file => file.path === unknown)).toBe(false);
  });

  it("records successful rename destinations at the native move chokepoint", async () => {
    const sourcePath = join(directory, "old.sh");
    const destinationPath = join(directory, "new.sh");
    await writeFile(sourcePath, "source\n");
    expect((await new MoveFileTool().execute({ sourcePath, destinationPath }, context)).isError).toBe(false);
    expect((await snapshot()).files.find(file => file.path === destinationPath)?.sessionIds).toEqual([sessionId]);
  });

  it("retains changed-file history across deletion and restoration", async () => {
    const path = join(directory, "run.sh");
    await turn(async () => {
      await checkpointFileMutation([{ path, content: "agent\n" }], () => writeFile(path, "agent\n"));
      await checkpointFileMutation([{ path, content: null }], () => unlink(path));
    });
    expect((await snapshot()).files.find(file => file.path === path)?.hash).toBe("missing");
    await writeFile(path, "restored\n");
    expect((await snapshot()).files.find(file => file.path === path)?.diff).toEqual({ before: "", after: "restored\n" });
  });

  it("attributes each successful owned transfer file without inferring directory descendants", async () => {
    const sourcePath = join(directory, "source.sh");
    const destinationPath = join(directory, "copied.sh");
    await writeFile(sourcePath, "copied bytes\n");
    expect((await copyPath({ sourcePath, destinationPath }, context)).ok).toBe(true);
    expect((await snapshot()).files.find(file => file.path === destinationPath)).toMatchObject({ sessionIds: [sessionId], diff: { before: "", after: "copied bytes\n" } });
  });

  it("does not manufacture concrete evidence for unreported subprocess effects", async () => {
    const path = join(directory, "unreported.sh");
    await turn(() => writeFile(path, "unreported\n"));
    expect((await snapshot()).files).toEqual([]);
  });
});
