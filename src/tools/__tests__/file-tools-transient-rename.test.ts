// Isolate module-wide filesystem and sleep mocks from the real-filesystem suite.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { transientFsLockDelayMs } from "../../lib/transient-fs-lock-retry.js";
import { configureHostResources } from "../../main/host-resources.js";

// Windows file targets are admitted through the shipped path-kind helper; boot configures its resources first.
beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

const renameFailures: string[] = [];
const sleeps: number[] = [];
const renameSources: string[] = [];
const stage = vi.hoisted(() => ({ original: "", alternate: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameSources.push(from);
      const code = renameFailures.shift();
      if (code) {
        throw Object.assign(new Error(`${code}: locked`), { code });
      }
      return actual.rename(from, to);
    },
  };
});

vi.mock("../../shared/shell-filesystem-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/shell-filesystem-path.js")>();
  return {
    ...actual,
    resolvePhysicalFilesystemPath: (...args: Parameters<typeof actual.resolvePhysicalFilesystemPath>) =>
      args[0] === stage.original ? stage.alternate : actual.resolvePhysicalFilesystemPath(...args),
  };
});

vi.mock("../../shared/abortable-deadline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/abortable-deadline.js")>();
  return {
    ...actual,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
});

const { WriteFileTool } = await import("../file-tools.js");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ave-file-tools-rename-"));
  renameFailures.length = 0;
  sleeps.length = 0;
  renameSources.length = 0;
  stage.original = "";
  stage.alternate = "";
});

afterEach(async () => {
  await cleanupTmpDir(workDir);
});

describe("write_file transient rename retry", () => {
  it("waits on the shared transient-lock curve, not a private one", async () => {
    renameFailures.push("EBUSY", "EPERM");
    const result = await new WriteFileTool().execute(
      { path: "notes.txt", content: "hello" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: {} },
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, "notes.txt"), "utf8")).toBe("hello");
    expect(sleeps).toEqual([transientFsLockDelayMs(1), transientFsLockDelayMs(2)]);
  });

  it.runIf(process.platform === "win32")("stages the write beside the entry captured by the invocation", async () => {
    stage.original = workDir;
    stage.alternate = join(workDir, "alternate");
    mkdirSync(stage.alternate);
    const target = join(workDir, "notes.txt");
    const fileTargetSeal = { verify: vi.fn(), entryFor: (path: string) => path === target ? target : undefined };
    const result = await new WriteFileTool().execute({ path: target, content: "hello" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: {}, fileTargetSeal });
    expect(result.isError, result.output).toBe(false);
    expect(renameSources.map(dirname)).toEqual([workDir]);
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  it("does not retry a code outside the shared retryable set", async () => {
    renameFailures.push("ENOENT");
    await expect(new WriteFileTool().execute(
      { path: "notes.txt", content: "hello" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: {} },
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(sleeps).toEqual([]);
  });
});
