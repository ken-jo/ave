import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, symlink, link, stat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { checkpointFileMutation, markCodeCheckpointUnavailable, restoreCodeCheckpoint, withCodeCheckpoint } from "../code-checkpoints.js";
import { CODE_CHECKPOINT_POLICY } from "../../shared/code-rewind.js";
import { ApplyPatchTool, DeleteFileTool, EditFileTool, MoveFileTool, MultiEditTool, ReadFileTool, WriteFileTool } from "../../tools/file-tools.js";
import type { ToolExecutionContext } from "../../tools/types.js";

let root: string;
let file: string;
let sessionId: string;
let ctx: ToolExecutionContext;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-code-rewind-")));
  file = join(root, "source.txt");
  sessionId = randomUUID();
  ctx = { cwd: root, extraAllowedDirectories: [], metadata: { sessionId } };
  vi.stubEnv("AVE_HOME", join(root, "state"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const turn = <T>(messageId: string, run: () => Promise<T>) => withCodeCheckpoint({ sessionId, messageId }, run);
async function read(path = file) { expect((await new ReadFileTool().execute({ path }, ctx)).isError).toBe(false); }
async function write(content: string, path = file) {
  expect((await new WriteFileTool().execute({ path, content }, ctx)).isError).toBe(false);
}

describe("native file-tool code checkpoints", () => {
  it("restores exact original bytes after edits across turns and reload", async () => {
    const original = Buffer.from("before\r\n한글\r\n");
    await writeFile(file, original);
    await turn("first", async () => {
      await read();
      expect((await new EditFileTool().execute({ path: file, oldText: "before", newText: "after" }, ctx)).isError).toBe(false);
    });
    await turn("second", async () => { await read(); await write("latest\n"); });
    // Restore reads persisted state rather than requiring an active turn.
    expect(await restoreCodeCheckpoint(sessionId, "first")).toEqual({ ok: true });
    expect((await readFile(file)).equals(original)).toBe(true);
    expect(await restoreCodeCheckpoint(sessionId, "first")).toEqual({ ok: true });
  });

  it("keeps restored baselines guarded against later external edits", async () => {
    await writeFile(file, "original");
    await turn("restored", async () => { await read(); await write("agent"); });
    expect(await restoreCodeCheckpoint(sessionId, "restored")).toEqual({ ok: true });
    await writeFile(file, "external after restore");
    expect(await restoreCodeCheckpoint(sessionId, "restored")).toEqual({ ok: false, error: "code-restore-conflict", conflictingFiles: [file] });
    expect(await readFile(file, "utf8")).toBe("external after restore");
  });

  it("refuses consumed later checkpoints while earlier and new turns remain usable", async () => {
    await writeFile(file, "original");
    await turn("one", async () => { await read(); await write("first"); });
    await turn("two", async () => { await read(); await write("second"); });
    await turn("three", async () => { await read(); await write("third"); });
    expect(await restoreCodeCheckpoint(sessionId, "two")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("first");
    expect(await restoreCodeCheckpoint(sessionId, "three")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    await turn("four", async () => { await read(); await write("new work"); });
    expect(await restoreCodeCheckpoint(sessionId, "four")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("first");
    expect(await restoreCodeCheckpoint(sessionId, "one")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("original");
    expect(await restoreCodeCheckpoint(sessionId, "two")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
  });

  it("deletes created files without deleting unrelated shell-created files", async () => {
    const shellFile = join(root, "shell-created.txt");
    await turn("create", async () => { await write("created"); await writeFile(shellFile, "untracked bash effect"); });
    expect(await restoreCodeCheckpoint(sessionId, "create")).toEqual({ ok: true });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(shellFile, "utf8")).toBe("untracked bash effect");
  });

  it("refuses all files before mutation when an external writer changes any target", async () => {
    const second = join(root, "second.txt");
    await writeFile(file, "original");
    await turn("edit", async () => { await read(); await write("agent"); await write("new", second); });
    await writeFile(file, "external");
    expect(await restoreCodeCheckpoint(sessionId, "edit")).toEqual({ ok: false, error: "code-restore-conflict", conflictingFiles: [file] });
    expect(await readFile(file, "utf8")).toBe("external");
    expect(await readFile(second, "utf8")).toBe("new");
  });

  it("detects an external change between two native edits even when the last hash matches", async () => {
    await writeFile(file, "initial");
    await turn("one", async () => { await read(); await write("first edit"); });
    await writeFile(file, "external intermediate");
    await turn("two", async () => { await read(); await write("last edit"); });
    expect(await restoreCodeCheckpoint(sessionId, "one")).toMatchObject({ ok: false, conflictingFiles: [file] });
    expect(await restoreCodeCheckpoint(sessionId, "two")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("external intermediate");
  });

  it("does not claim bash-only edits as tracked file edits", async () => {
    await writeFile(file, "before shell");
    await turn("bash", async () => {
      if (process.platform === "win32") {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", 'Set-Content -LiteralPath $env:AVE_REWIND_TEST_FILE -Value "after shell" -NoNewline'], { env: { ...process.env, AVE_REWIND_TEST_FILE: file } });
      } else {
        execFileSync("/bin/bash", ["-c", 'printf %s "after shell" > "$1"', "shell", file]);
      }
    });
    expect(await restoreCodeCheckpoint(sessionId, "bash")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("after shell");
    const ledger = JSON.parse(await readFile(join(root, "state/code-checkpoints/turns.json"), "utf8"));
    expect(ledger[0].changes).toEqual([]);
  });

  it("restores multi-edit, patch add/delete/move and deleted binary bytes", async () => {
    await writeFile(file, "alpha beta\n");
    const binary = join(root, "binary.bin");
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    await writeFile(binary, bytes);
    await turn("patch", async () => {
      await read();
      expect((await new MultiEditTool().execute({ path: file, replacements: [{ oldText: "alpha", newText: "updated" }] }, ctx)).isError).toBe(false);
      expect((await new ApplyPatchTool().execute({ patch: "*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n-updated beta\n+patched beta\n*** Add File: added.txt\n+new\n*** End Patch" }, ctx)).isError).toBe(false);
      expect((await new DeleteFileTool().execute({ path: binary }, ctx)).isError).toBe(false);
    });
    expect(await restoreCodeCheckpoint(sessionId, "patch")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("alpha beta\n");
    expect(await readFile(binary)).toEqual(bytes);
    await expect(readFile(join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores move source and overwritten destination", async () => {
    const destination = join(root, "destination.txt");
    await writeFile(file, "source"); await writeFile(destination, "destination");
    await turn("move", async () => {
      expect((await new MoveFileTool().execute({ sourcePath: file, destinationPath: destination, overwrite: true }, ctx)).isError).toBe(false);
    });
    expect(await restoreCodeCheckpoint(sessionId, "move")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("source");
    expect(await readFile(destination, "utf8")).toBe("destination");
  });

  it("refuses externally deleted or replaced files, including links", async () => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside");
    await turn("create", () => write("agent"));
    await rm(file); await symlink(outside, file);
    expect(await restoreCodeCheckpoint(sessionId, "create")).toMatchObject({ ok: false, conflictingFiles: [file] });
    expect(await readFile(outside, "utf8")).toBe("outside");
    await rm(file); await link(outside, file);
    expect(await restoreCodeCheckpoint(sessionId, "create")).toMatchObject({ ok: false, conflictingFiles: [file] });
  });

  it("refuses a changed ancestor and leaves its new target untouched", async () => {
    const parent = join(root, "parent"); const elsewhere = join(root, "elsewhere");
    await mkdir(parent); await mkdir(elsewhere);
    const target = join(parent, "file.txt");
    await turn("create", () => write("agent", target));
    await rm(parent, { recursive: true }); await writeFile(join(elsewhere, "file.txt"), "agent");
    await symlink(elsewhere, parent);
    expect(await restoreCodeCheckpoint(sessionId, "create")).toMatchObject({ ok: false, conflictingFiles: [target] });
    expect(await readFile(join(elsewhere, "file.txt"), "utf8")).toBe("agent");
  });

  it("prunes oldest whole turns at the session cap and refuses a pruned boundary", async () => {
    for (let i = 0; i <= CODE_CHECKPOINT_POLICY.maxSessionTurns; i++) await turn(`turn-${i}`, async () => {});
    expect(await restoreCodeCheckpoint(sessionId, "turn-0")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    expect(await restoreCodeCheckpoint(sessionId, "turn-1")).toEqual({ ok: true });
    const path = join(root, "state/code-checkpoints/turns.json");
    expect((await stat(path)).size).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(CODE_CHECKPOINT_POLICY.maxSessionTurns);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses oversized images before the mutation happens", async () => {
    const mutate = vi.fn(async () => {});
    await expect(turn("large", () => checkpointFileMutation([{ path: file, content: Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes + 1) }], mutate))).rejects.toThrow("limit");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("enforces the serialized byte cap before mutation and reloads full-size before-images", async () => {
    const original = Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes, 65);
    await writeFile(file, original);
    await turn("byte-cap", async () => {
      for (let i = 0; i < 5; i++) {
        const next = Buffer.from(original); next[0] = i;
        await checkpointFileMutation([{ path: file, content: next }], () => writeFile(file, next));
      }
      const refused = Buffer.from(original); refused[0] = 99;
      await expect(checkpointFileMutation([{ path: file, content: refused }], () => writeFile(file, refused))).rejects.toThrow("storage limit");
    });
    expect((await readFile(file))[0]).toBe(4);
    expect((await stat(join(root, "state/code-checkpoints/turns.json"))).size).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes);
    expect(await restoreCodeCheckpoint(sessionId, "byte-cap")).toEqual({ ok: true });
    expect((await readFile(file)).equals(original)).toBe(true);
  }, 60_000);

  it("refuses an oversized before-image and keeps the existing file", async () => {
    const bytes = Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes + 1, 65);
    await writeFile(file, bytes);
    await expect(turn("large-before", () => new DeleteFileTool().execute({ path: file }, ctx))).rejects.toThrow("size limit");
    expect((await readFile(file)).equals(bytes)).toBe(true);
  });

  it("does not retain a failed no-op move as a file change", async () => {
    const destination = join(root, "existing.txt");
    await writeFile(file, "source"); await writeFile(destination, "destination");
    await turn("failed-move", async () => {
      expect((await new MoveFileTool().execute({ sourcePath: file, destinationPath: destination }, ctx)).isError).toBe(true);
    });
    expect(await restoreCodeCheckpoint(sessionId, "failed-move")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("source");
    expect(await readFile(destination, "utf8")).toBe("destination");
  });

  it("does not overwrite another session's edits or claim unsupported routes", async () => {
    await turn("one", () => write("first"));
    const otherSession = randomUUID();
    await withCodeCheckpoint({ sessionId: otherSession, messageId: "other" }, async () => { await read(); await write("other"); });
    expect(await restoreCodeCheckpoint(sessionId, "one")).toMatchObject({ ok: false, conflictingFiles: [file] });
    await turn("remote", markCodeCheckpointUnavailable);
    expect(await restoreCodeCheckpoint(sessionId, "remote")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
  });
});
