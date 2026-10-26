// Isolate module-wide filesystem and sleep mocks from the real-filesystem suite.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { transientFsLockDelayMs } from "../../lib/transient-fs-lock-retry.js";

const renameFailures: string[] = [];
const sleeps: number[] = [];
let abortDuringStage: AbortController | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      if (String(args[0]).includes(".ave-tmp-")) abortDuringStage?.abort(new Error("Write cancelled"));
    },
    rename: async (from: string, to: string) => {
      const code = renameFailures.shift();
      if (code) {
        throw Object.assign(new Error(`${code}: locked`), { code });
      }
      return actual.rename(from, to);
    },
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

const { WriteFileTool, DeleteFileTool } = await import("../file-tools.js");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ave-file-tools-rename-"));
  renameFailures.length = 0;
  sleeps.length = 0;
  abortDuringStage = undefined;
});

afterEach(async () => {
  await cleanupTmpDir(workDir);
});

describe("write_file transient rename retry", () => {
  it("keeps write and delete ownership until cancelled execution settles", () => {
    expect(new WriteFileTool().awaitCancellationSettlement).toBe(true);
    expect(new DeleteFileTool().awaitCancellationSettlement).toBe(true);
  });

  it("cancels a staged replacement before rename and cleans its temporary bytes", async () => {
    abortDuringStage = new AbortController();
    await expect(new WriteFileTool().execute(
      { path: "notes.txt", content: "cancelled content" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: {}, abortSignal: abortDuringStage.signal },
    )).rejects.toThrow("Write cancelled");
    expect(existsSync(join(workDir, "notes.txt"))).toBe(false);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("refuses a deletion cancelled before the effect", async () => {
    const target = join(workDir, "notes.txt");
    writeFileSync(target, "retain bytes");
    const controller = new AbortController();
    controller.abort(new Error("Delete cancelled"));
    await expect(new DeleteFileTool().execute({ path: target }, {
      cwd: workDir, extraAllowedDirectories: [], metadata: {}, abortSignal: controller.signal,
    })).rejects.toThrow("Delete cancelled");
    expect(readFileSync(target, "utf8")).toBe("retain bytes");
  });

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

  it("does not retry a code outside the shared retryable set", async () => {
    renameFailures.push("ENOENT");
    await expect(new WriteFileTool().execute(
      { path: "notes.txt", content: "hello" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: {} },
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(sleeps).toEqual([]);
  });
});
