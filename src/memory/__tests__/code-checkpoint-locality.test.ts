import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { sealTargets, TargetIdentityChangedError } from "../../permissions/target-seal.js";
import { resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { MoveFileTool, WriteFileTool } from "../../tools/file-tools.js";
import { checkpointFileMutation, restoreCodeCheckpoint, withCodeCheckpoint } from "../code-checkpoints.js";

const probe = vi.hoisted(() => vi.fn<(path: unknown) => void>());
const copy = vi.hoisted(() => ({ afterCopy: undefined as (() => void) | undefined }));
vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    open: (...args: Parameters<typeof actual.open>) => { probe(args[0]); return actual.open(...args); },
    lstat: (...args: Parameters<typeof actual.lstat>) => { probe(args[0]); return actual.lstat(...args); },
    realpath: (...args: Parameters<typeof actual.realpath>) => { probe(args[0]); return actual.realpath(...args); },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...args);
      copy.afterCopy?.();
    },
  };
});

const LOCAL_DRIVE = String.raw`\Device\HarddiskVolume1`;

describe.runIf(process.platform === "win32")("checkpoint mutation locality", () => {
  let root: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
    root = await realpath(await mkdtemp(join(tmpdir(), "ave-checkpoint-locality-")));
    vi.stubEnv("AVE_HOME", join(root, "state"));
    first = join(root, "first.txt");
    second = join(root, "second.txt");
    await writeFile(first, "first");
    await writeFile(second, "second");
  });

  afterEach(async () => {
    setWindowsDriveQueryForTest();
    vi.unstubAllEnvs();
    probe.mockClear();
    copy.afterCopy = undefined;
    await rm(root, { recursive: true, force: true });
  });

  function turn(run: () => Promise<unknown>) {
    return withCodeCheckpoint({ sessionId: randomUUID(), messageId: "mutation" }, run);
  }

  it("does not dispatch sibling baseline reads after a drive query fails", async () => {
    const unavailable = new Error("Drive query failed");
    const query = vi.fn(() => LOCAL_DRIVE).mockImplementationOnce(() => { throw unavailable; });
    const mutate = vi.fn(async () => {});
    const failure = await turn(async () => {
      setWindowsDriveQueryForTest(query);
      probe.mockClear();
      return checkpointFileMutation([{ path: first, content: "new" }, { path: second, content: "new" }], mutate);
    }).catch((error: unknown) => error);
    expect(failure).toBe(unavailable);
    expect(probe.mock.calls.filter(([path]) => path === first || path === second)).toEqual([]);
    expect(query).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not probe the mutation path for line counts after the write seal fails", async () => {
    const unavailable = new Error("Drive query failed");
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(first, root, 64));
    const failure = await turn(() => checkpointFileMutation([{ path: first, content: "new" }], async () => {
      probe.mockClear();
      setWindowsDriveQueryForTest(() => { throw unavailable; });
      seal.verify();
    }, seal)).catch((error: unknown) => error);
    expect(failure).toBe(unavailable);
    expect(probe.mock.calls.filter(([path]) => path === first)).toEqual([]);
  });

  it("rewinds prior edits after a drive query refuses a write-ahead entry", async () => {
    const unavailable = new Error("Drive query failed");
    const sessionId = randomUUID();
    const ledger = join(root, "state", "code-checkpoints", "turns.json");
    const mutate = vi.fn(() => writeFile(second, "refused edit"));
    const query = vi.fn(() => { throw unavailable; });
    const seal = {
      verify() {
        if (readFileSync(ledger, "utf8").includes("second.txt")) {
          probe.mockClear();
          setWindowsDriveQueryForTest(query);
        }
        resolvePhysicalFilesystemPath(second, root, 64);
      },
    };
    await withCodeCheckpoint({ sessionId, messageId: "mutation" }, async () => {
      await checkpointFileMutation([{ path: first, content: "prior edit" }], () => writeFile(first, "prior edit"));
      await expect(checkpointFileMutation([{ path: second, content: "refused edit" }], mutate, seal))
        .rejects.toBe(unavailable);
      expect(query).toHaveBeenCalledOnce();
      expect(probe.mock.calls.filter(([path]) => path === first || path === second || path === root)).toEqual([]);
      expect(mutate).not.toHaveBeenCalled();
      setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
    });

    expect(await restoreCodeCheckpoint(sessionId, "mutation", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(first, "utf8")).toBe("first");
    expect(await readFile(second, "utf8")).toBe("second");
  });

  it("retains applied effects and drops untouched files after a separate seal operand changes", async () => {
    const sessionId = randomUUID();
    let anchor = "original";
    const seal = sealTargets(() => anchor);
    await withCodeCheckpoint({ sessionId, messageId: "mutation" }, async () => {
      await checkpointFileMutation([{ path: first, content: "prior edit" }], () => writeFile(first, "prior edit"));
      await expect(checkpointFileMutation([
        { path: first, content: "applied edit" },
        { path: second, content: "refused edit" },
      ], async () => {
        await writeFile(first, "applied edit");
        anchor = "replacement";
        seal.verify();
        await writeFile(second, "refused edit");
      }, seal)).rejects.toBeInstanceOf(TargetIdentityChangedError);
    });

    expect(await readFile(first, "utf8")).toBe("applied edit");
    expect(await restoreCodeCheckpoint(sessionId, "mutation", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(first, "utf8")).toBe("first");
    expect(await readFile(second, "utf8")).toBe("second");
  });

  it("rewinds prior edits when a staged file never reaches publication", async () => {
    const sessionId = randomUUID();
    const path = join(root, "new.txt");
    const context = { cwd: root, extraAllowedDirectories: [], metadata: {} };
    const unavailable = new Error("Drive query failed");
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(path, root, 64));
    const stagingFiles = () => readdirSync(root).filter((name) => name.startsWith("new.txt.ave-tmp-"));
    const failedQuery = vi.fn(() => { throw unavailable; });

    await withCodeCheckpoint({ sessionId, messageId: "mutation" }, async () => {
      await checkpointFileMutation([{ path: first, content: "prior edit" }], () => writeFile(first, "prior edit"));
      setWindowsDriveQueryForTest(() => {
        if (stagingFiles().length === 0) return LOCAL_DRIVE;
        probe.mockClear();
        setWindowsDriveQueryForTest(failedQuery);
        return failedQuery();
      });
      await expect(new WriteFileTool().execute({ path, content: "refused edit" }, { ...context, fileTargetSeal: seal }))
        .rejects.toBe(unavailable);
      expect(failedQuery).toHaveBeenCalledOnce();
      expect(probe.mock.calls.filter(([operand]) => operand === path || operand === root)).toEqual([]);
      expect(stagingFiles()).toEqual([]);
      setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
    });

    expect(await restoreCodeCheckpoint(sessionId, "mutation", context)).toEqual({ ok: true });
    expect(await readFile(first, "utf8")).toBe("first");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps only the copied destination when a move loses locality before unlink", async () => {
    const sessionId = randomUUID();
    const destination = join(root, "moved.txt");
    const context = { cwd: root, extraAllowedDirectories: [], metadata: {} };
    const unavailable = new Error("Drive query failed");
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(first, root, 64));
    const query = vi.fn(() => { throw unavailable; });
    copy.afterCopy = () => {
      probe.mockClear();
      setWindowsDriveQueryForTest(query);
    };

    await withCodeCheckpoint({ sessionId, messageId: "mutation" }, async () => {
      const move = new MoveFileTool().execute({ sourcePath: first, destinationPath: destination }, { ...context, fileTargetSeal: seal });
      await expect(move).rejects.toBe(unavailable);
      expect(query).toHaveBeenCalledOnce();
      expect(probe.mock.calls.filter(([path]) => path === first || path === destination || path === root)).toEqual([]);
      setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
    });

    expect(await readFile(first, "utf8")).toBe("first");
    expect(await readFile(destination, "utf8")).toBe("first");
    expect(await restoreCodeCheckpoint(sessionId, "mutation", context)).toEqual({ ok: true });
    expect(await readFile(first, "utf8")).toBe("first");
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
