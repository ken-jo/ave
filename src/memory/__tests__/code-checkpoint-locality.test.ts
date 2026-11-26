import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { sealTargets, TargetIdentityChangedError } from "../../permissions/target-seal.js";
import { resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { CopyPathTool, MoveFileTool, ReadFileTool, WriteFileTool } from "../../tools/file-tools.js";
import { checkpointFileMutation, restoreCodeCheckpoint, withCodeCheckpoint } from "../code-checkpoints.js";

const probe = vi.hoisted(() => vi.fn<(path: unknown) => void>());
const afterRename = vi.hoisted(() => vi.fn<(destination: unknown) => void>());
const copy = vi.hoisted(() => ({
  afterCopy: undefined as (() => void) | undefined,
  afterOpen: undefined as ((path: unknown, handle: FileHandle) => void) | undefined,
}));
vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => { probe(args[0]); return actual.existsSync(...args); },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => { probe(args[0]); return actual.lstatSync(...args); },
    openSync: (...args: Parameters<typeof actual.openSync>) => { probe(args[0]); return actual.openSync(...args); },
    readlinkSync: (...args: Parameters<typeof actual.readlinkSync>) => { probe(args[0]); return actual.readlinkSync(...args); },
    statSync: (...args: Parameters<typeof actual.statSync>) => { probe(args[0]); return actual.statSync(...args); },
    realpathSync: Object.assign(
      (...args: Parameters<typeof actual.realpathSync>) => { probe(args[0]); return actual.realpathSync(...args); },
      { native: (...args: Parameters<typeof actual.realpathSync.native>) => { probe(args[0]); return actual.realpathSync.native(...args); } },
    ),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      probe(args[0]);
      const handle = await actual.open(...args);
      copy.afterOpen?.(args[0], handle);
      return handle;
    },
    lstat: (...args: Parameters<typeof actual.lstat>) => { probe(args[0]); return actual.lstat(...args); },
    mkdir: (...args: Parameters<typeof actual.mkdir>) => { probe(args[0]); return actual.mkdir(...args); },
    opendir: (...args: Parameters<typeof actual.opendir>) => { probe(args[0]); return actual.opendir(...args); },
    realpath: (...args: Parameters<typeof actual.realpath>) => { probe(args[0]); return actual.realpath(...args); },
    rmdir: (...args: Parameters<typeof actual.rmdir>) => { probe(args[0]); return actual.rmdir(...args); },
    unlink: (...args: Parameters<typeof actual.unlink>) => { probe(args[0]); return actual.unlink(...args); },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      afterRename(args[1]);
    },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...args);
      copy.afterCopy?.();
    },
  };
});

const LOCAL_DRIVE = String.raw`\Device\HarddiskVolume1`;

describe("checkpoint mutation locality", () => {
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
    probe.mockReset();
    afterRename.mockReset();
    copy.afterCopy = undefined;
    copy.afterOpen = undefined;
    await rm(root, { recursive: true, force: true });
  });

  function turn(run: () => Promise<unknown>) {
    return withCodeCheckpoint({ sessionId: randomUUID(), messageId: "mutation" }, run);
  }

  it.runIf(process.platform === "win32")("does not dispatch sibling baseline reads after a drive query fails", async () => {
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

  it.runIf(process.platform === "win32")("does not probe the mutation path for line counts after the write seal fails", async () => {
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

  it.runIf(process.platform === "win32")("rewinds prior edits after a drive query refuses a write-ahead entry", async () => {
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

  it.each(["tracked", "untracked"])("retains applied effects after a separate seal operand changes for a %s writer", async (kind) => {
    const sessionId = randomUUID();
    let anchor = "original";
    const seal = sealTargets(() => anchor);
    await withCodeCheckpoint({ sessionId, messageId: "mutation" }, async () => {
      await checkpointFileMutation([{ path: first, content: "prior edit" }], () => writeFile(first, "prior edit"));
      const run = async (recordEffect?: (path: string) => void) => {
        await writeFile(first, "applied edit");
        recordEffect?.(first);
        anchor = "replacement";
        seal.verify();
        await writeFile(second, "refused edit");
        recordEffect?.(second);
      };
      await expect(checkpointFileMutation([
        { path: first, content: "applied edit" },
        { path: second, content: "refused edit" },
      ], kind === "tracked" ? { run } : () => run(), seal)).rejects.toBeInstanceOf(TargetIdentityChangedError);
    });

    expect(await readFile(first, "utf8")).toBe("applied edit");
    expect(await restoreCodeCheckpoint(sessionId, "mutation", { cwd: root, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(first, "utf8")).toBe("first");
    expect(await readFile(second, "utf8")).toBe("second");
  });

  it.skipIf(process.platform === "win32")("rewinds a published text write after attribution fails", async () => {
    const sessionId = randomUUID();
    const context = { cwd: root, extraAllowedDirectories: [], metadata: { sessionId } };
    const original = await readFile(first);
    const read = await new ReadFileTool().execute({ path: first }, context);
    expect(read.isError, read.output).toBe(false);
    const unavailable = Object.assign(new Error("Attribution path lookup failed"), { code: "EIO" });
    const failAttribution = vi.fn(() => { throw unavailable; });
    afterRename.mockImplementation((destination) => {
      if (destination !== first) return;
      probe.mockImplementation((operand) => {
        if (operand !== first) return;
        probe.mockReset();
        failAttribution();
      });
    });

    await withCodeCheckpoint({ sessionId, messageId: "mutation" }, async () => {
      await expect(new WriteFileTool().execute({ path: first, content: "published edit" }, context))
        .rejects.toBe(unavailable);
    });

    expect(failAttribution).toHaveBeenCalledOnce();
    expect(await readFile(first, "utf8")).toBe("published edit");
    afterRename.mockReset();
    expect(await restoreCodeCheckpoint(sessionId, "mutation", context)).toEqual({ ok: true });
    expect(await readFile(first)).toEqual(original);
  });

  it.runIf(process.platform === "win32")("rewinds prior edits when a staged file never reaches publication", async () => {
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

  it.runIf(process.platform === "win32")("keeps only the copied destination when a move loses locality before unlink", async () => {
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

  it.runIf(process.platform === "win32").each(["created", "written"])("stops workspace IO when copy loses locality after the destination is %s", async (stage) => {
    const sessionId = randomUUID();
    const destination = join(root, "copied.txt");
    const state = join(root, "state");
    const context = { cwd: root, extraAllowedDirectories: [], metadata: {} };
    const unavailable = new Error("Drive query failed");
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(first, root, 64));
    const query = vi.fn(() => LOCAL_DRIVE).mockImplementationOnce(() => {
      probe.mockClear();
      throw unavailable;
    });
    copy.afterOpen = (path, handle) => {
      if (path !== destination) return;
      if (stage === "created") {
        setWindowsDriveQueryForTest(query);
      } else {
        const chmod = handle.chmod.bind(handle);
        vi.spyOn(handle, "chmod").mockImplementationOnce(async (mode) => {
          await chmod(mode);
          setWindowsDriveQueryForTest(query);
        });
      }
    };

    await withCodeCheckpoint({ sessionId, messageId: "mutation" }, async () => {
      const failure = await new CopyPathTool().execute(
        { sourcePath: first, destinationPath: destination }, { ...context, fileTargetSeal: seal },
      ).catch((error: unknown) => error);
      const workspaceOperations = probe.mock.calls.flatMap(([path]) => {
        if (typeof path !== "string" || path === state || path.startsWith(state + sep)) return [];
        return path === root || path.startsWith(root + sep) || root.startsWith(path.endsWith(sep) ? path : path + sep) ? [path] : [];
      });
      expect(workspaceOperations).toEqual([]);
      expect(query).toHaveBeenCalledOnce();
      expect(failure).toBe(unavailable);
      setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
    });

    expect(await readFile(first, "utf8")).toBe("first");
    expect(await readFile(destination, "utf8")).toBe(stage === "created" ? "" : "first");
    const result = await restoreCodeCheckpoint(sessionId, "mutation", context);
    if (stage === "created") {
      expect(result).toMatchObject({ ok: false, conflictingFiles: [destination] });
      expect(await readFile(destination, "utf8")).toBe("");
    } else {
      expect(result).toEqual({ ok: true });
      await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
