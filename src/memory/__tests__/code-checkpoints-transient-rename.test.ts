vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

// Keep module-wide filesystem and retry mocks isolated from real-filesystem checkpoint tests.
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { transientFsLockDelayMs } from "../../lib/transient-fs-lock-retry.js";

const renameFailures: string[] = [];
const sleeps: number[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const code = renameFailures.shift();
      if (code) throw Object.assign(new Error(`${code}: locked`), { code });
      return actual.rename(from, to);
    },
  };
});

vi.mock("../../shared/abortable-deadline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/abortable-deadline.js")>();
  return { ...actual, sleep: async (ms: number) => { sleeps.push(ms); } };
});

const { checkpointFileMutation, restoreCodeCheckpoint: restoreWithPolicy, withCodeCheckpoint } = await import("../code-checkpoints.js");
const restoreCodeCheckpoint = (session: string, message: string) => restoreWithPolicy(session, message, { cwd: root, extraAllowedDirectories: [] });

const hostPlatform = process.platform;
let root: string;
let file: string;
let sessionId: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-code-rewind-rename-")));
  file = join(root, "source.txt");
  sessionId = randomUUID();
  vi.stubEnv("AVE_HOME", join(root, "state"));
  renameFailures.length = 0;
  sleeps.length = 0;
  await writeFile(file, "original");
  await withCodeCheckpoint({ sessionId, messageId: "edit" }, () =>
    checkpointFileMutation([{ path: file, content: "agent" }], () => writeFile(file, "agent")));
});

afterEach(async () => {
  setProcessPlatform(hostPlatform);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("code restore transient rename retry", () => {
  it("retries a transient Windows lock on the shared curve", async () => {
    setProcessPlatform("win32");
    renameFailures.push("EBUSY");
    expect(await restoreCodeCheckpoint(sessionId, "edit")).toEqual({ ok: true });
    expect(renameFailures).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("original");
    expect(sleeps).toEqual([transientFsLockDelayMs(1)]);
  });

  // Do not emulate POSIX here; it would also trigger ledger mode checks on Windows.
  it.skipIf(hostPlatform === "win32")("does not retry on POSIX", async () => {
    renameFailures.push("EBUSY");
    expect(await restoreCodeCheckpoint(sessionId, "edit")).toEqual({ ok: false, error: "code-restore-failed" });
    expect(renameFailures).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("agent");
    expect(sleeps).toEqual([]);
  });
});
