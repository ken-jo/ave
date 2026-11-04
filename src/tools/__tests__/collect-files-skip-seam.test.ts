// The skip path through an injected fs error, so it runs on every platform (Windows reports EPERM; chmod cannot lock there).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const { refuse } = vi.hoisted(() => ({ refuse: new Map<string, { op: "readdir" | "stat"; code: string }>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (path: unknown, op: "readdir" | "stat") => {
    const rule = refuse.get(String(path));
    if (rule?.op !== op) return;
    throw Object.assign(new Error(`${rule.code}: injected, ${op} '${String(path)}'`), { code: rule.code });
  };
  return {
    ...actual,
    readdir: (async (path: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
      fail(path, "readdir");
      return (actual.readdir as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readdir,
    stat: (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
      fail(path, "stat");
      return (actual.stat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.stat,
  };
});

import { collectFiles, GlobFilesTool, ListFilesTool } from "../file-tools.js";

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ave-collect-seam-")));
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "locked"), { recursive: true });
  mkdirSync(join(base, "gone"), { recursive: true });
  writeFileSync(join(base, "src", "main.ts"), "x");
  writeFileSync(join(base, "src", "vanished.ts"), "x");
  writeFileSync(join(base, "locked", "secret.txt"), "x");
  writeFileSync(join(base, "gone", "old.txt"), "x");
});

beforeEach(() => refuse.clear());

afterAll(async () => {
  await cleanupTmpDir(base);
});

describe("collectFiles skip path", () => {
  it("skips a subfolder the OS refuses with EPERM and reports it", async () => {
    refuse.set(join(base, "locked"), { op: "readdir", code: "EPERM" });
    const listed = await collectFiles(base, 1_000);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.files.map((file) => file.relativePath).sort()).toEqual(["gone/old.txt", "src/main.ts", "src/vanished.ts"]);
    expect(listed.value.skippedUnreadable).toEqual({ count: 1, paths: ["locked"] });
  });

  it("skips a subfolder and a file deleted mid-walk (ENOENT)", async () => {
    refuse.set(join(base, "gone"), { op: "readdir", code: "ENOENT" });
    refuse.set(join(base, "src", "vanished.ts"), { op: "stat", code: "ENOENT" });
    const listed = await collectFiles(base, 1_000);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.files.map((file) => file.relativePath).sort()).toEqual(["locked/secret.txt", "src/main.ts"]);
    expect(listed.value.skippedUnreadable).toEqual({ count: 2, paths: ["gone", "src/vanished.ts"] });
  });

  it("still fails when the root itself is refused or gone", async () => {
    refuse.set(base, { op: "readdir", code: "EPERM" });
    expect((await collectFiles(base, 1_000)).ok).toBe(false);
    refuse.set(base, { op: "readdir", code: "ENOENT" });
    expect((await collectFiles(base, 1_000)).ok).toBe(false);
  });

  it("still fails on an error that is not a refusal or a race", async () => {
    refuse.set(join(base, "locked"), { op: "readdir", code: "EIO" });
    expect((await collectFiles(base, 1_000)).ok).toBe(false);
  });

  it("names the skipped paths in list_files output, and leaves the field out when nothing was skipped", async () => {
    const tool = new ListFilesTool();
    const run = async () => JSON.parse((await tool.execute({ path: base, depth: 3, limit: 100 }, { workspaceRoot: base, allowedDirectories: [base] } as never)).output);
    expect((await run()).skippedUnreadable).toBeUndefined();
    refuse.set(join(base, "locked"), { op: "readdir", code: "EPERM" });
    expect((await run()).skippedUnreadable).toEqual({ count: 1, paths: ["locked"] });
  });

  it("names the skipped paths in glob_files output too", async () => {
    refuse.set(join(base, "locked"), { op: "readdir", code: "EPERM" });
    const result = await new GlobFilesTool().execute({ path: base, pattern: "**/*.ts", limit: 100 }, { workspaceRoot: base, allowedDirectories: [base] } as never);
    const output = JSON.parse(result.output);
    expect(output.matches.length).toBe(2);
    expect(output.skippedUnreadable).toEqual({ count: 1, paths: ["locked"] });
  });
});
