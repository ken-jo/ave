// Per-terminal startup files live only in the disposable sandbox HOME; user startup files are never read.
// OSC 133 grammar, terminated by BEL or ST; n is the terminal nonce:
// D;<exit>;<n> finishes a command; A;<n> starts a prompt; C;cmdline_url=<encoded>;<n> starts output.
// P;Cwd=<encoded>;Keys=<emacs|vi>;Paste=<0|1>;NotFound=<0|1>;Edit=<0|1>;B=<token>;Pid=<pid>;<n> reports prompt state.
// B;<token> marks prompt end; E;Line=<encoded>;B=<token>;<n> reports the editor buffer privately.
// Nonce-bearing markers prevent output from forging blocks; load the nonce from an owner-only file, not the readable initial environment.
// Delete that file before the first prompt and keep the nonce unexported; hooks print authenticated markers only to the terminal.
// B uses a fresh prompt token announced by authenticated P because prompt expansion can expose the prompt string.
// Accept B only at its current prompt; refuse shell-state expansion so a command cannot learn a usable prompt token.
// Pid binds markers to the OS-observed shell; zsh disables Paste with a right-hand prompt because its redraw looks like typed input.
// Percent-encode control characters, percent signs, and semicolons; cap command text at 4096 characters.
// Unknown shells use Enter-split heuristics; line arrays keep shell expansions out of JavaScript interpolation.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type IntegratedShell = "zsh" | "bash" | "fish";

export function detectIntegratedShell(shellPath: string): IntegratedShell | null {
  const name = basename(shellPath).replace(/^-/u, "");
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  return null;
}

// A path as one single-quoted word for the startup files.
function shellQuoteForRc(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

const HEADER = "# Ave terminal shell integration (generated; this HOME is discarded when the terminal closes).";

// File in the sandbox HOME that hands the nonce to the startup file, which reads it into an unexported shell variable and deletes it before anything
// else runs. Nothing the shell later starts can find it: not in the environment, not on disk.
export const SHELL_INTEGRATION_NONCE_FILE = ".ave-terminal-nonce";

// Private line-editor query; send only after the current prompt attests its binding.
export const TERMINAL_EDIT_LINE_QUERY = "\u0018\u0016";

// Characters of command text a script encodes into its C marker.
const MAX_ENCODED_COMMAND_CHARS = 4096;

// Read the nonce file into an unexported shell variable and delete it; a nested shell finds none.
export function shellNoncePrologue(shell: "zsh" | "bash", noncePath: string): string {
  return (shell === "zsh" ? [
    "__ave_nonce=''",
    "if [[ -f " + shellQuoteForRc(noncePath) + " ]]; then",
    "  __ave_nonce=\"$(<" + shellQuoteForRc(noncePath) + ")\"",
    "  /bin/rm -f -- " + shellQuoteForRc(noncePath),
    "fi",
  ] : [
    "__ave_nonce=''",
    "if [ -f " + shellQuoteForRc(noncePath) + " ]; then",
    "  IFS= read -r __ave_nonce < " + shellQuoteForRc(noncePath),
    "  /bin/rm -f -- " + shellQuoteForRc(noncePath),
    "fi",
  ]).join("\n");
}

// `noncePath` null: the caller's prologue already holds the nonce in `__ave_nonce`.
const ZSH_RC = (noncePath: string | null): string => [
  HEADER,
  ...(noncePath === null ? [] : [shellNoncePrologue("zsh", noncePath)]),
  // `#` starts a comment, as in bash: the permission rules read a typed command as bash, and without this option zsh runs the text after `#`. Set before
  // anything can return, so every shell of the terminal has it.
  "setopt interactivecomments",
  // A nested shell (or one started without the variable) has no nonce: it emits no markers rather than markers the tracker would reject.
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
  "__ave_report_edit_line() {",
  "  emulate -L zsh",
  "  local REPLY",
  '  [[ -n "$__ave_prompt_token" ]] || return 0',
  "  (( ${#BUFFER} <= " + MAX_ENCODED_COMMAND_CHARS + " )) || return 0",
  '  __ave_encode "$BUFFER"',
  "  printf '\\e]133;E;Line=%s;B=%s;%s\\a' \"$REPLY\" \"$__ave_prompt_token\" \"$__ave_nonce\"",
  "}",
  "__ave_edit_handler=\"${functions[__ave_report_edit_line]}\"",
  ...(process.platform === "darwin" ? [
    "__ave_rearm_interrupt() {",
    "  emulate -L zsh",
    "  local ave_traps",
    // A synchronous pipeline preserves the producer's traps; a command substitution would discard command-list and ignored traps. Require the complete dump,
    // including its delimiter, before resetting.
    "  { builtin trap && builtin printf '\\0'; } | IFS= builtin read -r -d '' ave_traps",
    "  if (( pipestatus[1] == 0 && pipestatus[2] == 0 )) && [[ -z \"$ave_traps\" ]]; then builtin trap - INT; fi",
    "}",
  ] : []),
  "__ave_precmd() {",
  "  local ave_status=$? ave_keys=emacs ave_paste=0 ave_not_found=0 ave_edit=0 ave_token",
  "  printf '\\e]133;D;%s;%s\\a' \"$ave_status\" \"$__ave_nonce\"",
  // A command-not-found handler runs code for any word that is not a command.
  "  (( ${+functions[command_not_found_handler]} )) && ave_not_found=1",
  // How typed text will be read: vi bindings in the main keymap, and whether zle takes bracketed paste as plain text: zle_bracketed_paste set, and the
  // paste and self-insert widgets still the builtins (bracketed-paste-magic or url-quote-magic would rewrite what is pasted).
  '  [[ "$(bindkey -lL main)" == *vi* ]] && ave_keys=vi',
  '  [[ -n "$zle_bracketed_paste" && "${widgets[bracketed-paste]}" == builtin && "${widgets[self-insert]}" == builtin ]] && ave_paste=1',
  // A right-hand prompt is drawn after B, where it would read as typing.
  '  [[ -n "${RPROMPT}${RPS1}" ]] && ave_paste=0',
  '  [[ "$ave_keys" == emacs && "$(bindkey -M main \'^X^V\' 2>/dev/null)" == \'"^X^V" __ave_report_edit_line\' && "${widgets[__ave_report_edit_line]}" == user:__ave_report_edit_line && "${functions[__ave_report_edit_line]}" == "$__ave_edit_handler" ]] && ave_edit=1',
  // A fresh token for this prompt's B, which the prompt string prints.
  '  ave_token="$(/usr/bin/od -An -N16 -tx1 /dev/urandom 2>/dev/null)"',
  '  ave_token="${ave_token//[^0-9a-f]/}"',
  '  __ave_prompt_token="$ave_token"',
  "  __ave_b=$'\\e]133;B;'\"$ave_token\"$'\\a'",
  '  __ave_encode "$PWD"',
  // A child wait can leave SIGINT blocked on this platform. Resetting its default handler also unblocks it. Never replace a configured trap, and finish
  // all child waits before rearming delivery and advertising readiness.
  ...(process.platform === "darwin" ? [
    "  __ave_rearm_interrupt",
  ] : []),
  "  printf '\\e]133;P;Cwd=%s;Keys=%s;Paste=%s;NotFound=%s;Edit=%s;B=%s;Pid=%s;%s\\a\\e]133;A;%s\\a' \"$REPLY\" \"$ave_keys\" \"$ave_paste\" \"$ave_not_found\" \"$ave_edit\" \"$ave_token\" \"$$\" \"$__ave_nonce\" \"$__ave_nonce\"",
  "}",
  "__ave_preexec() {",
  '  __ave_encode "${1[1,' + MAX_ENCODED_COMMAND_CHARS + ']}"',
  "  printf '\\e]133;C;cmdline_url=%s;%s\\a' \"$REPLY\" \"$__ave_nonce\"",
  "}",
  "autoload -Uz add-zsh-hook",
  "add-zsh-hook precmd __ave_precmd",
  "add-zsh-hook preexec __ave_preexec",
  "zmodload zsh/zleparameter",
  "zle -N __ave_report_edit_line",
  "bindkey -M main '^X^V' __ave_report_edit_line",
  // The prompt prints the B marker of the moment (set by the hook above).
  "__ave_b=''",
  "setopt prompt_subst",
  "PS1=\"${PS1:-%m%# }\"'%{${__ave_b}%}'",
  "",
].join("\n");

const BASH_PROFILE = (noncePath: string | null): string => [
  HEADER,
  ...(noncePath === null ? [] : [shellNoncePrologue("bash", noncePath)]),
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
  "__ave_report_edit_line() {",
  "  local REPLY",
  '  [[ -n "$__ave_prompt_token" ]] || return 0',
  "  (( ${#READLINE_LINE} <= " + MAX_ENCODED_COMMAND_CHARS + " )) || return 0",
  '  __ave_encode "$READLINE_LINE"',
  "  printf '\\e]133;E;Line=%s;B=%s;%s\\a' \"$REPLY\" \"$__ave_prompt_token\" \"$__ave_nonce\"",
  "}",
  '__ave_edit_handler="$(declare -f __ave_report_edit_line)"',
  "__ave_at_prompt=0",
  // Bracketed paste (readline 7 / bash 4.4 and later; on by default from bash 5.1): pasted text is inserted, never read as keys. Older bash has none, and reports Paste=0.
  "__ave_paste=0",
  "if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then",
  "  bind 'set enable-bracketed-paste on' 2>/dev/null && __ave_paste=1",
  "fi",
  "__ave_precmd() {",
  "  local ave_status=$? ave_keys=emacs ave_paste=0 ave_not_found=0 ave_edit=0 ave_keymap=0 ave_token ave_binding",
  "  printf '\\e]133;D;%s;%s\\a' \"$ave_status\" \"$__ave_nonce\"",
  "  [[ -o vi ]] && ave_keys=vi",
  // A command-not-found handler (Ubuntu's /etc/bash.bashrc defines one) runs code for any word that is not a command.
  "  declare -F command_not_found_handle >/dev/null && ave_not_found=1",
  // Bracketed paste as readline has it now (a user can turn it off by hand).
  '  [[ "$__ave_paste" = 1 && "$(bind -v)" == *"enable-bracketed-paste on"* ]] && ave_paste=1',
  '  while IFS= read -r ave_binding; do',
  '    [[ "$ave_binding" == "set keymap emacs" || "$ave_binding" == "set keymap emacs-standard" ]] && ave_keymap=1',
  '  done < <(builtin bind -v 2>/dev/null)',
  // Loading a keymap file can leave its command registry stale. Reserve this private key anew before reading back the installed callback.
  '  if [[ "$ave_keys" == emacs && "$ave_keymap" == 1 && "$__ave_paste" == 1 && "$(declare -f __ave_report_edit_line)" == "$__ave_edit_handler" ]] && ! alias __ave_report_edit_line >/dev/null 2>&1 && builtin bind -m emacs-standard -x \'"\\C-x\\C-v":__ave_report_edit_line\' 2>/dev/null; then',
  '    while IFS= read -r ave_binding; do',
  '      [[ "$ave_binding" == \'"\\C-x\\C-v": "__ave_report_edit_line"\' || "$ave_binding" == \'"\\C-x\\C-v" "__ave_report_edit_line"\' ]] && ave_edit=1',
  '    done < <(builtin bind -m emacs-standard -X 2>/dev/null)',
  "  fi",
  // A fresh token for this prompt's B, which the prompt string prints.
  '  ave_token="$(/usr/bin/od -An -N16 -tx1 /dev/urandom 2>/dev/null)"',
  '  ave_token="${ave_token//[^0-9a-f]/}"',
  '  __ave_prompt_token="$ave_token"',
  "  __ave_b=$'\\e]133;B;'\"$ave_token\"$'\\a'",
  '  __ave_encode "$PWD"',
  "  printf '\\e]133;P;Cwd=%s;Keys=%s;Paste=%s;NotFound=%s;Edit=%s;B=%s;Pid=%s;%s\\a\\e]133;A;%s\\a' \"$REPLY\" \"$ave_keys\" \"$ave_paste\" \"$ave_not_found\" \"$ave_edit\" \"$ave_token\" \"$$\" \"$__ave_nonce\" \"$__ave_nonce\"",
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
  // The prompt prints the B marker of the moment, set by the hook above (bash expands variables in PS1 after decoding its escapes, so the variable holds the raw ESC/BEL).
  "__ave_b=''",
  "shopt -s promptvars",
  "PS1=\"${PS1:-\\s-\\v\\$ }\"'\\[${__ave_b}\\]'",
  // Bash PS0 emits authenticated command markers outside command redirections; DEBUG traps can leak them into files.
  // Older shells keep the trap for human typing but are refused by terminal_run.
  "if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then",
  "  PS0='$(__ave_preexec)'",
  "else",
  "  trap '__ave_preexec' DEBUG",
  "fi",
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

// Write only inside the sandbox HOME and propagate failures; the caller decides whether a terminal without markers is acceptable.
export function installShellIntegration(
  homePath: string,
  shellPath: string,
  options: {
    nonce: string;
    // The environment the shell will run with (the sandbox HOME's). fish reads its startup files from `$XDG_CONFIG_HOME/fish`, so that is where its file goes.
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
      // Global completion setup precedes .zshrc and can wait for approval of host completion paths. This isolated HOME owns its completion setup.
      writeFileSync(join(homePath, ".zshenv"), HEADER + "\nskip_global_compinit=1\n", { mode: 0o600 });
      writeFileSync(join(homePath, ".zshrc"), ZSH_RC(noncePath), { mode: 0o600 });
      writeNonce();
      // zsh reads its startup files from ZDOTDIR when set; pin it to this HOME so the file just written is the one read.
      return { shell, env: { ZDOTDIR: homePath } };
    case "bash":
      writeFileSync(join(homePath, ".bash_profile"), BASH_PROFILE(noncePath), { mode: 0o600 });
      writeNonce();
      return { shell, env: {} };
    case "fish": {
      const configHome = options.sandboxEnv.XDG_CONFIG_HOME;
      // Without it fish would look in ~/.config, a directory the sandbox refuses writes to — the file would never be read. Fail, not guess.
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

// Host wrappers retain user callbacks while capturing command status before those callbacks run.
// The wrapper's first startup step has already moved the nonce into `__ave_nonce` (see shellNoncePrologue), before any user file ran.
export function generateHostShellHooks(shell: "zsh" | "bash"): string {
  const hooks = (shell === "zsh" ? ZSH_RC(null) : BASH_PROFILE(null))
    .replace(HEADER, "# Generated authenticated terminal hooks.")
    .replace("local ave_status=$?", 'local ave_status="$__ave_command_status"');
  if (shell === "zsh") {
    return hooks.replace("add-zsh-hook precmd __ave_precmd", [
      "__ave_command_status=0",
      // The single precmd function runs before precmd_functions, so capture at that boundary.
      'if (( ${+functions[precmd]} )); then functions[__ave_user_precmd]="$functions[precmd]"; fi',
      '__ave_return_status() { return "$__ave_command_status"; }',
      "precmd() {",
      "  __ave_command_status=$?",
      '  if (( ${+functions[__ave_user_precmd]} )); then __ave_return_status; __ave_user_precmd "$@"; else return "$__ave_command_status"; fi',
      "}",
      "add-zsh-hook precmd __ave_precmd",
    ].join("\n"));
  }
  return hooks
    .replace('PROMPT_COMMAND="__ave_precmd"', [
      "__ave_command_status=0",
      '__ave_capture_status() { __ave_command_status=$?; return "$__ave_command_status"; }',
      'PROMPT_COMMAND=(__ave_capture_status "${PROMPT_COMMAND[@]}" __ave_precmd)',
    ].join("\n"))
    .replace("PS0='$(__ave_preexec)'", "PS0=\"${PS0-}\"'$(__ave_preexec)'")
    // Older interpreters retain the user's DEBUG trap and have no authenticated command-start claim.
    .replace("  trap '__ave_preexec' DEBUG", "  :");
}

/** A PowerShell single-quoted string literal: only `'` (and its typographic variants) is special, doubled. */
export function powerShellQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/gu, "$&$&")}'`;
}

/** The first step of a pwsh host terminal, before any user profile runs: take the nonce into a global variable, delete its file. */
export function pwshNoncePrologue(noncePath: string): string {
  const path = powerShellQuote(noncePath);
  return [
    "$global:__ave_nonce = ''",
    `if (Test-Path -LiteralPath ${path} -PathType Leaf) {`,
    `  $global:__ave_nonce = ([System.IO.File]::ReadAllText(${path})).Trim()`,
    `  Remove-Item -LiteralPath ${path} -Force`,
    "}",
  ].join("\n");
}

/** Dot-source the user's profiles in PowerShell's own order, in the global scope, as a launch without -NoProfile would. */
export const PWSH_PROFILE_STARTUP = [
  "foreach ($__ave_profile in @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)) {",
  "  if ($__ave_profile -and (Test-Path -LiteralPath $__ave_profile -PathType Leaf)) { . $__ave_profile }",
  "}",
  "Remove-Variable -Name __ave_profile -Scope Global -ErrorAction SilentlyContinue",
].join("\n");

/** pwsh prompt hooks: authenticated D, P (cwd, edit mode, Paste=0, Pid, prompt token), A and B around the user's own prompt, and C from the Enter
 * key while Enter is still PSReadLine's AcceptLine. PSReadLine documents no bracketed paste, so the prompt always reports Paste=0 and agent typing
 * refuses it (`no-bracketed-paste`); markers still attest prompts, directories and exits for the user's own command blocks. */
export function generatePwshHostHooks(): string {
  return [
    "if (-not $global:__ave_nonce) { return }",
    "function global:__ave_encode([string]$text) {",
    "  $out = [System.Text.StringBuilder]::new()",
    "  foreach ($c in $text.ToCharArray()) {",
    "    $code = [int]$c",
    "    if ($c -eq '%' -or $c -eq ';' -or $code -lt 32 -or $code -eq 127) { [void]$out.Append(('%{0:X2}' -f $code)) } else { [void]$out.Append($c) }",
    "  }",
    "  $out.ToString()",
    "}",
    "$global:__ave_user_prompt = $function:prompt",
    "function global:prompt {",
    "  $ok = $?",
    "  $code = $global:LASTEXITCODE",
    "  $e = [char]27; $bel = [char]7; $n = $global:__ave_nonce",
    "  $status = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }",
    "  $bytes = [byte[]]::new(16)",
    "  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)",
    "  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })",
    "  $keys = 'emacs'",
    "  try { if ((Get-PSReadLineOption).EditMode -eq 'Vi') { $keys = 'vi' } } catch { }",
    "  $cwd = __ave_encode $executionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath",
    "  $head = \"$e]133;D;$status;$n$bel$e]133;P;Cwd=$cwd;Keys=$keys;Paste=0;NotFound=0;Edit=0;B=$token;Pid=$PID;$n$bel$e]133;A;$n$bel\"",
    "  $user = if ($global:__ave_user_prompt) { & $global:__ave_user_prompt } else { \"PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) \" }",
    "  $global:LASTEXITCODE = $code",
    "  \"$head$user$e]133;B;$token$bel\"",
    "}",
    "try {",
    "  if ((Get-PSReadLineKeyHandler -Chord Enter -ErrorAction Stop).Function -eq 'AcceptLine') {",
    "    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {",
    "      $line = $null; $cursor = $null",
    "      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)",
    `      $text = if ($line.Length -gt ${MAX_ENCODED_COMMAND_CHARS}) { $line.Substring(0, ${MAX_ENCODED_COMMAND_CHARS}) } else { $line }`,
    "      [Console]::Write(\"$([char]27)]133;C;cmdline_url=$(__ave_encode $text);$global:__ave_nonce$([char]7)\")",
    "      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()",
    "    }",
    "  }",
    "} catch { }",
  ].join("\n");
}
