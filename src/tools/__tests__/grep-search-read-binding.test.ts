// windows-native: uses real junctions across search and read boundaries.
// grep_files shows only lines the host read itself from the file its judged path names. These tests change the
// filesystem around the search's own read and around the host's read, so they hook the spawn and the open for the whole
// module and stay out of the real-filesystem grep suite.
import {
  appendFileSync, constants, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Around = { swap: () => void; restore: () => void };

const hooks = vi.hoisted(() => ({
  /** Runs around the next spawned search: `swap` before it starts, `restore` before any of its output can be read. */
  search: undefined as Around | undefined,
  /** Runs around the next open of `openTarget`: `swap` before it, `restore` after it. */
  open: undefined as Around | undefined,
  openTarget: "",
  /** Opens without the flag that refuses a link in the last name, as on Windows. */
  dropNoFollow: false,
  /** Runs once when the host resolves `openTarget`, after the search of the tree listed it. */
  beforeRealpath: undefined as (() => void) | undefined,
  /** Holds the host's second read of `openTarget` until the search it feeds has ended. */
  holdSecondRead: false,
  /** Runs once as that held read starts. */
  onSecondRead: undefined as (() => void) | undefined,
  onCompletionRead: undefined as (() => void) | undefined,
  /** Settles when the search spawned last has ended. */
  searchEnded: undefined as Promise<void> | undefined,
  /** The search spawned last. */
  lastSearch: undefined as ChildProcess | undefined,
  boundFailure: undefined as "exit" | "signal" | "no-match" | undefined,
  listingFailure: undefined as number | "signal" | undefined,
  failureOutput: true,
  reportedClose: undefined as { code: number | null; signal: NodeJS.Signals | null } | undefined,
  failedSearch: undefined as ChildProcess | undefined,
  killDelivered: undefined as boolean | undefined,
  holdListing: false,
  listingClosed: false,
  listingSearch: undefined as ChildProcess | undefined,
  cancelSearch: undefined as (() => void) | undefined,
  pendingSearch: undefined as Promise<unknown> | undefined,
}));

vi.mock("../../main/managed-child-processes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../main/managed-child-processes.js")>();
  const spawnManaged = ((...args: Parameters<typeof actual.spawnManaged>) => {
    const around = hooks.search;
    hooks.search = undefined;
    around?.swap();
    const bound = args[1]?.at(-1) === "-";
    const scripted = (source: string) => actual.spawnManaged(process.execPath, ["-e", source], {
      ...args[2], stdio: ["pipe", "pipe", "pipe"], env: { ...args[2]?.env, ELECTRON_RUN_AS_NODE: "1" },
    }, args[3]);
    if (!bound && hooks.holdListing) {
      const child = scripted(`process.stdout.write(${JSON.stringify(`${hooks.openTarget}\0`)}); process.stdin.resume();`);
      hooks.listingSearch = child;
      child.once("close", () => { hooks.listingClosed = true; });
      return child;
    }
    const failure = bound ? hooks.boundFailure : hooks.listingFailure;
    const output = hooks.failureOutput
      ? (bound ? (args[1]?.includes("--count") ? "1\n" : "1:needle\n") : `${hooks.openTarget}\0${args[1]?.includes("--count") ? "1\n" : ""}`)
      : "";
    const child = failure !== undefined
      ? scripted(`process.stdout.write(${JSON.stringify(output)}); ${failure === "signal"
        ? "process.stdin.resume();"
        : `process.stderr.write("bound search failed\\n"); process.exitCode = ${failure === "exit" ? 2 : failure === "no-match" ? 1 : failure};`}`)
      : actual.spawnManaged(...args);
    if (failure !== undefined) hooks.failedSearch = child;
    if (failure === "signal") {
      const reported = hooks.reportedClose;
      if (reported) {
        const emit = child.emit.bind(child);
        child.emit = ((event: string | symbol, ...values: unknown[]) => {
          if (event === "close") {
            Object.defineProperties(child, {
              exitCode: { value: reported.code, writable: true, configurable: true },
              signalCode: { value: reported.signal, writable: true, configurable: true },
            });
            return emit(event, reported.code, reported.signal);
          }
          return emit(event, ...values);
        }) as typeof child.emit;
      }
      // The parent owns termination; self-signalling can become an ordinary no-match status on some hosts.
      const kill = () => { hooks.killDelivered = child.kill("SIGKILL"); };
      if (child.stdout === null) throw new Error("Search output pipe is missing");
      if (output.length > 0) child.stdout.once("data", kill);
      else child.once("spawn", kill);
    }
    hooks.lastSearch = child;
    hooks.searchEnded = new Promise((resolveEnd) => child.once("close", () => resolveEnd()));
    if (around && child.stdout) {
      // Every byte of output enters the stream through push, before a listener or a reader can see it.
      let restored = false;
      const push = child.stdout.push.bind(child.stdout);
      child.stdout.push = (chunk: unknown, encoding?: BufferEncoding) => {
        if (!restored) {
          restored = true;
          around.restore();
        }
        return push(chunk, encoding);
      };
    }
    return child;
  }) as typeof actual.spawnManaged;
  return { ...actual, spawnManaged };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (path: string, flags?: unknown, ...rest: unknown[]) => {
    const around = path === hooks.openTarget ? hooks.open : undefined;
    if (around) hooks.open = undefined;
    const opening = hooks.dropNoFollow && typeof flags === "number" ? flags & ~(constants.O_NOFOLLOW ?? 0) : flags;
    around?.swap();
    let handle: FileHandle;
    try {
      handle = await (actual.open as (path: string, ...rest: unknown[]) => Promise<FileHandle>)(path, opening, ...rest);
    } finally {
      around?.restore();
    }
    if (path === hooks.openTarget && hooks.holdSecondRead) {
      const read = handle.read.bind(handle) as (...args: unknown[]) => ReturnType<FileHandle["read"]>;
      let reads = 0;
      handle.read = (async (...args: unknown[]) => {
        reads += 1;
        if (reads === 2) {
          const started = hooks.onSecondRead;
          hooks.onSecondRead = undefined;
          started?.();
          await hooks.searchEnded;
        }
        if (reads === 3) {
          const completing = hooks.onCompletionRead;
          hooks.onCompletionRead = undefined;
          completing?.();
        }
        return read(...args);
      }) as FileHandle["read"];
    }
    return handle;
  }) as typeof actual.open;
  const realpath = (async (path: string, ...rest: unknown[]) => {
    const before = path === hooks.openTarget ? hooks.beforeRealpath : undefined;
    if (before) {
      hooks.beforeRealpath = undefined;
      before();
    }
    return (actual.realpath as (path: string, ...rest: unknown[]) => Promise<string>)(path, ...rest);
  }) as typeof actual.realpath;
  return { ...actual, default: { ...actual, open, realpath }, open, realpath };
});

const { GrepFilesTool } = await import("../file-tools.js");
const { GrepFilesInputSchema, searchWithRipgrep } = await import("../grep-search.js");
const { allowKeyMaterialInspectionUnder } = await import("../../permissions/sensitive-paths.js");
const { forceKillManagedChildProcess } = await import("../../main/managed-child-processes.js");

let base: string;
let project: string;
let folder: string;
let protectedFolder: string;
let file: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ave-grep-binding-")));
  project = join(base, "project");
  folder = join(project, "notes");
  protectedFolder = join(base, "elsewhere", ".ssh");
  file = join(folder, "config");
  mkdirSync(folder, { recursive: true });
  mkdirSync(protectedFolder, { recursive: true });
  writeFileSync(file, "needle: buy milk\n");
  writeFileSync(join(protectedFolder, "config"), "needle: API_TOKEN=PROTECTED\n");
  hooks.search = undefined;
  hooks.open = undefined;
  hooks.openTarget = file;
  hooks.dropNoFollow = false;
  hooks.beforeRealpath = undefined;
  hooks.holdSecondRead = false;
  hooks.onSecondRead = undefined;
  hooks.onCompletionRead = undefined;
  hooks.lastSearch = undefined;
  hooks.boundFailure = undefined;
  hooks.listingFailure = undefined;
  hooks.failureOutput = true;
  hooks.reportedClose = undefined;
  hooks.failedSearch = undefined;
  hooks.killDelivered = undefined;
  hooks.holdListing = false;
  hooks.listingClosed = false;
  hooks.listingSearch = undefined;
  hooks.cancelSearch = undefined;
  hooks.pendingSearch = undefined;
});

afterEach(async () => {
  hooks.cancelSearch?.();
  if (hooks.listingSearch) await forceKillManagedChildProcess(hooks.listingSearch, "grep-files-stop");
  if (hooks.pendingSearch) await Promise.allSettled([hooks.pendingSearch]);
  hooks.search = undefined;
  hooks.open = undefined;
  hooks.dropNoFollow = false;
  hooks.beforeRealpath = undefined;
  hooks.holdSecondRead = false;
  hooks.onSecondRead = undefined;
  hooks.onCompletionRead = undefined;
  rmSync(base, { recursive: true, force: true });
});

const folderLeadsElsewhere: Around = {
  swap: () => {
    renameSync(folder, `${folder}.orig`);
    symlinkSync(protectedFolder, folder, "junction");
  },
  restore: () => {
    unlinkSync(folder);
    renameSync(`${folder}.orig`, folder);
  },
};
// A second name for the protected file stands in for a link the open follows.
const lastNameLeadsElsewhere: Around = {
  swap: () => {
    renameSync(file, `${file}.orig`);
    linkSync(join(protectedFolder, "config"), file);
  },
  restore: () => {
    unlinkSync(file);
    renameSync(`${file}.orig`, file);
  },
};

function grep(input: Record<string, unknown>) {
  return new GrepFilesTool().execute({ pattern: "needle", ...input }, { cwd: project, extraAllowedDirectories: [], metadata: {} });
}

describe.each([
  ["", false],
  [", with no flag that refuses a link", true],
])("grep_files binds what it shows to the judged path%s", (_label, dropNoFollow) => {
  beforeEach(() => {
    hooks.dropNoFollow = dropNoFollow;
  });

  it("shows the file's own lines when a folder led into a protected one while the search read it", async () => {
    hooks.search = folderLeadsElsewhere;
    const result = await grep({ path: join("notes", "config") });
    expect(hooks.search).toBeUndefined();
    expect(result.isError, result.output).toBe(false);
    expect(result.output).not.toContain("PROTECTED");
    expect(result.output).toContain("1: needle: buy milk");
  });

  const openSwaps: Array<[string, Around]> = [["a folder", folderLeadsElsewhere]];
  if (dropNoFollow) openSwaps.push(["the last name", lastNameLeadsElsewhere]);
  it.each(openSwaps)("drops a file when %s led elsewhere while the host opened it", async (_name, around) => {
    hooks.open = around;
    const result = await grep({ path: "." });
    expect(hooks.open).toBeUndefined();
    expect(result.isError, result.output).toBe(false);
    expect(result.output).not.toContain("PROTECTED");
    expect(result.output).toContain("No matches found.");
  });

  it("drops a file whose folder led out of the searched one by the time the host resolved it", async () => {
    const plain = join(base, "elsewhere", "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "config"), "needle: OUTSIDE\n");
    hooks.beforeRealpath = () => {
      renameSync(folder, `${folder}.orig`);
      symlinkSync(plain, folder, "junction");
    };
    let result: Awaited<ReturnType<typeof grep>>;
    try {
      result = await grep({ path: "." });
    } finally {
      // The link goes before the tree is removed, which on Windows would otherwise follow it.
      if (hooks.beforeRealpath === undefined) {
        unlinkSync(folder);
        renameSync(`${folder}.orig`, folder);
      }
    }
    expect(hooks.beforeRealpath).toBeUndefined();
    expect(result.isError, result.output).toBe(false);
    expect(result.output).not.toContain("OUTSIDE");
    expect(result.output).toContain("No matches found.");
  });

  it("shows the file's lines, counts and name when nothing changes", async () => {
    const lines = await grep({ path: "." });
    expect(lines.output).toContain(`${file}\n  1: needle: buy milk`);
    expect((await grep({ path: ".", outputMode: "count" })).output).toContain(`${file}: 1`);
    expect((await grep({ path: ".", outputMode: "files_with_matches" })).output).toContain(file);
  });
});

describe("grep_files feeding a search of one file's bytes", () => {
  it.each([
    ["pem", "files_with_matches"], ["key", "files_with_matches"],
    ["pem", "content"], ["key", "content"],
  ] as const)("finishes inspecting a harmless .%s after an early %s result", async (extension, outputMode) => {
    mkdirSync(join(project, "certificates"));
    const target = join(project, "certificates", `bundle.${extension}`);
    writeFileSync(target, `${"needle certificate\n".repeat(5000)}${"harmless certificate data\n".repeat(25000)}`);
    hooks.openTarget = target;
    hooks.holdSecondRead = true;
    const withdraw = allowKeyMaterialInspectionUnder(() => [project]);
    try {
      const result = await grep({ path: "certificates", outputMode, limit: 1 });
      expect(result.isError, result.output).toBe(false);
      expect(result.metadata).toMatchObject({ matchCount: 1 });
      expect(result.output).toContain(target);
      hooks.onCompletionRead = () => appendFileSync(target, "-----BEGIN PRIVATE KEY-----\n");
      const changed = await grep({ path: "certificates", outputMode, limit: 1 });
      expect(hooks.onCompletionRead).toBeUndefined();
      expect(changed.isError, changed.output).toBe(false);
      expect(changed.metadata).toMatchObject({ matchCount: 0 });
    } finally { withdraw(); }
  });

  it.each([
    ["realpath", "content"], ["realpath", "count"], ["realpath", "files_with_matches"],
    ["open", "content"], ["open", "count"], ["open", "files_with_matches"],
    ["partial read", "content"], ["partial read", "count"], ["partial read", "files_with_matches"],
  ] as const)("judges replacement key bytes after %s in %s mode", async (phase, outputMode) => {
    mkdirSync(join(project, "key-files"));
    const target = join(project, "key-files", "notes.pem");
    writeFileSync(target, "needle harmless certificate\n");
    const replacement = join(base, "replacement");
    writeFileSync(replacement, phase === "partial read"
      ? `needle PRIVATE_KEY_BYTES\nneedle second\n${"filler line\n".repeat(20_000)}-----BEGIN PRIVATE KEY-----\n`
      : "-----BEGIN PRIVATE KEY-----\nneedle PRIVATE_KEY_BYTES\n");
    hooks.openTarget = target;
    const replace = () => renameSync(replacement, target);
    if (phase === "realpath") hooks.beforeRealpath = replace;
    else hooks.open = { swap: replace, restore: () => {} };
    const withdraw = allowKeyMaterialInspectionUnder(() => [project]);
    try {
      const result = await grep({ path: "key-files", outputMode, limit: 1 });
      expect(hooks.beforeRealpath).toBeUndefined();
      expect(hooks.open).toBeUndefined();
      expect(result.isError, result.output).toBe(false);
      expect(result.output).not.toContain("PRIVATE_KEY_BYTES");
      expect(result.output).not.toContain(target);
    } finally { withdraw(); }
  });

  it("returns a ready page while the candidate listing is still open", async () => {
    writeFileSync(file, "needle first\nneedle second\nneedle third\n");
    hooks.holdListing = true;
    const controller = new AbortController();
    hooks.cancelSearch = () => controller.abort(new Error("Search fixture cleanup"));
    const pending = searchWithRipgrep(project, GrepFilesInputSchema.parse({ pattern: "needle", limit: 1 }), controller.signal);
    hooks.pendingSearch = pending;
    const result = await pending;
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("1: needle first");
    expect(result.metadata).toMatchObject({ matchCount: 1, truncated: true, nextOffset: 1 });
    expect(hooks.listingClosed).toBe(true);
  });

  it.each([
    ["files_with_matches", "exit"], ["files_with_matches", "signal"],
    ["content", "exit"], ["content", "signal"], ["count", "exit"], ["count", "signal"],
  ] as const)("reports a second %s search ended by %s", async (outputMode, failure) => {
    hooks.boundFailure = failure;
    const result = await grep({ path: ".", outputMode });
    expect(result.isError, result.output).toBe(true);
    expect(result.output).not.toContain("No matches found.");
    if (failure === "exit") expect(result.output).toContain("bound search failed");
    else {
      expect(hooks.killDelivered).toBe(true);
      expect(hooks.failedSearch?.killed).toBe(true);
    }
  });

  describe.each([0, 1])("a killed search reporting status %s without a signal", (code) => {
    it.each([
      ["content", "listing", false], ["count", "listing", false], ["files_with_matches", "listing", false],
      ["content", "listing", true], ["count", "listing", true], ["files_with_matches", "listing", true],
      ["content", "bound", true], ["count", "bound", true], ["files_with_matches", "bound", true],
    ] as const)("rejects an incomplete %s %s search with output=%s", async (outputMode, phase, output) => {
      if (phase === "listing") hooks.listingFailure = "signal";
      else hooks.boundFailure = "signal";
      hooks.failureOutput = output;
      hooks.reportedClose = { code, signal: null };
      const result = await grep({ path: ".", outputMode });
      expect(hooks.killDelivered).toBe(true);
      expect(hooks.failedSearch?.killed).toBe(true);
      expect(result.isError, result.output).toBe(true);
      expect(result.output).not.toContain("No matches found.");
    });
  });

  it.each([
    ["content", "listing"], ["count", "listing"], ["files_with_matches", "listing"],
    ["content", "bound"], ["count", "bound"],
  ] as const)("rejects contradictory matches from a %s %s search with no-match status", async (outputMode, phase) => {
    if (phase === "listing") hooks.listingFailure = 1;
    else hooks.boundFailure = "no-match";
    const result = await grep({ path: ".", outputMode });
    expect(hooks.failedSearch?.killed).toBe(false);
    expect(result.isError, result.output).toBe(true);
    expect(result.output).not.toContain("No matches found.");
  });

  it.each(["content", "count", "files_with_matches"] as const)("rejects abnormal listing status after partial %s results", async (outputMode) => {
    hooks.listingFailure = 137;
    const result = await grep({ path: ".", outputMode });
    expect(result.isError, result.output).toBe(true);
    expect(result.output).not.toContain("No matches found.");
  });

  it.each(["content", "count", "files_with_matches"] as const)("retains diagnosed partial %s results after an ordinary listing error", async (outputMode) => {
    hooks.listingFailure = 2;
    const result = await grep({ path: ".", outputMode });
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain(file);
    expect(hooks.failedSearch?.exitCode).toBe(2);
    expect(result.output).toContain("Some paths could not be searched:");
  });

  it.each(["content", "count", "files_with_matches"] as const)("retains an ordinary %s no-match after the candidate changed", async (outputMode) => {
    hooks.open = { swap: () => writeFileSync(file, "ordinary text\n"), restore: () => {} };
    const result = await grep({ path: ".", outputMode });
    expect(hooks.open).toBeUndefined();
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("No matches found.");
  });
  it("finishes when the search ends while the host is still reading the file", async () => {
    // The search of the file's bytes ends while the host's second read is under way.
    const long = join(project, "long", "notes.txt");
    mkdirSync(join(project, "long"));
    writeFileSync(long, `needle: buy milk\n${"filler line of text\n".repeat(20_000)}`);
    hooks.openTarget = long;
    hooks.holdSecondRead = true;
    let killed = false;
    hooks.onSecondRead = () => {
      const search = hooks.lastSearch;
      if (search === undefined) throw new Error("Bound search was not started");
      killed = search.kill("SIGKILL");
    };
    const result = await grep({ path: "long", outputMode: "files_with_matches" });
    expect(hooks.onSecondRead).toBeUndefined();
    expect(killed).toBe(true);
    expect(hooks.lastSearch?.killed).toBe(true);
    expect(result.isError, result.output).toBe(true);
    expect(result.output).toContain("grep_files failed:");
  });

  it("finishes when the turn is aborted while the host is still reading the file", async () => {
    // The search of the file's lines waits for the rest of the file, so only the abort can end it.
    const long = join(project, "long", "notes.txt");
    mkdirSync(join(project, "long"));
    writeFileSync(long, `needle: buy milk\n${"filler line of text\n".repeat(20_000)}`);
    hooks.openTarget = long;
    hooks.holdSecondRead = true;
    const controller = new AbortController();
    hooks.onSecondRead = () => controller.abort(new Error("turn aborted"));
    const result = await searchWithRipgrep(join(project, "long"), GrepFilesInputSchema.parse({ pattern: "needle" }), controller.signal);
    expect(hooks.onSecondRead).toBeUndefined();
    expect(result).toMatchObject({ isError: true, output: "turn aborted" });
  });
});
