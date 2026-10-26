import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const budget = vi.hoisted(() => ({ bytes: 64 * 1024 * 1024 }));
vi.mock("../../shared/code-rewind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/code-rewind.js")>();
  return { ...actual, CODE_CHECKPOINT_POLICY: {
    ...actual.CODE_CHECKPOINT_POLICY, get maxStorageBytes() { return budget.bytes; },
  } };
});
import { checkpointFileMutation, restoreCodeCheckpoint, withCodeCheckpoint } from "../code-checkpoints.js";

let root: string;
beforeEach(async () => {
  budget.bytes = 64 * 1024 * 1024;
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-count-quota-")));
  vi.stubEnv("AVE_HOME", join(root, "state"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe("checkpoint line-count storage", () => {
  it("does not discard a fitting restore image to add informational counts at the quota boundary", async () => {
    const sessionId = randomUUID();
    const path = join(root, "source.txt");
    await writeFile(path, "before\n");
    await withCodeCheckpoint({ sessionId, messageId: "latest" }, async () => {
      await checkpointFileMutation([{ path, content: "after\n" }], async () => {
        await writeFile(path, "after\n");
        const directory = join(root, "state", "code-checkpoints");
        const names = await readdir(directory);
        const sizes = await Promise.all(names.map(async (name) => (await stat(join(directory, name))).size));
        budget.bytes = sizes.reduce((sum, size) => sum + size, 0);
      });
    });
    const ledger = JSON.parse(await readFile(join(root, "state", "code-checkpoints", "turns.json"), "utf8"));
    expect(ledger.turns).toHaveLength(1);
    expect(ledger.turns[0]).toMatchObject({ unavailable: false, consumed: false, changes: [
      { path, before: expect.stringMatching(/^image-/) },
    ] });
    expect(ledger.turns[0].changes[0]).not.toHaveProperty("addedLines");
    expect(ledger.turns[0].changes[0]).not.toHaveProperty("removedLines");
    budget.bytes = 64 * 1024 * 1024;
    expect(await restoreCodeCheckpoint(sessionId, "latest", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("before\n");
  });
});
