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
}));
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

const { _helperFileOperationsForTest, HeldDirectoryRefusedError, HeldFileHelperStalledError, HeldFileHelperUnavailableError } =
  await import("../browser-download-files.js");

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
    // Let past `ready` only, so its commit was never allowed; its temporary file is removed through the chosen folder, held anew.
    expect(copy?.input).toBe("c");
    expect(run.error).toMatchObject({ passed: "ready", partialCopy: "removed", stillRunning: false });
    const [, removal] = helpers();
    expect(removal?.args).toEqual(["--dir-remove", "/chosen", "1", "3", ".0123.part"]);
    expect(helpers()).toHaveLength(2);
  });

  it("kills it at the stall bound after it is told no at `copied`, and removes its temporary file", async () => {
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
    expect(run.error).toMatchObject({ passed: "ready", partialCopy: "removed", stillRunning: false });
    expect(copy?.input).toBe("c");
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

  it("rejects invalid diagnostics independently of pipe order, and never accepts them as successful outcomes", async () => {
    for (const diagnostic of ["x", "Windows error 32\n\n", "Windows error 32\nextra", "Windows error 32"]) {
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
      expect(helpers()[1]?.args).toEqual(["--dir-remove", directory, info.dev.toString(), info.ino.toString(), expect.stringMatching(/^\.[0-9a-f]{32}\.part$/u)]);
      expect(boundary.warn).toHaveBeenCalledWith({ path: join(directory, "report.pdf") }, expect.stringContaining("commit was allowed"));
      expect(boundary.info).toHaveBeenCalledWith({ path: expect.stringMatching(/\.part$/u), partialCopy: "removed" }, expect.stringContaining("left no temporary file"));
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
    expect(run.error).toMatchObject({ passed: lastStep, partialCopy: "removed" });
    expect(helpers()[1]?.args).toEqual(["--dir-remove", "/chosen", "1", "3", ".0123.part"]);
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
