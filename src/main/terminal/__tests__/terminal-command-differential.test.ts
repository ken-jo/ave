/**
 * Differential check of terminal_run's two readers of one command line: the
 * permission classifier (which reads it as bash, `analyzeShellForRules`) and
 * the interactive shell that actually runs it.
 *
 * Every command of the corpus that the terminal_run validator ACCEPTS (and
 * the classifier can parse) is typed, with the real
 * typing protocol, into a real interactive zsh and bash on a pseudo-terminal,
 * started with the terminal's shell integration. Each shell has:
 *  - xtrace on, written to a file, with a PS4 that names the running function
 *    so the integration's own hook lines can be dropped;
 *  - PATH set to a directory of recording shims only: every program the shell
 *    starts by name writes its argv (NUL-separated) to a file and exits 0, so
 *    nothing real runs;
 *  - a temporary sandbox directory as its working directory and HOME.
 *
 * The property: every simple command the shell executed \u2014 each program a
 * shim recorded, each builtin xtrace reports \u2014 is one the classifier
 * evaluated. A command whose words the classifier read as static literals
 * must have run with exactly those words; one with an expansion must have run
 * under the head the classifier named. Commands the classifier marks as
 * hiding code (a wrapper or interpreter fed a string) are run too: the shims
 * do not run what they are handed, so what the shell itself runs must still
 * be visible to the rules. Anything else is a word the rules never
 * saw, and fails the test.
 *
 * Commands that wait for terminal input or end the shell (read, exit, kill,
 * ...), and background jobs (which may run after their records are read),
 * are not run; the summary counts them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as nodePty from "node-pty";
import { installShellIntegration } from "../shell-integration.js";
import { TerminalBlockTracker } from "../terminal-blocks.js";
import { typeLineAtPrompt } from "../pty-manager.js";
import { canonicalizePathForMatch } from "../../../permissions/sensitive-paths.js";
import { terminalCommandTextProblem } from "../../../shared/terminal-command-text.js";
import { analyzeShellForRules } from "../../../permissions/rules/shell-rule-matcher.js";
import { wrapperPrefixLength } from "../../../permissions/rules/shell-prefix-policy.js";
import { analyzeShell } from "../../../shared/shell-analysis.js";

const NONCE = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Corpus: the validator's own accepted and refused cases, ordinary commands,
// and constructs where zsh and bash part ways, each then mutated.

const BASE_COMMANDS: readonly string[] = [
  // The validator's accepted cases (terminal-run.test.ts).
  "echo 'a # b'",
  "echo \"#hash\"",
  "echo a#b",
  "git log --grep=\\#12",
  "echo \uc548\ub155 && ls \ubb38\uc11c",
  "echo caf\u00e9",
  "PATH=/nonexistent:$PATH make",
  "FOO=1 npm test",
  "export FOO=1",
  "echo $((1 + 2))",
  "echo ${#x}",
  "echo $'it\\'s' ok",
  "printf '%s\\n' PATH",
  "getopts ab opt",
  "echo ${x#p}",
  "echo ${x##p}",
  "echo \"${x%%p}\" ${y:-${z#q}}",
  "npm test -- --watch=false",
  "[ ! -f x ] && echo missing",
  "test \"$a\" != b",
  "git log --oneline | head -5",
  "echo 'it''s'",
  // The validator's refused cases: the mutations below may make one acceptable.
  "echo SAFE # ; echo PWNED",
  "ls # ; rm -rf build",
  "nocorrect rm -rf build",
  "noglob ls *",
  "r ls=rm",
  "alias ls=rm",
  "c=alias; $c ls=rm",
  "trap 'rm -rf build' DEBUG",
  "time alias ls=rm",
  "command -p alias ls=rm",
  // Ordinary commands.
  "ls -la",
  "rm -rf build",
  "git status && git diff",
  "cat a.txt | wc -l",
  "ls; rm x",
  "(cd sub && ls)",
  "ls > out.txt",
  "cat < a.txt",
  "echo $(ls)",
  "echo `ls`",
  "diff <(ls a) <(ls b)",
  "for f in a b; do rm \"$f\"; done",
  "if [ -f x ]; then rm x; else touch x; fi",
  "while false; do rm x; done",
  "until true; do rm x; done",
  "! git diff --quiet",
  "x=1; echo $x",
  "command ls",
  "command -v ls",
  "builtin echo hi",
  "time ls",
  "cd sub",
  "pwd",
  "true && false || echo no",
  "[[ -n $x ]] && rm y",
  "{ rm x; ls; }",
  "echo hi | ( rm x )",
  "x=$(rm a); echo \"$x\"",
  "a=(1 2); echo \"${a[1]}\"",
  "export A=$(rm b)",
  "echo ${x:-$(touch z)}",
  "echo ${x:-`rm a`}",
  "printf -v v '%s' \"$(rm y)\"",
  "env FOO=1 rm x",
  "xargs rm < a.txt",
  "sudo rm x",
  "nohup rm x",
  "touch ./-rf",
  "rm -- -rf",
  "echo hi > /dev/null",
  "ls 2>&1 | cat",
  "echo a\\ b",
  "echo 'x'\"y\"z",
  "printf '%s\\n' a b",
  "echo -e 'a\\nb'",
  "echo $'\\x41' $'\\u00e9'",
  "echo $\"hi\"",
  "echo $# $@ $1 $$ $? $_ $0",
  "echo ${x/a/b} ${x:0:1} ${x^^} ${x,,}",
  "echo ${x:=y}",
  "echo {1..3} a{b,c}d",
  "touch {a,b}",
  "rm x{1,2}",
  "ls *.txt ? [ab]",
  "echo ~ ~/x ~root",
  "r\\m x",
  "'rm' x",
  "\"rm\" x",
  "r'm' x",
  "\\rm x",
  "\\eval 'rm x'",
  "e\"val\" 'rm x'",
  "type ls",
  "which ls",
  "true",
  ":",
  "echo hi; echo there",
  "ls -l | tee out",
  "echo \"$HOME\" '$HOME'",
  "echo \"a\\$b\" \"a\\\"b\"",
  "echo \"\\x\"",
  "echo \u00e9 \u6587\u4ef6 \ud55c\uae00",
  "touch \u6587\u4ef6",
  "ls -- *",
  // zsh reads these differently from bash.
  "ls =rm",
  "echo =ls",
  "echo a=b c==d",
  "repeat 2 rm x",
  "ls *(e:'touch pwned':)",
  "ls x(e:'touch pwned':)",
  "ls *(+rm)",
  "echo x > *(e:'touch pwned':)",
  "echo hi > \"$(touch r)\"",
  "rm x(N)",
  "echo $x:h $x:t",
  "rm $x:h",
  "echo ${x:u}",
  "echo $x[1]",
  "echo ${=x} ${~x} ${^x}",
  "x='a b'; touch $x",
  "x='*'; rm $x",
  "ls >| out",
  "ls >! out",
  "ls &!",
  "ls &|",
  "diff =(ls) a.txt",
  "echo ~+ ~-",
  "ls **/x",
  "echo ^x",
  "echo ${x:#p}",
  "print -r hi",
  "echo $(( x[\\$(touch p)] ))",
  "echo ${x:-a b}",
  "rm ${x:-a b}",
  "rm \"${x:-a b}\"",
  "echo a{,b}",
  "echo {a}",
  "echo {}",
  "echo {a,}{b,}",
  "echo \\{a,b\\}",
  "echo '{a,b}'",
  "ls {a,b}*",
  "echo x[1]",
  "echo %1",
  "echo a\\#b",
  "echo -n",
  "echo $=x",
  "echo $+x",
  "echo ${+x}",
  "echo $~x",
  "echo $^x",
  "echo $#x",
  "echo ${#}",
];

/** Rewrites of one command; the validator decides which survive. */
const MUTATIONS: ReadonlyArray<(command: string) => string> = [
  (c) => c,
  (c) => `command ${c}`,
  (c) => `time ${c}`,
  (c) => `builtin ${c}`,
  (c) => `( ${c} )`,
  (c) => `{ ${c}; }`,
  (c) => `${c}; true`,
  (c) => `true && ${c}`,
  (c) => `X=1 ${c}`,
  (c) => `${c} 2>/dev/null`,
  (c) => `echo $( ${c} )`,
  (c) => `${c} | cat`,
  (c) => `if true; then ${c}; fi`,
  (c) => `${c} \u6587\u4ef6`,
  (c) => `${c} a#b`,
  (c) => `${c} {a,b}`,
  (c) => `${c} *`,
  (c) => `${c} ~`,
  (c) => `${c} =x`,
  (c) => `${c} $'\\x41'`,
  (c) => `${c} "$(rm q)"`,
  (c) => `${c} \\*`,
  (c) => `${c} '*'`,
  (c) => `${c} x(N)`,
  (c) => `${c} $x`,
  (c) => `${c} "$x"`,
  // The head word spelled with quotes and escapes.
  (c) => c.replace(/^([a-z])([a-z]+)/u, "$1''$2"),
  (c) => c.replace(/^([a-z])([a-z]+)/u, "$1\"\"$2"),
  (c) => c.replace(/^([a-z])/u, "\\$1"),
  (c) => c.replace(/^([a-z]+)/u, "'$1'"),
];

/** Heads that wait for terminal input, end or replace the shell, or signal it. */
const NOT_RUN_HEADS: ReadonlySet<string> = new Set([
  "read", "mapfile", "readarray", "vared", "exit", "logout", "bye", "kill", "suspend", "wait", "fg", "bg", "disown", "exec", "cat",
]);

// ---------------------------------------------------------------------------
// What the classifier evaluated.

type Argv = readonly (string | undefined)[];

const baseName = (word: string): string => word.split("/").pop() ?? word;

/** The positions a command word can start at: argv[0], and past wrappers. */
function commandStarts(argv: Argv): number[] {
  const starts = new Set<number>([0]);
  let index = 0;
  while (index < argv.length && (argv[index] === "command" || argv[index] === "builtin" || argv[index] === "time" || argv[index] === "nohup")) {
    index++;
    while (index < argv.length && argv[index]?.startsWith("-")) index++;
    starts.add(index);
  }
  const wrapped = wrapperPrefixLength(argv);
  if (wrapped > 0) starts.add(wrapped);
  return [...starts].filter((start) => start < argv.length);
}

/** Whether `ran` is the classifier's command `argv` (from some command start). */
/** Builtins whose `NAME=value` arguments the classifier reads as assignments, not words. */
const DECLARATIONS: ReadonlySet<string> = new Set(["export", "readonly", "declare", "typeset", "local"]);

function covers(argv: Argv, executed: Executed): boolean {
  let ran = executed.argv;
  // zsh's second `time` is the time program, which runs the rest.
  while (ran[0] === "time" && ran.length > 1) ran = ran.slice(1);
  if (ran.length === 0) return false;
  if (executed.via === "trace" && DECLARATIONS.has(ran[0]!)) {
    return commandStarts(argv).some((start) => argv[start] === ran[0]);
  }
  return commandStarts(argv).some((start) => {
    const window = argv.slice(start);
    const head = window[0];
    if (head === undefined || baseName(head) !== baseName(ran[0]!)) return false;
    if (window.every((word) => word !== undefined)) {
      return window.length === ran.length && window.slice(1).every((word, i) => word === ran[i + 1]);
    }
    // A dynamic word may expand to any number of words: the static words
    // before the first one must still be what ran.
    const firstDynamic = window.findIndex((word) => word === undefined);
    return window.slice(1, firstDynamic).every((word, i) => word === ran[i + 1]);
  });
}

// ---------------------------------------------------------------------------
// What the shell executed.

/** Decode one xtrace line into words (`'\u2026'`, `$'\u2026'`, `"\u2026"`, backslash). */
function traceWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === " ") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      word += line.slice(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end;
    } else if (ch === "$" && line[i + 1] === "'") {
      i += 2;
      while (i < line.length && line[i] !== "'") {
        if (line[i] === "\\") {
          const next = line[i + 1]!;
          const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", e: "\u001b", E: "\u001b", a: "\u0007", "\\": "\\", "'": "'", "\"": "\"" };
          if (next in simple) { word += simple[next]; i += 2; continue; }
          if (next === "x") { const hex = /^[0-9a-fA-F]{1,2}/u.exec(line.slice(i + 2))![0]; word += String.fromCharCode(parseInt(hex, 16)); i += 2 + hex.length; continue; }
          if (/[0-7]/u.test(next)) { const oct = /^[0-7]{1,3}/u.exec(line.slice(i + 1))![0]; word += String.fromCharCode(parseInt(oct, 8)); i += 1 + oct.length; continue; }
        }
        word += line[i];
        i++;
      }
    } else if (ch === "\"") {
      i++;
      while (i < line.length && line[i] !== "\"") {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        word += line[i];
        i++;
      }
    } else if (ch === "\\" && i + 1 < line.length) {
      word += line[i + 1];
      i++;
    } else {
      word += ch;
    }
  }
  if (inWord) words.push(word);
  return words;
}

const TRACE_LINE = /^\++([^>\n]*)> (.*)$/u;
const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=\(/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u;
/** Trace lines of compound commands, not simple commands. */
const KEYWORD_HEADS: ReadonlySet<string> = new Set(["[[", "((", "for", "case", "select", "if", "while", "until", "function", "}", "{"]);

interface Executed {
  readonly via: "program" | "trace";
  readonly argv: readonly string[];
}

// ---------------------------------------------------------------------------
// The shells.

interface Rig {
  readonly root: string;
  readonly box: string;
  readonly shims: string;
  readonly calls: string;
}

function makeRig(root: string, shimNames: ReadonlySet<string>): Rig {
  const box = join(root, "box");
  const shims = join(root, "shims");
  const calls = join(root, "calls");
  for (const dir of [box, shims, calls, join(box, "sub")]) mkdirSync(dir, { recursive: true });
  for (const file of ["a.txt", "x", "list"]) writeFileSync(join(box, file), "");
  const shim = join(shims, ".shim");
  writeFileSync(shim, [
    "#!/bin/sh",
    `f=$(/usr/bin/mktemp '${calls}/call.XXXXXX') || exit 97`,
    "printf '%s\\0' \"${0##*/}\" \"$@\" > \"$f\"",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  for (const name of shimNames) symlinkSync(shim, join(shims, name));
  return { root, box, shims, calls };
}

interface Outcome {
  readonly command: string;
  readonly shell: string;
  readonly executed: readonly Executed[];
  /** What the shell recorded as the line it ran (its C marker), or null. */
  readonly recorded: string | null;
  readonly hung: boolean;
}

interface Session {
  run(command: string): Promise<Outcome>;
  /** Commands that left the shell unable to take the next one. */
  readonly stuck: readonly string[];
  close(): Promise<void>;
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await sleep(5);
  }
  return true;
}

async function openSession(shellPath: string, rig: Rig): Promise<Session> {
  const name = basename(shellPath);
  const home = join(rig.root, `home-${name}`);
  mkdirSync(home);
  const trace = join(rig.root, `trace-${name}`);
  writeFileSync(trace, "");
  const { env } = installShellIntegration(home, shellPath, { nonce: NONCE, sandboxEnv: { HOME: home, XDG_CONFIG_HOME: join(home, "config") } });
  const pty = nodePty.spawn(shellPath, ["-l", "-i"], {
    cwd: rig.box,
    cols: 200,
    rows: 50,
    env: { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8", ...env },
  });
  const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
  pty.onData((data) => { tracker.recordOutput(data); });
  const exited = new Promise<void>((resolve) => pty.onExit(() => { tracker.recordExit(); resolve(); }));
  if (!await until(() => tracker.promptEndCount() > 0, 10_000)) throw new Error(`${name} did not start`);
  await sleep(100);

  let previous = "(start)";
  const stuck: string[] = [];
  const typeAndWait = async (line: string): Promise<{ blockId: number | null; hung: boolean }> => {
    const typeOnce = () => typeLineAtPrompt({
      blocks: tracker,
      isLive: () => !tracker.hasExited(),
      write: (data) => pty.write(data),
      // The operating-system check is pty-manager's, tested on its own; here
      // the shell is known to be the foreground process.
      verify: async () => ({ ok: true, cwd: canonicalizePathForMatch(tracker.currentCwd() ?? "") }),
      missing: "no terminal",
    }, line);
    let typed = await typeOnce();
    // A loaded host can be slow to redraw the prompt after the reset.
    for (let attempt = 0; !typed.ok && typed.reason === "no-fresh-prompt" && attempt < 3; attempt++) typed = await typeOnce();
    if (!typed.ok) {
      // The previous command left the shell not ready for the next one:
      // a failure of its own; clear the line and go on.
      stuck.push(`${name}: ${JSON.stringify(previous)} left the shell ${typed.reason}`);
      const prompts = tracker.promptEndCount();
      pty.write("\u0003");
      await until(() => tracker.promptEndCount() > prompts, 3_000);
      await sleep(200);
      typed = await typeOnce();
      if (!typed.ok) throw new Error(`${name}: not typed (${typed.reason}): ${line} (after ${previous})`);
    }
    previous = line;
    const prompts = tracker.promptEndCount();
    if (!await until(() => tracker.promptEndCount() > prompts, 5_000)) {
      pty.write("\u0003");
      await until(() => tracker.promptEndCount() > prompts, 3_000);
      return { blockId: typed.firstBlockId, hung: true };
    }
    return { blockId: typed.firstBlockId, hung: false };
  };

  // Trace to a file, every program through the shims, in the sandbox. zsh
  // asks before `rm *` (rm_star_silent off) and waits for the user's y/n;
  // nothing runs until it is answered, so the query is turned off here.
  const setup = name === "zsh"
    ? `exec 7>>'${trace}' 2>&7; PS4='+%N> '; PATH='${rig.shims}'; cd '${rig.box}'; setopt rm_star_silent xtrace`
    : `exec 7>>'${trace}'; BASH_XTRACEFD=7; PS4='+\${FUNCNAME[0]:-main}> '; PATH='${rig.shims}'; cd '${rig.box}'; set -x`;
  await typeAndWait(setup);

  return {
    stuck,
    async run(command) {
      if (tracker.currentCwd() !== rig.box) await typeAndWait(`cd '${rig.box}'`);
      truncateSync(trace, 0);
      for (const call of readdirSync(rig.calls)) rmSync(join(rig.calls, call));
      const { blockId, hung } = await typeAndWait(command);
      // The shell does not wait for a process substitution's program; give
      // it time to start, and let every program finish writing its record.
      if (/[<>]\(/u.test(command)) await sleep(200);
      await until(() => readdirSync(rig.calls).every((call) => statSync(join(rig.calls, call)).size > 0), 2_000);
      const executed: Executed[] = [];
      for (const call of readdirSync(rig.calls)) {
        const argv = readFileSync(join(rig.calls, call), "utf-8").split("\0");
        argv.pop();
        executed.push({ via: "program", argv });
      }
      for (const raw of readFileSync(trace, "utf-8").split("\n")) {
        const match = TRACE_LINE.exec(raw);
        if (!match) continue;
        const [, context, text] = match as unknown as [string, string, string];
        if (context.startsWith("__ave_") || context === "add-zsh-hook") continue;
        // zsh traces a command's assignments on the command's own line:
        // `+zsh> X=1 +zsh> echo hi`.
        for (const segment of text.split(/ ?\++[^ >]*> /u)) {
          if (ARRAY_ASSIGNMENT.test(segment)) continue;
          const words = traceWords(segment);
          while (words.length > 0 && ASSIGNMENT.test(words[0]!)) {
            // An array assignment traced inline: `X=1 a=( 1 2 )`.
            if (words.shift()!.endsWith("=(")) words.splice(0, words.indexOf(")") + 1);
          }
          if (words.length === 0 || KEYWORD_HEADS.has(words[0]!) || words[0]!.startsWith("__ave_")) continue;
          executed.push({ via: "trace", argv: words });
        }
      }
      const block = blockId === null ? null : tracker.get(blockId);
      return { command, shell: name, executed, recorded: block?.command ?? null, hung };
    },
    async close() {
      try { pty.kill(); } catch { /* gone */ }
      await Promise.race([exited, sleep(3_000)]);
    },
  };
}

// ---------------------------------------------------------------------------

const BASH = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find((path) =>
  existsSync(path) && /version (?:4\.[4-9]|[5-9]\.)/u.test(spawnSync(path, ["--version"], { encoding: "utf-8" }).stdout));
const ZSH = existsSync("/bin/zsh") ? "/bin/zsh" : undefined;
const SHELLS = [ZSH, BASH].filter((path): path is string => path !== undefined);
const SESSIONS_PER_SHELL = 2;

function hasBackgroundJob(command: string): boolean {
  const analysis = analyzeShell(command, "bash");
  if (!analysis.ok) return false;
  const found = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if ((node as { kind?: unknown }).kind === "background") return true;
    return Object.values(node).some(found);
  };
  return found(analysis.program);
}

interface Plan {
  readonly candidates: number;
  readonly refused: number;
  /** Accepted, yet the classifier could not parse it: never allowed, and not run. */
  readonly unparsed: number;
  /** Run, and marked by the classifier as hiding code. */
  readonly hidden: number;
  readonly notRun: number;
  readonly runs: ReadonlyArray<{ command: string; commands: readonly Argv[] }>;
}

function plan(): Plan {
  const candidates = new Set<string>();
  for (const base of BASE_COMMANDS) for (const mutate of MUTATIONS) candidates.add(mutate(base));
  let refused = 0;
  let unparsed = 0;
  let hidden = 0;
  let notRun = 0;
  const runs: Array<{ command: string; commands: readonly Argv[] }> = [];
  for (const command of candidates) {
    if (terminalCommandTextProblem(command) !== null) { refused++; continue; }
    const shape = analyzeShellForRules(command);
    if (!shape.ok) { unparsed++; continue; }
    if (shape.hidden.length > 0) hidden++;
    // A background job may run after the prompt returns, past the point its
    // records are read: not run, counted with the others.
    if (hasBackgroundJob(command)) { notRun++; continue; }
    const commands = shape.commands.map((c) => c.argv);
    if (commands.some((argv) => commandStarts(argv).some((start) => NOT_RUN_HEADS.has(argv[start] ?? "")))) { notRun++; continue; }
    runs.push({ command, commands });
  }
  return { candidates: candidates.size, refused, unparsed, hidden, notRun, runs };
}

const opened: string[] = [];
afterAll(() => {
  for (const root of opened.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe.runIf(SHELLS.length === 2)("terminal_run: what the classifier evaluated is what the shell runs", () => {
  it("runs no simple command, in zsh or bash, that the permission classifier did not evaluate", async () => {
    const { candidates, refused, unparsed, hidden, notRun, runs } = plan();
    const shimNames = new Set<string>(["rm", "touch", "sh", "bash", "zsh", "curl", "ls", "git", "make", "npm", "head", "wc", "tee", "diff", "env", "xargs", "sudo", "nohup", "which", "print", "repeat", "pwned", "id"]);
    for (const { commands } of runs) {
      for (const argv of commands) {
        for (const start of commandStarts(argv)) {
          const head = argv[start];
          if (head !== undefined && /^[A-Za-z0-9_.+-]+$/u.test(head) && !NOT_RUN_HEADS.has(head)) shimNames.add(head);
        }
      }
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-diff-")));
    opened.push(root);

    const mismatches: string[] = [];
    const recordedDiffers: string[] = [];
    const hung: string[] = [];
    const stuckAfter: string[] = [];
    // Each shell runs the corpus in SESSIONS_PER_SHELL parts at once, each
    // session with its own sandbox, shims and call records.
    const parts = Array.from({ length: SESSIONS_PER_SHELL }, (_, part) => runs.filter((_run, i) => i % SESSIONS_PER_SHELL === part));
    await Promise.all(SHELLS.flatMap((shellPath) => parts.map(async (part, index) => {
      const rig = makeRig(join(root, `${basename(shellPath)}-${index}`), shimNames);
      const session = await openSession(shellPath, rig);
      try {
        for (const { command, commands } of part) {
          const outcome = await session.run(command);
          if (outcome.hung) hung.push(`${outcome.shell}: ${JSON.stringify(command)}`);
          if (outcome.recorded !== null && outcome.recorded !== command) recordedDiffers.push(`${outcome.shell}: ${JSON.stringify(command)} recorded as ${JSON.stringify(outcome.recorded)}`);
          for (const ran of outcome.executed) {
            if (!commands.some((argv) => covers(argv, ran))) {
              mismatches.push(`${outcome.shell}: ${JSON.stringify(command)} ran ${ran.via} ${JSON.stringify(ran.argv)}; classifier evaluated ${JSON.stringify(commands)}`);
            }
          }
        }
        stuckAfter.push(...session.stuck);
      } finally {
        await session.close();
      }
    })));

    process.stdout.write(`[terminal_run differential] candidates=${candidates} validator-refused=${refused} classifier-unparsed=${unparsed} not-run=${notRun} run=${runs.length} (${hidden} hiding code) x ${SHELLS.length} shells, hung=${hung.length}, stuck=${stuckAfter.length}, mismatches=${mismatches.length}, recorded-differs=${recordedDiffers.length}\n`);
    for (const line of [...mismatches, ...recordedDiffers, ...hung.map((h) => `hung ${h}`), ...stuckAfter.map((h) => `stuck ${h}`)]) console.info(line);
    expect(mismatches).toEqual([]);
    expect(recordedDiffers).toEqual([]);
    expect(hung).toEqual([]);
    expect(stuckAfter).toEqual([]);
  }, 600_000);
});
