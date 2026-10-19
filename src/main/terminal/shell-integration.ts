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
 *   OSC 133;P;Cwd=<encoded path>;<n>  the working directory
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
 * last field equals the nonce, and never trusts OSC 7). Like VS Code the nonce
 * arrives in an environment variable that the startup file copies into an
 * unexported shell variable and unsets at once — it is not written into the
 * file, which the shell can read. Unlike VS Code, where only E and P carry it,
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

const HEADER = "# Ave terminal shell integration (generated; this HOME is discarded when the terminal closes).";

/**
 * Environment variable that hands the nonce to the startup file. Each script
 * copies it into an unexported shell variable and unsets it before anything
 * else runs, so no command the user starts inherits it.
 */
const SHELL_INTEGRATION_NONCE_ENV = "AVE_TERMINAL_NONCE";

/** Characters of command text a script encodes into its C marker. */
const MAX_ENCODED_COMMAND_CHARS = 4096;

const ZSH_RC = [
  HEADER,
  '__ave_nonce="$' + SHELL_INTEGRATION_NONCE_ENV + '"',
  'unset ' + SHELL_INTEGRATION_NONCE_ENV,
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
  "  local ave_status=$?",
  "  printf '\\e]133;D;%s;%s\\a' \"$ave_status\" \"$__ave_nonce\"",
  '  __ave_encode "$PWD"',
  "  printf '\\e]133;P;Cwd=%s;%s\\a\\e]133;A;%s\\a' \"$REPLY\" \"$__ave_nonce\" \"$__ave_nonce\"",
  "}",
  "__ave_preexec() {",
  '  __ave_encode "${1[1,' + MAX_ENCODED_COMMAND_CHARS + ']}"',
  "  printf '\\e]133;C;cmdline_url=%s;%s\\a' \"$REPLY\" \"$__ave_nonce\"",
  "}",
  "autoload -Uz add-zsh-hook",
  "add-zsh-hook precmd __ave_precmd",
  "add-zsh-hook preexec __ave_preexec",
  "PS1=\"${PS1:-%m%# }%{\"$'\\e]133;B;'\"${__ave_nonce}\"$'\\a'\"%}\"",
  "",
].join("\n");

const BASH_PROFILE = [
  HEADER,
  '__ave_nonce="$' + SHELL_INTEGRATION_NONCE_ENV + '"',
  'unset ' + SHELL_INTEGRATION_NONCE_ENV,
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
  "__ave_precmd() {",
  "  local ave_status=$?",
  "  printf '\\e]133;D;%s;%s\\a' \"$ave_status\" \"$__ave_nonce\"",
  '  __ave_encode "$PWD"',
  "  printf '\\e]133;P;Cwd=%s;%s\\a\\e]133;A;%s\\a' \"$REPLY\" \"$__ave_nonce\" \"$__ave_nonce\"",
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
  "PS1=\"${PS1:-\\s-\\v\\$ }\\[\\e]133;B;${__ave_nonce}\\a\\]\"",
  "trap '__ave_preexec' DEBUG",
  "",
].join("\n");

const FISH_CONF = [
  HEADER,
  'if set -q ' + SHELL_INTEGRATION_NONCE_ENV + '; and test -n "$' + SHELL_INTEGRATION_NONCE_ENV + '"',
  '    set -g __ave_nonce $' + SHELL_INTEGRATION_NONCE_ENV,
  '    set -e ' + SHELL_INTEGRATION_NONCE_ENV,
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
  const nonceEnv = { [SHELL_INTEGRATION_NONCE_ENV]: options.nonce };
  const shell = detectIntegratedShell(shellPath);
  switch (shell) {
    case "zsh":
      writeFileSync(join(homePath, ".zshrc"), ZSH_RC, { mode: 0o600 });
      // zsh reads its startup files from ZDOTDIR when set; pin it to this HOME
      // so the file just written is the one read.
      return { shell, env: { ZDOTDIR: homePath, ...nonceEnv } };
    case "bash":
      writeFileSync(join(homePath, ".bash_profile"), BASH_PROFILE, { mode: 0o600 });
      return { shell, env: nonceEnv };
    case "fish": {
      const configHome = options.sandboxEnv.XDG_CONFIG_HOME;
      // Without it fish would look in ~/.config, a directory the sandbox
      // refuses writes to — the file would never be read. Fail, not guess.
      if (!configHome) throw new Error("fish shell integration needs XDG_CONFIG_HOME in the sandbox environment");
      const dir = join(configHome, "fish", "conf.d");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "ave-shell-integration.fish"), FISH_CONF, { mode: 0o600 });
      return { shell, env: nonceEnv };
    }
    default:
      // No startup file reads the nonce, so it is not handed to the shell.
      return { shell: null, env: {} };
  }
}
