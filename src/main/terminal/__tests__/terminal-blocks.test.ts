import { terminalSessionFixture } from "../../../__tests__/support/terminal-session-fixtures.js";
import { describe, expect, it } from "vitest";
import {
  EMULATOR_REPLY_WINDOW_MS,
  TerminalBlockTracker,
  USER_INPUT_QUIET_MS,
  decodePercentEncoded,
  getTerminalBlockTracker,
  getWindowTerminalBlockTracker,
  getWindowTerminalBlockSession,
  listTerminalBlockTabs,
  registerTerminalBlockTracker,
  unregisterTerminalBlockTracker,
  __resetTerminalBlocksForTest,
} from "../terminal-blocks.js";

const ESC = "\u001b";
const BEL = "\u0007";
const osc = (body: string, terminator: "bel" | "st" = "bel"): string =>
  `${ESC}]${body}${terminator === "bel" ? BEL : `${ESC}\\`}`;
const NONCE = "0123456789abcdef0123456789abcdef";
const PROMPT_TOKEN = "b0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
// An authenticated OSC 133 marker: its fields, then the nonce. A P marker also announces the prompt's B token, and B carries that token instead of the
// nonce (the prompt string prints it).
const mark = (fields: string, terminator: "bel" | "st" = "bel"): string => {
  if (fields === "B") return osc(`133;B;${PROMPT_TOKEN}`, terminator);
  let announced = fields;
  if (fields.startsWith("P;")) {
    if (fields.includes(";Keys=") && !fields.includes(";NotFound=")) announced += ";NotFound=0";
    if (!fields.includes(";B=")) announced += `;B=${PROMPT_TOKEN}`;
  }
  return osc(`133;${announced};${NONCE}`, terminator);
};

// One prompt-command-output-finish cycle, as the generated zsh rc emits it.
function cycle(command: string, output: string, exit: number, cwd = "/work"): string {
  return [
    mark(`P;Cwd=${encodeURIComponent(cwd).replace(/%2F/gu, "/")};Keys=emacs;Paste=1`),
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
    tracker.recordOutput(`${mark("P;Cwd=/work")}${mark("A")}$ ${mark("B")}make test\r\n${mark("C")}ok\r\n${mark("D;0")}`);
    expect(tracker.recent(1)[0]).toMatchObject({ command: "make test", output: "ok\n" });
  });

  it("accepts B only with the token its prompt's P announced, and only while that prompt is up", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const forged = (token: string): string => osc(`133;B;${token}`);
    // Before any P: no token to match.
    tracker.recordOutput(`${mark("A")}$ ${mark("B")}`);
    expect(tracker.promptEndCount()).toBe(0);
    tracker.recordOutput(`${mark("D;0")}${mark("P;Cwd=/work;Keys=emacs;Paste=1;B=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}${mark("A")}$ `);
    // The nonce, another token, or a field too many is ordinary output.
    tracker.recordOutput(`${osc(`133;B;${NONCE}`)}${forged("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")}${osc("133;B;aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;x")}`);
    expect(tracker.promptEndCount()).toBe(0);
    tracker.recordOutput(forged("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(tracker.promptEndCount()).toBe(1);
    expect(tracker.promptState()).toBe("ready");
    // A command prints its own prompt's B while it runs: output, not a prompt.
    tracker.recordOutput(`${mark("C;cmdline_url=x")}${forged("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}`);
    expect(tracker.promptEndCount()).toBe(1);
    expect(tracker.promptState()).toBe("command-running");
    // After it, the next prompt has a new token; the old one is stale.
    tracker.recordOutput(`${mark("D;0")}${mark("P;Cwd=/work;Keys=emacs;Paste=1;B=cccccccccccccccccccccccccccccccc")}${mark("A")}$ ${forged("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}`);
    expect(tracker.promptEndCount()).toBe(1);
    tracker.recordOutput(forged("cccccccccccccccccccccccccccccccc"));
    expect(tracker.promptEndCount()).toBe(2);
  });

  it("reads a repeated B as the line editor redrawing its prompt: the echo starts over, the count and typing stay", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${mark("D;0")}${mark("P;Cwd=/work;Keys=emacs;Paste=1")}${mark("A")}$ ${mark("B")}`);
    expect(tracker.promptState()).toBe("ready");
    // A resize redraws the prompt text and its B.
    tracker.recordOutput(`\r$ ${mark("B")}`);
    expect(tracker.promptEndCount()).toBe(1);
    expect(tracker.promptState()).toBe("ready");
    tracker.recordInput("l");
    tracker.recordOutput("l");
    tracker.recordOutput(`\r$ ${mark("B")}l`);
    expect(tracker.editLineText()).toBe("l");
    expect(tracker.promptState()).toBe("pending-input");
  });

  it("reads bash readline's wrap placeholder (\" \" CR at the right margin) as no part of the edit line", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    // The bytes the ubuntu-24.04 runner's bash 5.2 echoed for a paste that ended at column 100: an 85-column prompt, the pasted line in standout, then a
    // blank on the next row and a return to its start.
    const prompt = "runner@runnervm4yw5a:/tmp/ave-test-1001/t-HDkvJN/pty-linux-sandbox-pHo2zN/workspace$ ";
    expect(prompt.length + "echo still-here".length).toBe(100);
    tracker.recordOutput(`${mark("D;0")}${mark("P;Cwd=/work;Keys=emacs;Paste=1")}${mark("A")}\u001b[?2004h${prompt}${mark("B")}`);
    tracker.recordOutput("\u001b[7mecho still-here\u001b[27m \r");
    expect(tracker.editLineText()).toBe("echo still-here");
    expect(tracker.promptEndCount()).toBe(1);
  });

  it("keeps the line's own trailing space: only the placeholder's one space before a pending CR goes", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${mark("D;0")}${mark("P;Cwd=/work;Keys=emacs;Paste=1")}${mark("A")}$ ${mark("B")}`);
    tracker.recordOutput("\u001b[7mecho still-here \u001b[27m");
    expect(tracker.editLineText()).toBe("echo still-here ");
    tracker.recordOutput(" \r");
    expect(tracker.editLineText()).toBe("echo still-here ");
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
    tracker.recordOutput(`${mark("P;Cwd=/work")}${mark("A")}`);
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
    tracker.recordOutput(mark("P;Cwd=/repo;Keys=emacs;Paste=1"));
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
      mark("P;Cwd=/repo;Keys=emacs;Paste=1"),
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

describe("authenticated editor-buffer reports", () => {
  const prompt = (fields = "Edit=1"): string => `${mark(`P;Cwd=/work;Keys=emacs;Paste=1;${fields}`)}${mark("A")}% ${mark("B")}`;
  const report = (line: string): string => mark(`E;Line=${encodeURIComponent(line)};B=${PROMPT_TOKEN}`);

  it("accepts fresh empty and exact buffer reports without changing the displayed echo", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    expect(tracker.supportsEditLineQuery()).toBe(false);
    expect(tracker.editLineReport()).toBeNull();
    tracker.recordOutput(prompt());
    expect(tracker.supportsEditLineQuery()).toBe(true);
    tracker.recordOutput(report(""));
    expect(tracker.editLineReport()).toEqual({ generation: 1, line: "" });
    tracker.recordOutput("echo shown");
    tracker.recordOutput(report("echo 'actual;100% 한 😀'"));
    expect(tracker.editLineText()).toBe("echo shown");
    expect(tracker.editLineReport()).toEqual({ generation: 2, line: "echo 'actual;100% 한 😀'" });
    expect(tracker.editLineReportGeneration()).toBe(2);
  });

  it("requires a single current authenticated Edit capability", () => {
    for (const fields of ["", "Edit=0", "Edit=true", "Edit=1;Edit=1", "Edit=0;Edit=1"]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      tracker.recordOutput(prompt(fields));
      expect(tracker.supportsEditLineQuery()).toBe(false);
      expect(tracker.recordOutput(report("x"))).toBe("");
      expect(tracker.editLineReportGeneration()).toBe(0);
    }
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(prompt());
    tracker.recordOutput(osc(`133;P;Edit=0;B=${PROMPT_TOKEN};wrong-nonce`));
    expect(tracker.supportsEditLineQuery()).toBe(true);
    tracker.recordOutput(prompt("Edit=0"));
    expect(tracker.supportsEditLineQuery()).toBe(false);
  });

  it("rejects a bad nonce, stale token, wrong phase, duplicate or missing fields and invalid encoding", () => {
    for (const fields of [
      `E;Line=x;B=${PROMPT_TOKEN};wrong-nonce`,
      `E;Line=x;B=aaaaaaaaaaaaaaaa;${NONCE}`,
      `E;Line=x;Line=y;B=${PROMPT_TOKEN};${NONCE}`,
      `E;Line=x;B=${PROMPT_TOKEN};B=${PROMPT_TOKEN};${NONCE}`,
      `E;Line=x;${NONCE}`,
      `E;B=${PROMPT_TOKEN};${NONCE}`,
      `E;Line=x;B=${PROMPT_TOKEN};Extra=1;${NONCE}`,
      ...["%", "%zz", "%0", "%FF", "%ED%A0%80", "raw\ncontrol"].map((line) => `E;Line=${line};B=${PROMPT_TOKEN};${NONCE}`),
    ]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      tracker.recordOutput(prompt());
      let notifications = 0;
      tracker.subscribe(() => { notifications++; });
      const untrusted = osc(`133;${fields}`);
      expect(tracker.recordOutput(untrusted)).toBe(fields.endsWith(`;${NONCE}`) ? "" : untrusted);
      expect(tracker.editLineReport()).toBeNull();
      expect(tracker.editLineReportGeneration()).toBe(0);
      expect(notifications).toBe(0);
    }
    for (const phase of ["", mark("D;0"), mark("A"), mark("C;cmdline_url=echo"), mark("P;Cwd=/work;Edit=1")]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      if (phase !== "") tracker.recordOutput(prompt() + phase);
      expect(tracker.recordOutput(report("x"))).toBe("");
      expect(tracker.editLineReport()).toBeNull();
    }
  });

  it("advertises queries only after the current B while the authenticated prompt remains in input phase", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(mark("P;Cwd=/work;Edit=1"));
    expect(tracker.supportsEditLineQuery()).toBe(false);
    tracker.recordOutput(mark("A"));
    expect(tracker.supportsEditLineQuery()).toBe(false);
    tracker.recordOutput(mark("B"));
    expect(tracker.supportsEditLineQuery()).toBe(true);
    tracker.recordOutput(mark("C;cmdline_url=echo"));
    expect(tracker.supportsEditLineQuery()).toBe(false);
    tracker.recordOutput(mark("D;0"));
    expect(tracker.supportsEditLineQuery()).toBe(false);
    tracker.recordOutput(prompt());
    expect(tracker.supportsEditLineQuery()).toBe(true);
    tracker.recordExit();
    expect(tracker.supportsEditLineQuery()).toBe(false);
  });

  it("hides stale authenticated reports while leaving unauthenticated reports as ordinary output", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(prompt());
    const stale = report("private stale buffer");
    const newToken = "aa".repeat(16);
    tracker.recordOutput(`${mark(`P;Cwd=/work;Edit=1;B=${newToken}`)}${mark("A")}${osc(`133;B;${newToken}`)}`);
    expect(tracker.recordOutput(stale)).toBe("");
    expect(tracker.editLineReport()).toBeNull();
    expect(tracker.editLineReportGeneration()).toBe(0);
    const unauthenticated = osc(`133;E;Line=ordinary;B=${newToken};wrong-nonce`);
    expect(tracker.recordOutput(unauthenticated)).toBe(unauthenticated);
  });

  it("invalidates reports on new prompts, user input and exit without resetting generation", () => {
    for (const invalidate of [
      (tracker: TerminalBlockTracker) => tracker.recordOutput(mark("P;Cwd=/work;Edit=1")),
      (tracker: TerminalBlockTracker) => tracker.recordOutput(mark("A")),
      (tracker: TerminalBlockTracker) => tracker.recordOutput(mark("C;cmdline_url=echo")),
      (tracker: TerminalBlockTracker) => tracker.recordOutput(mark("D;0")),
      (tracker: TerminalBlockTracker) => tracker.recordInput("\u001b"),
      (tracker: TerminalBlockTracker) => tracker.recordExit(),
    ]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      tracker.recordOutput(prompt() + report("old"));
      invalidate(tracker);
      expect(tracker.editLineReport()).toBeNull();
      expect(tracker.editLineReportGeneration()).toBe(1);
    }
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    // A focus report the shell asked for is the emulator's, not an edit.
    tracker.recordOutput("\u001b[?1004h" + prompt() + report("old"));
    tracker.recordInput("\u001b[I");
    expect(tracker.editLineReport()).toEqual({ generation: 1, line: "old" });
    tracker.recordOutput(prompt() + report("new"));
    expect(tracker.editLineReport()).toEqual({ generation: 2, line: "new" });
  });

  it("preserves actual-buffer proof across a same-token prompt redisplay after the query callback", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(prompt() + "echo actual" + report("echo actual"));
    tracker.recordOutput(mark("B") + "echo actual");
    expect(tracker.editLineReport()).toEqual({ generation: 1, line: "echo actual" });
    expect(tracker.editLineText()).toBe("echo actual");
    expect(tracker.promptEndCount()).toBe(1);
    tracker.recordInput("x");
    tracker.recordOutput(mark("B") + "echo actualx");
    expect(tracker.editLineReport()).toBeNull();
    tracker.recordOutput(prompt() + mark("B"));
    expect(tracker.editLineReport()).toBeNull();
  });

  it("hides complete and split reports from renderer replay and blocks, and notifies host subscribers", () => {
    for (const size of [1, 3, 1000]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      tracker.recordOutput(prompt());
      let reports = 0;
      tracker.subscribe(() => { if (tracker.editLineReport() !== null) reports++; });
      const stream = mark(`E;Line=${encodeURIComponent("private report ; 한")};B=${PROMPT_TOKEN}`, size === 3 ? "st" : "bel");
      let display = "";
      for (let i = 0; i < stream.length; i += size) display += tracker.recordOutput(stream.slice(i, i + size));
      expect(display).toBe("");
      expect(reports).toBe(1);
      tracker.recordOutput(`${mark("C;cmdline_url=echo")}visible${mark("D;0")}`);
      expect(tracker.recent(1)[0]).toMatchObject({ command: "echo", output: "visible" });
      expect(JSON.stringify(tracker.recent(1))).not.toContain("private report");
    }
  });

  it("discards split oversized editor reports privately and recovers within the OSC payload bound", () => {
    for (const size of [1, 127, 100_000]) {
      for (const nonce of [NONCE, "wrong-nonce"]) {
        const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
        tracker.recordOutput(prompt());
        let notifications = 0;
        tracker.subscribe(() => { notifications++; });
        const stream = `before${osc(`133;E;Line=${"private".repeat(10_000)};B=${PROMPT_TOKEN};${nonce}`, "st")}after`;
        let display = "";
        for (let i = 0; i < stream.length; i += size) display += tracker.recordOutput(stream.slice(i, i + size));
        expect(display).toBe("beforeafter");
        expect(tracker.editLineReport()).toBeNull();
        expect(tracker.editLineReportGeneration()).toBe(0);
        expect(notifications).toBe(0);
        tracker.recordOutput(report("valid"));
        expect(tracker.editLineReport()).toEqual({ generation: 1, line: "valid" });
      }
    }
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
    registerTerminalBlockTracker(terminalSessionFixture("terminal:1"), first, 1);
    registerTerminalBlockTracker(terminalSessionFixture("terminal:2"), second, 1);
    expect(listTerminalBlockTabs(1).map((entry) => entry.tabId)).toEqual(["terminal:1", "terminal:2"]);
    const replacement = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    registerTerminalBlockTracker(terminalSessionFixture("terminal:1"), replacement, 1);
    expect(getTerminalBlockTracker(terminalSessionFixture("terminal:1"))).toBe(replacement);
    unregisterTerminalBlockTracker(terminalSessionFixture("terminal:1"));
    expect(getTerminalBlockTracker(terminalSessionFixture("terminal:1"))).toBeUndefined();
    __resetTerminalBlocksForTest();
    expect(listTerminalBlockTabs(1)).toEqual([]);
  });

  it("scopes listing and lookup to the window that owns the terminal", () => {
    __resetTerminalBlocksForTest();
    const mine = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    registerTerminalBlockTracker(terminalSessionFixture("terminal:1"), mine, 1);
    registerTerminalBlockTracker(terminalSessionFixture("terminal:2"), new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true }), 2);
    registerTerminalBlockTracker(terminalSessionFixture("terminal:3"), new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true }), null);
    expect(listTerminalBlockTabs(1).map((entry) => entry.tabId)).toEqual(["terminal:1"]);
    expect(listTerminalBlockTabs(2).map((entry) => entry.tabId)).toEqual(["terminal:2"]);
    expect(getWindowTerminalBlockTracker(terminalSessionFixture("terminal:1"), 1)).toBe(mine);
    expect(getWindowTerminalBlockTracker(terminalSessionFixture("terminal:1"), 2)).toBeUndefined();
    expect(getWindowTerminalBlockTracker(terminalSessionFixture("terminal:3"), 1)).toBeUndefined();
    __resetTerminalBlocksForTest();
  });
});

describe("prompt state (whether a command may be typed now)", () => {
  const prompt = (cwd = "/work"): string => `${mark(`P;Cwd=${cwd};Keys=emacs;Paste=1`)}${mark("A")}user@host work % ${mark("B")}`;

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
    tracker.recordOutput(`${mark("P;Cwd=/w;Keys=emacs;Paste=1")}${mark("A")}user@host /w> `);
    expect(tracker.promptState()).toBe("no-prompt-end-marker");
    // Typed text after fish's prompt looks the same as an empty prompt.
    tracker.recordOutput("rm -rf ");
    expect(tracker.promptState()).toBe("no-prompt-end-marker");
  });

  it("tells a zsh or bash still drawing its first prompt apart from fish, and is ready once the prompt ends", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(`${mark("P;Cwd=/w;Keys=emacs;Paste=1")}${mark("A")}user@host w % `);
    expect(tracker.promptState()).toBe("shell-starting");
    tracker.recordOutput(mark("B"));
    expect(tracker.promptState()).toBe("ready");
    // Later prompts between A and B are between prompts, not starting.
    tracker.recordOutput(`ls\r\n${mark("C;cmdline_url=ls")}${mark("D;0")}${mark("P;Cwd=/w;Keys=emacs;Paste=1")}${mark("A")}% `);
    expect(tracker.promptState()).toBe("between-prompts");
  });

  it("counts any key pressed at this prompt as typing, and a fresh prompt's keys until they have been quiet for a while", () => {
    let clock = 10_000;
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => clock });
    tracker.recordOutput(prompt());
    expect(tracker.promptState()).toBe("ready");
    // An ESC (a pending prefix, or vi command mode) echoes nothing, yet changes what typed text does: the prompt stays taken however long it waits.
    tracker.recordInput("\u001b");
    expect(tracker.promptState()).toBe("pending-input");
    clock += USER_INPUT_QUIET_MS * 10;
    expect(tracker.promptState()).toBe("pending-input");
    // A fresh prompt clears it; keys just before that prompt still count until quiet.
    tracker.recordInput("\r");
    tracker.recordOutput(prompt());
    expect(tracker.promptState()).toBe("pending-input");
    clock += USER_INPUT_QUIET_MS;
    expect(tracker.promptState()).toBe("ready");
  });

  it("needs the shell to report bracketed paste on and emacs keys before it is ready", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const promptWith = (fields: string): string => `${mark(`P;Cwd=/w${fields}`)}${mark("A")}% ${mark("B")}`;
    tracker.recordOutput(promptWith(""));
    expect(tracker.promptState()).toBe("no-bracketed-paste");
    tracker.recordOutput(`\r\n${mark("D;0")}${promptWith(";Keys=emacs;Paste=0")}`);
    expect(tracker.promptState()).toBe("no-bracketed-paste");
    tracker.recordOutput(`\r\n${mark("D;0")}${promptWith(";Keys=vi;Paste=1")}`);
    expect(tracker.promptState()).toBe("vi-editing-mode");
    tracker.recordOutput(`\r\n${mark("D;0")}${promptWith(";Keys=emacs;Paste=1")}`);
    expect(tracker.promptState()).toBe("ready");
    expect(tracker.promptEndCount()).toBe(4);
  });

  it("says no-bracketed-paste, not typing, for a prompt that reported Paste=0 and shows text after its end (zsh RPROMPT)", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => 10_000 });
    // zle draws the right-hand prompt after B: it lands in the edit line's echo.
    tracker.recordOutput(`${mark("P;Cwd=/w;Keys=emacs;Paste=0")}${mark("A")}% ${mark("B")}\u001b[50C[main]\r\u001b[2C`);
    expect(tracker.editLineText()).not.toBe("");
    expect(tracker.promptState()).toBe("no-bracketed-paste");
    // A prompt that takes paste and shows text after its end is the user's typing.
    tracker.recordOutput(`\r\n${mark("D;0")}${mark("P;Cwd=/w;Keys=emacs;Paste=1")}${mark("A")}% ${mark("B")}ls`);
    expect(tracker.promptState()).toBe("pending-input");
  });

  it("keeps the pid the shell reported at its last prompt", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    expect(tracker.reportedShellPid()).toBeNull();
    tracker.recordOutput(`${mark("P;Cwd=/w;Keys=emacs;Paste=1;Pid=2")}${mark("A")}% ${mark("B")}`);
    expect(tracker.reportedShellPid()).toBe(2);
    for (const bad of ["Pid=0", "Pid=-1", "Pid=2x", "Pid=", "Pid=12345678901"]) {
      tracker.recordOutput(`\r\n${mark("D;0")}${mark(`P;Cwd=/w;Keys=emacs;Paste=1;${bad}`)}${mark("A")}% ${mark("B")}`);
      expect(tracker.reportedShellPid()).toBeNull();
    }
    // Text a command prints carries no nonce and changes nothing.
    tracker.recordOutput(`\r\n${mark("D;0")}${mark("P;Cwd=/w;Keys=emacs;Paste=1;Pid=2")}${mark("A")}% ${mark("B")}`);
    tracker.recordOutput("\u001b]133;P;Cwd=/w;Pid=99;forged\u0007");
    expect(tracker.reportedShellPid()).toBe(2);
  });

  it("is not ready while the shell has a command-not-found handler, or does not say whether it has one", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const promptWith = (fields: string): string => `\r\n${mark("D;0")}${mark(`P;Cwd=/w${fields}`)}${mark("A")}% ${mark("B")}`;
    tracker.recordOutput(promptWith(";Keys=emacs;Paste=1;NotFound=1"));
    expect(tracker.promptState()).toBe("not-found-handler");
    tracker.recordOutput(promptWith(";Keys=emacs;Paste=1;NotFound="));
    expect(tracker.promptState()).toBe("not-found-handler");
    // The P marker as a shell without the field would send it.
    tracker.recordOutput(`\r\n${mark("D;0")}${osc(`133;P;Cwd=/w;Keys=emacs;Paste=1;B=${PROMPT_TOKEN};${NONCE}`)}${mark("A")}% ${mark("B")}`);
    expect(tracker.promptState()).toBe("not-found-handler");
    tracker.recordOutput(promptWith(";Keys=emacs;Paste=1;NotFound=0"));
    expect(tracker.promptState()).toBe("ready");
  });

  it("does not count the emulator's replies to its programs' own queries (device, status, cursor, mode, colour, focus) as the user typing", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => 10_000 });
    tracker.recordOutput(prompt());
    const exchanges: Array<[query: string, reply: string]> = [
      ["\u001b[c", "\u001b[?1;2c"], ["\u001b[0c", "\u001b[?6c"], ["\u001b[>c", "\u001b[>0;276;0c"], ["\u001b[5n", "\u001b[0n"],
      ["\u001b[6n", "\u001b[12;40R"], ["\u001b[?6n", "\u001b[?12;40R"], ["\u001b[?2004$p", "\u001b[?2004;1$y"],
      ["\u001b]11;?\u0007", "\u001b]11;rgb:0000/0000/0000\u001b\\"], ["\u001b]4;1;?\u001b\\", "\u001b]4;1;rgb:cdcd/0000/0000\u0007"],
      ["\u001b[?1004h", "\u001b[I"], ["", "\u001b[O"], ["", "\u001b[I"],
      // Two queries in one output, each answered by its own write as xterm.js sends them.
      ["\u001b[c\u001b[6n", "\u001b[?1;2c"], ["", "\u001b[3;1R"],
    ];
    for (const [query, reply] of exchanges) {
      tracker.recordOutput(query);
      tracker.recordInput(reply);
      expect(tracker.userInputGeneration(), JSON.stringify(reply)).toBe(0);
      expect(tracker.promptState()).toBe("ready");
    }
  });

  it.each([
    // A reply shape with nothing asked for it, or asked for once and answered twice.
    { name: "unsolicited device report", query: "", input: "\u001b[?1;2c" },
    { name: "second answer to one query", query: "\u001b[5n", input: "\u001b[0n\u001b[0n" },
    // Replies batched into one write: xterm.js sends each reply on its own.
    { name: "two solicited replies in one write", query: "\u001b[c\u001b[6n", input: "\u001b[?1;2c\u001b[3;1R" },
    { name: "a burst of 16 queued cursor replies", query: "\u001b[6n".repeat(16), input: "\u001b[1;1R".repeat(16) },
    { name: "two focus reports in one write", query: "\u001b[?1004h", input: "\u001b[O\u001b[I" },
    { name: "focus report while focus reporting is off", query: "\u001b[?1004h\u001b[?1004l", input: "\u001b[I" },
    { name: "colour reply to a different colour query", query: "\u001b]10;?\u0007", input: "\u001b]11;rgb:0000/0000/0000\u0007" },
    // Keys around or inside a reply: the line editor runs them.
    { name: "OSC-shaped write carrying a command line", query: "\u001b]1;?\u0007",
      input: "\u001b]1;x\rprintf 'RAN_%s\\n' HIDDEN\r\u0007" },
    { name: "OSC-shaped write with no query", query: "", input: "\u001b]1;x\rprintf 'RAN_%s\\n' HIDDEN\r\u0007" },
    { name: "colour reply carrying a newline", query: "\u001b]11;?\u0007", input: "\u001b]11;rgb:0000/0000/0000\n\u0007" },
    { name: "solicited reply followed by a key", query: "\u001b[c", input: "\u001b[?1;2cx" },
    { name: "DCS-shaped write", query: "", input: "\u001bP1$r0m\u001b\\" },
    { name: "arrow key", query: "", input: "\u001b[A" },
    { name: "a letter", query: "", input: "x" },
  ])("counts $name as the user's input", ({ query, input }) => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => 10_000 });
    tracker.recordOutput(prompt());
    if (query) tracker.recordOutput(query);
    tracker.recordInput(input);
    expect(tracker.userInputGeneration()).toBe(1);
    expect(tracker.typedSincePromptEnd()).toBe(true);
    expect(tracker.promptState()).toBe("pending-input");
  });

  it("counts a reply to an expired query as the user's input, and a reply inside the window as the emulator's", () => {
    let clock = 10_000;
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true, now: () => clock });
    tracker.recordOutput(prompt());
    tracker.recordOutput("\u001b[5n");
    clock += EMULATOR_REPLY_WINDOW_MS;
    tracker.recordInput("\u001b[0n");
    expect(tracker.userInputGeneration()).toBe(0);
    // The query was consumed; ask again and let the window pass unanswered.
    tracker.recordOutput("\u001b[5n");
    clock += EMULATOR_REPLY_WINDOW_MS + 1;
    tracker.recordInput("\u001b[0n");
    expect(tracker.userInputGeneration()).toBe(1);
    expect(tracker.typedSincePromptEnd()).toBe(true);
  });

  it("never hands the marker nonce out in a block's command or output", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    tracker.recordOutput(cycle(`echo ${NONCE}`, `${NONCE}\r\n`, 0));
    tracker.recordOutput(`${mark("P;Cwd=/work;Keys=emacs;Paste=1")}${mark("A")}% ${mark("B")}printf x${NONCE}y\r\n${mark("C;cmdline_url=printf")}x${NONCE}y`);
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
    // P, A, B, C, D: one notification per marker. Between A and B of its first prompt the shell is still starting.
    expect(seen).toEqual(["between-prompts", "shell-starting", "ready", "command-running", "between-prompts"]);
    expect(tracker.nextBlockId()).toBe(2);
    tracker.recordExit();
    expect(seen.at(-1)).toBe("exited");
    unsubscribe();
    tracker.recordOutput(prompt());
    expect(seen.length).toBe(6);
  });
});

describe("TerminalBlockTracker selected command output", () => {
  it("streams only the selected future authenticated block and excludes prompts and later commands", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const seen: string[] = [];
    const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
    tracker.recordOutput("startup text\n");
    tracker.recordOutput(cycle("make", "built\n", 0));
    tracker.recordOutput(cycle("user-command", "user-private\n", 0));
    expect(seen.join("")).toBe("built\n");
    subscription.dispose();
  });

  it("does not stream heuristic blocks as authenticated command output", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const seen: string[] = [];
    const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
    tracker.recordOutput("echo human");
    tracker.recordInput("\r");
    tracker.recordOutput("private human output\n");
    tracker.recordExit();
    expect(seen).toEqual([]);
    subscription.dispose();
  });

  it("redacts a private marker nonce at every chunk split and after stripped escape carriers", () => {
    for (let split = 1; split < NONCE.length; split++) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      const seen: string[] = [];
      const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
      tracker.recordOutput(cycle("print", "", 0).replace(mark("D;0"), ""));
      tracker.recordOutput(`${NONCE.slice(0, split)}${ESC}[31m`);
      tracker.recordOutput(`${NONCE.slice(split)}${ESC}[0m\n${mark("D;0")}`);
      expect(seen.join("")).toBe("[terminal-nonce]\n");
      expect(seen.every((text) => !text.includes(NONCE))).toBe(true);
      subscription.dispose();
    }
  });

  it("preserves ordered output framing after scrollback truncation with bounded delivery chunks", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const seen: string[] = [];
    const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
    const output = `${"prefix\n".repeat(2_000)}-----BEGIN PRIVATE KEY-----\n${"body\n".repeat(40_000)}-----END PRIVATE KEY-----\ntail\n`;
    tracker.recordOutput(cycle("print", output, 0));
    expect(tracker.get(1)!.truncated).toBe(true);
    expect(seen.join("")).toBe(output);
    expect(seen.every((text) => text.length <= 8_256)).toBe(true);
    subscription.dispose();
  });

  it("drops held nonce framing on disposal and never replays it into another subscription", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const first: string[] = [];
    const subscription = tracker.subscribeBlockOutput(1, (text) => first.push(text));
    tracker.recordOutput(cycle("print", NONCE.slice(0, 16), 0).replace(mark("D;0"), ""));
    expect(first).toEqual([]);
    subscription.dispose();
    tracker.recordOutput(`${NONCE.slice(16)}\n${mark("D;0")}`);
    const second: string[] = [];
    const next = tracker.subscribeBlockOutput(2, (text) => second.push(text));
    tracker.recordOutput(cycle("next", "visible\n", 0));
    expect(first).toEqual([]);
    expect(second.join("")).toBe("visible\n");
    next.dispose();
  });

  it("flushes a final short line only for its exact live block and refuses duplicate or stale subscriptions", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const seen: string[] = [];
    const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
    expect(() => tracker.subscribeBlockOutput(1, () => {})).toThrow("Terminal output subscription does not name an available next block.");
    subscription.flush();
    expect(seen).toEqual([]);
    tracker.recordOutput(cycle("print", "short", 0).replace(mark("D;0"), ""));
    expect(seen).toEqual([]);
    subscription.flush();
    expect(seen.join("")).toBe("short");
    tracker.recordOutput(mark("D;0"));
    subscription.dispose();
    expect(() => tracker.subscribeBlockOutput(1, () => {})).toThrow("Terminal output subscription does not name an available next block.");
    tracker.recordExit();
    expect(() => tracker.subscribeBlockOutput(2, () => {})).toThrow("Terminal output subscription does not name an available next block.");
  });
});

describe("TerminalBlockTracker control-string boundaries", () => {
  it.each([
    ["seven-bit device control", `${ESC}P`],
    ["seven-bit start of string", `${ESC}X`],
    ["seven-bit privacy message", `${ESC}^`],
    ["seven-bit application command", `${ESC}_`],
    ["C1 device control", "\u0090"],
    ["C1 start of string", "\u0098"],
    ["C1 privacy message", "\u009e"],
    ["C1 application command", "\u009f"],
  ])("keeps %s payload hidden through BEL until either ST spelling, across all chunk boundaries", (_name, start) => {
    for (const end of [`${ESC}\\`, "\u009c"]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      const seen: string[] = [];
      const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
      tracker.recordOutput(cycle("print", "", 0).replace(mark("D;0"), ""));
      const carrier = `${start}hidden-before${BEL}hidden-after${mark("D;9")}`;
      for (const character of carrier) tracker.recordOutput(character);
      expect(tracker.get(1)).toMatchObject({ status: "running", output: "" });
      expect(seen).toEqual([]);
      for (const character of end) tracker.recordOutput(character);
      tracker.recordOutput(`visible\n${mark("D;0")}`);
      expect(tracker.get(1)).toMatchObject({ status: "done", exitCode: 0, output: "visible\n" });
      expect(seen.join("")).toBe("visible\n");
      subscription.dispose();
    }
  });

  it.each([
    ["seven-bit operating-system command", `${ESC}]`],
    ["C1 operating-system command", "\u009d"],
  ])("ends %s at BEL or either ST without publishing its carrier", (_name, start) => {
    for (const end of [BEL, `${ESC}\\`, "\u009c"]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      const seen: string[] = [];
      const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
      tracker.recordOutput(cycle("print", "", 0).replace(mark("D;0"), ""));
      const carrier = `${start}title;hidden payload${end}`;
      let display = "";
      for (const character of carrier) display += tracker.recordOutput(character);
      expect(display).toBe(carrier);
      tracker.recordOutput(`visible\n${mark("D;0")}`);
      expect(tracker.get(1)!.output).toBe("visible\n");
      expect(seen.join("")).toBe("visible\n");
      subscription.dispose();
    }
  });

  it("recognizes a control-string start interrupting an unfinished escape without leaking its payload", () => {
    for (const start of [`${ESC}P`, "\u0090"]) {
      const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      const seen: string[] = [];
      const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
      tracker.recordOutput(cycle("print", "", 0).replace(mark("D;0"), ""));
      for (const character of `${ESC}[123;${start}hidden${BEL}still-hidden\u009cvisible\n${mark("D;0")}`) {
        tracker.recordOutput(character);
      }
      expect(tracker.get(1)!.output).toBe("visible\n");
      expect(seen.join("")).toBe("visible\n");
      subscription.dispose();
    }
  });

  it("recognizes split C1 control-sequence and standalone string terminator controls", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const seen: string[] = [];
    const subscription = tracker.subscribeBlockOutput(1, (text) => seen.push(text));
    tracker.recordOutput(cycle("print", "", 0).replace(mark("D;0"), ""));
    for (const character of `\u009b31mvisible\u009b0m\u009c\n${mark("D;0")}`) tracker.recordOutput(character);
    expect(tracker.get(1)!.output).toBe("visible\n");
    expect(seen.join("")).toBe("visible\n");
    subscription.dispose();
  });
});


describe("host shell integration metadata", () => {
  it("recognizes authenticated host cwd markers without granting agent typing", () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const session = terminalSessionFixture("terminal:0000000a-1", "manual");
    registerTerminalBlockTracker(session, tracker, 7);
    try {
      tracker.recordOutput(mark("P;Cwd=/workspace;Keys=emacs;Paste=1"));
      expect(getWindowTerminalBlockSession(session, 7)).toMatchObject({ lane: "manual", substrate: "host", shellIntegration: true, currentCwd: "/workspace", cwdSource: "shell-marker" });
      expect(getWindowTerminalBlockSession(session, 8)).toBeUndefined();
    } finally { unregisterTerminalBlockTracker(session); }
  });
});
