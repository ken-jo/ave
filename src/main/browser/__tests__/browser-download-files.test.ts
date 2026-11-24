import { createHash } from "node:crypto";
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

const { _helperFileOperationsForTest, HeldDirectoryRefusedError, HeldFileHelperStalledError, HeldFileHelperUnavailableError, stoppedCopyOf } =
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
  it("keeps the entire Windows writer identity when rejecting a plain refusal after progress", async () => {
    const windows = _helperFileOperationsForTest("/helper/ave-path-kind.exe", BOUNDS, true);
    const fileId = "fedcba9876543210123456789abcdef0";
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => {
        if (helper.args[0] === "--dir-remove-id") {
          helper.say("left");
          helper.exit(0);
        } else {
          helper.say(`writing 4294967297 ${fileId}`, "progress 8", "refused source");
          helper.exit(3);
        }
      });
    });
    const run = follow(windows.copy(from, "staged", to, "report.pdf", ".part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(helpers()[0]?.killed).toBe(1);
    expect(helpers()[1]?.args).toEqual(["--dir-remove-id", "/chosen", "1", "3", ".part", "4294967297", fileId]);
  });

  it("kills a copy that refuses its source after making progress", async () => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => {
        helper.say("writing 1 2", "progress 8", "refused source");
        helper.exit(3);
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(helpers()[0]?.killed).toBe(1);
  });

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
      expect(boundary.warn).toHaveBeenCalledWith({ path: expect.stringMatching(/\.part$/u) }, expect.stringContaining("never seen while the copy wrote it"));
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

it("keeps the Windows writer identity for recording when isolation leaves its part in place", async () => {
  const windows = _helperFileOperationsForTest("/helper/ave-path-kind.exe", BOUNDS, true);
  const fileId = "fedcba9876543210123456789abcdef0";
  script((helper) => {
    helper.say("ready");
    helper.once("input", () => {
      helper.say(`writing 4294967297 ${fileId}`, "progress 8", "copied");
      helper.afterInputEnds(() => { helper.say("cancelled left"); helper.exit(0); });
    });
  });
  const run = follow(windows.copy(from, "staged", to, "report.pdf", ".part", (step) => step === "ready", UNSTOPPED));
  await flush();
  expect(stoppedCopyOf(run.error)).toEqual({
    partialCopy: "left",
    partLeftAt: { name: ".part", identity: { kind: "fileId", file: { dev: 4294967297n, ino: BigInt(`0x${fileId}`) } } },
  });
});

// A copy's helper that stops after creating its temporary file says when it did not remove what is at that name (native/macos-dir-ops/README.md):
// The copy reports the file as left and starts no removal of its own.
describe("a copy whose helper says it left its temporary file", () => {
  const HIDDEN = ".0123456789abcdef0123456789abcdef.removing";
  const SUFFIXES = [["left", null], [`left ${HIDDEN} 1 18446744073709551615 mismatch -`, "mismatch"],
    [`left ${HIDDEN} 1 18446744073709551615 remove-failed -`, "remove-failed"]] as const;
  const expectLeftByHelper = (error: unknown, verdict: "mismatch" | "remove-failed" | null): void => {
    expect(stoppedCopyOf(error)).toEqual({ partialCopy: "left", partLeftAt: verdict === null ? null : {
      name: HIDDEN, identity: { kind: "helper", dev: 1n, ino: 18446744073709551615n, verdict, observed: null },
    } });
    expect(helpers()).toHaveLength(1);
  };

  it.each(["EEXIST", "EPERM"])("keeps a plain %s before writing free of part cleanup", async (code) => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => {
        helper.say(`failed ${code}`);
        helper.exit(4);
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toMatchObject({ code });
    expect(stoppedCopyOf(run.error)).toBeNull();
    expect(boundary.warn).not.toHaveBeenCalled();
    expect(helpers()).toHaveLength(1);
  });

  it.each(SUFFIXES)("reports a cancel answered `cancelled %s` as a failure", async (suffix, hidden) => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => helper.say("writing 1 18446744073709551615"));
    });
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

  it("awaits the synced target record even when the helper dies after a complete leftover", async () => {
    let finishWrite = () => {};
    const write = vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const resolved = vi.fn();
    let moveAuthorized = false;
    script((helper) => {
      if (helper.args[0] === "--dir-remove-id") {
        helper.say("ready");
        helper.once("input", () => { helper.say("removed"); helper.exit(0); });
        return;
      }
      helper.say("target-id 1 3 15", "ready");
      helper.once("input", () => {
        helper.say("writing 1 2", "progress 8", "copied");
        helper.once("input", () => {
          moveAuthorized = true;
          helper.say(`target-left left ${HIDDEN} 1 3 mismatch -`);
          helper.exit(7);
        });
      });
    });
    const journal = { hidden: HIDDEN, write, resolved };
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED, journal));
    await flush();
    expect(write).toHaveBeenCalledExactlyOnceWith({ dev: 1n, ino: 3n, birthtimeNs: 15n }, { dev: 1n, ino: 2n });
    expect(moveAuthorized).toBe(false);
    finishWrite();
    await flush();
    expect(moveAuthorized).toBe(true);
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(resolved).not.toHaveBeenCalled();
  });

  it("ends the copy without authorizing a move when the journal cannot be synced", async () => {
    let moveAuthorized = false;
    script((helper) => {
      if (helper.args[0] === "--dir-remove-id") {
        helper.say("ready");
        helper.once("input", () => { helper.say("absent"); helper.exit(0); });
        return;
      }
      helper.say("target-id 1 3 15", "ready");
      helper.once("input", () => {
        helper.say("writing 1 2", "copied");
        helper.once("input", () => { moveAuthorized = true; });
        helper.afterInputEnds(() => { helper.say("cancelled"); helper.exit(0); });
      });
    });
    const journal = { hidden: HIDDEN, write: vi.fn().mockRejectedValue(new Error("sync failed")), resolved: vi.fn() };
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED, journal));
    await flush();
    expect(run.error).toMatchObject({ message: "sync failed" });
    expect(journal.write).toHaveBeenCalledOnce();
    expect(moveAuthorized).toBe(false);
    expect(journal.resolved).not.toHaveBeenCalled();
  });

  it("reports a displaced target separately from the part on a failed commit", async () => {
    script((helper) => {
      helper.say("target-id 1 3 15", "ready");
      helper.once("input", () => {
        helper.say("writing 1 2", "progress 8", "copied");
        helper.once("input", () => {
          helper.say(`target-left left ${HIDDEN} 1 3 mismatch -`, "refused target removed");
          helper.exit(3);
        });
      });
    });
    const record = vi.fn();
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED, { hidden: HIDDEN, write: vi.fn().mockResolvedValue(undefined), resolved: vi.fn(), left: record }));
    await flush();
    expect(run.error).toBeInstanceOf(HeldDirectoryRefusedError);
    expect(stoppedCopyOf(run.error)?.partialCopy).toBe("removed");
    expect(record).toHaveBeenCalledExactlyOnceWith({
      name: HIDDEN, identity: { kind: "helper", dev: 1n, ino: 3n, verdict: "mismatch", observed: null },
    });
  });

  const invalidTargets: { label: string; id?: string; hidden?: string; early?: boolean; duplicate?: boolean;
    old?: string; verdict?: string; snapshot?: string }[] = [
    { label: "before commit authorization", early: true },
    { label: "wrong old identity", id: "1 4" },
    { label: "writing identity as target", id: "1 2" },
    { label: "different leftover volume", id: "2 3" },
    { label: "different announced volume", old: "2 3 15", id: "2 3" },
    { label: "announced writer as old target", old: "1 2 15", id: "1 2" },
    { label: "hidden name from another copy", hidden: ".11111111111111111111111111111111.removing" },
    { label: "different birth time", snapshot: `1:3:16:1:2:${"0".repeat(64)}:${"0".repeat(64)}` },
    { label: "duplicate leftover", duplicate: true },
    { label: "incompatible outcome", verdict: "remove-failed" },
  ];
  it.each(invalidTargets)("rejects a target leftover with $label", async ({
    id = "1 3", hidden = HIDDEN, old = "1 3 15", verdict = "mismatch", snapshot = "-", early, duplicate,
  }) => {
    const left = vi.fn();
    const journal = { hidden: HIDDEN, write: vi.fn().mockResolvedValue(undefined), resolved: vi.fn(), left };
    script((helper) => {
      if (helper.args[0] === "--dir-remove-id") {
        helper.say("ready");
        helper.once("input", () => { helper.say("absent"); helper.exit(0); });
        return;
      }
      helper.say(`target-id ${old}`, "ready");
      helper.once("input", () => {
        const report = () => {
          const line = `target-left left ${hidden} ${id} ${verdict} ${snapshot}`;
          helper.say(line);
          if (duplicate) helper.say(line);
          helper.say("failed EIO");
          helper.exit(4);
        };
        helper.say("writing 1 2");
        if (!early) {
          helper.say("copied");
          helper.once("input", report);
        } else {
          report();
        }
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED, journal));
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(helpers()[0]?.killed).toBe(1);
    expect(left).not.toHaveBeenCalled();
    expect(journal.resolved).not.toHaveBeenCalled();
    if (old !== "1 3 15") expect(journal.write).not.toHaveBeenCalled();
  });

  it.each([
    ["another identity", "writing 1 2", "1 4"],
    ["another volume", "writing 1 2", "2 2"],
    ["the held old target", "writing 1 2", "1 3"],
    ["no writer", null, "1 2"],
  ] as const)("rejects a named copy-part leftover claiming %s", async (_label, writing, claimed) => {
    script((helper) => {
      if (helper.args[0] === "--dir-remove-id") {
        helper.say("ready");
        helper.once("input", () => { helper.say("absent"); helper.exit(0); });
        return;
      }
      helper.say("target-id 1 3 15", "ready");
      helper.once("input", () => {
        if (writing !== null) helper.say(writing);
        helper.say(`failed EIO left ${HIDDEN} ${claimed} mismatch -`);
        helper.exit(4);
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(helpers()[0]?.killed).toBe(1);
    expect(stoppedCopyOf(run.error)?.partLeftAt).toBeNull();
  });

  it.each(SUFFIXES)("keeps the errno of a failure answered `failed EIO %s`", async (suffix, hidden) => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => { helper.say("writing 1 18446744073709551615", "progress 8", `failed EIO ${suffix}`); helper.exit(4); });
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
        helper.say("writing 1 18446744073709551615", "progress 8", "copied");
        helper.once("input", () => { helper.say(`refused target ${suffix}`); helper.exit(3); });
      });
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toBeInstanceOf(HeldDirectoryRefusedError);
    expect(run.error).toMatchObject({ refusal: "target" });
    expectLeftByHelper(run.error, hidden);
    expect(stoppedCopyOf(new Error("wrapped", { cause: run.error }))).toEqual(stoppedCopyOf(run.error));
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

  it.each([
    HIDDEN,
    `${HIDDEN} 1 2`,
    `${HIDDEN} -1 2 mismatch`,
    `${HIDDEN} 01 2 mismatch`,
    `${HIDDEN} 18446744073709551616 2 mismatch`,
    `${HIDDEN} 1 18446744073709551616 remove-failed`,
    `${HIDDEN} 1 2 retry`,
    `${HIDDEN} 1  2 mismatch`,
    `${HIDDEN} 1 2 mismatch extra`,
  ])("kills the helper for a malformed hidden leftover %s", async (suffix) => {
    script((helper) => {
      helper.say("ready");
      helper.once("input", () => helper.say(`failed EIO left ${suffix}`));
    });
    const run = follow(files.copy(from, "staged", to, "report.pdf", ".0123.part", () => true, UNSTOPPED));
    await flush();
    expect(run.error).toBeInstanceOf(HeldFileHelperUnavailableError);
    expect(helpers()[0]?.killed).toBe(1);
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
describe("a stalled copy's temporary file in the chosen folder", () => {
  interface Faults {
    readonly copyDiesWhenKilled: boolean;
    // The copy writes its temporary file but never says so.
    readonly quietCopy: boolean;
    // The copy answers that it failed once it has written its temporary file, and ends.
    readonly copyFails: boolean;
    readonly hiddenVerdict?: "mismatch" | "remove-failed";
    readonly replaceBeforeProgress?: boolean;
  }
  const fingerprint = (path: string): string => {
    const bytes = fs.readFileSync(path);
    const info = fs.statSync(path, { bigint: true });
    const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    return `${info.size}:${info.mtimeNs}:${digest(bytes.subarray(0, 65536))}:${digest(bytes.subarray(-65536))}`;
  };
  const namedLeftover = ".0123456789abcdef0123456789abcdef.removing";
  const actOnRealFolders = ({ copyDiesWhenKilled, quietCopy, copyFails, hiddenVerdict, replaceBeforeProgress }: Faults) => (helper: FakeHelper): void => {
    const [mode] = helper.args;
    helper.say("ready");
    if (mode === "--dir-copy") {
      helper.diesWhenKilled = copyDiesWhenKilled;
      helper.once("input", () => {
        const part = join(arg(helper, 5), arg(helper, 9));
        fs.writeFileSync(part, "partial copy");
        const written = fs.statSync(part, { bigint: true });
        if (!quietCopy) helper.say(`writing ${written.dev} ${written.ino}`);
        if (replaceBeforeProgress) {
          fs.renameSync(part, `${part}.saved`);
          fs.writeFileSync(part, "replacement before progress");
        }
        if (!quietCopy) helper.say("progress 1048576");
        if (hiddenVerdict !== undefined) {
          const own = fs.statSync(part, { bigint: true });
          const hidden = join(arg(helper, 5), namedLeftover);
          if (hiddenVerdict === "mismatch") {
            fs.unlinkSync(part);
            fs.writeFileSync(hidden, "the user's file");
          } else {
            fs.renameSync(part, hidden);
          }
          const marked = fs.statSync(hidden, { bigint: true });
          const snapshot = `${marked.dev}:${marked.ino}:${marked.birthtimeNs}:${fingerprint(hidden)}`;
          helper.say(`failed EIO left ${namedLeftover} ${own.dev} ${own.ino} ${hiddenVerdict} ${snapshot}`);
          helper.exit(4);
          return;
        }
        if (copyFails) {
          helper.say("failed EIO");
          helper.exit(4);
        }
      });
    } else {
      helper.once("input", () => {
        const directory = arg(helper, 1);
        const facts = fs.statSync(directory, { bigint: true, throwIfNoEntry: false });
        if (facts === undefined || facts.dev !== BigInt(arg(helper, 2)) || facts.ino !== BigInt(arg(helper, 3))) {
          helper.say("failed ENOENT"); helper.exit(4); return;
        }
        const name = arg(helper, 4);
        const path = join(directory, name);
        const entry = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
        const end = (answer: string): void => { helper.say(answer); helper.exit(0); };
        switch (mode) {
          case "--dir-list-records":
            end(["records", ...fs.readdirSync(directory).filter((name) => /^[a-f0-9]{32}\.cleanup\.json$/u.test(name))].join(" "));
            break;
          case "--dir-read":
            end(entry?.isFile() ? `record ${fs.readFileSync(path).toString("hex")}` : "absent");
            break;
          case "--dir-write-record":
            fs.writeFileSync(path, Buffer.from(arg(helper, 5), "hex"), { flag: "wx" });
            end("written");
            break;
          case "--dir-remove":
            if (entry !== undefined) fs.unlinkSync(path);
            end(entry === undefined ? "absent" : "removed");
            break;
          case "--dir-remove-id":
          case "--dir-restore": {
            const restore = mode === "--dir-restore";
            const id = restore ? 6 : 5;
            if (entry === undefined) { end("absent"); break; }
            const expected = helper.args[id + 2];
            if (!entry.isFile() || entry.dev !== BigInt(arg(helper, id)) || entry.ino !== BigInt(arg(helper, id + 1)) ||
                (expected !== undefined && expected !== `${entry.birthtimeNs}:${fingerprint(path)}` && expected !== `${entry.birthtimeNs}:-`)) {
              end("left"); break;
            }
            if (restore) {
              const target = join(directory, arg(helper, 5));
              if (fs.existsSync(target)) { end("left"); break; }
              fs.copyFileSync(path, target, fs.constants.COPYFILE_EXCL);
            }
            fs.unlinkSync(path);
            end(restore ? "restored" : "removed");
            break;
          }
          default: {
            const names = fs.readdirSync(directory).filter((entry) => name !== "keep-records" || !/^[a-f0-9]{32}\.cleanup\.json$/u.test(entry));
            for (const name of names) fs.unlinkSync(join(directory, name));
            end(`swept ${names.length}`);
          }
        }
      });
    }
  };
  let base: string;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "download-part-"))); });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  const stalledCopy = async ({
    copyDiesWhenKilled = false, quietCopy = false, copyFails = false, beforeStall = (_chosen: string): void => {},
    hiddenVerdict = undefined as Faults["hiddenVerdict"],
    replaceBeforeProgress = false,
  } = {}) => {
    const staging = join(base, "staging");
    const chosen = join(base, "chosen");
    fs.mkdirSync(staging);
    fs.mkdirSync(chosen);
    const info = fs.statSync(staging, { bigint: true });
    const root = { path: staging, dev: info.dev, ino: info.ino, files: { ...files, move: async () => "cross-volume" as const } };
    script(actOnRealFolders({ copyDiesWhenKilled, quietCopy, copyFails, hiddenVerdict, replaceBeforeProgress }));
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
  const removalsIn = (folder: string) => helpers().filter((helper) => helper.args[0] === "--dir-remove-id" && helper.args[1] === folder);
  const records = (staging: string) => fs.readdirSync(staging).filter((name) => /^[0-9a-f]{32}\.cleanup\.json$/u.test(name));
  const recordedAt = (staging: string) => records(staging).map((name) => (JSON.parse(fs.readFileSync(join(staging, name), "utf8")) as { at: string }).at);

  it.each([true, false])("preserves a replacement before the first progress line (immediate exit: %s)", async (copyDiesWhenKilled) => {
    const { root, part } = await stalledCopy({ copyDiesWhenKilled, replaceBeforeProgress: true });
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept.error).toBeUndefined();
    expect(fs.readFileSync(part, "utf8")).toBe("replacement before progress");
    expect(fs.readFileSync(`${part}.saved`, "utf8")).toBe("partial copy");
  });

  it.each(["remove-failed", "mismatch"] as const)("records a helper's %s verdict and retries it at startup", async (hiddenVerdict) => {
    const { root, staging, chosen, part, done } = await stalledCopy({ hiddenVerdict });
    const hidden = join(chosen, namedLeftover);
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    expect(recordedAt(staging)).toEqual([namedLeftover]);
    const [record] = records(staging);
    expect(JSON.parse(fs.readFileSync(join(staging, record ?? ""), "utf8"))).toMatchObject({
      part: basename(part), identity: { kind: "helper", verdict: hiddenVerdict, dev: expect.any(String), ino: expect.any(String) },
    });
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 1 });
    expect(fs.existsSync(hidden)).toBe(false);
    if (hiddenVerdict === "mismatch") expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
    else expect(fs.existsSync(part)).toBe(false);
    expect(records(staging)).toEqual([]);
  });

  it("keeps the hidden file and its record when the original name is taken", async () => {
    const { root, staging, chosen, part } = await stalledCopy({ hiddenVerdict: "mismatch" });
    const hidden = join(chosen, namedLeftover);
    fs.writeFileSync(part, "the file now at the original name");
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 0 });
    expect(fs.readFileSync(part, "utf8")).toBe("the file now at the original name");
    expect(fs.readFileSync(hidden, "utf8")).toBe("the user's file");
    expect(recordedAt(staging)).toEqual([namedLeftover]);
    expect(boundary.warn).toHaveBeenCalledWith({ path: part, leftAs: hidden }, expect.stringContaining("left in place"));
  });

  it.each(["remove-failed", "mismatch"] as const)("leaves a hidden entry that changed after a %s verdict", async (hiddenVerdict) => {
    const { root, staging, chosen, part } = await stalledCopy({ hiddenVerdict });
    const hidden = join(chosen, namedLeftover);
    fs.renameSync(hidden, join(chosen, "elsewhere"));
    fs.writeFileSync(hidden, "the replacement");
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 0 });
    expect(fs.readFileSync(hidden, "utf8")).toBe("the replacement");
    expect(fs.existsSync(part)).toBe(false);
    expect(recordedAt(staging)).toEqual([namedLeftover]);
  });

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
    expect(removalsIn(chosen)).toHaveLength(1);
    expect(recordedAt(staging)).toEqual([basename(part)]);
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
    copy.exit(null, "SIGKILL");
    await flush();
    await flush();
    // The held retry finds no temporary file.
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
    expect(swept).toMatchObject({ settled: true, value: 0 });
    expect(fs.readFileSync(part, "utf8")).toBe("the user's file");
    expect(recordedAt(staging)).toEqual([basename(part)]);
  });

  it("never removes by name a temporary file it never saw while the copy wrote it", async () => {
    const { chosen, part, done } = await stalledCopy({ copyDiesWhenKilled: true, quietCopy: true });
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(removalsIn(chosen)).toEqual([]);
    expect(boundary.warn).toHaveBeenCalledWith({ path: part }, expect.stringContaining("never seen while the copy wrote it"));
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

  it("retains the same record when a staged-file sweep fails part-way", async () => {
    const { root, staging, chosen, part } = await stalledCopy();
    const [oldRecord] = records(staging);
    expect(oldRecord).toBeDefined();
    const moved = join(base, "moved");
    fs.renameSync(chosen, moved);
    const stale = join(staging, "stale-download");
    fs.writeFileSync(stale, "staged bytes");
    const failed = new Error("the sweep failed after deleting a staged file");
    const failing: typeof root = {
      ...root,
      files: {
        ...root.files,
        sweep: async (_directory, keepRecords) => {
          expect(keepRecords).toBe(true);
          fs.unlinkSync(stale);
          throw failed;
        },
      },
    };

    await expect(sweepBrowserDownloadStaging(failing)).rejects.toBe(failed);
    expect(records(staging)).toEqual([oldRecord]);
    expect(recordedAt(staging)).toEqual([basename(part)]);

    fs.renameSync(moved, chosen);
    const swept = follow(sweepBrowserDownloadStaging(root));
    await flush();
    await flush();
    expect(swept).toMatchObject({ settled: true, value: 1 });
    expect(fs.existsSync(part)).toBe(false);
    expect(records(staging)).toEqual([]);
  });

  it("removes the temporary file of a copy the helper reports failed, once it is the file the copy wrote", async () => {
    const { chosen, done } = await stalledCopy({ copyFails: true });
    expect(fs.readdirSync(chosen)).toEqual([]);
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "removed"] });
    expect(arg(removalsIn(chosen)[0] as FakeHelper, 4)).toMatch(/^\.[0-9a-f]{32}\.part$/u);
  });

  it("reports the temporary file of a copy the helper reports failed as left, when it was never seen while written", async () => {
    const { chosen, part, done } = await stalledCopy({ copyFails: true, quietCopy: true });
    expect(fs.readFileSync(part, "utf8")).toBe("partial copy");
    expect(removalsIn(chosen)).toEqual([]);
    expect(done).toMatchObject({ settled: true, value: ["interrupted", "part-left"] });
  });
});
