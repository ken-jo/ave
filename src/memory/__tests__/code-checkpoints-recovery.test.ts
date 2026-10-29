import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { checkpointFileMutation, markCodeCheckpointUnavailable, restoreCodeCheckpoint as restoreWithPolicy, withCodeCheckpoint } from "../code-checkpoints.js";
import { MemoryManager } from "../memory-manager.js";
import { CODE_CHECKPOINT_POLICY } from "../../shared/code-rewind.js";
import { createCodeCheckpointEdit, createCodeCheckpointTurn } from "../../__tests__/support/code-checkpoint-turn.js";

let root: string;
let file: string;
let sessionId: string;
let storage: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-checkpoint-recovery-")));
  file = join(root, "source.txt");
  storage = join(root, "state", "code-checkpoints");
  sessionId = randomUUID();
  vi.stubEnv("AVE_HOME", join(root, "state"));
  await writeFile(file, "original");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const turn = createCodeCheckpointTurn(() => sessionId);
const edit = createCodeCheckpointEdit(() => file);
const restoreCodeCheckpoint = (session: string, message: string, context = { cwd: root, extraAllowedDirectories: [] }) => restoreWithPolicy(session, message, context);
const unavailable = { ok: false, error: "code-checkpoint-unavailable" };

describe("checkpoint recovery and retention", () => {
  it("marks the dispatching parent even when a child task has no inherited async context", async () => {
    const detached = new AsyncResource("child-dispatch");
    try {
      await turn("dispatch", () => detached.runInAsyncScope(() => markCodeCheckpointUnavailable(sessionId)));
      expect(await restoreCodeCheckpoint(sessionId, "dispatch")).toEqual(unavailable);
    } finally { detached.emitDestroy(); }
  });

  it.each(["symlink", "hardlink", "oversized"] as const)("continues an authorized edit with an uncapturable %s original", async (kind) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      if (kind === "symlink") {
        const target = join(root, "target.txt");
        await writeFile(target, "original");
        await rm(file);
        await symlink(target, file);
      } else if (kind === "hardlink") await link(file, join(root, "alias.txt"));
      else await writeFile(file, Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes + 1));
      await turn("uncapturable", () => edit());
      expect(await readFile(file, "utf8")).toBe("agent");
      expect(await restoreCodeCheckpoint(sessionId, "uncapturable")).toEqual(unavailable);
      expect(warn.mock.calls.flat().join(" ")).toContain("uncapturable original");
    } finally { warn.mockRestore(); }
  });

  it.each(["syntax", "schema"])("quarantines a %s damaged ledger and admits the next turn", async (kind) => {
    await turn("old", () => edit());
    const ledger = join(storage, "turns.json");
    const corrupt = kind === "syntax" ? "{" : "{}";
    await writeFile(ledger, corrupt);
    await turn("new", () => edit("next"));
    expect(await restoreCodeCheckpoint(sessionId, "old")).toEqual(unavailable);
    expect(await restoreCodeCheckpoint(sessionId, "new")).toEqual({ ok: true });
    const backup = (await readdir(storage)).find((name) => name.startsWith("turns.json.corrupt-"))!;
    expect(await readFile(join(storage, backup), "utf8")).toBe(corrupt);
  });

  it.skipIf(process.platform === "win32")("quarantines a ledger with public mode bits without trusting its checkpoints", async () => {
    await turn("old", () => edit());
    await chmod(join(storage, "turns.json"), 0o644);
    await turn("new", async () => {});
    expect(await restoreCodeCheckpoint(sessionId, "old")).toEqual(unavailable);
    expect((await stat(join(storage, "turns.json"))).mode & 0o777).toBe(0o600);
    const backup = (await readdir(storage)).find((name) => name.startsWith("turns.json.corrupt-"))!;
    expect((await stat(join(storage, backup))).mode & 0o777).toBe(0o600);
  });

  it("protects an in-flight turn from another session's global turn pressure", async () => {
    await mkdir(storage, { recursive: true });
    const turns = Array.from({ length: CODE_CHECKPOINT_POLICY.maxTurns }, (_, i) => ({
      sessionId: i === 0 ? sessionId : randomUUID(), messageId: "active", unavailable: false, consumed: false, changes: [],
    }));
    await writeFile(join(storage, "turns.json"), JSON.stringify(turns), { mode: 0o600 });
    await turn("active", async () => {
      await withCodeCheckpoint({ sessionId: randomUUID(), messageId: "pressure" }, async () => {});
      await edit();
    });
    expect(await restoreCodeCheckpoint(sessionId, "active")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("continues edits and refuses the range after its in-flight record disappears", async () => {
    await turn("earlier", async () => {});
    await turn("lost", async () => {
      await writeFile(join(storage, "turns.json"), "[]");
      await edit();
    });
    expect(await readFile(file, "utf8")).toBe("agent");
    expect(await restoreCodeCheckpoint(sessionId, "lost")).toEqual(unavailable);
    expect(await restoreCodeCheckpoint(sessionId, "earlier")).toEqual(unavailable);
  });

  it("invalidates surviving session history when only the in-flight record disappears", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await turn("earlier", () => edit("first"));
      const other = randomUUID();
      await withCodeCheckpoint({ sessionId: other, messageId: "unrelated" }, async () => {});
      await turn("lost", async () => {
        const ledger = JSON.parse(await readFile(join(storage, "turns.json"), "utf8"));
        ledger.turns = ledger.turns.filter((item: { messageId: string }) => item.messageId !== "lost");
        await writeFile(join(storage, "turns.json"), JSON.stringify(ledger));
        await edit("second");
      });
      const ledger = JSON.parse(await readFile(join(storage, "turns.json"), "utf8"));
      expect(ledger.turns.find((item: { messageId: string }) => item.messageId === "earlier").unavailable).toBe(true);
      expect(await restoreCodeCheckpoint(sessionId, "earlier")).toEqual(unavailable);
      expect(await restoreCodeCheckpoint(other, "unrelated")).toEqual({ ok: true });
      expect(warn.mock.calls.flat().join(" ")).toContain("pruned record");
    } finally { warn.mockRestore(); }
  });

  it("retains quarantined index images until the backup is deleted", async () => {
    await turn("old", () => edit());
    const ledger = JSON.parse(await readFile(join(storage, "turns.json"), "utf8"));
    const image = ledger.turns[0].changes[0].before;
    ledger.version = 3;
    await writeFile(join(storage, "turns.json"), JSON.stringify(ledger));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await turn("new", async () => {});
      expect(JSON.parse(await readFile(join(storage, image), "utf8"))).toBe(Buffer.from("original").toString("base64"));
      expect(warn.mock.calls.flat().join(" ")).toContain("quarantine");
      const backup = (await readdir(storage)).find((name) => name.endsWith(".bak"))!;
      await rm(join(storage, backup));
      await turn("sweep", async () => {});
      expect(await readdir(storage)).not.toContain(image);
    } finally { warn.mockRestore(); }
  });

  it("protects an in-flight restore range from global byte pressure", async () => {
    const original = Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes, 65);
    await writeFile(file, original);
    await mkdir(storage, { recursive: true });
    const changes = [{ path: file, before: original.toString("base64"), mode: 0o600,
      afterHash: createHash("sha256").update(original).digest("hex") }];
    await writeFile(join(storage, "turns.json"), JSON.stringify(Array.from({ length: 5 }, (_, i) => ({
      sessionId: i === 0 ? sessionId : randomUUID(), messageId: "active", unavailable: false, consumed: false, changes,
    }))), { mode: 0o600 });
    await turn("active", async () => {
      const pressure = join(root, "pressure.txt");
      await writeFile(pressure, original);
      await withCodeCheckpoint({ sessionId: randomUUID(), messageId: "pressure" }, () =>
        checkpointFileMutation([{ path: pressure, content: "pressure" }], () => writeFile(pressure, "pressure")));
      await edit();
    });
    expect(await restoreCodeCheckpoint(sessionId, "active")).toEqual({ ok: true });
    expect(await readFile(file)).toEqual(original);
  }, 60_000);

  it("continues when pinned originals cannot fit and makes the turn unavailable", async () => {
    const original = Buffer.alloc(CODE_CHECKPOINT_POLICY.maxFileBytes, 65);
    await turn("full", async () => {
      for (let i = 0; i < 6; i++) {
        await writeFile(file, original);
        await edit(String(i));
      }
    });
    expect(await readFile(file, "utf8")).toBe("5");
    expect(await restoreCodeCheckpoint(sessionId, "full")).toEqual(unavailable);
    const sizes = await Promise.all((await readdir(storage)).map(async (name) => (await stat(join(storage, name))).size));
    expect(sizes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes);
  }, 60_000);

  it("migrates legacy originals without losing their restore boundary", async () => {
    await mkdir(storage, { recursive: true });
    await writeFile(file, "agent");
    await writeFile(join(storage, "turns.json"), JSON.stringify([{
      sessionId, messageId: "legacy", unavailable: false, consumed: false,
      changes: [{ path: file, before: Buffer.from("original").toString("base64"), mode: 0o600,
        afterHash: createHash("sha256").update("agent").digest("hex") }],
    }]), { mode: 0o600 });
    await turn("new", async () => {});
    expect(JSON.parse(await readFile(join(storage, "turns.json"), "utf8")).version).toBe(2);
    expect(await restoreCodeCheckpoint(sessionId, "legacy")).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it.each(["symlink", "hardlink"] as const)("refuses a replaced %s original blob", async (kind) => {
    await turn("blob", () => edit());
    const blob = (await readdir(storage)).find((name) => name.startsWith("image-"))!;
    const path = join(storage, blob);
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify(Buffer.from("original").toString("base64")));
    await rm(path);
    if (kind === "symlink") await symlink(target, path);
    else await link(target, path);
    expect(await restoreCodeCheckpoint(sessionId, "blob")).toEqual({ ok: false, error: "code-restore-failed" });
    expect(await readFile(file, "utf8")).toBe("agent");
  });

  it("keeps before-images outside the small metadata index", async () => {
    const original = Buffer.alloc(1024 * 1024, 65);
    await writeFile(file, original);
    await turn("first", () => edit());
    expect((await stat(join(storage, "turns.json"))).size).toBeLessThan(32 * 1024);
    expect((await readdir(storage)).some((name) => name.startsWith("image-"))).toBe(true);
    if (process.platform !== "win32") {
      for (const name of await readdir(storage)) expect((await stat(join(storage, name))).mode & 0o777).toBe(0o600);
    }
    expect(await restoreCodeCheckpoint(sessionId, "first")).toEqual({ ok: true });
    expect(await readFile(file)).toEqual(original);
  });

  it("rechecks the current write scope before restoring any path", async () => {
    await turn("edit", () => edit());
    const context = { cwd: join(root, "other"), extraAllowedDirectories: [] };
    await mkdir(context.cwd);
    expect(await restoreCodeCheckpoint(sessionId, "edit", context)).toMatchObject({ ok: false });
    expect(await readFile(file, "utf8")).toBe("agent");
  });

  it("restores ordinary secret-file writes within the allowed directory", async () => {
    file = join(root, ".env");
    await writeFile(file, "secret");
    await turn("sensitive", () => edit());
    expect(await restoreCodeCheckpoint(sessionId, "sensitive", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(file, "utf8")).toBe("secret");
  });

  it("refuses a write grant revoked while restore replacements are staged", async () => {
    await turn("revoked", () => edit());
    const other = join(root, "other");
    await mkdir(other);
    let checks = 0;
    expect(await restoreWithPolicy(sessionId, "revoked", () => ({
      cwd: checks++ === 0 ? root : other, extraAllowedDirectories: [],
    }))).toMatchObject({ ok: false });
    expect(checks).toBe(2);
    expect(await readFile(file, "utf8")).toBe("agent");
    expect((await readdir(root)).some((name) => name.startsWith(".ave-restore-"))).toBe(false);
  });

  it("deletes a session's originals while retaining another session's checkpoints", async () => {
    await turn("deleted", () => edit());
    const other = randomUUID();
    await withCodeCheckpoint({ sessionId: other, messageId: "kept" }, () => edit("other"));
    const before = await readdir(storage);
    await new MemoryManager({ aveDir: join(root, "state") }).deleteSession(sessionId);
    expect(await restoreCodeCheckpoint(sessionId, "deleted")).toEqual(unavailable);
    expect(await restoreCodeCheckpoint(other, "kept")).toEqual({ ok: true });
    expect((await readdir(storage)).length).toBeLessThan(before.length);
  });

  it("removes quarantined originals and orphan blobs on session deletion", async () => {
    await turn("old", () => edit());
    const old = await readFile(join(storage, "turns.json"), "utf8");
    await writeFile(join(storage, "turns.json.corrupt-1-example.bak"), old);
    await writeFile(join(storage, `image-${randomUUID()}.json`), '"orphan"', { mode: 0o600 });
    await new MemoryManager({ aveDir: join(root, "state") }).deleteSession(sessionId);
    expect(await readdir(storage)).toEqual(["turns.json"]);
  });
});
