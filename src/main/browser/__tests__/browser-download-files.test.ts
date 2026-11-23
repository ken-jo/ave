import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The helper client's lifecycle at its process boundary, on every platform: each helper process is an in-memory stand-in that says what
// a test tells it to, and a kill ends it only when the test lets it. Only the client's timers are fake, so every bound is checked to the
// millisecond; the stand-in's output and input still pass through real streams. Native runs of the same paths are in
// browser-download-staging.test.ts.
class FakeHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  input = "";
  inputEnded = false;
  killed = 0;
  /** Whether a kill ends it; a helper stuck in the kernel is not ended by one. */
  diesWhenKilled = true;
  constructor(readonly args: readonly string[]) {
    super();
    this.stdin.setEncoding("utf8");
    // Input reaches the stand-in later, as it reaches a process through a pipe: never inside the write that sent it.
    this.stdin.on("data", (chunk: string) => { this.input += chunk; setImmediate(() => this.emit("input", chunk)); });
    this.stdin.on("end", () => { this.inputEnded = true; setImmediate(() => this.emit("input-ended")); });
  }
  /** Run `listener` once the caller has ended its input, including when that happened before the stand-in looked. */
  afterInputEnds(listener: () => void): void {
    if (this.inputEnded) setImmediate(listener);
    else this.once("input-ended", listener);
  }
  say(...lines: string[]): void {
    if (this.exited) return;
    for (const line of lines) {
      if (this.exited) return;
      this.stdout.write(`${line}\n`);
    }
  }
  get exited(): boolean { return this.exitCode !== null || this.signalCode !== null; }
  exit(code: number | null, signal: NodeJS.Signals | null = null, stderr = ""): void {
    if (this.exited) return;
    if (stderr) this.stderr.write(stderr);
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

const boundary = vi.hoisted(() => ({
  helpers: [] as unknown[],
  script: (_helper: never) => {},
  info: vi.fn(),
  warn: vi.fn(),
  // Runs just before every rename through node:fs, and may throw in its place.
  beforeRename: null as ((from: string, to: string) => void) | null,
  // Runs just before every file copy through node:fs/promises.
  beforeCopy: null as ((from: string, to: string) => void) | null,
  // Runs just after every lstat through node:fs.
  afterLstat: null as ((path: string) => void) | null,
  // Every hard link made through node:fs, as [existing, new].
  links: [] as [string, string][],
  // A folder like FAT or exFAT: no hard links, and a rename gives a file another id.
  linkless: false,
  // The code the next hard link fails with, or null to make it.
  linkFault: null as (() => string | null) | null,
  // The code a removal of a path fails with, or null to remove it.
  unlinkFault: null as ((path: string) => string | null) | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    boundary.beforeRename?.(String(from), String(to));
    if (!boundary.linkless) {
      actual.renameSync(from, to);
      return;
    }
    // A new directory entry is a new file id there; the content and its last change stay.
    const { mtime, atime } = actual.statSync(from);
    actual.copyFileSync(from, to);
    actual.utimesSync(to, atime, mtime);
    actual.unlinkSync(from);
  };
  const linkSync: typeof actual.linkSync = (existing, path) => {
    boundary.links.push([String(existing), String(path)]);
    const fault = boundary.linkFault?.() ?? (boundary.linkless ? "ENOTSUP" : null);
    if (fault !== null) throw Object.assign(new Error(`${fault}: simulated, link`), { code: fault });
    actual.linkSync(existing, path);
  };
  const lstatSync = ((path: string, ...rest: unknown[]) => {
    const info = (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
    boundary.afterLstat?.(String(path));
    return info;
  }) as typeof actual.lstatSync;
  const unlinkSync: typeof actual.unlinkSync = (path) => {
    const fault = boundary.unlinkFault?.(String(path)) ?? null;
    if (fault !== null) throw Object.assign(new Error(`${fault}: simulated, unlink`), { code: fault });
    actual.unlinkSync(path);
  };
  const replaced = { renameSync, linkSync, lstatSync, unlinkSync };
  return { ...actual, default: { ...actual, ...replaced }, ...replaced };
});
// The host's own renames go through the promise API: the same hook and the same folder without hard links.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { copyFileSync, renameSync } = await import("node:fs");
  const rename: typeof actual.rename = async (from, to) => { renameSync(from, to); };
  const copyFile: typeof actual.copyFile = async (from, to, mode) => {
    boundary.beforeCopy?.(String(from), String(to));
    // Done at once, as the renames are, so a test sees it settle among the queued callbacks.
    copyFileSync(from, to, mode);
  };
  return { ...actual, default: { ...actual, rename, copyFile }, rename, copyFile };
});
vi.mock("../../../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/logger.js")>();
  return { ...actual, createLogger: (name: string) => ({ ...actual.createLogger(name), info: boundary.info, warn: boundary.warn }) };
});
vi.mock("../../managed-child-processes.js", () => ({
  spawnManaged: vi.fn((_command: string, args: readonly string[]) => {
    const helper = new FakeHelper(args);
    boundary.helpers.push(helper);
    // The stand-in acts once the client has attached its listeners, as a real process's output arrives after spawn returns.
    setImmediate(() => boundary.script(helper as never));
    return helper;
  }),
  forceKillManagedChildProcess: vi.fn((helper: FakeHelper) => {
    helper.killed += 1;
    if (helper.diesWhenKilled) helper.exit(null, "SIGKILL");
  }),
}));

const { _forgetLinkSupportForTest, _helperFileOperationsForTest, HeldDirectoryRefusedError, HeldFileHelperStalledError, HeldFileHelperUnavailableError, stoppedCopyOf } =
  await import("../browser-download-files.js");

const { BACKGROUND_BUDGET_MS } = await import("../../../lib/transient-fs-lock-retry.js");
const BOUNDS = { stallMs: 1_000, killMs: 400 };
const files = _helperFileOperationsForTest("/helper/ave-dir-ops", BOUNDS);
const from = { path: "/staging", dev: 1n, ino: 2n };
const to = { path: "/chosen", dev: 1n, ino: 3n };
const helpers = (): FakeHelper[] => boundary.helpers as FakeHelper[];
const script = (run: (helper: FakeHelper) => void): void => { boundary.script = run as never; };
// Let the stand-ins' real stream and immediate callbacks run, without moving the fake clock.
const flush = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
};
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};
// Follow an operation without awaiting it, so a test can check it is still running at a given moment.
const follow = <T>(operation: Promise<T>) => {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  operation.then((value) => { state.settled = true; state.value = value; }, (error: unknown) => { state.settled = true; state.error = error; });
  return state;
};
// A stop nothing aborts.
const UNSTOPPED = new AbortController().signal;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  boundary.helpers = [];
  boundary.info.mockClear();
  boundary.warn.mockClear();
  boundary.beforeRename = null;
  boundary.beforeCopy = null;
  boundary.afterLstat = null;
  boundary.links = [];
  boundary.linkless = false;
  boundary.linkFault = null;
  boundary.unlinkFault = null;
  _forgetLinkSupportForTest();
});
afterEach(() => {
  vi.useRealTimers();
  for (const helper of helpers()) helper.exit(null, "SIGKILL");
});

describe("a helper that never says it is ready", () => {
  it.each([
    ["move", () => files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED)],
    ["copy", () => files.copy(from, "staged", to, "report.pdf", ".part", () => true, UNSTOPPED)],
    ["remove", () => files.remove(from, "staged", () => true, UNSTOPPED)],
  ] as const)("is killed exactly at the stall bound, its exit is seen, and its %s fails having been let past nothing", async (_mode, start) => {
    script(() => {});
    const run = follow(start());
    await advance(BOUNDS.stallMs - 1);
    const [helper] = helpers();
    expect(helper?.killed).toBe(0);
    expect(run.settled).toBe(false);
    await advance(1);
    expect(helper?.killed).toBe(1);
    expect(helper?.signalCode).toBe("SIGKILL");
    // Settled by the exit it saw, not by the kill-confirm wait.
    expect(run.settled).toBe(true);
    expect(run.error).toBeInstanceOf(HeldFileHelperStalledError);
    expect(run.error).toMatchObject({ passed: null, partialCopy: null, stillRunning: false });
    expect(String((run.error as Error).message)).toMatch(/said nothing for 1000 ms while holding its folders/);
    // It was never told to act, and no other helper was started: nothing can be saved later.
    expect(helper?.input).toBe("");
    expect(helpers()).toHaveLength(1);
  });
});

describe("a copy whose helper ignores the end of its input", () => {
  // Says `ready`, then copies whatever its input does; the test writes its progress. A removal of the temporary file it may leave works.
  const ignoresEof = (helper: FakeHelper): void => {
    if (helper.args[0] === "--dir-remove") {
      helper.say("ready");
      helper.once("input", () => { helper.say("removed"); helper.exit(0); });
      return;
    }
    helper.say("ready");
  };

  it("keeps a copy that reports progress alive, then kills it at the stall bound after a cancel, however much progress follows", async () => {
    script(ignoresEof);
    const stop = new AbortController();
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, stop.signal));
    await flush();
    const [copy] = helpers();
    expect(copy?.input).toBe("c");
    // A slow copy that still moves is never stopped: each chunk's progress restarts the bound.
    for (let chunk = 1; chunk <= 3; chunk += 1) {
      await advance(BOUNDS.stallMs - 1);
      copy?.say(`progress ${chunk * 1048576}`);
      await flush();
    }
    expect(copy?.killed).toBe(0);
    stop.abort();
    await flush();
    expect(copy?.inputEnded).toBe(true);
    // Progress after the cancel does not move the deadline the cancel set.
    await advance(BOUNDS.stallMs / 2);
    copy?.say("progress 4194304");
    await advance(BOUNDS.stallMs / 2 - 1);
    copy?.say("progress 5242880");
    await flush();
    expect(copy?.killed).toBe(0);
    expect(run.settled).toBe(false);
    await advance(1);
    expect(copy?.killed).toBe(1);
    expect(copy?.signalCode).toBe("SIGKILL");
    await flush();
    expect(run.settled).toBe(true);
    expect(run.error).toBeInstanceOf(HeldFileHelperStalledError);
    expect(String((run.error as Error).message)).toMatch(/did not end within 1000 ms of being stopped/);
    // Let past `ready` only, so its commit was never allowed. Its temporary file was never seen while written, so nothing removes it by name.
    expect(copy?.input).toBe("c");
    expect(run.error).toMatchObject({ passed: "ready", partialCopy: "left", partFile: null, stillRunning: false });
    expect(helpers()).toHaveLength(1);
  });

  it("kills it at the stall bound after it is told no at `copied`, and leaves a temporary file it never saw", async () => {
    script((helper) => {
      ignoresEof(helper);
      if (helper.args[0] === "--dir-copy") helper.once("input", () => helper.say("progress 8", "copied"));
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", (step) => step !== "copied", UNSTOPPED));
    await flush();
    const [copy] = helpers();
    expect(copy?.inputEnded).toBe(true);
    await advance(BOUNDS.stallMs - 1);
    expect(copy?.killed).toBe(0);
    await advance(1);
    expect(copy?.killed).toBe(1);
    await flush();
    expect(run.error).toMatchObject({ passed: "ready", partialCopy: "left", partFile: null, stillRunning: false });
    expect(copy?.input).toBe("c");
    expect(helpers()).toHaveLength(1);
  });

  it("reports the temporary file as left, and starts nothing more, when a kill does not end the helper within the kill bound", async () => {
    script((helper) => {
      helper.diesWhenKilled = false;
      ignoresEof(helper);
      helper.once("input", () => helper.say("copied"));
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", (step) => step !== "copied", UNSTOPPED));
    await flush();
    await advance(BOUNDS.stallMs);
    const [copy] = helpers();
    expect(copy?.killed).toBe(1);
    await advance(BOUNDS.killMs - 1);
    expect(run.settled).toBe(false);
    await advance(1);
    expect(run.settled).toBe(true);
    expect(run.error).toMatchObject({ passed: "ready", partialCopy: "left", stillRunning: true });
    expect(String((run.error as Error).message)).toMatch(/has not been seen to end/);
    // A helper that may still be running is not raced by a removal.
    expect(helpers()).toHaveLength(1);
  });

  it("still reports a commit the helper printed before the kill landed", async () => {
    // Commits once let past `copied`, says so, and then never ends.
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => {
        helper.say("copied");
        helper.once("input", () => helper.say("committed"));
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    await advance(BOUNDS.stallMs);
    expect(helpers()[0]?.killed).toBe(1);
    await flush();
    expect(run).toMatchObject({ settled: true, value: "committed" });
  });
});

describe("a move or removal stopped by its signal", () => {
  it.each(["move", "remove"] as const)("a %s stopped before it is let go ends cancelled, and one that does not end is killed at the bound", async (mode) => {
    const start = (stop: AbortSignal) => mode === "move"
      ? files.move(from, "staged", to, "report.pdf", () => true, stop)
      : files.remove(from, "staged", () => true, stop);
    script((helper) => {
      helper.say("ready");
      helper.afterInputEnds(() => { helper.say("cancelled"); helper.exit(0); });
    });
    const stopped = new AbortController();
    stopped.abort();
    const cancelled = follow(start(stopped.signal));
    await flush();
    expect(cancelled).toMatchObject({ settled: true, value: "cancelled" });
    expect(helpers()[0]?.input).toBe("");

    script(() => {});
    const stop = new AbortController();
    const run = follow(start(stop.signal));
    await advance(5);
    stop.abort();
    await flush();
    const hung = helpers()[1];
    expect(hung?.inputEnded).toBe(true);
    // The deadline is the stop's, not the earlier one for saying `ready`.
    await advance(BOUNDS.stallMs - 1);
    expect(hung?.killed).toBe(0);
    await advance(1);
    expect(hung?.killed).toBe(1);
    expect(run.error).toBeInstanceOf(HeldFileHelperStalledError);
    expect(hung?.signalCode).toBe("SIGKILL");
  });
});

describe("a helper that does not keep to its protocol", () => {
  it.each([
    ["move", () => files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED)],
    ["copy", () => files.copy(from, "staged", to, "report.pdf", ".part", () => true, UNSTOPPED)],
    ["remove", () => files.remove(from, "staged", () => true, UNSTOPPED)],
    ["sweep", () => files.sweep(from)],
  ] as const)("preserves exit 4 and its errno in a %s with a native diagnostic in either pipe order", async (_mode, start) => {
    script((helper) => helper.say("ready"));
    for (const [code, nativeCode] of [["EBUSY", 32], ["EPERM", 5], ["EIO", 1117], ["EUNKNOWN", 4294967295]] as const) {
      for (const stderrFirst of [true, false]) {
        const run = follow<string | number>(start());
        await flush();
        const helper = helpers().at(-1);
        expect(helper?.input).toBe("c");
        if (!stderrFirst) helper?.say(`failed ${code}`);
        // Separate deliveries also exercise CRLF and a diagnostic split in the middle of a native write.
        helper?.stderr.write("Windows error ");
        await flush();
        helper?.stderr.write(`${nativeCode}\r\n`);
        if (stderrFirst) helper?.say(`failed ${code}`);
        await flush();
        expect(helper?.killed).toBe(0);
        expect(run.settled).toBe(false);
        helper?.exit(4);
        await flush();
        expect(helper?.exitCode).toBe(4);
        expect(run.error).toMatchObject({ code });
        expect(run.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
        expect(run.value).toBeUndefined();
      }
    }
    expect(helpers()).toHaveLength(8);
  });

  it.each(["NtCreateFile", "NtSetInformationFile"])("preserves a captured %s failure status in either pipe order", async (operation) => {
    script((helper) => helper.say("ready"));
    for (const stderrFirst of [true, false]) {
      const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
      await flush();
      const helper = helpers().at(-1);
      if (!stderrFirst) helper?.say("failed EUNKNOWN");
      helper?.stderr.write("Windows error 87 (NTSTATUS 0xC000");
      await flush();
      helper?.stderr.write(`000D, ${operation})\r\n`);
      if (stderrFirst) helper?.say("failed EUNKNOWN");
      helper?.exit(4);
      await flush();
      expect(helper?.killed).toBe(0);
      expect(run.error).toMatchObject({ code: "EUNKNOWN" });
      expect(run.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
      expect(run.value).toBeUndefined();
    }
  });

  it("rejects invalid diagnostics independently of pipe order, and never accepts them as successful outcomes", async () => {
    for (const diagnostic of ["x", "Windows error 32\n\n", "Windows error 32\nextra", "Windows error 32",
      "Windows error 87 (NTSTATUS 0xC00000D, NtCreateFile)\n", "Windows error 87 (NTSTATUS 0xC000000D, other)\n",
      "Windows error 87 (NTSTATUS 0xC000000D, NtCreateFile)\nextra"]) {
      for (const stderrFirst of [true, false]) {
        script((helper) => {
          helper.say("ready");
          helper.once("input", () => {
            if (stderrFirst) helper.stderr.write(diagnostic);
            helper.say("failed EBUSY");
            if (!stderrFirst && !helper.exited) helper.stderr.write(diagnostic);
            helper.exit(4);
          });
        });
        const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
        await flush();
        expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
        expect(run.error).toMatchObject({ passed: "ready" });
      }
    }
    for (const status of [0, 3]) {
      script((helper) => {
        helper.say("ready");
        helper.once("input", () => { helper.say("failed EBUSY"); helper.stderr.write("Windows error 32\n"); helper.exit(status); });
      });
      const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
      await flush();
      expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
      expect(run.error).toMatchObject({ passed: "ready" });
    }
  });

  it("does not let diagnostic fragments postpone a failure outcome's fixed exit deadline", async () => {
    script((helper) => { helper.say("ready"); helper.once("input", () => helper.say("failed EBUSY")); });
    const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    const [helper] = helpers();
    await advance(BOUNDS.stallMs / 2);
    helper?.stderr.write("Windows error ");
    await advance(BOUNDS.stallMs / 2 - 1);
    helper?.stderr.write("32\n");
    expect(helper?.killed).toBe(0);
    expect(run.settled).toBe(false);
    await advance(1);
    expect(helper?.killed).toBe(1);
    expect(helper?.signalCode).toBe("SIGKILL");
    expect(run.error).toMatchObject({ code: "EBUSY" });
    expect(run.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
  });

  it("waits for pipe closure after exit 4 before classifying a late diagnostic or its invalid suffix", async () => {
    for (const suffix of ["", "extra"]) {
      script((helper) => { helper.say("ready"); helper.once("input", () => helper.say("failed EBUSY")); });
      const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
      await flush();
      const helper = helpers().at(-1);
      if (helper === undefined) throw new Error("helper was not started");
      // Process exit can precede delivery of data already buffered in either pipe.
      helper.exitCode = 4;
      helper.emit("exit", 4, null);
      await flush();
      expect(run.settled).toBe(false);
      helper.stderr.write(`Windows error 32\n${suffix}`);
      helper.stdout.end();
      helper.stderr.end();
      helper.emit("close", 4, null);
      await flush();
      if (suffix === "") {
        expect(helper.killed).toBe(0);
        expect(run.error).toMatchObject({ code: "EBUSY" });
        expect(run.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
      } else {
        expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
        expect(run.error).toMatchObject({ passed: "ready" });
      }
    }
  });

  it.each([["EBUSY", 32], ["EPERM", 5]] as const)("retains the existing bounded file-lock ladder for %s from a native diagnostic", async (code, nativeCode) => {
    const { retryOnFileLock, transientFsLockDelayMs, BACKGROUND_ATTEMPTS, BACKGROUND_BUDGET_MS } = await import("../../../lib/transient-fs-lock-retry.js");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      let attempts = 0;
      script((helper) => {
        attempts += 1;
        helper.say("ready");
        helper.once("input", () => { helper.say(`failed ${code}`); if (!helper.exited) helper.stderr.write(`Windows error ${nativeCode}\n`); helper.exit(4); });
      });
      const run = follow(retryOnFileLock(() => files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED)));
      await flush();
      let waited = 0;
      for (let attempt = 1; attempt < BACKGROUND_ATTEMPTS; attempt += 1) {
        expect(attempts).toBe(attempt);
        const delay = transientFsLockDelayMs(attempt);
        waited += delay;
        await advance(delay);
      }
      expect(waited).toBe(BACKGROUND_BUDGET_MS);
      expect(attempts).toBe(BACKGROUND_ATTEMPTS);
      expect(run.error).toMatchObject({ code });
      expect(helpers().every((helper) => helper.exitCode === 4 && helper.killed === 0)).toBe(true);
      await advance(BOUNDS.stallMs);
      expect(attempts).toBe(BACKGROUND_ATTEMPTS);
      let recoveryAttempts = 0;
      script((helper) => {
        recoveryAttempts += 1;
        helper.say("ready");
        helper.once("input", () => {
          if (recoveryAttempts < 3) {
            helper.say(`failed ${code}`);
            helper.stderr.write(`Windows error ${nativeCode}\n`);
            helper.exit(4);
          } else { helper.say("committed"); helper.exit(0); }
        });
      });
      const recovered = follow(retryOnFileLock(() => files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED)));
      await flush();
      await advance(transientFsLockDelayMs(1));
      await advance(transientFsLockDelayMs(2));
      expect(recovered).toMatchObject({ settled: true, value: "committed" });
      expect(recoveryAttempts).toBe(3);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    ["progress before ready", ["progress 1", "ready", "committed"]],
    ["an unknown line before ready", ["all good", "ready", "committed"]],
    ["a second ready", ["ready", "ready", "committed"]],
    ["a copy step in a move", ["ready", "copied", "committed"]],
    ["a commit before ready", ["committed"]],
    ["progress in a move", ["ready", "progress 8", "committed"]],
    ["extra refusal fields", ["refused to extra"]],
    ["extra failure fields", ["failed EIO extra"]],
  ] as const)("rejects %s even if a valid outcome follows", async (_case, lines) => {
    script((helper) => { helper.say(...lines); helper.exit(lines[0]?.startsWith("refused") ? 3 : lines[0]?.startsWith("failed") ? 4 : 0); });
    const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    await advance(BOUNDS.stallMs + BOUNDS.killMs);
    expect(run.settled).toBe(true);
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(run.value).toBeUndefined();
  });

  it.each(["progress 1\n", "committed\n", "\n", "x", "\r", "\u00e9"])("rejects every trailing stdout byte after an outcome: %j", async (extra) => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => helper.say("committed"));
    });
    const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    await advance(BOUNDS.stallMs - 1);
    helpers()[0]?.stdout.write(extra);
    await advance(1);
    expect(helpers()[0]?.killed).toBe(1);
    await advance(BOUNDS.killMs);
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(run.error).toMatchObject({ passed: "ready" });
    expect(run.value).toBeUndefined();
  });

  it.each(["progress 0", "progress 8", "progress 7"])("does not let non-advancing copy output renew liveness: %s", async (line) => {
    script((helper) => { helper.say("ready"); helper.once("input", () => helper.say("progress 8")); });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".part", () => true, UNSTOPPED));
    await flush();
    await advance(BOUNDS.stallMs - 1);
    helpers()[0]?.say(line);
    await advance(1);
    expect(helpers()[0]?.killed).toBe(1);
    await advance(BOUNDS.stallMs + BOUNDS.killMs);
    expect(run.error).toMatchObject({ passed: "ready", partialCopy: "left" });
  });

  it("rejects a stderr byte after an outcome", async () => {
    script((helper) => { helper.say("ready"); helper.once("input", () => helper.say("committed")); });
    const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    helpers()[0]?.stderr.write("x");
    await advance(BOUNDS.stallMs + BOUNDS.killMs);
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(run.value).toBeUndefined();
  });

  it("rejects trailing output arriving between the kill request and confirmed exit", async () => {
    script((helper) => {
      helper.diesWhenKilled = false;
      helper.say("ready");
      helper.once("input", () => helper.say("committed"));
    });
    const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    await advance(BOUNDS.stallMs);
    const [helper] = helpers();
    expect(helper?.killed).toBe(1);
    expect(run.settled).toBe(false);
    helper?.say("progress 1");
    helper?.exit(null, "SIGKILL");
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(run.error).toMatchObject({ passed: "ready" });
    expect(run.value).toBeUndefined();
  });

  it("reports partial-copy cleanup and possible publication after malformed output at commit", async () => {
    const { mkdtempSync, realpathSync, statSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { stageBrowserDownload } = await import("../browser-download-staging.js");
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "download-recovery-")));
    try {
      const info = statSync(directory, { bigint: true });
      const root = { path: directory, dev: info.dev, ino: info.ino, files: { ...files, move: async () => "cross-volume" as const } };
      script((helper) => {
        helper.say("ready");
        if (helper.args[0] === "--dir-remove") {
          helper.once("input", () => { helper.say("removed"); helper.exit(0); });
        } else helper.once("input", () => {
          helper.say("copied");
          helper.once("input", () => helper.say("all good"));
        });
      });
      const item = Object.assign(new EventEmitter(), {
        getFilename: () => "report.pdf", getURL: () => "https://site.example/report", getURLChain: () => ["https://site.example/report"],
        hasUserGesture: () => true, getReceivedBytes: () => 8, getTotalBytes: () => 8, getState: () => "completed" as const,
        pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), setSavePath: vi.fn(),
      });
      const staged = stageBrowserDownload(item, { root, askSavePath: async () => join(directory, "report.pdf") }, Promise.resolve());
      const done = follow(new Promise<string>((resolve) => staged.download.once("done", (_event, state) => resolve(state))));
      await staged.answered;
      item.emit("done", {}, "completed");
      await flush();
      await advance(BOUNDS.stallMs + BOUNDS.killMs);
      expect(done).toMatchObject({ settled: true, value: "interrupted" });
      // The copy wrote no temporary file, so there is nothing to remove and no removal of it is started.
      expect(helpers().filter((helper) => /\.part$/u.test(helper.args[4] ?? ""))).toEqual([]);
      expect(boundary.warn).toHaveBeenCalledWith({ path: join(directory, "report.pdf") }, expect.stringContaining("commit was allowed"));
      expect(boundary.info).toHaveBeenCalledWith({ path: expect.stringMatching(/\.part$/u), partialCopy: "absent" }, expect.stringContaining("left no temporary file"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["ready", "copied"] as const)("keeps recovery metadata after malformed output beyond %s and a kill", async (lastStep) => {
    script((helper) => {
      if (helper.args[0] === "--dir-remove") {
        helper.say("ready");
        helper.once("input", () => { helper.say("removed"); helper.exit(0); });
        return;
      }
      helper.say("ready");
      helper.once("input", () => {
        if (lastStep === "copied") {
          helper.say("copied");
          helper.once("input", () => helper.say("all good"));
        } else helper.say("all good");
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    await advance(BOUNDS.stallMs + BOUNDS.killMs);
    expect(helpers()[0]?.killed).toBe(1);
    // No temporary file was seen while written, so none is removed by name.
    expect(run.error).toMatchObject({ passed: lastStep, partialCopy: "left", partFile: null });
    expect(helpers()).toHaveLength(1);
  });

  it("bounds a sweep even when both the kill promise and termination remain unconfirmed", async () => {
    const { forceKillManagedChildProcess } = await import("../../managed-child-processes.js");
    vi.mocked(forceKillManagedChildProcess).mockImplementationOnce((child) => {
      const helper = child as unknown as FakeHelper;
      helper.killed += 1;
      return new Promise<void>(() => {});
    });
    script((helper) => { helper.diesWhenKilled = false; });
    const run = follow(Promise.resolve().then(() => files.sweep(from)));
    await flush();
    expect(run.settled).toBe(false);
    await advance(BOUNDS.stallMs);
    expect(helpers()[0]?.killed).toBe(1);
    await advance(BOUNDS.killMs - 1);
    expect(run.settled).toBe(false);
    await advance(1);
    expect(run.error).toMatchObject({ stillRunning: true, passed: null });
    expect(helpers()).toHaveLength(1);
    expect(helpers()[0]?.input).toBe("");
  });

  it.each([
    ["exit 2 with its usage", (helper: FakeHelper) => helper.exit(2, null, "usage: ave-dir-ops --dir-rename|--dir-copy|--dir-remove|--dir-sweep <arguments>\n")],
    ["a crash", (helper: FakeHelper) => { helper.say("ready"); helper.once("input", () => helper.exit(null, "SIGSEGV")); }],
    ["exit 0 with a line it never gives", (helper: FakeHelper) => { helper.say("ready"); helper.once("input", () => { helper.say("all good"); helper.exit(0); }); }],
    ["exit 0 at a step", (helper: FakeHelper) => { helper.say("ready"); helper.exit(0); }],
    ["exit 3 with no refusal", (helper: FakeHelper) => { helper.say("ready"); helper.once("input", () => helper.exit(3)); }],
  ] as const)("is unavailable on %s, not a refusal or a filesystem failure", async (_case, behave) => {
    script(behave);
    const run = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    expect(run.settled).toBe(true);
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(run.error).not.toBeInstanceOf(HeldFileHelperStalledError);
  });

  it("keeps a refusal and a filesystem failure it reports as answers about the operation", async () => {
    script((helper) => { helper.say("refused to"); helper.exit(3); });
    const refused = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    expect(refused.error).toBeInstanceOf(HeldDirectoryRefusedError);
    script((helper) => { helper.say("ready"); helper.once("input", () => { helper.say("failed EIO"); helper.exit(4); }); });
    const failed = follow(files.move(from, "staged", to, "report.pdf", () => true, UNSTOPPED));
    await flush();
    expect(failed.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(failed.error).toMatchObject({ code: "EIO" });
  });

  it.each([
    ["exit 2 with its usage", { status: 2, stdout: "", stderr: "usage: ave-dir-ops ...\n" }],
    ["SIGSEGV", { status: null, signal: "SIGSEGV", stdout: "ready\n" }],
    ["exit 0 with a line it never gives", { status: 0, stdout: "ready\nswept many\n" }],
    ["exit 0 with no sweep", { status: 0, stdout: "ready\n" }],
  ] as const)("fails a sweep as unavailable on %s", async (_case, result) => {
    script((helper) => {
      helper.stdout.write(result.stdout);
      helper.exit(result.status, "signal" in result ? result.signal : null, "stderr" in result ? result.stderr : "");
    });
    const run = follow(files.sweep(from));
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
  });

  it("kills a sweep that does not end within the stall bound, and keeps a filesystem failure it reports", async () => {
    script(() => {});
    const hung = follow(files.sweep(from));
    await advance(BOUNDS.stallMs);
    expect(helpers()[0]?.killed).toBe(1);
    expect(helpers()[0]?.signalCode).toBe("SIGKILL");
    expect(hung.error).toBeInstanceOf(HeldFileHelperStalledError);
    script((helper) => { helper.say("ready"); helper.once("input", () => { helper.say("failed EIO"); helper.exit(4); }); });
    const failed = follow(files.sweep(from));
    await flush();
    expect(failed.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(failed.error).toMatchObject({ code: "EIO" });
    script((helper) => { helper.say("ready"); helper.once("input", () => { helper.say("swept 2"); helper.exit(0); }); });
    const swept = follow(files.sweep(from));
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 2 });
  });
});

// A copy's helper that stops after creating its temporary file says when it did not remove what is at that name (native/macos-dir-ops/README.md):
// the copy then reports the file as left, records nothing for the next start, and starts no removal of its own.
describe("a copy whose helper says it left its temporary file", () => {
  const HIDDEN = ".0123456789abcdef0123456789abcdef.removing";
  const SUFFIXES = [["left", null], [`left ${HIDDEN}`, HIDDEN]] as const;
  const expectLeftByHelper = (error: unknown, hidden: string | null): void => {
    expect(stoppedCopyOf(error)).toEqual({ partialCopy: "left", partLeftAt: null });
    expect(boundary.warn).toHaveBeenCalledWith({ path: "/chosen/.0123.part", leftAs: hidden ?? undefined }, expect.stringMatching(/did not find it to be its own/));
    expect(helpers()).toHaveLength(1);
  };

  it.each(SUFFIXES)("reports a cancel answered `cancelled %s` as a failure", async (suffix, hidden) => {
    script((helper) => helper.say("ready"));
    const stop = new AbortController();
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, stop.signal));
    await flush();
    const [copy] = helpers();
    stop.abort();
    await flush();
    copy?.say(`cancelled ${suffix}`);
    copy?.exit(0);
    await flush();
    expect(run.error).toBeInstanceOf(Error);
    expect(run.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(copy?.killed).toBe(0);
    expectLeftByHelper(run.error, hidden);
  });

  it.each(SUFFIXES)("keeps the errno of a failure answered `failed EIO %s`", async (suffix, hidden) => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => { helper.say("progress 8", `failed EIO ${suffix}`); helper.exit(4); });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toMatchObject({ code: "EIO" });
    expect(run.error).not.toBeInstanceOf(HeldFileHelperUnavailableError);
    expectLeftByHelper(run.error, hidden);
  });

  it.each(SUFFIXES)("keeps the refusal of a commit answered `refused target %s`, also through an error that wraps it", async (suffix, hidden) => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => {
        helper.say("progress 8", "copied");
        helper.once("input", () => { helper.say(`refused target ${suffix}`); helper.exit(3); });
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toBeInstanceOf(HeldDirectoryRefusedError);
    expect(run.error).toMatchObject({ refusal: "target" });
    expectLeftByHelper(run.error, hidden);
    expect(stoppedCopyOf(new Error("wrapped", { cause: run.error }))).toEqual({ partialCopy: "left", partLeftAt: null });
  });

  it.each([
    ["a removal", () => files.remove(from, "staged", () => true, UNSTOPPED), "ready", "absent left"],
    ["a copy before `ready`", () => files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED), null, "failed EIO left"],
    ["a copy's refusal before `copied`", () => files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED), "ready", "refused target left"],
    ["a copy's cancel nobody asked for", () => files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED), "ready", "cancelled left"],
    ["a copy, with a hidden name of another shape", () => files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED), "ready", "failed EIO left .0123.removing"],
  ] as const)("treats a left answer from %s as a protocol violation", async (_case, start, first, answer) => {
    script((helper) => {
      if (first === null) { helper.say(answer); return; }
      helper.say(first);
      helper.once("input", () => helper.say(answer));
    });
    const run = follow<unknown>(start());
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(String((run.error as Error).message)).toMatch(/outside its mode or phase/);
  });
});

// A staged download's `done` reports what its removal helper did to the staged file, down to a kill that is not seen to end.
describe("the outcome a staged download's removal reports", () => {
  it.each([
    ["removes it", "removed", (helper: FakeHelper) => { helper.say("ready"); helper.once("input", () => { helper.say("removed"); helper.exit(0); }); }],
    ["fails", "remove-failed", (helper: FakeHelper) => { helper.say("ready"); helper.once("input", () => { helper.say("failed EIO"); helper.exit(4); }); }],
    ["is killed but not seen to end", "helper-still-running", (helper: FakeHelper) => { helper.diesWhenKilled = false; }],
  ] as const)("reports what a removal helper that %s did to a closed dialog's staged file: %s", async (_case, cleanup, behave) => {
    const { mkdtempSync, realpathSync, statSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { stageBrowserDownload } = await import("../browser-download-staging.js");
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "download-outcome-")));
    try {
      const info = statSync(directory, { bigint: true });
      const root = { path: directory, dev: info.dev, ino: info.ino, files };
      script(behave);
      const item = Object.assign(new EventEmitter(), {
        getFilename: () => "report.pdf", getURL: () => "https://site.example/report", getURLChain: () => ["https://site.example/report"],
        hasUserGesture: () => true, getReceivedBytes: () => 8, getTotalBytes: () => 8, getState: () => "progressing" as const,
        pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), setSavePath: vi.fn(),
      });
      const staged = stageBrowserDownload(item, { root, askSavePath: async () => null }, Promise.resolve());
      const done = follow(new Promise<[string, string]>((resolve) => staged.download.once("done", (_event, state, outcome) => resolve([state, outcome]))));
      await staged.answered;
      await flush();
      await advance(BOUNDS.stallMs + BOUNDS.killMs);
      expect(done).toMatchObject({ settled: true, value: ["cancelled", cleanup] });
      expect(helpers()).toHaveLength(1);
      expect(helpers()[0]?.args[0]).toBe("--dir-remove");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  // A silent helper killed at the stall bound whose exit is seen: on its close, or at the kill bound when its pipes stay open.
  it.each([
    ["dies when killed", false],
    ["exits when killed but keeps its pipes open", true],
  ] as const)("reports a closed dialog's staged file as not removed when a silent removal helper %s", async (_case, pipesOpen) => {
    const { mkdtempSync, realpathSync, statSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { stageBrowserDownload } = await import("../browser-download-staging.js");
    const { forceKillManagedChildProcess } = await import("../../managed-child-processes.js");
    if (pipesOpen) {
      vi.mocked(forceKillManagedChildProcess).mockImplementationOnce((child) => {
        const helper = child as unknown as FakeHelper;
        helper.killed += 1;
        helper.signalCode = "SIGKILL";
        helper.emit("exit", null, "SIGKILL");
      });
    }
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "download-outcome-")));
    try {
      const info = statSync(directory, { bigint: true });
      script(() => {});
      const item = Object.assign(new EventEmitter(), {
        getFilename: () => "report.pdf", getURL: () => "https://site.example/report", getURLChain: () => ["https://site.example/report"],
        hasUserGesture: () => true, getReceivedBytes: () => 8, getTotalBytes: () => 8, getState: () => "progressing" as const,
        pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), setSavePath: vi.fn(),
      });
      const staged = stageBrowserDownload(item, { root: { path: directory, dev: info.dev, ino: info.ino, files }, askSavePath: async () => null }, Promise.resolve());
      const done = follow(new Promise<[string, string]>((resolve) => staged.download.once("done", (_event, state, outcome) => resolve([state, outcome]))));
      await staged.answered;
      await flush();
      await advance(BOUNDS.stallMs);
      expect(helpers()[0]?.killed).toBe(1);
      expect(done.settled).toBe(!pipesOpen);
      await advance(BOUNDS.killMs);
      expect(done).toMatchObject({ settled: true, value: ["cancelled", "remove-failed"] });
      expect(helpers()).toHaveLength(1);
    } finally {
      for (const helper of helpers()) { helper.stdout.end(); helper.stderr.end(); }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// A cross-volume copy whose helper writes its temporary file in the chosen folder, stalls, and is not ended by its kill. The stand-ins act
// on real folders: the copy creates its temporary file, and removals and the sweep unlink what they name.
const fs = await import("node:fs");
const { basename, join } = await import("node:path");
const { tmpdir } = await import("node:os");
const { stageBrowserDownload, sweepBrowserDownloadStaging } = await import("../browser-download-staging.js");
const arg = (helper: FakeHelper, index: number): string => helper.args[index] ?? "";
const MOVED_ASIDE = /^\.[0-9a-f]{32}\.removing$/u;
describe("a stalled copy's temporary file in the chosen folder", () => {
  interface Faults {
    readonly copyDiesWhenKilled: boolean;
    // The copy writes its temporary file but never says so.
    readonly quietCopy: boolean;
    // The copy answers that it failed once it has written its temporary file, and ends.
    readonly copyFails: boolean;
    // Runs as a removal is let go, before it acts; answering "refuse" ends it without an outcome.
    readonly beforeRemove: (helper: FakeHelper) => "refuse" | undefined;
  }
  const actOnRealFolders = ({ copyDiesWhenKilled, quietCopy, copyFails, beforeRemove }: Faults) => (helper: FakeHelper): void => {
    const [mode] = helper.args;
    helper.say("ready");
    if (mode === "--dir-copy") {
      helper.diesWhenKilled = copyDiesWhenKilled;
      helper.once("input", () => {
        const part = join(arg(helper, 5), arg(helper, 9));
        fs.writeFileSync(part, "partial copy");
        // Whole seconds, which a copy of the file keeps exactly, as FAT keeps only coarse times.
        if (boundary.linkless) fs.utimesSync(part, 1_700_000_000, 1_700_000_000);
        if (!quietCopy) helper.say("progress 1048576");
        if (copyFails) {
          helper.say("failed EIO");
          helper.exit(4);
        }
      });
    } else if (mode === "--dir-remove") {
      helper.once("input", () => {
        if (beforeRemove(helper) === "refuse") {
          helper.exit(1);
          return;
        }
        const path = join(arg(helper, 1), arg(helper, 4));
        const present = fs.existsSync(path);
        try {
          if (present) fs.unlinkSync(path);
        } catch {
          // A removal the file system refuses ends without an outcome.
          helper.exit(1);
          return;
        }
        helper.say(present ? "removed" : "absent");
        helper.exit(0);
      });
    } else {
      helper.once("input", () => {
        const names = fs.readdirSync(arg(helper, 1)).filter((name) => fs.lstatSync(join(arg(helper, 1), name)).isFile());
        for (const name of names) fs.unlinkSync(join(arg(helper, 1), name));
        helper.say(`swept ${names.length}`);
        helper.exit(0);
      });
    }
  };
  let base: string;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "download-part-"))); });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  const stalledCopy = async ({
    copyDiesWhenKilled = false, quietCopy = false, copyFails = false, beforeRemove = (_helper: FakeHelper): "refuse" | undefined => undefined, beforeStall = (_chosen: string): void => {},
  } = {}) => {
    const staging = join(base, "staging");
    const chosen = join(base, "chosen");
    fs.mkdirSync(staging);
    fs.mkdirSync(chosen);
    const info = fs.statSync(staging, { bigint: true });
    const root = { path: staging, dev: info.dev, ino: info.ino, files: { ...files, move: async () => "cross-volume" as const } };
    script(actOnRealFolders({ copyDiesWhenKilled, quietCopy, copyFails, beforeRemove }));
    const item = Object.assign(new EventEmitter(), {
      getFilename: () => "report.pdf", getURL: () => "https://site.example/report", getURLChain: () => ["https://site.example/report"],
      hasUserGesture: () => true, getReceivedBytes: () => 8, getTotalBytes: () => 8, getState: () => "completed" as const,
      pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), setSavePath: vi.fn(),
    });
    const staged = stageBrowserDownload(item, { root, askSavePath: async () => join(chosen, "report.pdf") }, Promise.resolve());
    const done = follow(new Promise<[string, string]>((resolve) => staged.download.once("done", (_event, state, outcome) => resolve([state, outcome]))));
    await staged.answered;
    item.emit("done", {}, "completed");
    await flush();
    beforeStall(chosen);
    await advance(BOUNDS.stallMs);
    await advance(BOUNDS.killMs);
    await flush();
    const copy = helpers().find((helper) => helper.args[0] === "--dir-copy");
    if (copy === undefined) throw new Error("no copy was started");
    return { root, staging, chosen, copy, part: join(chosen, arg(copy, 9)), done };
  };
  const removalsIn = (folder: string) => helpers().filter((helper) => helper.args[0] === "--dir-remove" && helper.args[1] === folder);
  const records = (staging: string) => fs.readdirSync(staging).filter((name) => /^[0-9a-f]{32}\.cleanup\.json$/u.test(name));
  const recordedAt = (staging: string) => records(staging).map((name) => (JSON.parse(fs.readFileSync(join(staging, name), "utf8")) as { at: string }).at);

  it("never removes a file put over the temporary file's name before a helper that is seen to end was killed", async () => {
    const { staging, chosen, part, done } = await stalledCopy({
      copyDiesWhenKilled: true,
      beforeStall: (folder) => {
        const [name] = fs.readdirSync(folder);
        fs.writeFileSync(join(folder, "mine.txt"), "the user's file");
        fs.renameSync(join(folder, "mine.txt"), join(folder, name ?? ""));
      },
    });
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
    expect(helpers().filter((helper) => helper.args[0] === "--dir-remove").map((helper) => helper.args[1])).not.toContain(chosen);
    expect(records(staging)).toEqual([]);
  });

  it("reports the temporary file as left, and removes it once the helper is seen to end", async () => {
    const { staging, copy, part, done } = await stalledCopy();
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    expect(copy.killed).toBe(1);
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(records(staging)).toHaveLength(1);
    copy.exit(null, "SIGKILL");
    await flush();
    await flush();
    expect(fs.existsSync(part)).toBe(false);
    expect(fs.readdirSync(staging)).toEqual([]);
  });

  it("leaves it for the next start while the helper never ends, and that start's sweep removes it", async () => {
    const { root, staging, chosen, copy, part, done } = await stalledCopy();
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    expect(fs.existsSync(part)).toBe(true);
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 1 });
    expect(fs.existsSync(part)).toBe(false);
    expect(fs.readdirSync(staging)).toEqual([]);
    const spawned = helpers().length;
    copy.exit(null, "SIGKILL");
    await flush();
    await flush();
    // The helper ending later finds no temporary file, so nothing more is done in the chosen folder.
    expect(helpers().slice(spawned).map((helper) => helper.args[1])).not.toContain(chosen);
    expect(fs.readdirSync(chosen)).toEqual([]);
  });

  it("never removes a file put over the temporary file's name, when the helper ends or at the next start", async () => {
    const { root, staging, chosen, copy, part, done } = await stalledCopy();
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    const mine = join(chosen, "mine.txt");
    fs.writeFileSync(mine, "the user's file");
    fs.renameSync(mine, part);
    copy.exit(null, "SIGKILL");
    await flush();
    await flush();
    expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
    expect(records(staging)).toHaveLength(1);
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 1 });
    expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
    expect(fs.readdirSync(staging)).toEqual([]);
  });

  it("never removes by name a temporary file it never saw while the copy wrote it", async () => {
    const { chosen, part, done } = await stalledCopy({ copyDiesWhenKilled: true, quietCopy: true });
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(removalsIn(chosen)).toEqual([]);
    expect(boundary.warn).toHaveBeenCalledWith({ path: part }, expect.stringContaining("never seen while the copy wrote it"));
  });

  it("puts back, and never removes, a file put at the temporary file's name just before it is moved aside", async () => {
    const { chosen, part, done } = await stalledCopy({
      copyDiesWhenKilled: true,
      beforeStall: (folder) => {
        boundary.beforeRename = (from) => {
          if (from !== join(folder, fs.readdirSync(folder)[0] ?? "")) return;
          boundary.beforeRename = null;
          fs.unlinkSync(from);
          fs.writeFileSync(from, "the user's file");
        };
      },
    });
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    expect(fs.readdirSync(chosen)).toEqual([part.slice(chosen.length + 1)]);
    expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
    expect(removalsIn(chosen)).toEqual([]);
  });

  it("removes the copy's file, moved aside, and never touches a file put at its name after that", async () => {
    let original = "";
    let folder = "";
    const { chosen, part, done } = await stalledCopy({
      copyDiesWhenKilled: true,
      beforeRemove: (helper) => {
        if (arg(helper, 1) === folder && original !== "") fs.writeFileSync(join(folder, original), "the user's file");
        return undefined;
      },
      beforeStall: (chosenFolder) => {
        folder = chosenFolder;
        original = fs.readdirSync(chosenFolder)[0] ?? "";
      },
    });
    expect(fs.readdirSync(chosen)).toEqual([original]);
    expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "removed"] });
    const [removal] = removalsIn(chosen);
    expect(arg(removal as FakeHelper, 4)).toMatch(/^\.[0-9a-f]{32}\.removing$/u);
  });

  it("puts the copy's file back when its removal fails after it was moved aside, and the next start removes it", async () => {
    let folder = "";
    let refused = false;
    const { root, staging, chosen, copy, part, done } = await stalledCopy({
      beforeRemove: (helper) => {
        if (arg(helper, 1) !== folder || refused) return undefined;
        refused = true;
        return "refuse";
      },
      beforeStall: (chosenFolder) => { folder = chosenFolder; },
    });
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    copy.exit(null, "SIGKILL");
    await flush();
    await flush();
    expect(refused).toBe(true);
    expect(fs.readdirSync(chosen)).toEqual([part.slice(chosen.length + 1)]);
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(records(staging)).toHaveLength(1);
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 1 });
    expect(fs.readdirSync(chosen)).toEqual([]);
    expect(fs.readdirSync(staging)).toEqual([]);
  });

  it("leaves the temporary file, and its record for the next start, when it cannot be moved aside", async () => {
    const { staging, chosen, copy, part, done } = await stalledCopy();
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    boundary.beforeRename = () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); };
    copy.exit(null, "SIGKILL");
    await flush();
    // On Windows the rename is tried again through the bounded lock ladder.
    await advance(BACKGROUND_BUDGET_MS);
    await flush();
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(records(staging)).toHaveLength(1);
    expect(removalsIn(chosen)).toEqual([]);
    expect(boundary.warn).toHaveBeenCalledWith({ path: part, code: "EPERM" }, expect.stringContaining("could not be moved aside"));
  });

  it.runIf(process.platform === "win32")("leaves the temporary file while another process holds it without sharing", async () => {
    let held: number | null = null;
    try {
      const { chosen, part, done } = await stalledCopy({
        copyDiesWhenKilled: true,
        beforeStall: (folder) => {
          // The exclusive-lock open flag, which node:fs does not name: the file is opened with no sharing, as another program may hold it.
          held = fs.openSync(join(folder, fs.readdirSync(folder)[0] ?? ""), fs.constants.O_RDONLY | 0x10000000);
        },
      });
      // The rename is tried again through the bounded lock ladder before the file is left.
      await advance(BACKGROUND_BUDGET_MS);
      await flush();
      expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
      expect(fs.readdirSync(chosen)).toEqual([part.slice(chosen.length + 1)]);
      expect(removalsIn(chosen)).toEqual([]);
      expect(boundary.warn).toHaveBeenCalledWith({ path: part, code: "EBUSY" }, expect.stringContaining("could not be moved aside"));
    } finally {
      if (held !== null) fs.closeSync(held);
    }
  });

  // A folder like FAT or exFAT: a file moved aside has another id there, and nothing can be linked back.
  describe("in a folder without hard links", () => {
    beforeEach(() => { boundary.linkless = true; });

    it("removes the copy's file, given another id by its move aside, once its content is the copy's", async () => {
      const { staging, chosen, done } = await stalledCopy({ copyDiesWhenKilled: true });
      expect(fs.readdirSync(chosen)).toEqual([]);
      expect(done).toMatchObject({ settled: true, value: ["interrupted", "removed"] });
      expect(arg(removalsIn(chosen)[0] as FakeHelper, 4)).toMatch(/^\.[0-9a-f]{32}\.removing$/u);
      expect(records(staging)).toEqual([]);
    });

    it("puts back, and never removes, a file with other content put at the temporary file's name just before it is moved aside", async () => {
      const { chosen, part, done } = await stalledCopy({
        copyDiesWhenKilled: true,
        beforeStall: (folder) => {
          boundary.beforeRename = (from) => {
            if (!from.startsWith(folder) || !from.endsWith(".part")) return;
            boundary.beforeRename = null;
            fs.unlinkSync(from);
            fs.writeFileSync(from, "the user's file");
          };
        },
      });
      await flush();
      await flush();
      expect(fs.readdirSync(chosen)).toEqual([part.slice(chosen.length + 1)]);
      expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
      expect(removalsIn(chosen)).toEqual([]);
      expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    });

    // The helper ends late; the removal of the copy's file, moved aside, fails while a file is put at its name, so it cannot go back.
    const leftUnderHiddenName = async () => {
      let folder = "";
      let original = "";
      let refused = false;
      const copied = await stalledCopy({
        beforeRemove: (helper) => {
          if (arg(helper, 1) !== folder || refused) return undefined;
          refused = true;
          fs.writeFileSync(join(folder, original), "the user's file");
          return "refuse";
        },
        beforeStall: (chosenFolder) => {
          folder = chosenFolder;
          original = fs.readdirSync(chosenFolder)[0] ?? "";
        },
      });
      expect(copied.done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
      copied.copy.exit(null, "SIGKILL");
      await flush();
      await flush();
      expect(refused).toBe(true);
      return { ...copied, original };
    };

    it("keeps the copy's file it cannot put back tracked, by its hidden name and its content, for the next start", async () => {
      const { staging, chosen, original } = await leftUnderHiddenName();
      const hidden = fs.readdirSync(chosen).find((name) => name !== original) ?? "";
      expect(hidden).toMatch(/^\.[0-9a-f]{32}\.removing$/u);
      expect(fs.readFileSync(join(chosen, original), "utf8")).toBe("the user's file");
      expect(fs.readFileSync(join(chosen, hidden), "utf8")).toBe("partial copy");
      const kept = records(staging).map((name) => JSON.parse(fs.readFileSync(join(staging, name), "utf8")) as { part: string; at: string; identity: { kind: string } });
      expect(kept).toEqual([expect.objectContaining({ part: original, at: hidden, identity: expect.objectContaining({ kind: "fingerprint" }) })]);
    });

    it("never replaces a file put at the temporary file's name while the copy's file is being put back", async () => {
      let folder = "";
      let original = "";
      let putThere = 0;
      const putUsersFile = (to: string): void => {
        if (to !== join(folder, original) || putThere > 0) return;
        putThere += 1;
        fs.writeFileSync(to, "the user's file");
      };
      const copied = await stalledCopy({
        beforeRemove: (helper) => (arg(helper, 1) === folder ? "refuse" : undefined),
        beforeStall: (chosenFolder) => {
          folder = chosenFolder;
          original = fs.readdirSync(chosenFolder)[0] ?? "";
          // Whichever way the file is put back, the user's file lands at its name right before.
          boundary.beforeRename = (from, to) => { if (MOVED_ASIDE.test(basename(from))) putUsersFile(to); };
          boundary.beforeCopy = (_from, to) => { putUsersFile(to); };
        },
      });
      copied.copy.exit(null, "SIGKILL");
      await flush();
      await flush();
      expect(putThere).toBe(1);
      expect(fs.readFileSync(join(folder, original), "utf8")).toBe("the user's file");
      const hidden = fs.readdirSync(folder).find((name) => name !== original) ?? "";
      expect(hidden).toMatch(MOVED_ASIDE);
      expect(fs.readFileSync(join(folder, hidden), "utf8")).toBe("partial copy");
      const kept = records(copied.staging).map((name) => JSON.parse(fs.readFileSync(join(copied.staging, name), "utf8")) as { part: string; at: string });
      expect(kept).toEqual([expect.objectContaining({ part: original, at: hidden })]);
    });

    it("puts the copy's file back as a new file, known by the copy's own content, when its removal fails", async () => {
      let folder = "";
      const copied = await stalledCopy({
        beforeRemove: (helper) => (arg(helper, 1) === folder ? "refuse" : undefined),
        beforeStall: (chosenFolder) => { folder = chosenFolder; },
      });
      const original = basename(copied.part);
      copied.copy.exit(null, "SIGKILL");
      await flush();
      await flush();
      expect(fs.readdirSync(folder)).toEqual([original]);
      expect(fs.readFileSync(copied.part, "utf8")).toBe("partial copy");
      const kept = records(copied.staging).map((name) => JSON.parse(fs.readFileSync(join(copied.staging, name), "utf8")) as { at: string; identity: { mtimeNs: string } });
      const mtimeNs = fs.statSync(copied.part, { bigint: true }).mtimeNs.toString();
      expect(kept).toEqual(expect.arrayContaining([expect.objectContaining({ at: original, identity: expect.objectContaining({ mtimeNs }) })]));
    });

    it("finds that file by its hidden name at the next start, and removes only it", async () => {
      const { root, staging, chosen, original } = await leftUnderHiddenName();
      const swept = follow(sweepBrowserDownloadStaging(root));
      await flush();
      await flush();
      expect(fs.readdirSync(chosen)).toEqual([original]);
      expect(fs.readFileSync(join(chosen, original), "utf8")).toBe("the user's file");
      expect(swept).toMatchObject({ settled: true, value: 1 });
      expect(fs.readdirSync(staging)).toEqual([]);
    });
  });

  it("in a folder with hard links, probes that once per volume and removes the copy's file by its id", async () => {
    const { removeOwnFile } = await import("../browser-download-files.js");
    const { chosen, done } = await stalledCopy({ copyDiesWhenKilled: true });
    expect(fs.readdirSync(chosen)).toEqual([]);
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "removed"] });
    const probes = () => boundary.links.filter(([, link]) => /\.probe$/u.test(link));
    expect(probes()).toHaveLength(1);
    // Another file on that volume: no second probe, and the same check by id.
    const name = ".0123456789abcdef0123456789abcdef.part";
    fs.writeFileSync(join(chosen, name), "another");
    const info = fs.statSync(chosen, { bigint: true });
    const file = fs.statSync(join(chosen, name), { bigint: true });
    const folder = { path: chosen, dev: info.dev, ino: info.ino };
    const removed = await removeOwnFile(folder, name, name, { kind: "fileId", file: { dev: file.dev, ino: file.ino, birthtimeNs: file.birthtimeNs } },
      async (directory, at) => { fs.unlinkSync(join(directory.path, at)); return "removed"; });
    expect(removed).toEqual({ outcome: "removed" });
    expect(probes()).toHaveLength(1);
    expect(fs.readdirSync(chosen)).toEqual([]);
  });

  it("does not record a file again at a start whose sweep fails and keeps its record", async () => {
    const { root, staging, chosen, part } = await stalledCopy();
    fs.rmSync(chosen, { recursive: true, force: true });
    const failing = { ...root, files: { ...root.files, sweep: async () => { throw new Error("the sweep failed"); } } };
    for (let start = 0; start < 2; start += 1) {
      const swept = follow(sweepBrowserDownloadStaging(failing));
      await flush();
      await flush();
      expect(swept.error).toBeInstanceOf(Error);
      expect(recordedAt(staging)).toEqual([basename(part)]);
    }
  });

  it("records anew, at the next start, a file the sweep left under another name", async () => {
    let chosenFolder = "";
    let original = "";
    const { root, staging, chosen } = await stalledCopy({
      beforeRemove: (helper) => {
        if (arg(helper, 1) !== chosenFolder) return undefined;
        // The removal fails while a file is put at the temporary file's name, so it cannot go back.
        fs.writeFileSync(join(chosenFolder, original), "the user's file");
        return "refuse";
      },
      beforeStall: (folder) => {
        chosenFolder = folder;
        original = fs.readdirSync(folder)[0] ?? "";
      },
    });
    expect(recordedAt(staging)).toEqual([original]);
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept.error).toBeUndefined();
    const hidden = fs.readdirSync(chosen).find((name) => name !== original) ?? "";
    expect(hidden).toMatch(MOVED_ASIDE);
    expect(fs.readFileSync(join(chosen, original), "utf8")).toBe("the user's file");
    expect(fs.readFileSync(join(chosen, hidden), "utf8")).toBe("partial copy");
    expect(recordedAt(staging)).toEqual([hidden]);
  });

  // The host's own cleanup of a copy it stopped (the Linux copy), on a real folder.
  describe("a stopped copy's own temporary file", () => {
    const part = ".0123456789abcdef0123456789abcdef.part";
    const written = async () => {
      const chosen = join(base, "chosen");
      fs.mkdirSync(chosen);
      fs.writeFileSync(join(chosen, part), "partial copy");
      const info = fs.statSync(chosen, { bigint: true });
      const file = fs.statSync(join(chosen, part), { bigint: true });
      return { chosen, folder: { path: chosen, dev: info.dev, ino: info.ino }, file: { dev: file.dev, ino: file.ino, birthtimeNs: file.birthtimeNs } };
    };
    // Another file put at the temporary file's name, as a user or another program may.
    const swapped = (chosen: string): void => {
      fs.renameSync(join(chosen, part), join(chosen, "elsewhere"));
      fs.writeFileSync(join(chosen, part), "the user's file");
    };

    it("never removes a file put at its name when the copy is cancelled, and reports it left", async () => {
      const { cleanStoppedPart, stoppedCopyOf } = await import("../browser-download-files.js");
      const { chosen, folder, file } = await written();
      swapped(chosen);
      const cleaned = cleanStoppedPart(folder, part, file, null);
      await expect(cleaned).rejects.toThrow(/temporary file is left/u);
      expect(stoppedCopyOf(await cleaned.catch((error: unknown) => error))).toEqual({ partialCopy: "left", partLeftAt: null });
      expect(fs.readFileSync(join(chosen, part), "utf8")).toBe("the user's file");
    });

    it("never removes a file put at its name when the copy fails, and reports it left on the failure", async () => {
      const { cleanStoppedPart, stoppedCopyOf } = await import("../browser-download-files.js");
      const { chosen, folder, file } = await written();
      swapped(chosen);
      const failure = new Error("the copy failed");
      await cleanStoppedPart(folder, part, file, { error: failure });
      expect(stoppedCopyOf(failure)).toEqual({ partialCopy: "left", partLeftAt: null });
      expect(fs.readFileSync(join(chosen, part), "utf8")).toBe("the user's file");
    });

    it("removes the file the copy wrote", async () => {
      const { cleanStoppedPart, stoppedCopyOf } = await import("../browser-download-files.js");
      const { chosen, folder, file } = await written();
      await cleanStoppedPart(folder, part, file, null);
      const failure = new Error("the copy failed");
      fs.writeFileSync(join(chosen, part), "partial copy");
      const again = fs.statSync(join(chosen, part), { bigint: true });
      await cleanStoppedPart(folder, part, { dev: again.dev, ino: again.ino, birthtimeNs: again.birthtimeNs }, { error: failure });
      expect(stoppedCopyOf(failure)).toEqual({ partialCopy: "removed", partLeftAt: null });
      expect(fs.readdirSync(chosen)).toEqual([]);
    });

    it("leaves a file it never saw the copy write", async () => {
      const { cleanStoppedPart } = await import("../browser-download-files.js");
      const { chosen, folder } = await written();
      await expect(cleanStoppedPart(folder, part, null, null)).rejects.toThrow(/temporary file is left/u);
      expect(fs.readFileSync(join(chosen, part), "utf8")).toBe("partial copy");
      expect(boundary.warn).toHaveBeenCalledWith({ path: join(chosen, part) }, expect.stringContaining("never seen while the copy wrote it"));
    });
  });

  it("says a file known by its content is left because its folder is gone, not that it could not be moved aside", async () => {
    const { removeOwnFile } = await import("../browser-download-files.js");
    const chosen = join(base, "chosen");
    fs.mkdirSync(chosen);
    const info = fs.statSync(chosen, { bigint: true });
    fs.rmSync(chosen, { recursive: true });
    const name = ".0123456789abcdef0123456789abcdef.part";
    const identity = { kind: "fingerprint", content: { size: 12n, mtimeNs: 1n, head: "0".repeat(64), tail: "0".repeat(64) } } as const;
    const remove = vi.fn(async () => "removed" as const);
    const result = await removeOwnFile({ path: chosen, dev: info.dev, ino: info.ino }, name, name, identity, remove);
    expect(result).toEqual({ outcome: "left", at: { name, identity } });
    expect(remove).not.toHaveBeenCalled();
    expect(boundary.warn).toHaveBeenCalledWith({ path: join(chosen, name) }, expect.stringContaining("its folder is no longer the chosen one"));
    expect(boundary.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("could not be moved aside"));
  });

  describe("the hard-link probe", () => {
    const name = ".0123456789abcdef0123456789abcdef.part";
    const probes = () => boundary.links.filter(([, link]) => /\.probe$/u.test(link)).map(([, link]) => link);
    // Write a temporary file in a fresh folder and remove it through the probe and the check by id.
    const removeOne = async (folderName: string) => {
      const { removeOwnFile } = await import("../browser-download-files.js");
      const chosen = join(base, folderName);
      fs.mkdirSync(chosen);
      fs.writeFileSync(join(chosen, name), "partial copy");
      const info = fs.statSync(chosen, { bigint: true });
      const file = fs.statSync(join(chosen, name), { bigint: true });
      const result = await removeOwnFile({ path: chosen, dev: info.dev, ino: info.ino }, name, name,
        { kind: "fileId", file: { dev: file.dev, ino: file.ino, birthtimeNs: file.birthtimeNs } },
        async (directory, at) => { fs.unlinkSync(join(directory.path, at)); return "removed"; });
      return { chosen, result };
    };

    it("does not keep a probe that failed for a passing reason, and probes again at the next cleanup", async () => {
      let faults = 1;
      boundary.linkFault = () => (faults-- > 0 ? "EBUSY" : null);
      const first = await removeOne("first");
      expect(first.result).toEqual({ outcome: "removed" });
      expect(fs.readdirSync(first.chosen)).toEqual([]);
      expect(boundary.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "EBUSY" }), expect.stringContaining("could not be probed"));
      await removeOne("second");
      await removeOne("third");
      // The failed probe, then one that answers for the volume, then none.
      expect(probes()).toHaveLength(2);
    });

    it("keeps a probe whose failure says the file system has no hard links", async () => {
      boundary.linkFault = () => "ENOTSUP";
      expect((await removeOne("first")).result).toEqual({ outcome: "removed" });
      expect((await removeOne("second")).result).toEqual({ outcome: "removed" });
      expect(probes()).toHaveLength(1);
    });

    it("says distinctly when the probe's name cannot be removed", async () => {
      boundary.unlinkFault = (path) => (/\.probe$/u.test(path) ? "EIO" : null);
      const { chosen, result } = await removeOne("first");
      expect(result).toEqual({ outcome: "removed" });
      const [probe] = probes();
      expect(fs.readdirSync(chosen)).toEqual([basename(probe ?? "")]);
      expect(boundary.warn).toHaveBeenCalledWith({ path: join(chosen, name), probe, code: "EIO" }, expect.stringContaining("probe's name for a temporary download file is left"));
    });

    it.runIf(process.platform === "win32")("removes the probe's name after another program's brief lock", async () => {
      let locks = 1;
      boundary.unlinkFault = (path) => (/\.probe$/u.test(path) && locks-- > 0 ? "EBUSY" : null);
      const removing = follow(removeOne("first"));
      await flush();
      await flush();
      await advance(BACKGROUND_BUDGET_MS);
      await flush();
      await flush();
      expect(removing.value?.result).toEqual({ outcome: "removed" });
      expect(fs.readdirSync(removing.value?.chosen ?? "")).toEqual([]);
      expect(boundary.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("probe's name"));
    });
  });

  it.runIf(process.platform === "win32")("moves the copy's file aside after another program's brief lock, and removes it", async () => {
    let locked = 0;
    const { chosen, done } = await stalledCopy({
      copyDiesWhenKilled: true,
      beforeStall: () => {
        boundary.beforeRename = () => {
          locked += 1;
          if (locked === 1) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
        };
      },
    });
    await advance(BACKGROUND_BUDGET_MS);
    await flush();
    expect(fs.readdirSync(chosen)).toEqual([]);
    expect(locked).toBe(2);
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "removed"] });
  });

  it("never follows a record swapped for a link after it was listed", async () => {
    const { root, staging, part } = await stalledCopy();
    const [name] = records(staging);
    const recordPath = join(staging, name ?? "");
    // The same record, outside the staging folder.
    const elsewhere = join(base, "elsewhere.json");
    fs.copyFileSync(recordPath, elsewhere);
    boundary.afterLstat = (path) => {
      if (path !== recordPath) return;
      boundary.afterLstat = null;
      fs.unlinkSync(recordPath);
      fs.symlinkSync(elsewhere, recordPath, "file");
    };
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(swept.settled).toBe(true);
    // The link is never followed. macOS and Linux refuse to open it (O_NOFOLLOW answers ELOOP), so the record cannot be acted on; Windows
    // opens what it names and finds a file other than the one listed.
    if (process.platform === "win32") {
      expect(boundary.warn).toHaveBeenCalledWith({ path: recordPath }, expect.stringContaining("not one this app wrote"));
    } else {
      expect(boundary.warn).toHaveBeenCalledWith({ path: recordPath, error: expect.stringMatching(/^ELOOP/) }, expect.stringContaining("could not be acted on"));
    }
  });

  it("says a recorded file's folder is gone, not that the file there is another, and keeps the record", async () => {
    const { staging, chosen, copy, part } = await stalledCopy();
    fs.rmSync(chosen, { recursive: true, force: true });
    copy.exit(null, "SIGKILL");
    await flush();
    await flush();
    expect(boundary.warn).toHaveBeenCalledWith({ path: part }, expect.stringContaining("its folder is no longer the chosen one"));
    expect(boundary.warn).not.toHaveBeenCalledWith({ path: part }, expect.stringContaining("not the file that was written"));
    expect(records(staging)).toHaveLength(1);
  });

  it("removes the temporary file of a copy the helper reports failed, once it is the file the copy wrote", async () => {
    const { chosen, done } = await stalledCopy({ copyFails: true });
    expect(fs.readdirSync(chosen)).toEqual([]);
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "removed"] });
    expect(arg(removalsIn(chosen)[0] as FakeHelper, 4)).toMatch(/^\.[0-9a-f]{32}\.removing$/u);
  });

  it("reports the temporary file of a copy the helper reports failed as left, when it was never seen while written", async () => {
    const { chosen, part, done } = await stalledCopy({ copyFails: true, quietCopy: true });
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(removalsIn(chosen)).toEqual([]);
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
  });
});
