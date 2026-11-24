import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { afterQueuedCallbacks } from "../../../__tests__/support/deferred.js";

// Hooks into the filesystem calls a test needs to steer or observe: a check of the staging folder that fails with a filesystem error, short
// writes by the Linux copy, and every rename and removal the host itself makes, so a test can prove each one names its file through a
// held directory.
const hooks = vi.hoisted(() => ({
  checkFault: null as { path: string; code: string } | null,
  writeLimit: null as number | null,
  pathOperations: [] as string[],
  // A removal of a matching path that fails with a filesystem error.
  unlinkFault: null as RegExp | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fault = (path: unknown) => {
    if (hooks.checkFault !== null && String(path) === hooks.checkFault.path) {
      throw Object.assign(new Error(`${hooks.checkFault.code}: simulated`), { code: hooks.checkFault.code });
    }
  };
  return {
    ...actual,
    openSync: (path: string, ...rest: unknown[]) => {
      fault(path);
      return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    },
    lstatSync: (path: string, ...rest: unknown[]) => {
      fault(path);
      return (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
    renameSync: (from: string, to: string) => {
      hooks.pathOperations.push(from, to);
      return actual.renameSync(from, to);
    },
    unlinkSync: (path: string) => {
      hooks.pathOperations.push(path);
      if (hooks.unlinkFault?.test(String(path))) throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      return actual.unlinkSync(path);
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // The host's own renames, seen like those through node:fs.
    rename: async (from: string, to: string) => {
      hooks.pathOperations.push(from, to);
      return actual.rename(from, to);
    },
    open: async (path: string, ...rest: unknown[]) => {
      hooks.pathOperations.push(String(path));
      const handle = await (actual.open as (...args: unknown[]) => Promise<import("node:fs/promises").FileHandle>)(path, ...rest);
      if (basename(String(path)).endsWith(".part")) {
        // A write may legally take fewer bytes than it was given, or none.
        const write = handle.write.bind(handle) as (buffer: Buffer, offset: number, length: number, position?: number | null) => Promise<{ bytesWritten: number; buffer: Buffer }>;
        Object.assign(handle, {
          write: async (buffer: Buffer, offset: number, length: number, position?: number | null) => {
            if (hooks.writeLimit === null) return write(buffer, offset, length, position);
            if (hooks.writeLimit === 0) return { bytesWritten: 0, buffer };
            return write(buffer, offset, Math.min(length, hooks.writeLimit), position);
          },
        });
      }
      return handle;
    },
  };
});

const { prepareBrowserDownloadStaging, stageBrowserDownload, sweepBrowserDownloadStaging, BrowserDownloadStagingError, UNANSWERED_DOWNLOAD_BYTES } =
  await import("../browser-download-staging.js");
const { _helperFileOperationsForTest, HeldFileHelperStalledError } = await import("../browser-download-files.js");
type Root = import("../browser-download-staging.js").BrowserDownloadStagingRoot;
type Observed = import("../browser-download-staging.js").ObservedDownload;
type Files = import("../browser-download-files.js").HeldFileOperations;
// The step an operation reports while it holds its directories.
type Step = Parameters<Parameters<Files["move"]>[4]>[0];
const { isAdmissionDeniedPath, isSensitivePath } = await import("../../../permissions/sensitive-paths.js");
// The test's own moves and removals never go through the observed calls.
const { renameSync: moveAside, unlinkSync: removeEntry } = await vi.importActual<typeof import("node:fs")>("node:fs");

// The checkout's resources folder, where the native helper for this platform is built (test:prepare).
const RESOURCES = resolve("resources");

let home: string;
let aveHomeDir: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ave-download-staging-")));
  aveHomeDir = join(home, "ave-home");
  mkdirSync(aveHomeDir);
  vi.stubEnv("AVE_HOME", aveHomeDir);
  hooks.checkFault = null;
  hooks.writeLimit = null;
  hooks.pathOperations = [];
  hooks.unlinkFault = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const linkKind = process.platform === "win32" ? "junction" : "dir";
const prepare = (): Root => prepareBrowserDownloadStaging(RESOURCES);

// A download as the browser runs it: it writes to the path it was given, can be paused and resumed, and ends with a state.
function fakeItem(name = "report.pdf") {
  const item = Object.assign(new EventEmitter(), {
    path: "",
    received: 0,
    state: "progressing" as "progressing" | "completed" | "cancelled" | "interrupted",
    setSavePath: vi.fn((path: string) => { item.path = path; }),
    pause: vi.fn(),
    resume: vi.fn(),
    getFilename: () => name,
    getURL: () => `https://files.example/${name}`,
    getURLChain: () => [`https://files.example/${name}`],
    hasUserGesture: () => true,
    getReceivedBytes: () => item.received,
    getTotalBytes: () => item.received,
    getState: () => item.state,
    cancel: vi.fn(() => { if (item.state === "progressing") item.end("cancelled"); }),
    complete: (content: string | Buffer = "data") => { writeFileSync(item.path, content); item.end("completed"); },
    end: (state: "completed" | "cancelled" | "interrupted") => { item.state = state; item.emit("done", {}, state); },
  });
  return item;
}

function dialogs() {
  const asked: Array<{ name: string; answer: (path: string | null) => void }> = [];
  const askSavePath = vi.fn((name: string) => new Promise<string | null>((resolve) => { asked.push({ name, answer: resolve }); }));
  return { asked, askSavePath };
}

const settled = afterQueuedCallbacks;
const doneState = (download: { once(event: "done", listener: (event: unknown, state: string) => void): unknown }) =>
  new Promise<string>((resolve) => { download.once("done", (_event, state) => resolve(state)); });
// The state `done` reports, with what it says became of the staged file.
const doneOutcome = (download: Observed) =>
  new Promise<{ state: string; cleanup: string }>((resolve) => { download.once("done", (_event, state, cleanup) => resolve({ state, cleanup })); });
const stagingPath = () => join(aveHomeDir, "browser-downloads");

// The staging root with some of its file operations replaced: the rest still run for real, natively on macOS and Windows.
const withFiles = (root: Root, change: (files: Files) => Partial<Files>): Root => ({ ...root, files: { ...root.files, ...change(root.files) } });
// Every rename reports another volume, so publication takes the real copy through a temporary file.
const acrossVolumes = (root: Root): Root => withFiles(root, () => ({ move: async () => "cross-volume" as const }));
// Runs `at` once, when the operation of that kind reaches `step` with its directories held, right before it acts.
const atStep = (root: Root, operation: "move" | "copy" | "remove", step: Step, at: (detail: { part?: string }) => void): Root =>
  withFiles(root, (files) => {
    let fired = false;
    const wrap = (proceed: (step: Step) => boolean, detail: { part?: string }) => (reached: Step) => {
      if (!fired && reached === step) {
        fired = true;
        at(detail);
      }
      return proceed(reached);
    };
    if (operation === "move") return { move: (from, name, to, target, proceed, stop) => files.move(from, name, to, target, wrap(proceed, {}), stop) };
    if (operation === "copy") {
      return { copy: (from, name, to, target, part, proceed, stop) => files.copy(from, name, to, target, part, wrap(proceed, { part }), stop) };
    }
    return { remove: (directory, name, proceed, stop) => files.remove(directory, name, wrap(proceed, {}), stop) };
  });

// The host names a file only through a held directory: on Linux a /proc/self/fd entry of the held descriptor, and on macOS and Windows
// never at all, since the helper performs every step.
function expectOnlyHeldPathOperations(): void {
  if (process.platform === "linux") for (const path of hooks.pathOperations) expect(path).toMatch(/^\/proc\/self\/fd\/\d+\//);
  else expect(hooks.pathOperations).toEqual([]);
}

/**
 * Move `directory` aside and put a link to `elsewhere` at its path, while an operation holds it or a folder below it. Windows refuses the
 * move, since the held handles share no delete access; elsewhere the move succeeds. Returns where the held directory now is.
 */
function substitute(directory: string, elsewhere: string): string {
  const aside = `${directory}-moved`;
  if (process.platform === "win32") {
    expect(() => moveAside(directory, aside)).toThrow(/EBUSY|EPERM|EACCES/);
    return directory;
  }
  moveAside(directory, aside);
  symlinkSync(elsewhere, directory, linkKind);
  return aside;
}

describe("the staging folder", () => {
  it("is created private under the Ave home, narrowed when it was left wider, and denied to tools", () => {
    const root = prepare();
    expect(root.path).toBe(stagingPath());
    if (process.platform !== "win32") {
      expect(statSync(root.path).mode & 0o777).toBe(0o700);
      chmodSync(root.path, 0o755);
      prepare();
      expect(statSync(root.path).mode & 0o777).toBe(0o700);
    }
    const staged = join(root.path, "0123456789abcdef0123456789abcdef");
    expect(isAdmissionDeniedPath(staged, "read")).not.toBeNull();
    expect(isAdmissionDeniedPath(staged, "write")).not.toBeNull();
    expect(isSensitivePath(staged, "read")).not.toBeNull();
  });

  it("refuses every download when the native helper that moves files is missing, and never falls back to paths", () => {
    const empty = join(home, "no-resources");
    mkdirSync(empty);
    if (process.platform === "linux") {
      // Linux needs no helper: its steps go through the held descriptor itself.
      expect(prepareBrowserDownloadStaging(empty).path).toBe(stagingPath());
      return;
    }
    expect(() => prepareBrowserDownloadStaging(empty)).toThrow(BrowserDownloadStagingError);
    expect(() => prepareBrowserDownloadStaging(empty)).toThrow(/download file helper .+ cannot be used: it is missing/);
    // The private folder is still made, and narrowed, so what confined lanes are denied does not depend on the helper.
    expect(statSync(stagingPath()).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      chmodSync(stagingPath(), 0o755);
      expect(() => prepareBrowserDownloadStaging(empty)).toThrow(BrowserDownloadStagingError);
      expect(statSync(stagingPath()).mode & 0o777).toBe(0o700);
    }
  });

  it.runIf(process.platform === "darwin")("refuses every download when the helper is there but cannot run", async () => {
    const broken = join(home, "broken-resources");
    const helper = join(broken, "macos-dir-ops", process.arch, "ave-dir-ops");
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, readFileSync(join(RESOURCES, "macos-dir-ops", process.arch, "ave-dir-ops")), { mode: 0o644 });
    const root = prepareBrowserDownloadStaging(broken);
    await expect(sweepBrowserDownloadStaging(root)).rejects.toThrow(BrowserDownloadStagingError);
    await expect(sweepBrowserDownloadStaging(root)).rejects.toThrow(/cannot be used: .*EACCES/);
  });

  it("is refused when it is a link, so the sweep never reaches the folder it points to", () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "the user's file");
    symlinkSync(elsewhere, stagingPath(), linkKind);
    expect(() => prepare()).toThrow(BrowserDownloadStagingError);
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("the user's file");
  });

  it("is refused once a folder above it is swapped for a link to another tree, so nothing there is removed", async () => {
    const root = prepare();
    const other = join(home, "other-tree");
    mkdirSync(join(other, "browser-downloads"), { recursive: true });
    writeFileSync(join(other, "browser-downloads", "keep.txt"), "the user's file");
    moveAside(aveHomeDir, join(home, "ave-home-moved"));
    symlinkSync(other, aveHomeDir, linkKind);
    await expect(sweepBrowserDownloadStaging(root)).rejects.toThrow(BrowserDownloadStagingError);
    expect(() => stageBrowserDownload(fakeItem(), { root, askSavePath: dialogs().askSavePath }, Promise.resolve())).toThrow(BrowserDownloadStagingError);
    expect(readFileSync(join(other, "browser-downloads", "keep.txt"), "utf8")).toBe("the user's file");
  });

  it("removes at boot only the staged files a previous run left behind, and refuses a folder replaced since it was verified", async () => {
    const root = prepare();
    expect(await sweepBrowserDownloadStaging(root)).toBe(0);
    const outside = join(home, "outside-target.txt");
    writeFileSync(outside, "the user's file");
    mkdirSync(join(root.path, "kept"));
    writeFileSync(join(root.path, "0123456789abcdef0123456789abcdef"), "left");
    writeFileSync(join(root.path, "0123456789abcdef0123456789abcdef.crdownload"), "left");
    symlinkSync(outside, join(root.path, "fedcba9876543210fedcba9876543210"));
    expect(await sweepBrowserDownloadStaging(root)).toBe(3);
    expect(readdirSync(root.path)).toEqual(["kept"]);
    expect(readFileSync(outside, "utf8")).toBe("the user's file");
    expectOnlyHeldPathOperations();

    // The verified folder is moved away and a link to another folder put in its place.
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "the user's file");
    moveAside(root.path, join(home, "moved"));
    symlinkSync(elsewhere, root.path, linkKind);
    await expect(sweepBrowserDownloadStaging(root)).rejects.toThrow(BrowserDownloadStagingError);
    expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("the user's file");
  });
});

describe("a staged download", () => {
  it("writes to an unguessable file in the staging folder and stays paused until its Save dialog is answered", async () => {
    const root = prepare();
    const { asked, askSavePath } = dialogs();
    const first = fakeItem();
    const second = fakeItem();
    stageBrowserDownload(first, { root, askSavePath }, Promise.resolve());
    stageBrowserDownload(second, { root, askSavePath }, Promise.resolve());
    expect(dirname(first.path)).toBe(root.path);
    expect(basename(first.path)).toMatch(/^[0-9a-f]{32}$/);
    expect(first.path).not.toBe(second.path);
    expect(first.pause).toHaveBeenCalledOnce();
    await settled();
    expect(first.resume).not.toHaveBeenCalled();
    asked[0]?.answer(join(home, "report.pdf"));
    await settled();
    expect(first.resume).toHaveBeenCalledOnce();
  });

  it("shows concurrent downloads' Save dialogs one at a time and saves both where the user chose", async () => {
    const root = prepare();
    const { asked, askSavePath } = dialogs();
    const first = fakeItem("one.bin");
    const second = fakeItem("two.bin");
    const one = stageBrowserDownload(first, { root, askSavePath }, Promise.resolve());
    const two = stageBrowserDownload(second, { root, askSavePath }, one.answered.then(() => undefined));
    const firstDone = doneOutcome(one.download);
    const secondDone = doneOutcome(two.download);
    await settled();
    expect(asked.map((dialog) => dialog.name)).toEqual(["one.bin"]);
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "one.bin"));
    await one.answered;
    await settled();
    expect(asked.map((dialog) => dialog.name)).toEqual(["one.bin", "two.bin"]);
    asked[1]?.answer(join(chosen, "two.bin"));
    await settled();
    second.complete("second file");
    first.complete("first file");
    expect(await secondDone).toEqual({ state: "completed", cleanup: "removed" });
    expect(await firstDone).toEqual({ state: "completed", cleanup: "removed" });
    expect(readFileSync(join(chosen, "one.bin"), "utf8")).toBe("first file");
    expect(readFileSync(join(chosen, "two.bin"), "utf8")).toBe("second file");
    expect(one.download.getSavePath()).toBe(join(chosen, "one.bin"));
    expect(readdirSync(root.path)).toEqual([]);
    expectOnlyHeldPathOperations();
  });

  it("removes the staged file and reports cancelled when the dialog is closed without a path", async () => {
    const root = prepare();
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneOutcome(staged.download);
    writeFileSync(item.path, "partial");
    await settled();
    asked[0]?.answer(null);
    expect(await staged.answered).toBe(false);
    expect(await done).toEqual({ state: "cancelled", cleanup: "removed" });
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(existsSync(item.path)).toBe(false);
    expectOnlyHeldPathOperations();
  });

  it("removes the staged file and reports the failure when the download fails before its turn", async () => {
    const root = prepare();
    const { asked, askSavePath } = dialogs();
    let release!: () => void;
    const failing = fakeItem();
    const staged = stageBrowserDownload(failing, { root, askSavePath }, new Promise<void>((resolve) => { release = resolve; }));
    const done = doneOutcome(staged.download);
    writeFileSync(failing.path, "partial");
    failing.end("interrupted");
    expect(await done).toEqual({ state: "interrupted", cleanup: "removed" });
    expect(existsSync(failing.path)).toBe(false);
    release();
    expect(await staged.answered).toBe(false);
    expect(asked).toHaveLength(0);
  });

  it("stops a download that keeps writing before its dialog is answered, without touching another", async () => {
    const root = prepare();
    const { askSavePath } = dialogs();
    const onOverLimit = vi.fn();
    const runaway = fakeItem("runaway.bin");
    const quiet = fakeItem("quiet.bin");
    const stopped = stageBrowserDownload(runaway, { root, askSavePath, onOverLimit }, new Promise(() => {}));
    const other = stageBrowserDownload(quiet, { root, askSavePath, onOverLimit }, new Promise(() => {}));
    const done = doneState(stopped.download);
    writeFileSync(runaway.path, "partial");
    writeFileSync(quiet.path, "partial");
    runaway.received = UNANSWERED_DOWNLOAD_BYTES + 1;
    runaway.emit("updated", {}, "progressing");
    expect(await done).toBe("interrupted");
    expect(runaway.cancel).toHaveBeenCalledOnce();
    expect(onOverLimit).toHaveBeenCalledOnce();
    expect(existsSync(runaway.path)).toBe(false);
    let otherEnded = false;
    other.download.once("done", () => { otherEnded = true; });
    await settled();
    expect(quiet.cancel).not.toHaveBeenCalled();
    expect(otherEnded).toBe(false);
    expect(existsSync(quiet.path)).toBe(true);
  });

  it("refuses a destination that is a link, or whose folder was replaced after the answer, and writes nothing through it", async () => {
    const root = prepare();
    const target = join(home, "target.txt");
    writeFileSync(target, "the user's file");
    const chosen = join(home, "chosen");
    mkdirSync(chosen);

    // A link at the chosen name.
    const linked = fakeItem();
    const first = dialogs();
    const one = stageBrowserDownload(linked, { root, askSavePath: first.askSavePath }, Promise.resolve());
    const oneDone = doneState(one.download);
    symlinkSync(target, join(chosen, "linked.pdf"));
    await settled();
    first.asked[0]?.answer(join(chosen, "linked.pdf"));
    expect(await oneDone).toBe("interrupted");

    // A link planted at the name after the answer, before the file is put in place.
    const planted = fakeItem();
    const second = dialogs();
    const two = stageBrowserDownload(planted, { root, askSavePath: second.askSavePath }, Promise.resolve());
    const twoDone = doneState(two.download);
    await settled();
    second.asked[0]?.answer(join(chosen, "planted.pdf"));
    await settled();
    symlinkSync(target, join(chosen, "planted.pdf"));
    planted.complete("page data");
    expect(await twoDone).toBe("interrupted");

    // The chosen folder replaced by a link after the answer.
    const moved = fakeItem();
    const third = dialogs();
    const three = stageBrowserDownload(moved, { root, askSavePath: third.askSavePath }, Promise.resolve());
    const threeDone = doneState(three.download);
    await settled();
    third.asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    moveAside(chosen, join(home, "chosen-moved"));
    symlinkSync(elsewhere, chosen, linkKind);
    moved.complete("page data");
    expect(await threeDone).toBe("interrupted");

    expect(readFileSync(target, "utf8")).toBe("the user's file");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readdirSync(root.path)).toEqual([]);
  });

  it("copies across volumes through a private temporary file, then removes the staged copy", async () => {
    const root = acrossVolumes(prepare());
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneOutcome(staged.download);
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    item.complete("across");
    expect(await done).toEqual({ state: "completed", cleanup: "removed" });
    expect(readFileSync(join(chosen, "report.pdf"), "utf8")).toBe("across");
    expect(readdirSync(chosen)).toEqual(["report.pdf"]);
    expect(readdirSync(root.path)).toEqual([]);
    expectOnlyHeldPathOperations();
  });

  it.each(["create", "commit"] as const)("answers a cancel during a cross-volume copy (at %s) only once the copy has stopped, leaving nothing at the chosen path", async (when) => {
    const prepared = acrossVolumes(prepare());
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const states: string[] = [];
    let reportedBeforeCopyStopped = true;
    let download!: import("../browser-download-staging.js").ObservedDownload;
    const root = atStep(prepared, "copy", when === "create" ? "ready" : "copied", () => {
      download.cancel();
      reportedBeforeCopyStopped = states.length > 0;
    });
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    download = staged.download;
    const done = doneState(staged.download).then((state) => { states.push(state); return state; });
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    item.complete("x".repeat(3 * 1024 * 1024));
    expect(await done).toBe("cancelled");
    expect(reportedBeforeCopyStopped).toBe(false);
    expect(staged.download.getSavePath()).toBe("");
    expect(readdirSync(chosen)).toEqual([]);
    expect(readdirSync(prepared.path)).toEqual([]);
  });

  it("refuses to stage once the folder was replaced since it was verified", () => {
    const root = prepare();
    moveAside(root.path, join(home, "moved"));
    mkdirSync(root.path);
    expect(() => stageBrowserDownload(fakeItem(), { root, askSavePath: dialogs().askSavePath }, Promise.resolve())).toThrow(BrowserDownloadStagingError);
  });
});

// A removal of the staged file that does not succeed: `done` says so, and the next start's sweep removes what was left.
describe("what `done` reports when the staged file cannot be removed", () => {
  const failingRemoval = (root: Root, error: Error): Root => withFiles(root, () => ({ remove: async () => { throw error; } }));
  const faults = [
    ["the removal fails", () => Object.assign(new Error("EIO: simulated"), { code: "EIO" }), "remove-failed"],
    ["its helper is killed and seen to end", () => new HeldFileHelperStalledError("/helper", "said nothing for 1 ms", false), "remove-failed"],
    ["its helper is killed but not seen to end", () => new HeldFileHelperStalledError("/helper", "said nothing for 1 ms", true), "helper-still-running"],
  ] as const;

  // The helper may answer `cancelled` though it was let proceed; nothing is claimed removed.
  it("reports a closed dialog's staged file as not removed when its removal answers cancelled", async () => {
    const prepared = prepare();
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const root = withFiles(prepared, () => ({ remove: async () => "cancelled" as const }));
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneOutcome(staged.download);
    writeFileSync(item.path, "partial");
    await settled();
    asked[0]?.answer(null);
    expect(await done).toEqual({ state: "cancelled", cleanup: "remove-failed" });
    expect(readdirSync(prepared.path)).toEqual([basename(item.path)]);
  });

  it.each(faults)("reports a closed dialog's staged file as not removed when %s", async (_case, fault, cleanup) => {
    const prepared = prepare();
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root: failingRemoval(prepared, fault()), askSavePath }, Promise.resolve());
    const done = doneOutcome(staged.download);
    writeFileSync(item.path, "partial");
    await settled();
    asked[0]?.answer(null);
    expect(await done).toEqual({ state: "cancelled", cleanup });
    expect(readdirSync(prepared.path)).toEqual([basename(item.path)]);
    expect(await sweepBrowserDownloadStaging(prepared)).toBe(1);
    expect(readdirSync(prepared.path)).toEqual([]);
  });

  it.each(faults)("reports a saved cross-volume copy's staged file as not removed when %s", async (_case, fault, cleanup) => {
    const prepared = prepare();
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root: acrossVolumes(failingRemoval(prepared, fault())), askSavePath }, Promise.resolve());
    const done = doneOutcome(staged.download);
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    item.complete("across");
    expect(await done).toEqual({ state: "completed", cleanup });
    expect(readFileSync(join(chosen, "report.pdf"), "utf8")).toBe("across");
    expect(readdirSync(prepared.path)).toEqual([basename(item.path)]);
    expect(await sweepBrowserDownloadStaging(prepared)).toBe(1);
    expect(readdirSync(prepared.path)).toEqual([]);
  });
});

// A cross-volume copy whose helper stalled and was not seen to end (browser-download-files.test.ts drives that helper): the native helper
// removes its recorded temporary file once that helper ends, or at the next start, and only while it is still the file the copy wrote.
describe("a stalled copy's temporary file, removed through the native helper", () => {
  const stalledCopy = async () => {
    const prepared = prepare();
    let end!: () => void;
    const exited = new Promise<void>((resolve) => { end = resolve; });
    const removed: string[] = [];
    let onRemoved = (): void => {};
    const root = withFiles(acrossVolumes(prepared), (files) => ({
      copy: async (_from, _name, to, _target, part) => {
        writeFileSync(join(to.path, part), "partial copy");
        const info = statSync(join(to.path, part), { bigint: true });
        const error = new HeldFileHelperStalledError("/helper", "did not end within 1 ms of being stopped", true);
        Object.assign(error, { passed: "ready", partialCopy: "left", exited, partFile: { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs } });
        throw error;
      },
      remove: async (directory, name, proceed, stop) => {
        try {
          return await files.remove(directory, name, proceed, stop);
        } finally {
          removed.push(name);
          onRemoved();
        }
      },
    }));
    const removalOf = (name: string) => new Promise<void>((resolve) => {
      const check = (): void => { if (removed.includes(name)) resolve(); else onRemoved = check; };
      check();
    });
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneOutcome(staged.download);
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    item.complete("across");
    expect(await done).toEqual({ state: "interrupted", cleanup: "part-left" });
    const [part] = readdirSync(chosen);
    const records = readdirSync(prepared.path);
    expect(records).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.cleanup\.json$/u)]);
    return { prepared, chosen, part: join(chosen, part ?? ""), record: records[0] ?? "", end, removalOf };
  };

  it("sees the temporary file's identity while the native helper still holds it", async () => {
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    let identity: bigint | undefined;
    const root = atStep(acrossVolumes(prepare()), "copy", "copied", ({ part }) => { identity = statSync(join(chosen, part ?? ""), { bigint: true }).ino; });
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneOutcome(staged.download);
    await settled();
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    item.complete("across");
    expect(await done).toEqual({ state: "completed", cleanup: "removed" });
    expect(identity).toBeGreaterThan(0n);
  });

  it("removes it once the stalled helper is seen to end, and then its record", async () => {
    const { prepared, part, record, end, removalOf } = await stalledCopy();
    expect(readFileSync(part, "utf8")).toBe("partial copy");
    end();
    await removalOf(record);
    expect(existsSync(part)).toBe(false);
    expect(readdirSync(prepared.path)).toEqual([]);
  });

  it("leaves it while the helper never ends, and the next start's sweep removes it", async () => {
    const { prepared, chosen, part, record, end, removalOf } = await stalledCopy();
    expect(await sweepBrowserDownloadStaging(prepared)).toBe(1);
    expect(existsSync(part)).toBe(false);
    expect(readdirSync(prepared.path)).toEqual([]);
    end();
    await removalOf(record);
    expect(readdirSync(chosen)).toEqual([]);
  });

  it("never removes a file put over the temporary file's name, when the helper ends or at the next start", async () => {
    const { prepared, chosen, part, end } = await stalledCopy();
    const mine = join(chosen, "mine.txt");
    writeFileSync(mine, "the user's file");
    moveAside(mine, part);
    end();
    await settled();
    expect(readFileSync(part, "utf8")).toBe("the user's file");
    expect(readdirSync(prepared.path)).toHaveLength(1);
    expect(await sweepBrowserDownloadStaging(prepared)).toBe(1);
    expect(readFileSync(part, "utf8")).toBe("the user's file");
    expect(readdirSync(prepared.path)).toEqual([]);
  });
});

describe("a staging folder that cannot be verified", () => {
  it.each(["EACCES", "EPERM", "ENOTDIR", "ELOOP", "ENOENT"])("is a staging refusal at start when checking it fails with %s", (code) => {
    hooks.checkFault = { path: stagingPath(), code };
    expect(() => prepare()).toThrow(BrowserDownloadStagingError);
  });

  it("refuses to stage once the folder is gone or has become a link, as a staging refusal", () => {
    const root = prepare();
    rmSync(root.path, { recursive: true });
    expect(() => stageBrowserDownload(fakeItem(), { root, askSavePath: dialogs().askSavePath }, Promise.resolve())).toThrow(BrowserDownloadStagingError);
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, root.path, linkKind);
    expect(() => stageBrowserDownload(fakeItem(), { root, askSavePath: dialogs().askSavePath }, Promise.resolve())).toThrow(BrowserDownloadStagingError);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("lets an error that is not a verification result through unchanged", () => {
    hooks.checkFault = { path: stagingPath(), code: "EMFILE" };
    let thrown: unknown;
    try { prepare(); } catch (error) { thrown = error; }
    expect(thrown).not.toBeInstanceOf(BrowserDownloadStagingError);
    expect((thrown as NodeJS.ErrnoException).code).toBe("EMFILE");
  });
});

// A staged download whose staging folder is swapped before an operation starts: the verified folder moved away and its path, or the Ave
// home above it, made a link to a tree holding a file of the staged download's own name. Nothing in that tree may be removed or written.
describe("cleanup and publication after the staging folder is swapped", () => {
  type Swap = "folder" | "parent";
  const swapStaging = (swap: Swap, name: string): string => {
    const other = join(home, "other-tree");
    const lookalike = swap === "folder" ? other : join(other, "browser-downloads");
    mkdirSync(lookalike, { recursive: true });
    writeFileSync(join(lookalike, name), "the user's file");
    if (swap === "folder") {
      moveAside(stagingPath(), join(home, "staging-moved"));
      symlinkSync(other, stagingPath(), linkKind);
    } else {
      moveAside(aveHomeDir, join(home, "ave-home-moved"));
      symlinkSync(other, aveHomeDir, linkKind);
    }
    return join(lookalike, name);
  };

  it.each(["folder", "parent"] as const)("a cancel after the %s was swapped leaves the file of that name in the other tree", async (swap) => {
    const root = prepare();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath: dialogs().askSavePath }, new Promise(() => {}));
    const done = doneOutcome(staged.download);
    writeFileSync(item.path, "partial");
    const lookalike = swapStaging(swap, basename(item.path));
    expect(() => staged.download.cancel()).not.toThrow();
    // The file is left in the folder that was verified, and `done` does not claim it removed.
    expect(await done).toEqual({ state: "cancelled", cleanup: "remove-failed" });
    expect(readFileSync(lookalike, "utf8")).toBe("the user's file");
  });

  it.each(["folder", "parent"] as const)("a closed dialog or the unanswered limit after the %s was swapped removes nothing there", async (swap) => {
    const root = prepare();
    const closed = fakeItem("closed.bin");
    const runaway = fakeItem("runaway.bin");
    const dialog = dialogs();
    const one = stageBrowserDownload(closed, { root, askSavePath: dialog.askSavePath }, Promise.resolve());
    const two = stageBrowserDownload(runaway, { root, askSavePath: dialogs().askSavePath }, new Promise(() => {}));
    const oneDone = doneState(one.download);
    const twoDone = doneState(two.download);
    await settled();
    const first = swapStaging(swap, basename(closed.path));
    const lookalikeDir = dirname(first);
    writeFileSync(join(lookalikeDir, basename(runaway.path)), "the user's other file");
    dialog.asked[0]?.answer(null);
    runaway.received = UNANSWERED_DOWNLOAD_BYTES + 1;
    runaway.emit("updated", {}, "progressing");
    expect(await oneDone).toBe("cancelled");
    expect(await twoDone).toBe("interrupted");
    expect(readFileSync(first, "utf8")).toBe("the user's file");
    expect(readFileSync(join(lookalikeDir, basename(runaway.path)), "utf8")).toBe("the user's other file");
  });

  it.each(["folder", "parent"] as const)("a download completing after the %s was swapped during the Save wait is refused and touches nothing there", async (swap) => {
    const root = prepare();
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneState(staged.download);
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    writeFileSync(item.path, "page data");
    const lookalike = swapStaging(swap, basename(item.path));
    item.end("completed");
    expect(await done).toBe("interrupted");
    expect(readFileSync(lookalike, "utf8")).toBe("the user's file");
    expect(readdirSync(chosen)).toEqual([]);
  });
});

// The swap lands after an operation has opened and checked its directories, at the last moment before it acts: the staging folder, the
// chosen folder, or a folder above either is moved away and its path made a link to another tree. The operation acts on the directories
// it holds, never through the link: on Windows the move itself is refused while they are held, elsewhere it lands in the moved folder.
describe("the final operation boundary", () => {
  type Held = "chosen folder" | "folder above the chosen folder";
  // A chosen folder under a parent, as the user picked it, and a lookalike tree for a link to point at.
  const chosenTree = () => {
    const parent = join(home, "workspace");
    const chosen = join(parent, "downloads");
    mkdirSync(chosen, { recursive: true });
    const otherParent = join(home, "other-workspace");
    const otherChosen = join(otherParent, "downloads");
    mkdirSync(otherChosen, { recursive: true });
    return { parent, chosen, otherParent, otherChosen };
  };
  // Swap the held chosen folder, or the folder above it; returns where the held chosen folder now is.
  const swapChosen = (held: Held, tree: ReturnType<typeof chosenTree>): string => {
    if (held === "chosen folder") return substitute(tree.chosen, tree.otherChosen);
    return join(substitute(tree.parent, tree.otherParent), "downloads");
  };
  const answered = async (root: Root, tree: ReturnType<typeof chosenTree>) => {
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneState(staged.download);
    await settled();
    asked[0]?.answer(join(tree.chosen, "report.pdf"));
    await settled();
    return { item, staged, done };
  };

  it.each(["chosen folder", "folder above the chosen folder"] as const)("publication by rename lands in the held %s", async (held) => {
    const tree = chosenTree();
    let now = "";
    const root = atStep(prepare(), "move", "ready", () => { now = swapChosen(held, tree); });
    const { item, done } = await answered(root, tree);
    item.complete("page data");
    expect(await done).toBe("completed");
    expect(readFileSync(join(now, "report.pdf"), "utf8")).toBe("page data");
    expect(readdirSync(tree.otherChosen)).toEqual([]);
    expect(readdirSync(root.path)).toEqual([]);
    expectOnlyHeldPathOperations();
  });

  it.each(["chosen folder", "folder above the chosen folder"] as const)("the temporary file of a cross-volume copy is created in the held %s", async (held) => {
    const tree = chosenTree();
    let now = "";
    let part = "";
    const root = atStep(atStep(acrossVolumes(prepare()), "copy", "ready", () => { now = swapChosen(held, tree); }), "copy", "copied", (detail) => {
      part = detail.part ?? "";
      // The copy is complete and synced in the held folder, and nothing was created through the link.
      expect(readdirSync(now)).toEqual([part]);
      expect(readdirSync(tree.otherChosen)).toEqual([]);
    });
    const { item, done } = await answered(root, tree);
    item.complete("page data");
    expect(await done).toBe("completed");
    expect(part).toMatch(/^\.[0-9a-f]{32}\.part$/);
    expect(readdirSync(now)).toEqual(["report.pdf"]);
    expect(readFileSync(join(now, "report.pdf"), "utf8")).toBe("page data");
    expect(readdirSync(tree.otherChosen)).toEqual([]);
    expectOnlyHeldPathOperations();
  });

  it.each(["chosen folder", "folder above the chosen folder"] as const)("the commit rename of a cross-volume copy lands in the held %s", async (held) => {
    const tree = chosenTree();
    let now = "";
    const root = atStep(acrossVolumes(prepare()), "copy", "copied", () => { now = swapChosen(held, tree); });
    const { item, done } = await answered(root, tree);
    item.complete("page data");
    expect(await done).toBe("completed");
    expect(readdirSync(now)).toEqual(["report.pdf"]);
    expect(readFileSync(join(now, "report.pdf"), "utf8")).toBe("page data");
    expect(readdirSync(tree.otherChosen)).toEqual([]);
  });

  it.each(["chosen folder", "folder above the chosen folder"] as const)("a cancelled copy removes its temporary file from the held %s and nothing of that name elsewhere", async (held) => {
    const tree = chosenTree();
    let now = "";
    let download!: import("../browser-download-staging.js").ObservedDownload;
    const root = atStep(acrossVolumes(prepare()), "copy", "copied", (detail) => {
      now = swapChosen(held, tree);
      writeFileSync(join(tree.otherChosen, detail.part ?? ""), "the user's file");
      download.cancel();
    });
    const { item, staged, done } = await answered(root, tree);
    download = staged.download;
    item.complete("page data");
    expect(await done).toBe("cancelled");
    expect(readdirSync(now)).toEqual([]);
    const lookalikes = readdirSync(tree.otherChosen);
    expect(lookalikes).toEqual([expect.stringMatching(/^\.[0-9a-f]{32}\.part$/)]);
    expect(readFileSync(join(tree.otherChosen, String(lookalikes[0])), "utf8")).toBe("the user's file");
    expect(readdirSync(root.path)).toEqual([]);
  });

  it.each(["staging folder", "Ave home"] as const)("removing a cancelled download's staged file acts in the held %s and leaves the file of that name elsewhere", async (held) => {
    const other = join(home, "other-tree");
    let lookalike = "";
    let now = "";
    const root = atStep(prepare(), "remove", "ready", () => {
      const lookalikeDir = held === "staging folder" ? other : join(other, "browser-downloads");
      mkdirSync(lookalikeDir, { recursive: true });
      lookalike = join(lookalikeDir, basename(item.path));
      writeFileSync(lookalike, "the user's file");
      now = held === "staging folder" ? substitute(stagingPath(), other) : join(substitute(aveHomeDir, other), "browser-downloads");
    });
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath: dialogs().askSavePath }, new Promise(() => {}));
    const done = doneState(staged.download);
    writeFileSync(item.path, "partial");
    staged.download.cancel();
    expect(await done).toBe("cancelled");
    expect(readdirSync(now)).toEqual([]);
    expect(readFileSync(lookalike, "utf8")).toBe("the user's file");
    expectOnlyHeldPathOperations();
  });

  it.each(["staging folder", "Ave home"] as const)("a publishing rename takes the staged file from the held %s, not a file of that name elsewhere", async (held) => {
    const tree = chosenTree();
    const other = join(home, "other-tree");
    let lookalike = "";
    let item!: ReturnType<typeof fakeItem>;
    const root = atStep(prepare(), "move", "ready", () => {
      const lookalikeDir = held === "staging folder" ? other : join(other, "browser-downloads");
      mkdirSync(lookalikeDir, { recursive: true });
      lookalike = join(lookalikeDir, basename(item.path));
      writeFileSync(lookalike, "the user's file");
      if (held === "staging folder") substitute(stagingPath(), other);
      else substitute(aveHomeDir, other);
    });
    const answer = await answered(root, tree);
    item = answer.item;
    item.complete("page data");
    expect(await answer.done).toBe("completed");
    expect(readFileSync(join(tree.chosen, "report.pdf"), "utf8")).toBe("page data");
    expect(readFileSync(lookalike, "utf8")).toBe("the user's file");
  });
});

// Writes that take only part of what they are given, or nothing: on Linux through the copy's file handle, on macOS through the helper's
// test builds (scripts/build-macos-dir-ops.mjs --test-builds). Windows has no such build of its helper.
describe.runIf(process.platform !== "win32")("a cross-volume copy whose writes fall short", () => {
  const faulty = (root: Root, fault: "short-writes" | "stalled-writes"): Root => {
    if (process.platform === "linux") {
      hooks.writeLimit = fault === "short-writes" ? 4093 : 0;
      return acrossVolumes(root);
    }
    const files = _helperFileOperationsForTest(join(RESOURCES, "macos-dir-ops", process.arch, `ave-dir-ops-${fault}`));
    return acrossVolumes({ ...root, files });
  };
  const answered = async (fault: "short-writes" | "stalled-writes") => {
    const root = faulty(prepare(), fault);
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneState(staged.download);
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    return { root, item, done, chosen };
  };

  it("writes every byte when each write takes only part of what it was given", async () => {
    const { root, item, done, chosen } = await answered("short-writes");
    // Several copy chunks, none a multiple of the short write.
    const content = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 4099 }, (_, index) => index % 251));
    item.complete(content);
    expect(await done).toBe("completed");
    expect(readFileSync(join(chosen, "report.pdf")).equals(content)).toBe(true);
    expect(readdirSync(chosen)).toEqual(["report.pdf"]);
    expect(readdirSync(root.path)).toEqual([]);
  });

  it("fails without publishing anything when a write makes no progress", async () => {
    const { root, item, done, chosen } = await answered("stalled-writes");
    item.complete("ABCDEFGH");
    expect(await done).toBe("interrupted");
    expect(readdirSync(chosen)).toEqual([]);
    expect(readdirSync(root.path)).toEqual([]);
  });
});

// A helper that hangs, through the macOS helper's test builds: one never says `ready`, and one copies slowly, ignores every request to stop
// and never answers after `copied`. Each publication must end within the stall bound with its helper gone, and nothing may reach the
// chosen folder afterwards. Linux has no helper, and Windows has no such build of its own (browser-download-files.test.ts covers the client).
describe.runIf(process.platform === "darwin")("a native helper that stops answering", () => {
  // Wide enough that a loaded host still delivers each 100 ms progress line of the hang build in time; the ceilings below are this bound
  // plus the kill wait, with room for starting each helper.
  const BOUNDS = { stallMs: 1_000, killMs: 2_000 };
  const helperBuild = (fault: "never-ready" | "ignores-eof"): string => join(RESOURCES, "macos-dir-ops", process.arch, `ave-dir-ops-${fault}`);
  const hanging = (root: Root, fault: "never-ready" | "ignores-eof"): Root => ({ ...root, files: _helperFileOperationsForTest(helperBuild(fault), BOUNDS) });
  // Every helper this test started names a folder under its own temporary home, so none of them may still be in the process table.
  const helpersStillRunning = (): string[] => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n").filter((line) => line.includes("ave-dir-ops-") && line.includes(home));
  const publishing = async (root: Root, content: Buffer) => {
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    const done = doneState(staged.download);
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    const started = performance.now();
    item.complete(content);
    return { download: staged.download, chosen, ended: done.then((state) => ({ state, ms: performance.now() - started })) };
  };
  // The hang build copies one 1 MiB chunk per 100 ms.
  const chunks = (count: number): Buffer => Buffer.alloc(count * 1024 * 1024, 7);
  const nothingPublishedLater = async (chosen: string) => {
    await new Promise((resolve) => { setTimeout(resolve, BOUNDS.stallMs * 2); });
    expect(readdirSync(chosen)).toEqual([]);
    expect(helpersStillRunning()).toEqual([]);
  };

  it("fails a move whose helper never says it is ready within the bound, kills it, and publishes nothing later", async () => {
    const root = hanging(prepare(), "never-ready");
    const { chosen, ended } = await publishing(root, chunks(1));
    const { state, ms } = await ended;
    expect(state).toBe("interrupted");
    // The move, then the removal of the staged file, each stall once and are killed.
    expect(ms).toBeGreaterThanOrEqual(2 * BOUNDS.stallMs);
    expect(ms).toBeLessThan(2 * (BOUNDS.stallMs + BOUNDS.killMs));
    expect(helpersStillRunning()).toEqual([]);
    expect(readdirSync(chosen)).toEqual([]);
    // The staged file is not claimed removed: it stays in the verified staging folder for the next start to sweep.
    expect(readdirSync(root.path)).toHaveLength(1);
    await nothingPublishedLater(chosen);
  });

  it("kills a copy that ignores a cancel while it copies, removes its temporary file, and publishes nothing later", async () => {
    const prepared = prepare();
    let cancel = (): void => {};
    let reachedReady = false;
    const root = atStep(acrossVolumes(hanging(prepared, "ignores-eof")), "copy", "ready", () => {
      reachedReady = true;
      setTimeout(() => cancel(), 150);
    });
    // 30 chunks take 3 s, so the cancel's deadline falls while bytes are still copied.
    const { download, chosen, ended } = await publishing(root, chunks(30));
    cancel = () => download.cancel();
    const { state, ms } = await ended;
    expect(reachedReady).toBe(true);
    expect(state).toBe("interrupted");
    expect(ms).toBeGreaterThanOrEqual(150 + BOUNDS.stallMs);
    expect(ms).toBeLessThan(3_000);
    expect(helpersStillRunning()).toEqual([]);
    expect(readdirSync(chosen)).toEqual([]);
    expect(readdirSync(prepared.path)).toEqual([]);
    await nothingPublishedLater(chosen);
  });

  it("removes a killed copy's temporary file only once it is moved aside and checked, through the helper", async () => {
    const prepared = prepare();
    let cancel = (): void => {};
    const root = atStep(acrossVolumes(hanging(prepared, "ignores-eof")), "copy", "ready", () => { setTimeout(() => cancel(), 150); });
    const { download, chosen, ended } = await publishing(root, chunks(30));
    const outcome = doneOutcome(download);
    cancel = () => download.cancel();
    expect((await ended).state).toBe("interrupted");
    expect(await outcome).toEqual({ state: "interrupted", cleanup: "removed" });
    const movedAside = hooks.pathOperations.filter((path) => dirname(path) === chosen && /^.[0-9a-f]{32}.removing$/u.test(basename(path)));
    expect(movedAside).toHaveLength(1);
    expect(readdirSync(chosen)).toEqual([]);
    expect(helpersStillRunning()).toEqual([]);
  });

  it.each([
    ["is cancelled at its commit", true],
    ["is let commit but never answers", false],
  ] as const)("kills a copy that never answers after `copied` and %s, removes its temporary file, and publishes nothing later", async (_case, cancelAtCommit) => {
    const prepared = prepare();
    let cancel = (): void => {};
    let reachedCopied = false;
    const root = atStep(acrossVolumes(hanging(prepared, "ignores-eof")), "copy", "copied", () => {
      reachedCopied = true;
      if (cancelAtCommit) cancel();
    });
    const { download, chosen, ended } = await publishing(root, chunks(2));
    cancel = () => download.cancel();
    const { state, ms } = await ended;
    expect(reachedCopied).toBe(true);
    expect(state).toBe("interrupted");
    expect(ms).toBeGreaterThanOrEqual(BOUNDS.stallMs);
    expect(ms).toBeLessThan(2 * 100 + BOUNDS.stallMs + BOUNDS.killMs + 2_000);
    expect(helpersStillRunning()).toEqual([]);
    expect(readdirSync(chosen)).toEqual([]);
    expect(readdirSync(prepared.path)).toEqual([]);
    await nothingPublishedLater(chosen);
  });

  it("kills a boot sweep whose helper never says it is ready, and waits for its exit before failing", async () => {
    const root = prepare();
    writeFileSync(join(root.path, "0123456789abcdef0123456789abcdef"), "left by a crash");
    const files = _helperFileOperationsForTest(helperBuild("never-ready"), BOUNDS);
    const started = performance.now();
    await expect(files.sweep(root)).rejects.toThrow(/said nothing for 1000 ms while holding its folders/);
    expect(performance.now() - started).toBeGreaterThanOrEqual(BOUNDS.stallMs);
    expect(helpersStillRunning()).toEqual([]);
    expect(readdirSync(root.path)).toHaveLength(1);
  });
});

// Exercise the native sweep directly at its held step; Linux sweeps in process.
describe.runIf(process.platform !== "linux")("the native sweep", () => {
  const helper = process.platform === "win32"
    ? join(RESOURCES, "windows-path-kind", process.arch, "ave-path-kind.exe")
    : join(RESOURCES, "macos-dir-ops", process.arch, "ave-dir-ops");

  it.each(["staging folder", "Ave home"] as const)("removes only from the held %s once it was swapped for a link to another tree", async (held) => {
    const root = prepare();
    const name = "0123456789abcdef0123456789abcdef";
    writeFileSync(join(root.path, name), "left by a crash");
    const other = join(home, "other-tree");
    const lookalikeDir = held === "staging folder" ? other : join(other, "browser-downloads");
    mkdirSync(lookalikeDir, { recursive: true });
    writeFileSync(join(lookalikeDir, name), "the user's file");
    const child = spawn(helper, ["--dir-sweep", root.path, root.dev.toString(), root.ino.toString()], { stdio: ["pipe", "pipe", "pipe"], env: {} });
    let output = "";
    const closed = new Promise<number | null>((resolve) => { child.once("close", resolve); });
    await new Promise<void>((resolve) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("ready")) resolve();
      });
    });
    const now = held === "staging folder" ? substitute(root.path, other) : join(substitute(aveHomeDir, other), "browser-downloads");
    child.stdin.end("c");
    expect(await closed).toBe(0);
    expect(output.split(/\r?\n/u).filter(Boolean)).toEqual(["ready", "swept 1"]);
    expect(readdirSync(now)).toEqual([]);
    expect(readFileSync(join(lookalikeDir, name), "utf8")).toBe("the user's file");
  });
});

describe("the native helper", () => {
  it("refuses a directory whose identity is not the one checked, without acting", async () => {
    const root = prepare();
    const staged = join(root.path, "0123456789abcdef0123456789abcdef");
    writeFileSync(staged, "staged");
    const other = join(home, "other");
    mkdirSync(other);
    const proceed = vi.fn(() => true);
    await expect(root.files.remove({ ...root, ino: root.ino + 1n }, basename(staged), proceed, new AbortController().signal)).rejects.toMatchObject({ refusal: "from" });
    expect(proceed).not.toHaveBeenCalled();
    expect(readFileSync(staged, "utf8")).toBe("staged");
    const folder = { path: other, dev: statSync(other, { bigint: true }).dev, ino: statSync(other, { bigint: true }).ino };
    await expect(root.files.move(root, basename(staged), { ...folder, dev: folder.dev + 1n }, "report.pdf", proceed, new AbortController().signal)).rejects.toMatchObject({ refusal: "to" });
    expect(proceed).not.toHaveBeenCalled();
    expect(readdirSync(other)).toEqual([]);
    removeEntry(staged);
  });

  it("stops an operation the caller does not let proceed, changing nothing", async () => {
    const root = prepare();
    const staged = join(root.path, "0123456789abcdef0123456789abcdef");
    writeFileSync(staged, "staged");
    const other = join(home, "other");
    mkdirSync(other);
    const info = statSync(other, { bigint: true });
    const folder = { path: other, dev: info.dev, ino: info.ino };
    const stop = new AbortController();
    expect(await root.files.move(root, basename(staged), folder, "report.pdf", () => false, stop.signal)).toBe("cancelled");
    expect(await root.files.copy(root, basename(staged), folder, "report.pdf", ".0123.part", () => false, stop.signal)).toBe("cancelled");
    expect(await root.files.remove(root, basename(staged), () => false, stop.signal)).toBe("cancelled");
    expect(readFileSync(staged, "utf8")).toBe("staged");
    expect(readdirSync(other)).toEqual([]);
  });
});

// The macOS helper removes a copy's temporary file only while it is the file the copy wrote: a file put at its name before the copy is
// cancelled, fails, or finds its target refused is left there, and the download reports its temporary file as left. Each case is proven
// against the helper's own file too, which is removed. `base` is a folder on the volume the chosen folder is on.
type Ending = "cancelled" | "failed" | "refused";
const ENDINGS = ["cancelled", "failed", "refused"] as const;
const theTarget: Record<Ending, string[]> = { cancelled: [], failed: ["report.pdf"], refused: ["report.pdf"] };
// A folder's entries, without the `._` entries a volume without extended attributes (exFAT) keeps them in.
const entriesOf = (folder: string): string[] => readdirSync(folder).filter((name) => !name.startsWith("._")).sort();
async function stoppedNativeCopy(ending: Ending, swap: boolean | "absent", base: string) {
  const chosen = join(base, "chosen");
  mkdirSync(chosen);
  const target = join(chosen, "report.pdf");
  // A target that cannot be replaced fails the commit rename (EPERM) and nothing before it.
  if (ending === "failed") {
    writeFileSync(target, "the user's report");
    execFileSync("chflags", ["uchg", target]);
  }
  let download!: import("../browser-download-staging.js").ObservedDownload;
  let swapped = "";
  const root = atStep(acrossVolumes(prepare()), "copy", "copied", ({ part }) => {
    if (swap === "absent") {
      removeEntry(join(chosen, part ?? ""));
    } else if (swap) {
      swapped = join(chosen, part ?? "");
      moveAside(swapped, join(base, "the copy's own file"));
      writeFileSync(swapped, "the user's file");
    }
    if (ending === "refused") mkdirSync(target);
    if (ending === "cancelled") download.cancel();
  });
  const { asked, askSavePath } = dialogs();
  const item = fakeItem();
  const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
  download = staged.download;
  const done = doneOutcome(staged.download);
  await settled();
  asked[0]?.answer(target);
  await settled();
  item.complete("page data");
  try {
    return { outcome: await done, chosen, swapped };
  } finally {
    if (ending === "failed") execFileSync("chflags", ["nouchg", target]);
  }
}

async function expectSwappedFileLeft(ending: Ending, base: string): Promise<void> {
  const { outcome, chosen, swapped } = await stoppedNativeCopy(ending, true, base);
  expect(readFileSync(swapped, "utf8")).toBe("the user's file");
  expect(entriesOf(chosen)).toEqual([basename(swapped), ...theTarget[ending]].sort());
  expect(outcome).toEqual({ state: "interrupted", cleanup: "part-left" });
}

async function expectOwnFileRemoved(ending: Ending, base: string): Promise<void> {
  const { outcome, chosen } = await stoppedNativeCopy(ending, false, base);
  expect(entriesOf(chosen)).toEqual(theTarget[ending]);
  expect(outcome).toEqual({ state: ending === "cancelled" ? "cancelled" : "interrupted", cleanup: "removed" });
}

describe.runIf(process.platform === "darwin")("a stopped native copy's temporary file swapped for another file", () => {
  it.each(ENDINGS)("leaves a file put at the temporary file's name when the copy is %s", (ending) => expectSwappedFileLeft(ending, home));
  it.each(ENDINGS)("removes its own temporary file when the copy is %s", (ending) => expectOwnFileRemoved(ending, home));
  it.each(ENDINGS)("reports no leftover when the temporary file is already absent and the copy is %s", async (ending) => {
    const { outcome, chosen } = await stoppedNativeCopy(ending, "absent", home);
    expect(entriesOf(chosen)).toEqual(theTarget[ending]);
    expect(outcome).toEqual({ state: ending === "cancelled" ? "cancelled" : "interrupted", cleanup: "removed" });
  });
});

// The same on a volume without an exclusive rename, where the helper moves the file aside under a name it checked is free and knows its own
// file by id and content: an exFAT disk image, created and attached for these tests.
describe.runIf(process.platform === "darwin")("a stopped native copy's temporary file on an exFAT volume", () => {
  let image = "";
  let mounted: string | null = null;
  let unavailable = "";
  beforeAll(() => {
    image = realpathSync(mkdtempSync(join(tmpdir(), "ave-download-exfat-")));
    const mountPoint = join(image, "volume");
    mkdirSync(mountPoint);
    try {
      execFileSync("hdiutil", ["create", "-size", "64m", "-fs", "ExFAT", "-volname", "AVETEST", "-o", join(image, "volume.dmg")], { stdio: "pipe" });
      execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mountPoint, join(image, "volume.dmg")], { stdio: "pipe" });
      mounted = mountPoint;
    } catch (error) {
      unavailable = `hdiutil cannot create or attach an exFAT image here: ${(error as Error).message.split("\n")[0]}`;
    }
  }, 60_000);
  afterAll(() => {
    if (mounted !== null) execFileSync("hdiutil", ["detach", "-force", mounted], { stdio: "pipe" });
    rmSync(image, { recursive: true, force: true });
  }, 60_000);
  let cases = 0;
  const onVolume = (skip: (note?: string) => never): string => {
    if (mounted === null) skip(unavailable);
    cases += 1;
    const base = join(mounted as string, `case-${cases}`);
    mkdirSync(base);
    return base;
  };

  it.for(ENDINGS)("leaves a file put at the temporary file's name when the copy is %s", (ending, { skip }) => expectSwappedFileLeft(ending, onVolume(skip)));
  it.for(ENDINGS)("removes its own temporary file when the copy is %s", (ending, { skip }) => expectOwnFileRemoved(ending, onVolume(skip)));
});

describe.runIf(process.platform === "linux")("a Linux copy whose temporary file cannot be removed when it stops", () => {
  it("reports the temporary file as left", async () => {
    const prepared = acrossVolumes(prepare());
    const { asked, askSavePath } = dialogs();
    const item = fakeItem();
    let download!: Observed;
    const root = atStep(prepared, "copy", "ready", () => {
      // The copy's file is moved aside to be checked and removed; that removal fails, and so does the hidden name's after it is put back.
      hooks.unlinkFault = /.removing$/u;
      download.cancel();
    });
    const staged = stageBrowserDownload(item, { root, askSavePath }, Promise.resolve());
    download = staged.download;
    const done = doneOutcome(staged.download);
    await settled();
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    asked[0]?.answer(join(chosen, "report.pdf"));
    await settled();
    item.complete("x".repeat(3 * 1024 * 1024));
    expect(await done).toEqual({ state: "interrupted", cleanup: "part-left" });
    const left = readdirSync(chosen);
    expect(left).toHaveLength(2);
    expect(left).toEqual(expect.arrayContaining([expect.stringMatching(/^.[0-9a-f]{32}.part$/u), expect.stringMatching(/^.[0-9a-f]{32}.removing$/u)]));
  });

  // A file put at the temporary file's name once the copy has written it, as a user or another program may.
  const swapAt = (chosen: string, part: string): void => {
    moveAside(join(chosen, part), join(chosen, "elsewhere"));
    writeFileSync(join(chosen, part), "the user's file");
  };
  const copyInto = () => {
    const root = prepare();
    writeFileSync(join(root.path, "0123456789abcdef0123456789abcdef"), "staged");
    const chosen = join(home, "chosen");
    mkdirSync(chosen);
    const info = statSync(chosen, { bigint: true });
    return { root, chosen, folder: { path: chosen, dev: info.dev, ino: info.ino } };
  };
  const part = ".0123456789abcdef0123456789abcdef.part";

  it("never removes a file put at the temporary file's name when the copy is cancelled", async () => {
    const { root, chosen, folder } = copyInto();
    const proceed = (step: Step): boolean => {
      if (step !== "copied") return true;
      swapAt(chosen, part);
      return false;
    };
    await expect(root.files.copy(root, "0123456789abcdef0123456789abcdef", folder, "report.pdf", part, proceed, new AbortController().signal))
      .rejects.toThrow(/temporary file is left/u);
    expect(readFileSync(join(chosen, part), "utf8")).toBe("the user's file");
    expect(readdirSync(chosen).sort()).toEqual([part, "elsewhere"]);
    expectOnlyHeldPathOperations();
  });

  it("never removes a file put at the temporary file's name when the copy fails", async () => {
    const { root, chosen, folder } = copyInto();
    const proceed = (step: Step): boolean => {
      if (step !== "copied") return true;
      swapAt(chosen, part);
      // The chosen name now holds a folder, which the commit refuses to replace.
      mkdirSync(join(chosen, "report.pdf"));
      return true;
    };
    await expect(root.files.copy(root, "0123456789abcdef0123456789abcdef", folder, "report.pdf", part, proceed, new AbortController().signal))
      .rejects.toMatchObject({ refusal: "target" });
    expect(readFileSync(join(chosen, part), "utf8")).toBe("the user's file");
    expect(readdirSync(chosen).sort()).toEqual([part, "elsewhere", "report.pdf"]);
    expectOnlyHeldPathOperations();
  });
});
