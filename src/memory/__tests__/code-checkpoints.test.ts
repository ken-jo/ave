import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, symlink, link, stat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { checkpointFileMutation, isCodeCheckpointAvailable, markCodeCheckpointUnavailable, restoreCodeCheckpoint as restoreWithPolicy, withCodeCheckpoint, withRequiredCodeCheckpoint } from "../code-checkpoints.js";
import { CODE_CHECKPOINT_POLICY } from "../../shared/code-rewind.js";
import { ApplyPatchTool, DeleteFileTool, EditFileTool, MoveFileTool, MultiEditTool, ReadFileTool, WriteFileTool } from "../../tools/file-tools.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { createCodeCheckpointTurn } from "../../__tests__/support/code-checkpoint-turn.js";

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
const turn = createCodeCheckpointTurn(() => sessionId);
const restoreCodeCheckpoint = (session: string, message: string) => restoreWithPolicy(session, message, ctx);
async function read(path = file) { expect((await new ReadFileTool().execute({ path }, ctx)).isError).toBe(false); }
async function write(content: string, path = file) {
  expect((await new WriteFileTool().execute({ path, content }, ctx)).isError).toBe(false);
}

describe("native file-tool code checkpoints", () => {
  it("admits automatic writes only in an active healthy checkpoint turn", async () => {
    expect(await isCodeCheckpointAvailable([file])).toBe(false);
    await writeFile(file, "before");
    await turn("automatic", async () => {
      expect(await isCodeCheckpointAvailable([file, join(root, "new.txt")])).toBe(true);
      expect(await isCodeCheckpointAvailable([])).toBe(false);
      await withRequiredCodeCheckpoint(() => checkpointFileMutation([{ path: file, content: "after" }], () => writeFile(file, "after")));
      await markCodeCheckpointUnavailable();
      expect(await isCodeCheckpointAvailable([file])).toBe(false);
    });
    expect(await isCodeCheckpointAvailable([file])).toBe(false);
  });

  it("refuses automatic mutations when the turn loses checkpoint authority", async () => {
    const mutate = vi.fn(async () => {});
    await expect(withRequiredCodeCheckpoint(mutate)).rejects.toThrow("retry with explicit approval");
    await turn("revoked", async () => {
      expect(await isCodeCheckpointAvailable([file])).toBe(true);
      await withRequiredCodeCheckpoint(async () => {
        await markCodeCheckpointUnavailable();
        await expect(checkpointFileMutation([{ path: file, content: "after" }], mutate)).rejects.toThrow("retry with explicit approval");
      });
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refuses automatic writes with uncapturable originals", async () => {
    await writeFile(file, "before");
    const alias = join(root, "hard-link.txt");
    await link(file, alias);
    await turn("linked-original", async () => {
      expect(await isCodeCheckpointAvailable([file])).toBe(false);
      const mutate = vi.fn(() => writeFile(file, "after"));
      await expect(withRequiredCodeCheckpoint(() => checkpointFileMutation([{ path: file, content: "after" }], mutate))).rejects.toThrow("retry with explicit approval");
      expect(mutate).not.toHaveBeenCalled();
    });
    expect(await readFile(file, "utf8")).toBe("before");
  });

  it("does not allow a capture failure after automatic admission to mutate", async () => {
    await writeFile(file, "before");
    const mutate = vi.fn(() => writeFile(file, "after"));
    await turn("oversized-result", async () => {
      expect(await isCodeCheckpointAvailable([file])).toBe(true);
      await expect(withRequiredCodeCheckpoint(() => checkpointFileMutation([
        { path: file, content: Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes + 1) },
      ], mutate))).rejects.toThrow("retry with explicit approval");
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("before");
  });

  it("does not admit oversized originals or directories for automatic writes", async () => {
    await writeFile(file, Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes + 1));
    await turn("unsupported-original", async () => {
      expect(await isCodeCheckpointAvailable([file])).toBe(false);
      expect(await isCodeCheckpointAvailable([root])).toBe(false);
    });
  });

  it("requires fresh authority after checkpoint ledger corruption", async () => {
    const mutate = vi.fn(async () => {});
    await turn("corrupt-admission", async () => {
      expect(await isCodeCheckpointAvailable([file])).toBe(true);
      await writeFile(join(root, "state/code-checkpoints/turns.json"), "invalid JSON");
      expect(await isCodeCheckpointAvailable([file])).toBe(false);
      await expect(withRequiredCodeCheckpoint(() => checkpointFileMutation([{ path: file, content: "after" }], mutate))).rejects.toThrow("retry with explicit approval");
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("preserves the before-image hash race gate for automatic writes", async () => {
    await writeFile(file, "before");
    const mutate = vi.fn(() => writeFile(file, "agent"));
    await expect(turn("automatic-race", () => withRequiredCodeCheckpoint(() => checkpointFileMutation([{
      path: file,
      get content() { writeFileSync(file, "external"); return "agent"; },
    }], mutate)))).rejects.toThrow("File changed before checkpointed mutation");
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("external");
  });

  it("restores exact original bytes after edits across turns and reload", async () => {
    const original = Buffer.from("before\r\n한글\r\n");
    await writeFile(file, original);
    await turn("first", async () => {
      await read();
      expect((await new EditFileTool().execute({ path: file, oldText: "before", newText: "after" }, ctx)).isError).toBe(false);
    });
    await turn("second", async () => { await read(); await write("latest\n"); });
    expect(await restoreCodeCheckpoint(sessionId, "first")).toEqual({ ok: true });
    expect((await readFile(file)).equals(original)).toBe(true);
    expect(await restoreCodeCheckpoint(sessionId, "first")).toEqual({ ok: true });
  });

  it("refuses a mutation when an external write lands during checkpoint admission", async () => {
    await writeFile(file, "original");
    const mutate = vi.fn(() => writeFile(file, "agent"));
    await expect(turn("admission-race", () => checkpointFileMutation([{
      path: file,
      get content() { writeFileSync(file, "external"); return "agent"; },
    }], mutate))).rejects.toThrow("File changed before checkpointed mutation");
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("external");
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
    expect(ledger.turns[0].changes).toEqual([]);
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
    // Windows file symlinks need Developer Mode or elevation (EPERM); hard links do not.
    if (process.platform !== "win32") {
      await rm(file); await symlink(outside, file);
      expect(await restoreCodeCheckpoint(sessionId, "create")).toMatchObject({ ok: false, conflictingFiles: [file] });
      expect(await readFile(outside, "utf8")).toBe("outside");
    }
    await rm(file); await link(outside, file);
    expect(await restoreCodeCheckpoint(sessionId, "create")).toMatchObject({ ok: false, conflictingFiles: [file] });
  });

  it("refuses a changed ancestor and leaves its new target untouched", async () => {
    const parent = join(root, "parent"); const elsewhere = join(root, "elsewhere");
    await mkdir(parent); await mkdir(elsewhere);
    const target = join(parent, "file.txt");
    await turn("create", () => write("agent", target));
    await rm(parent, { recursive: true }); await writeFile(join(elsewhere, "file.txt"), "agent");
    // Junctions need no privilege on Windows; POSIX ignores the type.
    await symlink(elsewhere, parent, "junction");
    expect(await restoreCodeCheckpoint(sessionId, "create")).toMatchObject({ ok: false, conflictingFiles: [target] });
    expect(await readFile(join(elsewhere, "file.txt"), "utf8")).toBe("agent");
  });

  it("prunes oldest whole turns at the session cap and refuses a pruned boundary", async () => {
    for (let i = 0; i <= CODE_CHECKPOINT_POLICY.maxSessionTurns; i++) await turn(`turn-${i}`, async () => {});
    expect(await restoreCodeCheckpoint(sessionId, "turn-0")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    expect(await restoreCodeCheckpoint(sessionId, "turn-1")).toEqual({ ok: true });
    const path = join(root, "state/code-checkpoints/turns.json");
    expect((await stat(path)).size).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes);
    expect(JSON.parse(await readFile(path, "utf8")).turns).toHaveLength(CODE_CHECKPOINT_POLICY.maxSessionTurns);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("does not evict another conversation when only a session turn limit is exceeded", async () => {
    await turn("quiet-conversation", async () => {});
    const busySessionId = randomUUID();
    for (let i = 0; i <= CODE_CHECKPOINT_POLICY.maxSessionTurns; i++) {
      await withCodeCheckpoint({ sessionId: busySessionId, messageId: "busy-" + i }, async () => {});
    }
    expect(await restoreCodeCheckpoint(sessionId, "quiet-conversation")).toEqual({ ok: true });
    expect(await restoreCodeCheckpoint(busySessionId, "busy-0")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
    expect(await restoreCodeCheckpoint(busySessionId, "busy-1")).toEqual({ ok: true });
  });

  it("continues oversized effects with code restore unavailable", async () => {
    const mutate = vi.fn(async () => {});
    await turn("large", () => checkpointFileMutation([{ path: file, content: Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes + 1) }], mutate));
    expect(mutate).toHaveBeenCalledOnce();
    expect(await restoreCodeCheckpoint(sessionId, "large")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
  });

  it("reloads retained full-size before-images within the serialized byte cap", async () => {
    const original = Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes, 65);
    await writeFile(file, original);
    await turn("byte-cap", async () => {
      for (let i = 0; i < 5; i++) {
        const next = Buffer.from(original); next[0] = i;
        await checkpointFileMutation([{ path: file, content: next }], () => writeFile(file, next));
      }
    });
    expect((await readFile(file))[0]).toBe(4);
    expect((await stat(join(root, "state/code-checkpoints/turns.json"))).size).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes);
    expect(await restoreCodeCheckpoint(sessionId, "byte-cap")).toEqual({ ok: true });
    expect((await readFile(file)).equals(original)).toBe(true);
  }, 60_000);

  it("deletes an oversized original with code restore unavailable", async () => {
    const bytes = Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes + 1, 65);
    await writeFile(file, bytes);
    await turn("large-before", () => new DeleteFileTool().execute({ path: file }, ctx));
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await restoreCodeCheckpoint(sessionId, "large-before")).toEqual({ ok: false, error: "code-checkpoint-unavailable" });
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
