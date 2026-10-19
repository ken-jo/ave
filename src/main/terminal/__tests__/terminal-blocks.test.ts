/**
 * Command blocks parsed from a terminal's output stream: OSC 133 boundaries,
 * the Enter-split fallback, chunk splits, text normalization and the bounds.
 */
import { describe, expect, it } from "vitest";
import {
  TerminalBlockTracker,
  USER_INPUT_QUIET_MS,
  decodePercentEncoded,
  getTerminalBlockTracker,
  getWindowTerminalBlockTracker,
  listTerminalBlockTabs,
  registerTerminalBlockTracker,
  unregisterTerminalBlockTracker,
  __resetTerminalBlocksForTest,
} from "../terminal-blocks.js";

const ESC = "\u001b";
const BEL = "\u0007";
const osc = (body: string, terminator: "bel" | "st" = "bel"): string =>
  `${ESC}]${body}${terminator === "bel" ? BEL : `${ESC}\\`}`;
/** This terminal's marker nonce, as the shell integration would carry it. */
const NONCE = "0123456789abcdef0123456789abcdef";
/** An authenticated OSC 133 marker: its fields, then the nonce. */
const mark = (fields: string, terminator: "bel" | "st" = "bel"): string =>
  osc(`133;${fields};${NONCE}`, terminator);

/** One prompt-command-output-finish cycle, as the generated zsh rc emits it. */
function cycle(command: string, output: string, exit: number, cwd = "/work"): string {
  return [
    mark(`P;Cwd=${encodeURIComponent(cwd).replace(/%2F/gu, "/")}`),
    mark("A"),
    "user@host work % ",
    mark("B"),
    command,
    "\r\n",
    mark(`C;cmdline_url=${encodeURIComponent(command)}`),
    output,
    mark(`D;${exit}`),
  ].join("");
}

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("TerminalBlockTracker — OSC 133", () => {
  it("records command, cwd, exit code, timing and plain output per block", () => {
    const time = clock();
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: time.now });
    tracker.recordOutput(mark("D;0")); // first prompt: nothing open, ignored
    tracker.recordOutput(cycle("ls /missing", "ls: /missing: No such file\r\n", 1).replace(mark("D;1"), ""));
    time.advance(400);
    tracker.recordOutput(mark("D;1"));
    tracker.recordOutput(cycle("echo hi", `${ESC}[32mhi${ESC}[0m\r\n`, 0, "/work/sub"));

    expect(tracker.isIntegrated()).toBe(true);
    const [newest, oldest] = tracker.recent(5);
    expect(oldest).toMatchObject({
      id: 1,
      command: "ls /missing",
      cwd: "/work",
      exitCode: 1,
      startedAt: 1_000,
      endedAt: 1_400,
      status: "done",
      source: "osc133",
      output: "ls: /missing: No such file\n",
      truncated: false,
    });
    expect(newest).toMatchObject({ id: 2, command: "echo hi", cwd: "/work/sub", exitCode: 0, output: "hi\n" });
    // Summaries are newest first and carry no output.
    expect(tracker.list().map((block) => block.id)).toEqual([2, 1]);
    expect(tracker.list()[0]).not.toHaveProperty("output");
  });

  it("parses markers split across arbitrary chunk boundaries, with BEL or ST terminators", () => {
    const stream = [
      mark("P;Cwd=/w%20dir", "st"),
      mark("A", "st"),
      "$ ",
      mark("B"),
      mark("C;cmdline_url=printf%20%27a%3Bb%27%20%E2%9C%93", "st"),
      "a;b ✓\r\n",
      mark("D;0", "st"),
    ].join("");
    for (const size of [1, 2, 3, 7]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      for (let i = 0; i < stream.length; i += size) tracker.recordOutput(stream.slice(i, i + size));
      expect(tracker.recent(1)[0], `chunk size ${size}`).toMatchObject({
        command: "printf 'a;b' ✓",
        cwd: "/w dir",
        exitCode: 0,
        output: "a;b ✓\n",
      });
    }
  });

  it("parses a long URL-escaped Korean command split across many chunks", () => {
    const command = `echo ${"한글".repeat(1_500)}`;
    const encoded = encodeURIComponent(command);
    expect(encoded.length).toBeGreaterThan(20_000);
    const stream = `${mark(`C;cmdline_url=${encoded}`)}done\r\n${mark("D;3")}`;
    for (const size of [997, 4096, 7]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      for (let i = 0; i < stream.length; i += size) tracker.recordOutput(stream.slice(i, i + size));
      expect(tracker.recent(1)[0], `chunk size ${size}`).toMatchObject({
        command,
        exitCode: 3,
        output: "done\n",
      });
    }
  });

  it("discards an OSC past the payload bound without losing the block around it", () => {
    const stream = [
      mark("C;cmdline_url=make"),
      "before\r\n",
      osc(`8;;${"u".repeat(70 * 1024)}`),
      `${ESC}P${"d".repeat(70 * 1024)}${ESC}\\`,
      "after\r\n",
      mark("D;0"),
    ].join("");
    for (const size of [stream.length, 1_000, 3]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      for (let i = 0; i < stream.length; i += size) tracker.recordOutput(stream.slice(i, i + size));
      expect(tracker.recent(1)[0], `chunk size ${size}`).toMatchObject({
        command: "make",
        exitCode: 0,
        output: "before\nafter\n",
      });
    }
  });

  it("falls back to the echoed input when C carries no command text", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${mark("A")}$ ${mark("B")}make test\r\n${mark("C")}ok\r\n${mark("D;0")}`);
    expect(tracker.recent(1)[0]).toMatchObject({ command: "make test", output: "ok\n" });
  });

  it("closes a block whose D never came when the next prompt starts, without an exit code", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${mark("C;cmdline_url=sleep%2010")}^C\r\n${mark("A")}`);
    expect(tracker.recent(1)[0]).toMatchObject({ command: "sleep 10", exitCode: null, status: "done" });
  });

  it("reports a running block with its output so far", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${mark("C;cmdline_url=npm%20test")}running 1/3\r\n`);
    const [running] = tracker.recent(1);
    expect(running).toMatchObject({ status: "running", exitCode: null, endedAt: null, output: "running 1/3\n" });
    expect(tracker.get(running!.id)?.output).toBe("running 1/3\n");
  });

  it("applies carriage-return rewrites and backspaces, and drops padding rows", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(
      `${mark("C;cmdline_url=dl")}10%\r50%\r100%\r\nab\bc\r\n%  \r \r${mark("D;0")}`,
    );
    expect(tracker.recent(1)[0]!.output).toBe("100%\nac\n");
  });

  it("keeps the head and tail of a long output and says what it dropped", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(mark("C;cmdline_url=yes"));
    const line = `${"x".repeat(99)}\n`;
    for (let i = 0; i < 2_000; i++) tracker.recordOutput(i === 1_999 ? "LAST\n" : line);
    tracker.recordOutput(mark("D;0"));
    const block = tracker.recent(1)[0]!;
    expect(block.truncated).toBe(true);
    expect(block.outputChars).toBe(1_999 * 100 + 5);
    expect(block.output.startsWith("x".repeat(99))).toBe(true);
    expect(block.output.endsWith("LAST\n")).toBe(true);
    expect(block.output).toMatch(/\[… \d+ characters omitted …\]/u);
    expect(block.output.length).toBeLessThan(70 * 1024);
  });

  it("bounds output that never prints a newline and marks it truncated", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(mark("C;cmdline_url=cat%20bundle.min.js"));
    const piece = "y".repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) tracker.recordOutput(i === 19 ? `${piece}END` : piece);
    const running = tracker.recent(1)[0]!;
    expect(running.truncated).toBe(true);
    expect(running.outputChars).toBe(20 * 1024 * 1024 + 3);
    expect(running.output.length).toBeLessThan(80 * 1024);
    expect(running.output.startsWith("y".repeat(1024))).toBe(true);
    expect(running.output.endsWith("END")).toBe(true);
    tracker.recordOutput(mark("D;0"));
    const done = tracker.get(running.id)!;
    expect(done.truncated).toBe(true);
    expect(done.output.length).toBeLessThan(80 * 1024);
  });

  it("bounds a newline-free prompt and echoed input as well", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(mark("A"));
    tracker.recordOutput("p".repeat(2 * 1024 * 1024));
    tracker.recordOutput(mark("B"));
    tracker.recordOutput("e".repeat(2 * 1024 * 1024));
    tracker.recordOutput(`${mark("C")}ok\r\n${mark("D;0")}`);
    const block = tracker.recent(1)[0]!;
    expect(block.command).toBe("e".repeat(4096));
    expect(block.output).toBe("ok\n");
  });

  it("keeps only the newest 100 completed blocks", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    for (let i = 1; i <= 105; i++) tracker.recordOutput(cycle(`echo ${i}`, `${i}\r\n`, 0));
    const ids = tracker.list().map((block) => block.id);
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe(105);
    expect(ids.at(-1)).toBe(6);
    expect(tracker.get(5)).toBeNull();
  });

  it("closes the running block without an exit code when the shell exits", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(mark("C;cmdline_url=exit"));
    tracker.recordExit();
    expect(tracker.hasExited()).toBe(true);
    expect(tracker.recent(1)[0]).toMatchObject({ command: "exit", status: "done", exitCode: null });
  });
});

describe("TerminalBlockTracker — marker nonce", () => {
  it("ignores markers a command prints: no fake block, the real exit code and cwd intact", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(mark("P;Cwd=/repo"));
    tracker.recordOutput(mark("C;cmdline_url=cat%20evil.txt"));
    // The file's content: D;0, an OSC 7 to /etc and a C naming another command.
    tracker.recordOutput(
      `line 1\r\n${osc("133;D;0")}${osc("7;file://x/etc")}${osc("133;C;cmdline_url=npm%20test")}line 2\r\n`,
    );
    tracker.recordOutput(mark("D;1"));
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.recent(1)[0]).toMatchObject({
      command: "cat evil.txt",
      cwd: "/repo",
      exitCode: 1,
      output: "line 1\nline 2\n",
    });
  });

  it("rejects a wrong nonce and a nonce that is not the last field", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(osc("133;C;cmdline_url=x;ffffffffffffffffffffffffffffffff"));
    tracker.recordOutput(osc(`133;C;${NONCE};cmdline_url=x`));
    tracker.recordOutput(osc(`133;${NONCE}`));
    expect(tracker.list()).toEqual([]);
    expect(tracker.isIntegrated()).toBe(false);
  });

  it("keeps the Enter-split fallback when a marker without the nonce appears", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`$ cat notes${osc("133;A")}`);
    tracker.recordInput("\r");
    tracker.recordOutput(`\r\n${osc("133;D;0")}hello\r\n$ `);
    tracker.recordInput("\r");
    expect(tracker.isIntegrated()).toBe(false);
    expect(tracker.recent(5).map((block) => block.source)).toEqual(["heuristic", "heuristic"]);
  });

  it("returns the chunk for display without the nonce, and forged markers unchanged", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const shown = [
      mark("P;Cwd=/repo"),
      mark("A"),
      "$ ",
      mark("B"),
      `ls\r\n${mark("C;cmdline_url=ls")}`,
      `${ESC}[32ma${ESC}[0m\r\n${osc("133;D;0")}`,
      mark("D;0", "st"),
    ].join("");
    let display = "";
    for (let i = 0; i < shown.length; i += 5) display += tracker.recordOutput(shown.slice(i, i + 5));
    expect(display).not.toContain(NONCE);
    expect(display).toBe(
      `${osc("133;A")}$ ${osc("133;B")}ls\r\n${osc("133;C")}${ESC}[32ma${ESC}[0m\r\n${osc("133;D;0")}${osc("133;D")}`,
    );
  });

  it("refuses an empty nonce", () => {
    expect(() => new TerminalBlockTracker({ nonce: "", marksPromptEnd: true })).toThrow(/nonce/u);
  });
});

describe("TerminalBlockTracker — fallback without markers", () => {
  it("splits at each Enter and names the block after the line on screen", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput("$ ");
    tracker.recordOutput("ls");
    tracker.recordInput("\r");
    tracker.recordOutput("\r\na.txt\r\n$ ");
    tracker.recordOutput("pwd");
    tracker.recordInput("\r");
    tracker.recordOutput("\r\n/home\r\n$ ");

    expect(tracker.isIntegrated()).toBe(false);
    const [newest, oldest] = tracker.recent(2);
    expect(oldest).toMatchObject({ command: "$ ls", source: "heuristic", exitCode: null, status: "done" });
    expect(oldest!.output).toContain("a.txt");
    expect(newest).toMatchObject({ command: "$ pwd", source: "heuristic", status: "running" });
  });

  it("ignores typed input that is not an Enter", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordInput("ls");
    expect(tracker.list()).toEqual([]);
  });

  it("switches to markers for good at the first OSC 133", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput("$ make");
    tracker.recordInput("\r");
    tracker.recordOutput(cycle("echo hi", "hi\r\n", 0));
    tracker.recordInput("\r"); // no longer splits
    const blocks = tracker.recent(5);
    expect(blocks.map((block) => block.source)).toEqual(["osc133", "heuristic"]);
    expect(tracker.list()).toHaveLength(2);
  });
});

describe("decodePercentEncoded", () => {
  it("decodes byte escapes as UTF-8 and keeps literal characters and malformed escapes", () => {
    expect(decodePercentEncoded("a%3Bb%25")).toBe("a;b%");
    expect(decodePercentEncoded("%ED%95%9C 한")).toBe("한 한");
    expect(decodePercentEncoded("100%zz")).toBe("100%zz");
    expect(decodePercentEncoded("emoji 😀 %F0%9F%98%80")).toBe("emoji 😀 😀");
  });
});

describe("terminal block registry", () => {
  it("registers, lists, replaces and drops trackers by tab id", () => {
    __resetTerminalBlocksForTest();
    const first = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const second = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    registerTerminalBlockTracker("terminal:1", first, 1);
    registerTerminalBlockTracker("terminal:2", second, 1);
    expect(listTerminalBlockTabs(1).map((entry) => entry.tabId)).toEqual(["terminal:1", "terminal:2"]);
    const replacement = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    registerTerminalBlockTracker("terminal:1", replacement, 1);
    expect(getTerminalBlockTracker("terminal:1")).toBe(replacement);
    unregisterTerminalBlockTracker("terminal:1");
    expect(getTerminalBlockTracker("terminal:1")).toBeUndefined();
    __resetTerminalBlocksForTest();
    expect(listTerminalBlockTabs(1)).toEqual([]);
  });

  it("scopes listing and lookup to the window that owns the terminal", () => {
    __resetTerminalBlocksForTest();
    const mine = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    registerTerminalBlockTracker("terminal:1", mine, 1);
    registerTerminalBlockTracker("terminal:2", new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true }), 2);
    registerTerminalBlockTracker("terminal:3", new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true }), null);
    expect(listTerminalBlockTabs(1).map((entry) => entry.tabId)).toEqual(["terminal:1"]);
    expect(listTerminalBlockTabs(2).map((entry) => entry.tabId)).toEqual(["terminal:2"]);
    expect(getWindowTerminalBlockTracker("terminal:1", 1)).toBe(mine);
    expect(getWindowTerminalBlockTracker("terminal:1", 2)).toBeUndefined();
    expect(getWindowTerminalBlockTracker("terminal:3", 1)).toBeUndefined();
    __resetTerminalBlocksForTest();
  });
});

describe("prompt state (whether a command may be typed now)", () => {
  const prompt = (cwd = "/work"): string => `${mark(`P;Cwd=${cwd}`)}${mark("A")}user@host work % ${mark("B")}`;

  it("is ready only at an empty prompt, and names every other state", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    expect(tracker.promptState()).toBe("no-shell-integration");
    // A marker a program printed without the nonce proves nothing.
    tracker.recordOutput(osc("133;A"));
    expect(tracker.promptState()).toBe("no-shell-integration");
    tracker.recordOutput(prompt());
    expect(tracker.promptState()).toBe("ready");
    expect(tracker.currentCwd()).toBe("/work");
    tracker.recordOutput("git sta");
    expect(tracker.promptState()).toBe("pending-input");
    // Erased again with backspaces: an empty prompt once more.
    tracker.recordOutput("\b \b".repeat(7));
    expect(tracker.promptState()).toBe("ready");
    tracker.recordOutput(`vim\r\n${mark("C;cmdline_url=vim")}`);
    expect(tracker.promptState()).toBe("command-running");
    tracker.recordOutput(mark("D;0"));
    expect(tracker.promptState()).toBe("between-prompts");
    tracker.recordOutput(prompt("/work/app"));
    expect(tracker.promptState()).toBe("ready");
    expect(tracker.currentCwd()).toBe("/work/app");
    tracker.recordExit();
    expect(tracker.promptState()).toBe("exited");
  });

  it("refuses fish's prompt, which marks no end of prompt, so the user's typing there cannot be told", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: false });
    tracker.recordOutput(`${mark("P;Cwd=/w")}${mark("A")}user@host /w> `);
    expect(tracker.promptState()).toBe("no-prompt-end-marker");
    // Typed text after fish's prompt looks the same as an empty prompt.
    tracker.recordOutput("rm -rf ");
    expect(tracker.promptState()).toBe("no-prompt-end-marker");
  });

  it("tells a zsh or bash still drawing its first prompt apart from fish, and is ready once the prompt ends", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${mark("P;Cwd=/w")}${mark("A")}user@host w % `);
    expect(tracker.promptState()).toBe("shell-starting");
    tracker.recordOutput(mark("B"));
    expect(tracker.promptState()).toBe("ready");
    // Later prompts between A and B are between prompts, not starting.
    tracker.recordOutput(`ls\r\n${mark("C;cmdline_url=ls")}${mark("D;0")}${mark("P;Cwd=/w")}${mark("A")}% `);
    expect(tracker.promptState()).toBe("between-prompts");
  });

  it("counts the user's keystrokes as typing until they have been quiet for a while (keys not yet echoed)", () => {
    let clock = 10_000;
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => clock });
    tracker.recordOutput(prompt());
    expect(tracker.promptState()).toBe("ready");
    // Written to the PTY, not echoed yet: the echo is still empty.
    tracker.recordInput("g");
    expect(tracker.promptState()).toBe("pending-input");
    clock += USER_INPUT_QUIET_MS - 1;
    expect(tracker.promptState()).toBe("pending-input");
    clock += 1;
    expect(tracker.promptState()).toBe("ready");
    // Input before this prompt counts the same way: the clock, not the prompt, decides.
    tracker.recordInput("\r");
    tracker.recordOutput(prompt());
    expect(tracker.promptState()).toBe("pending-input");
  });

  it("does not count the terminal emulator's own replies (focus, device and cursor reports) as the user typing", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => 10_000 });
    tracker.recordOutput(prompt());
    for (const reply of ["\u001b[I", "\u001b[O", "\u001b[?62;22c", "\u001b[>0;276;0c", "\u001b[0n", "\u001b[12;40R", "\u001b]11;rgb:0000/0000/0000\u0007", "\u001b[I\u001b[O"]) {
      tracker.recordInput(reply);
      expect(tracker.promptState()).toBe("ready");
    }
    // A key that is not a report still counts: an arrow, a letter, a reply followed by typing.
    for (const key of ["\u001b[A", "x", "\u001b[Ix"]) {
      const fresh = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => 10_000 });
      fresh.recordOutput(prompt());
      fresh.recordInput(key);
      expect(fresh.promptState()).toBe("pending-input");
    }
  });

  it("never hands the marker nonce out in a block's command or output", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(cycle(`echo ${NONCE}`, `${NONCE}\r\n`, 0));
    tracker.recordOutput(`${mark("P;Cwd=/work")}${mark("A")}% ${mark("B")}printf x${NONCE}y\r\n${mark("C;cmdline_url=printf")}x${NONCE}y`);
    const blocks = tracker.recent(5);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(JSON.stringify(block)).not.toContain(NONCE);
      expect(block.output).toContain("[terminal-nonce]");
    }
    expect(tracker.list().map((block) => block.command).join(" ")).not.toContain(NONCE);
  });

  it("tells subscribers about every marker and the exit, and stops after unsubscribe", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const seen: string[] = [];
    const unsubscribe = tracker.subscribe(() => seen.push(tracker.promptState()));
    expect(tracker.nextBlockId()).toBe(1);
    tracker.recordOutput(cycle("make", "built\r\n", 0));
    // P, A, B, C, D: one notification per marker.
    // Between A and B of its first prompt the shell is still starting.
    expect(seen).toEqual(["between-prompts", "shell-starting", "ready", "command-running", "between-prompts"]);
    expect(tracker.nextBlockId()).toBe(2);
    tracker.recordExit();
    expect(seen.at(-1)).toBe("exited");
    unsubscribe();
    tracker.recordOutput(prompt());
    expect(seen.length).toBe(6);
  });
});
