/**
 * shell-integration.ts — OSC 133 command markers for the interactive terminal.
 *
 * Every terminal runs with its own throwaway sandbox HOME (pty-manager), so the
 * user's real startup files are never read. That HOME is where the integration
 * goes: one startup file for the login shell, written before the shell starts.
 * Nothing outside the sandbox HOME is touched and no startup-injection
 * environment variable is used.
 *
 * Each shell reports, around every command it runs:
 *   OSC 133;D;<exit>  the previous command finished (first prompt: nothing open)
 *   OSC 7 file://…    the working directory
 *   OSC 133;A         prompt start
 *   OSC 133;B         end of prompt / start of typed input (zsh, bash)
 *   OSC 133;C;cmdline_url=<percent-encoded command>  output starts
 *
 * The command text is percent-encoded so it can never carry the BEL / ESC that
 * would end the marker, or the `;` that separates its fields. zsh and bash
 * encode `%`, `;` and control characters and pass other characters through;
 * fish uses its URL escaping. terminal-blocks.ts decodes both.
 *
 * A shell not listed here gets no file and falls back to the Enter-split
 * heuristic in terminal-blocks.ts.
 *
 * The scripts are plain line arrays (no template literals) so shell `${…}`
 * expansions are never mistaken for JavaScript interpolation.
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

const ZSH_RC = [
  HEADER,
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
  "  printf '\\e]133;D;%s\\a\\e]7;file://%s%s\\a\\e]133;A\\a' \"$ave_status\" \"$HOST\" \"$PWD\"",
  "}",
  "__ave_preexec() {",
  '  __ave_encode "$1"',
  "  printf '\\e]133;C;cmdline_url=%s\\a' \"$REPLY\"",
  "}",
  "autoload -Uz add-zsh-hook",
  "add-zsh-hook precmd __ave_precmd",
  "add-zsh-hook preexec __ave_preexec",
  "PS1=\"${PS1:-%m%# }%{\"$'\\e]133;B\\a'\"%}\"",
  "",
].join("\n");

const BASH_PROFILE = [
  HEADER,
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
  "  printf '\\e]133;D;%s\\a\\e]7;file://%s%s\\a\\e]133;A\\a' \"$ave_status\" \"$HOSTNAME\" \"$PWD\"",
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
  '  __ave_encode "$line"',
  "  printf '\\e]133;C;cmdline_url=%s\\a' \"$REPLY\"",
  "}",
  'PROMPT_COMMAND="__ave_precmd"',
  "PS1=\"${PS1:-\\s-\\v\\$ }\\[\\e]133;B\\a\\]\"",
  "trap '__ave_preexec' DEBUG",
  "",
].join("\n");

const FISH_CONF = [
  HEADER,
  "function __ave_postexec --on-event fish_postexec",
  "    printf '\\e]133;D;%s\\a' $status",
  "end",
  "function __ave_prompt --on-event fish_prompt",
  "    printf '\\e]7;file://%s%s\\a\\e]133;A\\a' $hostname (string escape --style=url -- $PWD)",
  "end",
  "function __ave_preexec --on-event fish_preexec",
  "    printf '\\e]133;C;cmdline_url=%s\\a' (string escape --style=url -- $argv[1])",
  "end",
  "",
].join("\n");

/**
 * Write the integration for `shell` into the sandbox HOME and return the
 * environment the shell needs to find it. Throws on a write failure: the
 * caller decides whether a terminal without markers is acceptable.
 */
export function installShellIntegration(
  homePath: string,
  shellPath: string,
): { shell: IntegratedShell | null; env: Record<string, string> } {
  const shell = detectIntegratedShell(shellPath);
  switch (shell) {
    case "zsh":
      writeFileSync(join(homePath, ".zshrc"), ZSH_RC, { mode: 0o600 });
      // zsh reads its startup files from ZDOTDIR when set; pin it to this HOME
      // so the file just written is the one read.
      return { shell, env: { ZDOTDIR: homePath } };
    case "bash":
      writeFileSync(join(homePath, ".bash_profile"), BASH_PROFILE, { mode: 0o600 });
      return { shell, env: {} };
    case "fish": {
      const dir = join(homePath, "config", "fish", "conf.d");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "ave-shell-integration.fish"), FISH_CONF, { mode: 0o600 });
      return { shell, env: {} };
    }
    default:
      return { shell: null, env: {} };
  }
}
