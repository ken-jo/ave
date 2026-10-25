import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, link, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deleteCodeCheckpoints, restoreCodeCheckpoint, withCodeCheckpoint } from "../code-checkpoints.js";
import { CODE_CHECKPOINT_POLICY } from "../../shared/code-rewind.js";
import { createCodeCheckpointEdit, createCodeCheckpointTurn } from "../../__tests__/support/code-checkpoint-turn.js";

let root: string;
let storage: string;
let file: string;
let sessionId: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-checkpoint-quarantine-")));
  vi.stubEnv("AVE_HOME", join(root, "state"));
  storage = join(root, "state", "code-checkpoints");
  file = join(root, "source.txt");
  sessionId = randomUUID();
  await writeFile(file, "original");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const turn = createCodeCheckpointTurn(() => sessionId);
const edit = createCodeCheckpointEdit(() => file);
const namespaceBytes = async () => (await Promise.all((await readdir(storage))
  .map(async (name) => (await stat(join(storage, name))).size))).reduce((sum, bytes) => sum + bytes, 0);
const backupName = async () => (await readdir(storage)).find((name) => name.endsWith(".bak"))!;

describe("checkpoint quarantine storage", () => {
  it("preserves the on-disk quarantine set and bounds total bytes after large later edits", async () => {
    await writeFile(file, "x".repeat(512 * 1024));
    await turn("old", () => edit());
    const image = (await readdir(storage)).find((name) => name.startsWith("image-"))!;
    const orphan = `image-${randomUUID()}.json`;
    await writeFile(join(storage, orphan), '"evidence"\n', { mode: 0o600 });
    await writeFile(join(storage, "turns.json"), "{");
    await turn("quarantine", async () => {});
    const backup = await backupName();
    const manifest = `${backup}.images.json`;
    for (let i = 0; i < 200; i++) {
      await writeFile(file, String(i).padEnd(512 * 1024, "x"));
      await turn(`large-${i}`, () => edit());
      expect(await namespaceBytes()).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes * 2);
    }
    expect(JSON.parse(await readFile(join(storage, manifest), "utf8")).sort()).toEqual([image, orphan].sort());
    if (process.platform !== "win32") expect((await stat(join(storage, manifest))).mode & 0o777).toBe(0o600);
    expect((await readdir(storage))).toContain(image);
    expect(await readFile(join(storage, orphan), "utf8")).toBe('"evidence"\n');
    const index = JSON.parse(await readFile(join(storage, "turns.json"), "utf8"));
    const referenced = index.turns.flatMap((item: { changes: { before: string | null }[] }) => item.changes.map((change) => change.before));
    const activeBytes = (await stat(join(storage, "turns.json"))).size + (await Promise.all(
      [...new Set<string>(referenced)].filter(Boolean).map(async (name) => (await stat(join(storage, name))).size),
    )).reduce((sum, bytes) => sum + bytes, 0);
    expect(activeBytes).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes);
    expect((await readdir(storage)).filter((name) => name.startsWith("image-")).sort())
      .toEqual([...new Set([...referenced, image, orphan])].filter(Boolean).sort());
  }, 60_000);

  it("evicts oldest quarantine evidence when its separate byte budget is full", async () => {
    const images: string[] = [];
    const backups: string[] = [];
    for (let i = 0; i < 2; i++) {
      await turn(`old-${i}`, () => edit(`edit-${i}`));
      const index = JSON.parse(await readFile(join(storage, "turns.json"), "utf8"));
      images.push(index.turns.at(-1).changes[0].before);
      await writeFile(join(storage, "turns.json"), "{".padEnd(CODE_CHECKPOINT_POLICY.maxStorageBytes / 2, " "));
      await turn(`quarantine-${i}`, async () => {});
      backups.push(await backupName());
    }
    const names = await readdir(storage);
    expect(names).toContain(images[0]);
    expect(names).not.toContain(backups[0]);
    expect(names).not.toContain(`${backups[0]}.images.json`);
    expect(names).toContain(images[1]);
    const evidence = await Promise.all(names.filter((name) => name !== "turns.json").map(async (name) => (await stat(join(storage, name))).size));
    expect(evidence.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes);
  });

  it.each(["missing", "syntax", "schema", "symlink", "hardlink", ...(process.platform === "win32" ? [] : ["mode"])])("collects unreferenced images with a %s quarantine manifest", async (kind) => {
    await turn("old", () => edit());
    const image = (await readdir(storage)).find((name) => name.startsWith("image-"))!;
    await writeFile(join(storage, "turns.json"), "{");
    await turn("quarantine", async () => {});
    const backup = await backupName();
    const manifest = join(storage, `${backup}.images.json`);
    const target = join(root, "example.json");
    await writeFile(target, JSON.stringify([image]));
    if (["missing", "symlink", "hardlink"].includes(kind)) await rm(manifest, { force: true });
    if (kind === "syntax") await writeFile(manifest, "{");
    if (kind === "schema") await writeFile(manifest, JSON.stringify(["../example.json"]));
    if (kind === "symlink") await symlink(target, manifest);
    if (kind === "hardlink") await link(target, manifest);
    if (kind === "mode") await chmod(manifest, 0o644);
    await turn("sweep", () => edit("next"));
    const after = await readdir(storage);
    expect(after).not.toContain(image);
    expect(after).not.toContain(backup);
    expect(await namespaceBytes()).toBeLessThanOrEqual(CODE_CHECKPOINT_POLICY.maxStorageBytes * 2);
    expect(await readFile(target, "utf8")).toBe(JSON.stringify([image]));
    expect(await restoreCodeCheckpoint(sessionId, "sweep", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
  });

  it("removes backups, manifests and preserved images on session deletion while retaining active images", async () => {
    await turn("old", () => edit());
    const image = (await readdir(storage)).find((name) => name.startsWith("image-"))!;
    await writeFile(join(storage, "turns.json"), "{");
    await turn("quarantine", async () => {});
    const other = randomUUID();
    await withCodeCheckpoint({ sessionId: other, messageId: "kept" }, () => edit("other"));
    await deleteCodeCheckpoints(sessionId);
    const names = await readdir(storage);
    expect(names).not.toContain(image);
    expect(names.some((name) => name.includes(".corrupt-"))).toBe(false);
    expect(await restoreCodeCheckpoint(other, "kept", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
  });
});
