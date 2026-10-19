/**
 * shell-integration.ts — OSC 133 command markers for the interactive terminal.
 *
 * Every terminal runs with its own throwaway sandbox HOME (pty-manager), so the
 * user's real startup files are never read. That HOME is where the integration
 * goes: one startup file for the login shell, written before the shell starts.
 * Nothing outside the sandbox HOME is touched.
 *
 * Each shell reports, around every command it runs (`<n>` is the nonce):
 *   OSC 133;D;<exit>;<n>            the previous command finished (first prompt: nothing open)
 *   OSC 133;P;Cwd=<encoded path>;Keys=<emacs|vi>;Paste=<0|1>;<n>
 *                                   the working directory, the line editor's
 *                                   key bindings, and whether it takes
 *                                   bracketed paste (zsh, bash; fish: Cwd only)
 *   OSC 133;A;<n>                   prompt start
 *   OSC 133;B;<n>                   end of prompt / start of typed input (zsh, bash)
 *   OSC 133;C;cmdline_url=<percent-encoded command>;<n>  output starts
 *
 * NONCE. Anything a command prints reaches the same stream, so a program (or
 * `cat` of a file) could print these sequences and forge a block: its command,
 * exit code and directory. Every marker therefore ends with a random per-
 * terminal nonce, and terminal-blocks.ts accepts only markers that carry it.
 * This is VS Code's shell-integration scheme (microsoft/vscode @95ba2e3c,
 * shellIntegration-bash.sh and shellIntegration-rc.zsh: `__vsc_nonce=
 * "$VSCODE_NONCE"; unset VSCODE_NONCE`, then `OSC 633 ; E ; <cmd> ; <nonce>`;
 * shellIntegrationAddon.ts trusts a command line or a `P;Cwd=` only when its
 * last field equals the nonce, and never trusts OSC 7). Unlike VS Code the
 * nonce does not arrive in the environment: a process's initial environment
 * stays readable after the shell unsets the variable (`ps -E`,
 * `/proc/<pid>/environ`), so any program the shell runs could read it. It
 * arrives in an owner-only file in the sandbox HOME that the startup file
 * reads into an unexported shell variable and deletes before the first
 * prompt. The prompt string refers to that variable rather than holding the
 * nonce, so printing `$PS1` (or any transformation of it) reveals nothing.
 * Only the shell's own hook functions read it. Unlike VS Code, where only E
 * and P carry it,
 * every marker here does: a forged A, B, C or D would split blocks just as well.
 * The working directory moved from OSC 7 to `P;Cwd=` because OSC 7 has no
 * field for a nonce.
 *
 * The command text and the directory are percent-encoded so they can never
 * carry the BEL / ESC that would end the marker, or the `;` that separates its
 * fields. A command is encoded from its first 4096 characters at most, so every
 * marker stays far below the parser's OSC bound. zsh and bash
 * encode `%`, `;` and control characters and pass other characters through;
 * fish uses its URL escaping. terminal-blocks.ts decodes both.
 *
 * A shell not listed here gets no file and falls back to the Enter-split
 * heuristic in terminal-blocks.ts.
 *
 * The scripts are plain line arrays (no template literals; constants are
 * joined with `+`) so shell `${…}` expansions are never mistaken for
 * JavaScript interpolation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type IntegratedShell = "zsh" | "bash" | "fish";

export function detectIntegratedShell(shellPath: string): IntegratedShell | null {
  const name = basename(shellPath).replace(/^-/u, "");
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  return null;
}

/** A path as one single-quoted word for the startup files. */
function shellQuoteForRc(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

const HEADER = "# Ave terminal shell integration (generated; this HOME is discarded when the terminal closes).";

/**
 * File in the sandbox HOME that hands the nonce to the startup file, which
 * reads it into an unexported shell variable and deletes it before anything
 * else runs. Nothing the shell later starts can find it: not in the
 * environment, not on disk.
 */
export const SHELL_INTEGRATION_NONCE_FILE = ".ave-terminal-nonce";

/** Characters of command text a script encodes into its C marker. */
const MAX_ENCODED_COMMAND_CHARS = 4096;

const ZSH_RC = (noncePath: string): string => [
  HEADER,
  // Read and delete the nonce file first; a nested shell finds none.
  "__ave_nonce=''",
  "if [[ -f " + shellQuoteForRc(noncePath) + " ]]; then",
  "  __ave_nonce=\"$(<" + shellQuoteForRc(noncePath) + ")\"",
  "  /bin/rm -f -- " + shellQuoteForRc(noncePath),
  "fi",
  // `#` starts a comment, as in bash: the permission rules read a typed
  // command as bash, and without this option zsh runs the text after `#`.
  // Set before anything can return, so every shell of the terminal has it.
  "setopt interactivecomments",
  // A nested shell (or one started without the variable) has no nonce: it
  // emits no markers rather than markers the tracker would reject.
  '[[ -n "$__ave_nonce" ]] || return 0',
  "__ave_encode() {",
  "  emulate -L zsh",
  '  local s="$1" out="" c i',
  "  for (( i = 1; i <= ${#s}; i++ )); do",
  '    c="${s[i]}"',
  '    if [[ "$c" == "%" || "$c" == ";" || "$c" == [[:cntrl:]] ]]; then',
  "      printf -v c '%%%02X' \"'$c\"",
  "    fi",
  '    out+="$c"',
  "  done",
  '  REPLY="$out"',
  "}",
  "__ave_precmd() {",
  "  local ave_status=$? ave_keys=emacs ave_paste=0",
  "  printf '\\e]133;D;%s;%s\\a' \"$ave_status\" \"$__ave_nonce\"",
  // How typed text will be read: vi bindings in the main keymap, and whether
  // zle takes bracketed paste (it does unless zle_bracketed_paste is unset).
  '  [[ "$(bindkey -lL main)" == *vi* ]] && ave_keys=vi',
  '  [[ -n "$zle_bracketed_paste" ]] && ave_paste=1',
  '  __ave_encode "$PWD"',
  "  printf '\\e]133;P;Cwd=%s;Keys=%s;Paste=%s;%s\\a\\e]133;A;%s\\a' \"$REPLY\" \"$ave_keys\" \"$ave_paste\" \"$__ave_nonce\" \"$__ave_nonce\"",
  "}",
  "__ave_preexec() {",
  '  __ave_encode "${1[1,' + MAX_ENCODED_COMMAND_CHARS + ']}"',
  "  printf '\\e]133;C;cmdline_url=%s;%s\\a' \"$REPLY\" \"$__ave_nonce\"",
  "}",
  "autoload -Uz add-zsh-hook",
  "add-zsh-hook precmd __ave_precmd",
  "add-zsh-hook preexec __ave_preexec",
  // The prompt names the variable, not its value: `$PS1` never shows the nonce.
  "__ave_b=$'\\e]133;B;'\"${__ave_nonce}\"$'\\a'",
  "setopt prompt_subst",
  "PS1=\"${PS1:-%m%# }\"'%{${__ave_b}%}'",
  "",
].join("\n");

const BASH_PROFILE = (noncePath: string): string => [
  HEADER,
  // Read and delete the nonce file first; a nested shell finds none.
  "__ave_nonce=''",
  "if [ -f " + shellQuoteForRc(noncePath) + " ]; then",
  "  IFS= read -r __ave_nonce < " + shellQuoteForRc(noncePath),
  "  /bin/rm -f -- " + shellQuoteForRc(noncePath),
  "fi",
  "shopt -s interactive_comments",
  '[ -n "$__ave_nonce" ] || return 0',
  "__ave_encode() {",
  '  local LC_ALL=C s="$1" out="" c i',
  "  for (( i = 0; i < ${#s}; i++ )); do",
  '    c="${s:i:1}"',
  '    case "$c" in',
  "      %|\\;|[[:cntrl:]]) printf -v c '%%%02X' \"'$c\" ;;",
  "    esac",
  '    out+="$c"',
  "  done",
  '  REPLY="$out"',
  "}",
  "__ave_at_prompt=0",
  // Bracketed paste (readline 7 / bash 4.4 and later; on by default from
  // bash 5.1): pasted text is inserted, never read as keys. Older bash has
  // none, and reports Paste=0.
  "__ave_paste=0",
  "if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then",
  "  bind 'set enable-bracketed-paste on' 2>/dev/null && __ave_paste=1",
  "fi",
  "__ave_precmd() {",
  "  local ave_status=$? ave_keys=emacs",
  "  printf '\\e]133;D;%s;%s\\a' \"$ave_status\" \"$__ave_nonce\"",
  "  [[ -o vi ]] && ave_keys=vi",
  '  __ave_encode "$PWD"',
  "  printf '\\e]133;P;Cwd=%s;Keys=%s;Paste=%s;%s\\a\\e]133;A;%s\\a' \"$REPLY\" \"$ave_keys\" \"$__ave_paste\" \"$__ave_nonce\" \"$__ave_nonce\"",
  "  __ave_at_prompt=1",
  "}",
  "__ave_preexec() {",
  '  [ "$__ave_at_prompt" = 1 ] || return 0',
  '  [ -n "$COMP_LINE" ] && return 0',
  '  [ "$BASH_COMMAND" = "__ave_precmd" ] && return 0',
  "  __ave_at_prompt=0",
  "  local line",
  '  line="$(HISTTIMEFORMAT= builtin history 1)"',
  '  line="${line#"${line%%[![:space:]]*}"}"',
  '  line="${line#"${line%%[!0-9]*}"}"',
  '  line="${line#"${line%%[![:space:]]*}"}"',
  '  [ -n "$line" ] || line="$BASH_COMMAND"',
  '  __ave_encode "${line:0:' + MAX_ENCODED_COMMAND_CHARS + '}"',
  "  printf '\\e]133;C;cmdline_url=%s;%s\\a' \"$REPLY\" \"$__ave_nonce\"",
  "}",
  'PROMPT_COMMAND="__ave_precmd"',
  // The prompt names the variable, not its value (bash expands variables in
  // PS1 after decoding its escapes, so the variable holds the raw ESC/BEL).
  "__ave_b=$'\\e]133;B;'\"${__ave_nonce}\"$'\\a'",
  "shopt -s promptvars",
  "PS1=\"${PS1:-\\s-\\v\\$ }\"'\\[${__ave_b}\\]'",
  "trap '__ave_preexec' DEBUG",
  "",
].join("\n");

const FISH_CONF = (noncePath: string): string => [
  HEADER,
  "set -g __ave_nonce ''",
  "if test -f " + shellQuoteForRc(noncePath),
  "    read -g __ave_nonce < " + shellQuoteForRc(noncePath),
  "    /bin/rm -f -- " + shellQuoteForRc(noncePath),
  "end",
  'if test -n "$__ave_nonce"',
  "    function __ave_postexec --on-event fish_postexec",
  "        printf '\\e]133;D;%s;%s\\a' $status $__ave_nonce",
  "    end",
  "    function __ave_prompt --on-event fish_prompt",
  "        printf '\\e]133;P;Cwd=%s;%s\\a\\e]133;A;%s\\a' (string escape --style=url -- $PWD) $__ave_nonce $__ave_nonce",
  "    end",
  "    function __ave_preexec --on-event fish_preexec",
  "        printf '\\e]133;C;cmdline_url=%s;%s\\a' (string escape --style=url -- (string sub -l " + MAX_ENCODED_COMMAND_CHARS + " -- $argv[1])) $__ave_nonce",
  "    end",
  "end",
  "",
].join("\n");

/**
 * Write the integration for `shell` into the sandbox HOME and return the
 * environment the shell needs to find it — including the nonce, which the
 * startup file takes out of the environment before the first prompt. Throws on
 * a write failure: the caller decides whether a terminal without markers is
 * acceptable.
 */
export function installShellIntegration(
  homePath: string,
  shellPath: string,
  options: {
    nonce: string;
    /**
     * The environment the shell will run with (the sandbox HOME's). fish
     * reads its startup files from `$XDG_CONFIG_HOME/fish`, so that is where
     * its file goes.
     */
    sandboxEnv: Readonly<Record<string, string>>;
  },
): { shell: IntegratedShell | null; env: Record<string, string> } {
  if (!/^[0-9a-f]{16,}$/u.test(options.nonce)) {
    throw new Error("shell integration nonce must be at least 16 lowercase hex characters");
  }
  const shell = detectIntegratedShell(shellPath);
  const noncePath = join(homePath, SHELL_INTEGRATION_NONCE_FILE);
  // Owner-only, read and deleted by the startup file before the first prompt.
  const writeNonce = (): void => writeFileSync(noncePath, options.nonce, { mode: 0o600 });
  switch (shell) {
    case "zsh":
      writeFileSync(join(homePath, ".zshrc"), ZSH_RC(noncePath), { mode: 0o600 });
      writeNonce();
      // zsh reads its startup files from ZDOTDIR when set; pin it to this HOME
      // so the file just written is the one read.
      return { shell, env: { ZDOTDIR: homePath } };
    case "bash":
      writeFileSync(join(homePath, ".bash_profile"), BASH_PROFILE(noncePath), { mode: 0o600 });
      writeNonce();
      return { shell, env: {} };
    case "fish": {
      const configHome = options.sandboxEnv.XDG_CONFIG_HOME;
      // Without it fish would look in ~/.config, a directory the sandbox
      // refuses writes to — the file would never be read. Fail, not guess.
      if (!configHome) throw new Error("fish shell integration needs XDG_CONFIG_HOME in the sandbox environment");
      const dir = join(configHome, "fish", "conf.d");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "ave-shell-integration.fish"), FISH_CONF(noncePath), { mode: 0o600 });
      writeNonce();
      return { shell, env: {} };
    }
    default:
      // No startup file reads the nonce, so none is written.
      return { shell: null, env: {} };
  }
}
