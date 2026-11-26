import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { sealTargets } from "../../permissions/target-seal.js";
import { resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { checkpointFileMutation, withCodeCheckpoint } from "../code-checkpoints.js";

const probe = vi.hoisted(() => vi.fn<(path: unknown) => void>());
vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    open: (...args: Parameters<typeof actual.open>) => { probe(args[0]); return actual.open(...args); },
    lstat: (...args: Parameters<typeof actual.lstat>) => { probe(args[0]); return actual.lstat(...args); },
    realpath: (...args: Parameters<typeof actual.realpath>) => { probe(args[0]); return actual.realpath(...args); },
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
});
