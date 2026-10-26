/** Compare approved command analysis with real interactive shells using recording shims and temporary homes.
 * Every executed command must match the classifier's literal words or expansion head; command-not-found handlers must be refused before typing. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import * as nodePty from "node-pty";
import { installShellIntegration, TERMINAL_EDIT_LINE_QUERY } from "../shell-integration.js";
import { readTerminalForeground } from "../shell-process.js";
import { TerminalBlockTracker } from "../terminal-blocks.js";
import { typeLineAtPrompt } from "../pty-manager.js";
import { canonicalizePathForMatch } from "../../../permissions/sensitive-paths.js";
import { terminalCommandTextProblem } from "../../../shared/terminal-command-text.js";
import { analyzeShellForRules } from "../../../permissions/rules/shell-rule-matcher.js";
import { wrapperPrefixLength } from "../../../permissions/rules/shell-prefix-policy.js";
import { analyzeShell, staticShellWord } from "../../../shared/shell-analysis.js";
import { TERMINAL_TEST_MODERN_BASH, TERMINAL_TEST_UTF8_LOCALE, TERMINAL_TEST_ZSH, ubuntuLikeNotFoundHandler } from "../../../__tests__/support/terminal-markers.js";

import { TERMINAL_CALLBACK_COMMANDS, TERMINAL_PRINT_DATA_COMMANDS, TERMINAL_PRINTF_DATA_COMMANDS, TERMINAL_PRINTF_UNCHECKED_COMMANDS, TERMINAL_REGISTRY_COMMANDS } from "../../../__tests__/support/terminal-registry-commands.js";

const NONCE = "0123456789abcdef0123456789abcdef";

// Corpus: the validator's own accepted and refused cases, ordinary commands, and constructs where zsh and bash part ways, each then mutated.

const BASE_COMMANDS: readonly string[] = [
  ...TERMINAL_REGISTRY_COMMANDS,
  ...TERMINAL_CALLBACK_COMMANDS,
  ...TERMINAL_PRINT_DATA_COMMANDS,
  ...TERMINAL_PRINTF_DATA_COMMANDS,
  ...TERMINAL_PRINTF_UNCHECKED_COMMANDS,
  "mapfile -t -n1 lines < list",
  "readarray -tn1 lines < list",
  "mapfile -dC lines < list",
  "readarray -d C lines < list",
  "mapfile -- lines < list",
  "mapfile lines",
  "readarray lines",
  "printf '%%n %s' PATH",
  "printf -v 'values[0]' '%s' value",
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
  "read", "exit", "logout", "bye", "kill", "suspend", "wait", "fg", "bg", "disown", "cat",
]);

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

/** Whether `ran` is the classifier's command `argv` (from some command start). Builtins whose `NAME=value` arguments the classifier reads as assignments, not words. */
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
    // A dynamic word may expand to any number of words: the static words before the first one must still be what ran.
    const firstDynamic = window.findIndex((word) => word === undefined);
    return window.slice(1, firstDynamic).every((word, i) => word === ran[i + 1]);
  });
}

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
  writeFileSync(join(box, "list"), "line\n");
  const shim = join(shims, ".shim");
  writeFileSync(shim, [
    "#!/bin/sh",
    // One record per shim process. Keep real executable lookup and argv, but avoid starting another process just to allocate the record's filename.
    `f='${calls}/call.'$$`,
    "set -C",
    "printf '%s\\0' \"${0##*/}\" \"$@\" > \"$f\" || exit 97",
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

const liveSessions = new Set<() => Promise<void>>();

async function openSession(shellPath: string, rig: Rig, promptTokens?: string): Promise<Session> {
  const name = basename(shellPath);
  const home = join(rig.root, `home-${name}`);
  mkdirSync(home);
  const trace = join(rig.root, `trace-${name}`);
  writeFileSync(trace, "");
  const { env } = installShellIntegration(home, shellPath, { nonce: NONCE, sandboxEnv: { HOME: home, XDG_CONFIG_HOME: join(home, "config") } });
  // Every session starts as on an Ubuntu desktop, whatever the host: a command-not-found handler (Ubuntu's /etc/bash.bashrc defines one for
  // bash) ahead of the integration. Its program records a call like a shim, so a handler that ever ran would show as a program the rules never saw.
  const notFoundProgram = join(rig.root, `command-not-found-${name}`);
  writeFileSync(notFoundProgram, [
    "#!/bin/sh",
    `f='${rig.calls}/call.'$$`,
    "set -C",
    "printf '%s\\0' command-not-found \"$@\" > \"$f\" || exit 97",
    "exit 127",
    "",
  ].join("\n"), { mode: 0o755 });
  const rc = join(home, name === "zsh" ? ".zshrc" : ".bash_profile");
  const integration = readFileSync(rc, "utf-8");
  const instrument = (source: string, anchor: string, replacement: string): string => {
    if (source.split(anchor).length !== 2) throw new Error("Expected one shell integration instrumentation anchor");
    return source.replace(anchor, replacement);
  };
  let tracedIntegration = integration;
  if (name === "bash") {
    tracedIntegration = instrument(tracedIntegration, '  __ave_at_prompt=1\n}', '  __ave_close_fence\n  __ave_at_prompt=1\n}');
    tracedIntegration = instrument(tracedIntegration, '[ "$BASH_COMMAND" = "__ave_precmd" ]', '[[ "$BASH_COMMAND" = "__ave_precmd" || "$BASH_COMMAND" = "__ave_begin_fence" ]]');
  }
  // Per-character encoding was already excluded from the executable trace. Disable only that bookkeeping, with
  // native local-option restoration so every command and builtin still runs with the original global xtrace.
  const encoder = name === "bash" ? "__ave_encode() {\n" : "__ave_encode() {\n  emulate -L zsh\n";
  tracedIntegration = instrument(tracedIntegration, encoder, encoder + (name === "bash" ? "  local -\n  set +x\n" : "  unsetopt xtrace\n"));
  let promptFixture = "";
  if (promptTokens !== undefined) {
    // Each session reads its immutable cryptographic token stream through its own descriptor. Exhaustion is an error, never a reused token.
    const tokenSource = '  ave_token="$(/usr/bin/od -An -N16 -tx1 /dev/urandom 2>/dev/null)"\n  ave_token="${ave_token//[^0-9a-f]/}"';
    tracedIntegration = instrument(tracedIntegration, tokenSource, '  if ! IFS= read -r ave_token <&8; then printf "Prompt token fixture exhausted\\n" >&2; exit 98; fi');
    promptFixture = `exec 8<'${promptTokens}'\n`;
    // Query the actual bindings on every prompt using native builtins and a per-session file instead of forking to capture their standard output.
    const bindings = join(rig.root, "prompt-bindings");
    if (name === "zsh") {
      tracedIntegration = instrument(tracedIntegration, '  [[ "$(bindkey -lL main)" == *vi* ]]',
        `  local ave_keymap\n  bindkey -lL main >'${bindings}'\n  IFS= read -r ave_keymap <'${bindings}'\n  [[ "$ave_keymap" == *vi* ]]`);
      if (process.platform === "darwin") {
        // Query current traps with the native builtin as well. The focused default-prompt case retains the production pipe and its child wait.
        const traps = join(rig.root, "prompt-traps");
        tracedIntegration = instrument(tracedIntegration,
          "  { builtin trap && builtin printf '\\0'; } | IFS= builtin read -r -d '' ave_traps",
          `  { builtin trap && builtin printf '\\0'; } >'${traps}' || return 1\n  IFS= builtin read -r -d '' ave_traps <'${traps}' || return 1`);
        tracedIntegration = instrument(tracedIntegration,
          '  if (( pipestatus[1] == 0 && pipestatus[2] == 0 )) && [[ -z "$ave_traps" ]]; then builtin trap - INT; fi',
          '  if [[ -z "$ave_traps" ]]; then builtin trap - INT; fi');
      }
    } else {
      tracedIntegration = instrument(tracedIntegration, '  [[ "$__ave_paste" = 1 && "$(bind -v)" == *"enable-bracketed-paste on"* ]]',
        `  local -a ave_binding_options\n  bind -v >'${bindings}'\n  mapfile -t ave_binding_options <'${bindings}'\n  [[ "$__ave_paste" = 1 && "${"${ave_binding_options[*]}"}" == *"enable-bracketed-paste on"* ]]`);
    }
  }
  const fencePath = join(rig.root, "descendants-finished");
  expect(spawnSync("mkfifo", [fencePath]).status).toBe(0);
  // Opening this descriptor immediately before Enter gives every native descendant a writer. The prompt
  // closes the shell's own copy; EOF then proves process substitutions finished before their records are read.
  const fenceHooks = [
    `__ave_begin_fence() { exec 9>'${fencePath}'; printf f >&9; __ave_fence_open=1; }`,
    '__ave_close_fence() { if [ "${__ave_fence_open:-0}" = 1 ]; then exec 9>&-; __ave_fence_open=0; fi; return 0; }',
    name === "zsh"
      ? "zle -N __ave_begin_fence; bindkey '^[[98~' __ave_begin_fence; add-zsh-hook precmd __ave_close_fence"
      : `bind -x '"\\e[98~":__ave_begin_fence'`,
  ].join("\n");
  writeFileSync(rc, ubuntuLikeNotFoundHandler(name, notFoundProgram) + tracedIntegration + "\n" + promptFixture + fenceHooks + "\n");
  const pty = nodePty.spawn(shellPath, ["-l", "-i"], {
    cwd: rig.box,
    cols: 200,
    rows: 50,
    env: { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color", LANG: TERMINAL_TEST_UTF8_LOCALE, ...env },
  });
  const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
  const changes = new Set<() => void>();
  const until = (condition: () => boolean, timeoutMs: number): Promise<boolean> => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      changes.delete(check);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const check = () => {
      try {
        if (condition()) finish(true);
        else if (tracker.hasExited()) finish(false);
      } catch (error) { finish(false, error); }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    changes.add(check);
    check();
  });
  // The shell's latest output, for the report of a command that left it not ready.
  let recentOutput = "";
  const recentEvents: { at: number; kind: string; text: string; prompts: number; state: string }[] = [];
  const recordEvent = (kind: string, text: string): void => {
    recentEvents.push({ at: Date.now(), kind, text: text.slice(-800), prompts: tracker.promptEndCount(), state: tracker.promptState() });
    if (recentEvents.length > 30) recentEvents.shift();
  };
  const writeInput = (data: string): void => { recordEvent("input", data); pty.write(data); };
  let editorOutput = "";
  pty.onData((data) => {
    tracker.recordOutput(data);
    recordEvent("output", data);
    recentOutput = (recentOutput + data).slice(-600);
    editorOutput = (editorOutput + data).slice(-2048);
    for (const check of changes) check();
  });
  const exited = new Promise<void>((resolve) => pty.onExit(() => { tracker.recordExit(); for (const check of changes) check(); resolve(); }));
  let fence: { cancel(): Promise<void> } | undefined;
  const beginFence = async () => {
    const reader = spawn("/bin/cat", [fencePath], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    reader.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    reader.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    const closed = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      reader.on("error", (error) => resolve({ code: null, error }));
      reader.on("close", (code) => resolve({ code }));
    });
    // Hold a writer until the command returns, including the interval before its native editor callback opens FD 9. Neither FIFO open can lose EOF.
    const writer = await open(fencePath, "w");
    let finished: Promise<{ code: number | null; error?: Error }> | undefined;
    const finish = () => finished ??= (async () => {
      await writer.close();
      return new Promise<{ code: number | null; error?: Error }>((resolve) => {
        const timer = setTimeout(() => {
          reader.kill("SIGKILL");
          resolve({ code: null, error: new Error("A descendant kept the command-completion FIFO open") });
        }, 3_000);
        void closed.then((result) => { clearTimeout(timer); resolve(result); });
      });
    })();
    fence = { cancel: async () => {
      reader.kill("SIGKILL");
      // Cleanup is bounded and makes no assertions that could mask the command failure. Completion is checked by the command's own caller.
      try { await finish(); } catch (error) { process.stderr.write(`FIFO cleanup: ${String(error)}\n`); }
    } };
    return async () => {
      const result = await finish();
      fence = undefined;
      if (result.error) throw result.error;
      expect(result.code, errors).toBe(0);
      expect(output).toBe("f");
    };
  };
  const close = async () => {
    try { pty.kill("SIGKILL"); } catch { /* gone */ }
    await exited;
    await fence?.cancel();
    liveSessions.delete(close);
  };
  liveSessions.add(close);
  if (!await until(() => tracker.promptEndCount() > 0, 10_000)) throw new Error(`${name} did not start: ${JSON.stringify(recentOutput)}`);

  const waitForEditor = async () => {
    if (tracker.promptState() !== "ready") throw new Error(`${name}: prompt is ${tracker.promptState()} after ${previous}`);
    // Observe the native editor's enable sequence and B in this prompt's output, including split reads. The two shells emit them in opposite orders.
    const editorReady = name === "zsh"
      ? /\u001b\]133;B;[0-9a-f]{32}\u0007[\s\S]*\u001b\[\?2004h/u
      : /\u001b\[\?2004h[\s\S]*\u001b\]133;B;[0-9a-f]{32}\u0007/u;
    if (!await until(() => editorReady.test(editorOutput.slice(editorOutput.lastIndexOf(`\u001b]133;A;${NONCE}\u0007`))), 3_000)) {
      throw new Error(`${name}: line editor did not enable paste after ${previous} (${JSON.stringify(recentOutput)})`);
    }
  };

  let previous = "(start)";
  const stuck: string[] = [];
  const typeAndWait = async (line: string): Promise<{ blockId: number | null; hung: boolean }> => {
    const expectedBlockId = tracker.nextBlockId();
    const assertUnsubmitted = (): void => {
      if (tracker.nextBlockId() !== expectedBlockId) throw new Error(`${name}: a command started during refused preparation: ${line}`);
    };
    const capturePreparationState = async (stage: string, reason: string, query: boolean): Promise<void> => {
      // Capture the live terminal before teardown; a ready marker alone does not establish that the shell owns the tty or still receives SIGINT.
      const foreground = await readTerminalForeground(pty.pid);
      const ttyPath: unknown = Reflect.get(pty, "pty");
      const tty = typeof ttyPath === "string"
        ? spawnSync("/bin/stty", [process.platform === "darwin" ? "-f" : "-F", ttyPath, "-a"], { encoding: "utf8", timeout: 1_000 })
        : undefined;
      const queryGeneration = tracker.editLineReportGeneration();
      if (query && foreground.ok && foreground.foreground.pid === pty.pid && foreground.foreground.command === name && tracker.promptState() === "ready" && tracker.supportsEditLineQuery() && !tracker.hasExited()) {
        assertUnsubmitted();
        writeInput(TERMINAL_EDIT_LINE_QUERY);
        await until(() => tracker.editLineReportGeneration() > queryGeneration, 500);
        assertUnsubmitted();
      }
      process.stderr.write(`[terminal_run preparation diagnostic] ${JSON.stringify({ stage, reason, previous, refused: line, shell: name, pid: pty.pid, foreground, tty: tty?.stdout, ttyError: tty?.stderr, queryGeneration, queryAfter: tracker.editLineReportGeneration(), report: tracker.editLineReport(), trace: readFileSync(trace, "utf8").slice(-4_000), events: recentEvents })}\n`);
    };
    const typeOnce = async () => {
      assertUnsubmitted();
      await waitForEditor();
      const result = await typeLineAtPrompt({
        blocks: tracker,
        isLive: () => !tracker.hasExited(),
        // A submission behind the completion fence carries its marker key.
        write: (data) => writeInput(data === "\r" && fence ? "\u001b[98~\r" : data),
        // The operating-system check is pty-manager's, tested on its own; here the shell is known to be the foreground process.
        verify: async () => ({ ok: true, cwd: canonicalizePathForMatch(tracker.currentCwd() ?? "") }),
        missing: "no terminal",
      }, line);
      if (!result.ok) assertUnsubmitted();
      else if (result.firstBlockId !== expectedBlockId) throw new Error(`${name}: another command started before approved submission: ${line}`);
      return result;
    };
    // A preparation refusal is a failure of its own: it must have run nothing, and the line is not retried behind a fresh prompt.
    const typed = await typeOnce();
    if (!typed.ok) {
      await capturePreparationState("final-refusal", typed.reason, true);
      const detail = `${name}: ${JSON.stringify(previous)} left the shell ${typed.reason} (state ${tracker.promptState()}; edit line ${JSON.stringify(tracker.editLineText())}; output ${JSON.stringify(recentOutput)})`;
      stuck.push(detail);
      throw new Error(`${detail}; refused ${JSON.stringify(line)}`);
    }
    previous = line;
    const prompts = tracker.promptEndCount();
    if (!await until(() => tracker.promptEndCount() > prompts, 5_000)) {
      writeInput("\u0003");
      await until(() => tracker.promptEndCount() > prompts, 3_000);
      return { blockId: typed.firstBlockId, hung: true };
    }
    // The next line is typed only at a ready prompt (the shell may still be writing after its prompt marker).
    if (!await until(() => tracker.promptState() === "ready", 3_000)) return { blockId: typed.firstBlockId, hung: true };
    if (tracker.nextBlockId() > expectedBlockId + 1) throw new Error(`${name}: multiple command blocks started for one approved submission: ${line}`);
    return { blockId: typed.firstBlockId, hung: false };
  };

  // terminal_run types nothing while the handler is defined: it runs code for any word that is not a command.
  // The user removes it for this terminal (a key they type, not a line terminal_run types), and the run goes on.
  await until(() => tracker.promptState() !== "shell-starting", 3_000);
  const refused = await typeLineAtPrompt({
    blocks: tracker,
    isLive: () => !tracker.hasExited(),
    write: (data) => writeInput(data),
    verify: async () => ({ ok: true, cwd: canonicalizePathForMatch(tracker.currentCwd() ?? "") }),
    missing: "no terminal",
  }, "true");
  if (refused.ok || refused.reason !== "not-found-handler") {
    throw new Error(`${name}: typing with a command-not-found handler defined was not refused (${JSON.stringify(refused)})`);
  }
  const beforeRemoval = tracker.promptEndCount();
  writeInput(`${name === "zsh" ? "unfunction command_not_found_handler" : "unset -f command_not_found_handle"}\r`);
  if (!await until(() => tracker.promptEndCount() > beforeRemoval && tracker.promptState() === "ready", 5_000)) {
    throw new Error(`${name}: the prompt was not ready after the handler was removed (${tracker.promptState()})`);
  }

  // Trace to a file, every program through the shims, in the sandbox. zsh asks before `rm *` (rm_star_silent
  // off) and waits for the user's y/n; nothing runs until it is answered, so the query is turned off here.
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
      const finishDescendants = /[<>]\(/u.test(command) ? await beginFence() : undefined;
      const { blockId, hung } = await typeAndWait(command);
      await finishDescendants?.();
      const executed: Executed[] = [];
      for (const call of readdirSync(rig.calls)) {
        const argv = readFileSync(join(rig.calls, call), "utf-8").split("\0");
        expect(argv.pop(), `Complete argv record for ${command}`).toBe("");
        expect(argv.length, command).toBeGreaterThan(0);
        executed.push({ via: "program", argv });
      }
      for (const raw of readFileSync(trace, "utf-8").split("\n")) {
        const match = TRACE_LINE.exec(raw);
        if (!match) continue;
        const [, context, text] = match as unknown as [string, string, string];
        if (context.startsWith("__ave_") || context === "add-zsh-hook") continue;
        // zsh traces a command's assignments on the command's own line: `+zsh> X=1 +zsh> echo hi`.
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
    close,
  };
}

const BASH = TERMINAL_TEST_MODERN_BASH;
const ZSH = TERMINAL_TEST_ZSH;
const SHELLS = [ZSH, BASH].filter((path): path is string => path !== undefined);
const SESSIONS_PER_SHELL = 1;

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

/** Array reads run only with a known finite fixture file as standard input. */
function hasUnboundedArrayRead(command: string): boolean {
  const analysis = analyzeShell(command, "bash");
  if (!analysis.ok) return true;
  const found = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return false;
    if ((node as { kind?: unknown }).kind === "command") {
      const simple = node as Extract<typeof analysis.program, { kind: "command" }>;
      const argv = simple.words.map(staticShellWord);
      if (commandStarts(argv).some((start) => argv[start] === "mapfile" || argv[start] === "readarray")) {
        return argv.some((word) => word !== undefined && /^-[A-Za-z]*u/u.test(word))
          || !simple.redirects.some((redirect) => redirect.effect === "read" && !redirect.descriptor
          && redirect.target !== undefined && ["list", "a.txt", "/dev/null"].includes(staticShellWord(redirect.target) ?? ""));
      }
    }
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

function plan(baseCommands: readonly string[] = BASE_COMMANDS): Plan {
  const candidates = new Set<string>();
  for (const base of baseCommands) for (const mutate of MUTATIONS) candidates.add(mutate(base));
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
    // A background job may run after the prompt returns, past the point its records are read: not run, counted with the others.
    if (hasBackgroundJob(command) || hasUnboundedArrayRead(command)) { notRun++; continue; }
    const commands = shape.commands.map((c) => c.argv);
    if (commands.some((argv) => commandStarts(argv).some((start) => NOT_RUN_HEADS.has(argv[start] ?? "")))) { notRun++; continue; }
    runs.push({ command, commands });
  }
  return { candidates: candidates.size, refused, unparsed, hidden, notRun, runs };
}

const opened: string[] = [];
afterAll(async () => {
  await Promise.all([...liveSessions].map((close) => close()));
  for (const root of opened.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const executeShell = promisify(execFile);

/** Share interpreter startup while keeping each probe's state in a subshell. */
async function runProbeBatch(shellPath: string, root: string, scripts: readonly string[], interactive = false): Promise<string[]> {
  const script = scripts.map((body, index) => `(
${body}
)
__ave_probe_status=$?
printf '\\000%s:%s\\000' '${index}' "$__ave_probe_status"`).join("\n");
  const result = await executeShell(shellPath, [interactive ? "-fic" : "-fc", script], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, HOME: root, ZDOTDIR: root, ENV: "", BASH_ENV: "", LC_ALL: TERMINAL_TEST_UTF8_LOCALE },
  });
  const frames = result.stdout.split("\0");
  expect(frames, result.stderr).toHaveLength(scripts.length * 2 + 1);
  return scripts.map((_body, index) => {
    expect(frames[index * 2 + 1], result.stderr).toBe(`${index}:0`);
    return frames[index * 2]!;
  });
}

describe.runIf(SHELLS.length === 2)("terminal_run: what the classifier evaluated is what the shell runs", () => {
  it("runs mixed formats and refuses unchecked numeric operands before typing", async () => {
    // Focused checks need only their own mutations; the full corpus runs below.
    const { runs } = plan([...TERMINAL_PRINTF_DATA_COMMANDS, ...TERMINAL_PRINT_DATA_COMMANDS, ...TERMINAL_PRINTF_UNCHECKED_COMMANDS]);
    for (const command of [...TERMINAL_PRINTF_DATA_COMMANDS, ...TERMINAL_PRINT_DATA_COMMANDS]) {
      expect(runs.some((run) => run.command === command)).toBe(true);
    }
    for (const command of TERMINAL_PRINTF_UNCHECKED_COMMANDS) {
      expect(terminalCommandTextProblem(command)).toBe("shell-state");
      expect(runs.some((run) => run.command === command)).toBe(false);
    }
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-printf-")));
    opened.push(root);
    const results = await Promise.allSettled(SHELLS.map(async (shellPath) => {
      const session = await openSession(shellPath, makeRig(join(root, basename(shellPath)), new Set()));
      try {
        for (const command of [...TERMINAL_PRINTF_DATA_COMMANDS, ...TERMINAL_PRINT_DATA_COMMANDS]) {
          const shape = analyzeShellForRules(command);
          expect(shape.ok).toBe(true);
          if (!shape.ok) throw new Error("Expected a classified format command");
          const outcome = await session.run(command);
          expect(outcome.hung, command).toBe(false);
          expect(outcome.recorded, command).toBe(command);
          expect(outcome.executed.length, command).toBeGreaterThan(0);
          for (const executed of outcome.executed) {
            expect(shape.commands.some(({ argv }) => covers(argv, executed)), JSON.stringify({ command, executed })).toBe(true);
          }
        }
        expect(session.stuck).toEqual([]);
      } finally {
        await session.close();
      }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });

  it("observes hidden arithmetic in mixed, repeated, positional and star operands", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-printf-arithmetic-")));
    opened.push(root);
    const commands = [
      "printf '%s %d' hello 'printfProbe=7'",
      "printf '%s %d' hello 42 world 'printfProbe=7'",
      "printf '%d %% %s' 42 hello 'printfProbe=7' world",
      "printf '%s %*s' hello 'printfProbe=7' world",
      "printf '%s %.*s' hello 'printfProbe=7' world",
      "printf '%s %*.*f' hello 8 2 1.25 world 9 3 'printfProbe=7'",
      "printf '%s %d' $text 42 'printfProbe=7' 43",
      "printf '%2$d %1$s' hello 'printfProbe=7'",
      "printf '%2$*1$d' 8 'printfProbe=7'",
      "print -rv'values[printfProbe=7]' changed",
    ].map((command) => ({ command, problem: "shell-state" }));
    commands.push(...[
      "print -u 1 -f '%d' 'printfProbe=7'",
      "builtin print -u 1 -f '%d' 'printfProbe=7'",
      "print -C 1 -f '%d' 'printfProbe=7'",
      "print -x 8 -f '%d' 'printfProbe=7'",
      "print -X 8 -f '%d' 'printfProbe=7'",
      "print -v output -f '%d' 'printfProbe=7'",
      "print -Rf '%d' 'printfProbe=7'",
    ].map((command) => ({ command, problem: "unchecked-construct" })));
    for (const { command, problem } of commands) expect(terminalCommandTextProblem(command)).toBe(problem);
    const batches = await Promise.allSettled(SHELLS.map((shellPath) => runProbeBatch(shellPath, root,
      commands.map(({ command }) => `printfProbe=0; text=; ${command}; printf '\\n%s' "$printfProbe"`))));
    for (const [shellIndex, batch] of batches.entries()) {
      if (batch.status === "rejected") throw batch.reason;
      const shellPath = SHELLS[shellIndex]!;
      for (const [index, { command }] of commands.entries()) {
        const stdout = batch.value[index]!;
        expect(stdout.endsWith(shellPath === ZSH ? "\n7" : "\n0"), JSON.stringify({ shellPath, command, stdout })).toBe(true);
      }
    }
  });

  it("observes protected destination writes from attached print targets", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-print-target-")));
    opened.push(root);
    const cases = [
      ["print -rvPATH changed", "changed"],
      ["print -nrvPATH changed", "changed"],
      ["print -C1 -rvPATH changed", "changed\n"],
      ["print -RvPATH changed", "changed"],
    ] as const;
    for (const [command] of cases) expect(terminalCommandTextProblem(command)).toBe("shell-state");
    const outputs = await runProbeBatch(ZSH!, root, cases.map(([command]) => `PATH=original; ${command}; builtin printf '%s' "$PATH"`));
    for (const [index, [command, expected]] of cases.entries()) {
      expect(outputs[index], command).toBe(expected);
    }
  });

  it("runs array reads only with finite fixture input", () => {
    expect(hasUnboundedArrayRead("mapfile lines")).toBe(true);
    expect(hasUnboundedArrayRead("readarray -t lines")).toBe(true);
    expect(hasUnboundedArrayRead("builtin mapfile -t lines < list")).toBe(false);
    expect(hasUnboundedArrayRead("command readarray lines < /dev/null")).toBe(false);
    expect(hasUnboundedArrayRead("mapfile lines < /dev/tty")).toBe(true);
    expect(hasUnboundedArrayRead("mapfile -u1 lines < list")).toBe(true);
    const command = "mapfile -t -n1 lines < list";
    expect(plan([command]).runs.some((run) => run.command === command)).toBe(true);
  });

  it("keeps native prompt subprocesses ready after pipelines", async () => {
    // Keep the shipped prompt subprocesses real at this integration boundary; the larger classifier matrix
    // prebuilds entropy and captures bindings with native builtins instead of repeatedly forking for bookkeeping.
    const { runs } = plan(["git log --oneline | head -5"]);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-native-prompt-")));
    opened.push(root);
    const results = await Promise.allSettled(SHELLS.map(async (shellPath) => {
      const session = await openSession(shellPath, makeRig(join(root, basename(shellPath)), new Set(["git", "head", "rm"])));
      try {
        for (const { command, commands } of runs) {
          const outcome = await session.run(command);
          expect(outcome.hung, command).toBe(false);
          expect(outcome.recorded, command).toBe(command);
          expect(outcome.executed.length, command).toBeGreaterThan(0);
          for (const executed of outcome.executed) {
            expect(commands.some((argv) => covers(argv, executed)), JSON.stringify({ command, executed })).toBe(true);
          }
        }
        expect(session.stuck).toEqual([]);
      } finally { await session.close(); }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });

  it("preserves configured traps and default interrupt options while preparing prompts", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-prompt-traps-")));
    opened.push(root);
    const cases = [
      { setup: ":", marker: "" },
      { setup: "trap 'printf list-handler' INT", marker: "list-handler" },
      { setup: "TRAPINT() { printf function-handler; return 130; }", marker: "function-handler" },
      { setup: "trap '' INT", marker: "trap -- '' INT" },
      { setup: "trap 'printf unrelated-handler' USR1", marker: "unrelated-handler" },
      { setup: "read() { return 1; }; trap 'printf shadowed-read-handler' INT", marker: "shadowed-read-handler" },
    ];
    const fixtures = cases.map(({ setup }, index) => {
      const home = join(root, String(index));
      mkdirSync(home);
      installShellIntegration(home, ZSH!, { nonce: NONCE, sandboxEnv: { HOME: home, XDG_CONFIG_HOME: join(home, "config") } });
      return { home, script: `source '${join(home, ".zshrc")}'; unsetopt traps_async; ${setup}
builtin trap > '${join(home, "before")}'
__ave_precmd
builtin trap > '${join(home, "after")}'
print -r -- "$options[trapsasync]"` };
    });
    const output = await runProbeBatch(ZSH!, root, fixtures.map(({ script }) => script), true);
    for (const [index, { home }] of fixtures.entries()) {
      const before = readFileSync(join(home, "before"), "utf8");
      if (cases[index]!.marker) expect(before).toContain(cases[index]!.marker);
      else expect(before).toBe("");
      expect(readFileSync(join(home, "after"), "utf8")).toBe(before);
      expect(output[index]!.endsWith("off\n")).toBe(true);
    }
  });

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

    // Each session gets a disjoint immutable stream of real cryptographic tokens. Reserve for cwd restoration and the protocol's internal resets.
    const tokensPerSession = (Math.ceil(runs.length / SESSIONS_PER_SHELL) + 2) * 16;
    const streamCount = SHELLS.length * SESSIONS_PER_SHELL;
    const tokens = randomBytes(16 * tokensPerSession * streamCount).toString("hex").match(/.{32}/gu)!;
    const tokenPaths = Array.from({ length: streamCount }, (_unused, index) => {
      const path = join(root, `prompt-tokens-${index}`);
      writeFileSync(path, tokens.slice(index * tokensPerSession, (index + 1) * tokensPerSession).join("\n") + "\n", { mode: 0o400 });
      return path;
    });

    const mismatches: string[] = [];
    const recordedDiffers: string[] = [];
    const hung: string[] = [];
    const stuckAfter: string[] = [];
    // Each shell runs the corpus in SESSIONS_PER_SHELL parts at once, each session with its own sandbox, shims and call records.
    const parts = Array.from({ length: SESSIONS_PER_SHELL }, (_, part) => runs.filter((_run, i) => i % SESSIONS_PER_SHELL === part));
    const results = await Promise.allSettled(SHELLS.flatMap((shellPath, shellIndex) => parts.map(async (part, index) => {
      const rig = makeRig(join(root, `${basename(shellPath)}-${index}`), shimNames);
      const session = await openSession(shellPath, rig, tokenPaths[shellIndex * SESSIONS_PER_SHELL + index]!);
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
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (errors.length > 0) throw new AggregateError(errors.map((result) => result.reason), errors.map((result) => String(result.reason)).join("\n"));

    process.stdout.write(`[terminal_run differential] candidates=${candidates} validator-refused=${refused} classifier-unparsed=${unparsed} not-run=${notRun} run=${runs.length} (${hidden} hiding code) x ${SHELLS.length} shells, hung=${hung.length}, stuck=${stuckAfter.length}, mismatches=${mismatches.length}, recorded-differs=${recordedDiffers.length}\n`);
    for (const line of [...mismatches, ...recordedDiffers, ...hung.map((h) => `hung ${h}`), ...stuckAfter.map((h) => `stuck ${h}`)]) console.info(line);
    expect(mismatches).toEqual([]);
    expect(recordedDiffers).toEqual([]);
    expect(hung).toEqual([]);
    expect(stuckAfter).toEqual([]);
  }, 600_000);
});
