/**
 * Command blocks parsed from a terminal's output stream: OSC 133 boundaries,
 * the Enter-split fallback, chunk splits, text normalization and the bounds.
 */
import { describe, expect, it } from "vitest";
import {
  TerminalBlockTracker,
  decodePercentEncoded,
  getTerminalBlockTracker,
  listTerminalBlockTabs,
  registerTerminalBlockTracker,
  unregisterTerminalBlockTracker,
  __resetTerminalBlocksForTest,
} from "../terminal-blocks.js";

const ESC = "\u001b";
const BEL = "\u0007";
const osc = (body: string, terminator: "bel" | "st" = "bel"): string =>
  `${ESC}]${body}${terminator === "bel" ? BEL : `${ESC}\\`}`;

/** One prompt-command-output-finish cycle, as the generated zsh rc emits it. */
function cycle(command: string, output: string, exit: number, cwd = "/work"): string {
  return [
    osc(`7;file://host${cwd}`),
    osc("133;A"),
    "user@host work % ",
    osc("133;B"),
    command,
    "\r\n",
    osc(`133;C;cmdline_url=${encodeURIComponent(command)}`),
    output,
    osc(`133;D;${exit}`),
  ].join("");
}

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("TerminalBlockTracker — OSC 133", () => {
  it("records command, cwd, exit code, timing and plain output per block", () => {
    const time = clock();
    const tracker = new TerminalBlockTracker(time.now);
    tracker.recordOutput(osc("133;D;0")); // first prompt: nothing open, ignored
    tracker.recordOutput(cycle("ls /missing", "ls: /missing: No such file\r\n", 1).replace(osc("133;D;1"), ""));
    time.advance(400);
    tracker.recordOutput(osc("133;D;1"));
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
      osc("7;file://host/w%20dir", "st"),
      osc("133;A", "st"),
      "$ ",
      osc("133;B"),
      osc("133;C;cmdline_url=printf%20%27a%3Bb%27%20%E2%9C%93", "st"),
      "a;b ✓\r\n",
      osc("133;D;0", "st"),
    ].join("");
    for (const size of [1, 2, 3, 7]) {
      const tracker = new TerminalBlockTracker();
      for (let i = 0; i < stream.length; i += size) tracker.recordOutput(stream.slice(i, i + size));
      expect(tracker.recent(1)[0], `chunk size ${size}`).toMatchObject({
        command: "printf 'a;b' ✓",
        cwd: "/w dir",
        exitCode: 0,
        output: "a;b ✓\n",
      });
    }
  });

  it("falls back to the echoed input when C carries no command text", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(`${osc("133;A")}$ ${osc("133;B")}make test\r\n${osc("133;C")}ok\r\n${osc("133;D;0")}`);
    expect(tracker.recent(1)[0]).toMatchObject({ command: "make test", output: "ok\n" });
  });

  it("closes a block whose D never came when the next prompt starts, without an exit code", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(`${osc("133;C;cmdline_url=sleep%2010")}^C\r\n${osc("133;A")}`);
    expect(tracker.recent(1)[0]).toMatchObject({ command: "sleep 10", exitCode: null, status: "done" });
  });

  it("reports a running block with its output so far", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(`${osc("133;C;cmdline_url=npm%20test")}running 1/3\r\n`);
    const [running] = tracker.recent(1);
    expect(running).toMatchObject({ status: "running", exitCode: null, endedAt: null, output: "running 1/3\n" });
    expect(tracker.get(running!.id)?.output).toBe("running 1/3\n");
  });

  it("applies carriage-return rewrites and backspaces, and drops padding rows", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(
      `${osc("133;C;cmdline_url=dl")}10%\r50%\r100%\r\nab\bc\r\n%  \r \r${osc("133;D;0")}`,
    );
    expect(tracker.recent(1)[0]!.output).toBe("100%\nac\n");
  });

  it("keeps the head and tail of a long output and says what it dropped", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(osc("133;C;cmdline_url=yes"));
    const line = `${"x".repeat(99)}\n`;
    for (let i = 0; i < 2_000; i++) tracker.recordOutput(i === 1_999 ? "LAST\n" : line);
    tracker.recordOutput(osc("133;D;0"));
    const block = tracker.recent(1)[0]!;
    expect(block.truncated).toBe(true);
    expect(block.outputChars).toBe(1_999 * 100 + 5);
    expect(block.output.startsWith("x".repeat(99))).toBe(true);
    expect(block.output.endsWith("LAST\n")).toBe(true);
    expect(block.output).toMatch(/\[… \d+ characters omitted …\]/u);
    expect(block.output.length).toBeLessThan(70 * 1024);
  });

  it("bounds output that never prints a newline and marks it truncated", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(osc("133;C;cmdline_url=cat%20bundle.min.js"));
    const piece = "y".repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) tracker.recordOutput(i === 19 ? `${piece}END` : piece);
    const running = tracker.recent(1)[0]!;
    expect(running.truncated).toBe(true);
    expect(running.outputChars).toBe(20 * 1024 * 1024 + 3);
    expect(running.output.length).toBeLessThan(80 * 1024);
    expect(running.output.startsWith("y".repeat(1024))).toBe(true);
    expect(running.output.endsWith("END")).toBe(true);
    tracker.recordOutput(osc("133;D;0"));
    const done = tracker.get(running.id)!;
    expect(done.truncated).toBe(true);
    expect(done.output.length).toBeLessThan(80 * 1024);
  });

  it("bounds a newline-free prompt and echoed input as well", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(osc("133;A"));
    tracker.recordOutput("p".repeat(2 * 1024 * 1024));
    tracker.recordOutput(osc("133;B"));
    tracker.recordOutput("e".repeat(2 * 1024 * 1024));
    tracker.recordOutput(`${osc("133;C")}ok\r\n${osc("133;D;0")}`);
    const block = tracker.recent(1)[0]!;
    expect(block.command).toBe("e".repeat(4096));
    expect(block.output).toBe("ok\n");
  });

  it("keeps only the newest 100 completed blocks", () => {
    const tracker = new TerminalBlockTracker();
    for (let i = 1; i <= 105; i++) tracker.recordOutput(cycle(`echo ${i}`, `${i}\r\n`, 0));
    const ids = tracker.list().map((block) => block.id);
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe(105);
    expect(ids.at(-1)).toBe(6);
    expect(tracker.get(5)).toBeNull();
  });

  it("closes the running block without an exit code when the shell exits", () => {
    const tracker = new TerminalBlockTracker();
    tracker.recordOutput(osc("133;C;cmdline_url=exit"));
    tracker.recordExit();
    expect(tracker.hasExited()).toBe(true);
    expect(tracker.recent(1)[0]).toMatchObject({ command: "exit", status: "done", exitCode: null });
  });
});

describe("TerminalBlockTracker — fallback without markers", () => {
  it("splits at each Enter and names the block after the line on screen", () => {
    const tracker = new TerminalBlockTracker();
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
    const tracker = new TerminalBlockTracker();
    tracker.recordInput("ls");
    expect(tracker.list()).toEqual([]);
  });

  it("switches to markers for good at the first OSC 133", () => {
    const tracker = new TerminalBlockTracker();
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
    const first = new TerminalBlockTracker();
    const second = new TerminalBlockTracker();
    registerTerminalBlockTracker("terminal:1", first);
    registerTerminalBlockTracker("terminal:2", second);
    expect(listTerminalBlockTabs().map((entry) => entry.tabId)).toEqual(["terminal:1", "terminal:2"]);
    const replacement = new TerminalBlockTracker();
    registerTerminalBlockTracker("terminal:1", replacement);
    expect(getTerminalBlockTracker("terminal:1")).toBe(replacement);
    unregisterTerminalBlockTracker("terminal:1");
    expect(getTerminalBlockTracker("terminal:1")).toBeUndefined();
    __resetTerminalBlocksForTest();
    expect(listTerminalBlockTabs()).toEqual([]);
  });
});
