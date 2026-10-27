# Permissions: always-allow baseline and judge slot

Status: decided 2026-10-14 (issue #28). P1a, the approval rules UI (P1b), the P2 judge call site and scoped file, network and MCP rule enforcement (P1c) are implemented. The out-of-directory depth picker remains a UI integration task.

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
| `Bash(<prefix> *)` / `PowerShell(<prefix> *)` | every `static-complete` command of that dialect whose literal argv starts with the prefix words, including the bare prefix |
| `Bash(<exact>)` / `PowerShell(<exact>)` | exactly the original raw words of that dialect; quote style, raw content and program spelling remain part of the key |
| `Edit(<path-glob>)` | absolute or project-relative path, using `*`, `**`, and `?`; trailing `/**` also covers the directory itself |
| `WebFetch(domain:<host>[:port])` / `WebFetch(domain:*.<host>[:port])` | exact host, or strict subdomains; omitted port covers all ports |
| `Mcp(<server>)` / `Mcp(<server>:<tool>)` | every tool of a server, or one tool |

- Parsing is strict: anything outside the grammar throws.
- Shell rule storage normalizes only interword whitespace. Complete raw program and argument words retain module names, paths, casing and quotes without any head normalization.
- Legacy Store A glob patterns (`web_fetch`, `write_file:path:/abs`) never start with `Name(`. They are classified by shape and keep their glob semantics unchanged.

**2. Shell decision order.** A current-format exact shell allow rule for an eligible command authorizes execution outside the sandbox. An unsandboxed command over 2,000 characters immediately asks at L6 or denies headless before parsing, project loading, command rules, floors or review. For inputs within the limit, the host evaluates the actual per-invocation execution plan:

1. Explicit deny rules deny. The destructive/irreversible and visible sensitive-path floors require authenticated user consent on every invocation, inside or outside the sandbox; the reviewer cannot approve them. Visible credential and upload floors have the same behavior.
2. Explicit ask rules ask. Within-cap syntax refusal, unknown or incompletely consumed argv grammar, and runtime dependence also ask at L2 in the foreground and deny headless. A Lane B input-length or structural-cap refusal reached before static analysis follows the ordinary unsandboxed L6 ask and denies headless. No broad rule, mode or reviewer repairs either result.
3. A `static-complete` command that will actually run sandboxed follows the sandboxed route without asking.
4. A command that will run outside the sandbox runs unasked only on a current-format exact `Bash(<command>)` or `PowerShell(<command>)` allow rule of the same dialect (user, project or This session). With that rule, foreground and headless requests allow at layer 3. Without it, foreground asks in every mode and headless denies and audits. This includes sandbox-off/unavailable execution, excluded commands, an unsandboxed retry and the Windows Plan B. The reviewer and judge are not consulted for it.
5. A single outer command whose registered evaluator grammar consumes every option and operand and identifies a fully literal payload may use that current-format exact rule even though its static result is `unproven`. Without the exact rule it asks at L2 or denies headless, including on the sandboxed route.
6. Prefix rules never authorize an unsandboxed or literal-evaluation command. They apply only to `static-complete` sandboxed commands, whose foreground and headless requests follow the normal sandbox route. Stored prefixes remain visible and revocable, and still match as deny and ask rules.

Store A action-key rules and remembered dock grants are not current-format exact shell rules, so they do not authorize a plain-shell invocation; broad tool or glob allows never did. An unedited remembering choice defaults to the host-derived exact rule for its dialect, at session, project or user scope. An edited prefix remains sandbox-only and still requires a complete positive argument proof for the live request.

Deny wins over every allow, regardless of specificity or scope. Existing strict-mode and untrusted-origin gates remain before automatic lanes. A session approval never changes the execution plan or switches off the sandbox for later commands. Unsandboxed calls do not consume session or persistent exact-tuple approval memory from Store B: each retry asks afresh unless covered by a current-format exact shell rule.

The [shell classification contract](../architecture/permission-policy-design.md#shell-credential-and-sink-classification)
retains the 2,000-character Lane B cap and refuses incomplete analysis,
nonliteral words and ambiguous raw-word recovery. A simple literal invocation
through an external file, stdin or network content remains an accepted
indirection limit only when a registered grammar consumes the known outer command and every
literal operand; this does not prove the invoked effects. Runtime argv producers such
as `xargs` remain `unproven`. A literal evaluation payload uses only the narrow
current-format exact-rule exception and is not generally `static-complete`.

The PowerShell exclusion examines every semantic word across the whole command,
including a linear lexical scan of literal quoted word interiors. Once a
recognized launcher word is seen, every later token must pass a
positive character proof after shell quote removal: every code point is a
Unicode letter, number, punctuation, symbol, or U+0020 ASCII space. Other
separators, controls, combining marks and unassigned code points are unproven;
Hangul letters remain literal. Only validated tokens receive the deliberate
e-prefix overmatch: remove leading `-`, `/`, U+2013/U+2014/U+2015 and
lowercase; an e-leading result is unproven, including `ExecutionPolicy`.
No argument-binder whitespace emulation is used. The check never stops at
`-File`, `--`, pipelines, sequences or quoted separators, requires no
operand, and uses no wrapper list or recursive dialect parser. Module/basename,
executable-extension and case normalization are detection-only; raw keys remain
unchanged.
Literal display decoding remains presentation-only.

**Shell rule format.** Fresh shell allows, including session rules, record
`shellRuleVersion: 1` (`SHELL_RULE_CANONICAL_VERSION` in
`src/shared/shell-rule-version.ts`). Unversioned or wrong-version Bash and
PowerShell allows remain silently inert in all scopes. Reads and unrelated
writes preserve them without stamping a current version. There is no
migration, new error or UI marker. Deny and ask rules retain their narrowing
behavior regardless of version. A fresh user-authored current-format rule is
required to grant authority; lost quote provenance is not reconstructed.

**The approval card (owner decision 2026-10-25, unified approval card).** Every approval card draws one shared row: Deny ▾ | Allow for session ▾ | Allow once. Always deny is in the Deny dropdown; Allow for session, Always allow in this project and Always allow everywhere are in the allow dropdown. Selecting a choice shows the rule it saves and an Edit rule button above the row. On a shell card each remembering choice saves a rule: Always deny a user-global deny rule (the command's literal argv unless edited), the allows a session, project or user-global allow rule (the host-derived exact rule unless edited). The renderer sends `{ action, scope }` and, only when edited, `pattern`. The host validates an edited rule against the card's grammar and requires it to decide the live request, failing clearly otherwise. An allow edited into a wildcard is saved with a warning that it applies only to sandboxed runs; the exact-only rule for unsandboxed execution is unchanged. A network card's Always deny saves a `Network(<host>[:<port>])` deny rule, and its edited allows save `Network(...)` allow rules; unedited allows keep the grant of that lifetime. An exact tool approval maps the allows onto Store B session, project and user-global (`global`, owner decision 2026-10-25: Always allow everywhere) records and Always deny onto an exact deny, edited in Settings; any deny beats any allow, and among allows the conversation, then the project, then the global entry is consulted. Where the host records no exact decision for a request (`exactRecordAllowed: false`), Always deny is shown disabled with the one-shot reason. A folder card's lasting allow reads "Always allow this folder".

For shell rule subjects, the permission layer consumes one host-only input, `shellExecution: { runsSandboxed }`. The host invocation authorization pipeline derives this input for native shells from the sealed execution plan; the sandbox producer can supply its per-invocation answer at this single boundary. Whether a sandbox is active for other commands no longer matters (unsandboxed shell exact-rule requirement). Terminal commands carry an explicit plain route. A missing route is also treated as plain. Shell input receives destructive and sensitive-path inspection only within its lane's character, data and total-token limits. Unsandboxed input over 2,000 characters asks at L6 or denies headless before inspection; sandboxed input over its envelope/heredoc bounds requires modal approval. Exceeding the global 400 executable word/value records stops analysis and returns Lane B ask/L6 or headless deny, or Lane A modal/L2. The dock never infers sandboxed execution from missing plan evidence. After mandatory human approval floors are satisfied, native fallback execution still requires a one-use, exact-action permit, minted from either authenticated user consent or the completed host policy/reviewer decision.

**3. Shell command-rule matching** consumes the original typed parse and the
static result defined by [Shell Credential And Sink Classification](../architecture/permission-policy-design.md#shell-credential-and-sink-classification).
- Exact keys preserve every raw word, including quotes and program spelling;
  only whitespace between words is canonicalized.
- `static-complete` requires a registered grammar to consume the command name
  and every argument. An unknown command, unknown option, missing operand,
  unsupported form or unconsumed argument is `unproven`; literal syntax alone
  is not proof.
- A parse or lexer refusal, exceeded structural cap, dynamic program or operand,
  substitution, splat, loop, callback, generated string, runtime argv or prior
  state dependency is also `unproven` and matches no allow rule. Only the
  positively parsed literal-evaluation case below may use a current-format
  exact rule; a cap refusal never may.
- Wrappers and runners remain part of rule identity. An inner-only rule cannot
  authorize the outer command.
- Deny and ask rules retain their narrowing authority. A visible floor and the
  independent execution gates still take precedence over every allow.

**4. Prefix suggestions and validation.** `BANNED_PREFIX_SUGGESTIONS` in `src/permissions/rules/shell-prefix-values.ts` owns the broad-prefix refusals shared by the dock and the store. Program identities are normalized by basename and interpreter-version suffix for that refusal check only; exact rule keys remain raw. A banned vector followed only by switches or assignment bindings remains broad, so interpreter entry points and inline-code modes are refused wildcard prefixes. A positively proven exact command may name an otherwise broad program; an unknown command or argument form cannot. Empty prefixes remain refused; identified destructive/irreversible commands are refused as both exact and prefix allow rules. Deny and ask rules may still name them.

The default suggestion is an exact rule for the complete raw command only after
the positive argv proof succeeds. A wider prefix requires an explicit edit and
must pass the same refusal check. The command catalogue owns a closed grammar
for each supported program or wrapper form, including the exact option arity and
operand roles; an absent grammar or remainder refuses instead of falling back to
an unknown-command allow.

Option arity distinguishes required and optional values. A required-value option
may consume the next word. An optional-value option never does: its value must
be attached as `--option=value` or, for a registered short option, a same-word
suffix. A bare optional-value option preserves the next word's option or operand
role, so a later unknown flag remains unproven.

`make` remains outside the positive command catalogue: assignments, evaluation
options and build files can select executable code. Direct native Git has a
small checked repository-read grammar: no-patch `log`/`show`, two-revision
name/raw `diff`, closed `rev-parse` queries and verification, and closed
`branch --list` forms. A protected fixed-installation Git 2.x executable from
2.54 onward, matching host handle, complete argv grammar and bounded repository
input checks are all required. Registered Git installations are macOS/Linux only;
Windows remains unproven. Unknown versions, PATH-derived installations,
wrappers, mutation, remote operations, `status`, cached/staged diffs and worktree
diffs remain unproven, with no exact-rule upgrade. Cached/staged reads can refresh
a shared split-index file's mtime despite disabled optional locks; check-time
validation cannot exclude a later split-index swap.

The [canonical checked repository-read contract](../architecture/permission-policy-design.md#checked-repository-reads)
owns metadata/configuration refusals, the forced execution recipe and the
accepted residual. At check time the real authorized cwd must contain an
ordinary `.git` directory with no linked/reparse/special metadata, common-dir
routing, root `.git/worktrees` administration or alternates. A main checkout with
linked-worktree administration also refuses. Configuration includes,
mailmap/order-file routing, `core.worktree`, all extensions and unsupported
syntax refuse. The host pins
absolute repository/worktree roots and the `files` reference backend, strips
inherited selectors, and forces execution, output, write and transport controls.

Two-revision comparisons execute as recursive `diff-tree` with no commit
header and metadata-only output, so losing the repository cannot select
filesystem comparison. An owned `GIT_INDEX_FILE` selects an absent path beside
the verified executable, under its protected installation parent, so implicit
index reads cannot refresh a mutable repository split index. A non-following
check must establish absence; the host creates no file. After the actual
child close, including cancellation or error paths, the same inspector must
return unchanged `.git` state and worktree-root/physical-ancestor provenance
through the filesystem root, including identities and change timestamps. The
32-level ancestor bound still applies. Unrelated concurrent directory activity
can conservatively refuse a benign read. Any mismatch discards stdout and
stderr and returns a refusal. Checked reads keep bounded output private until
that check succeeds, with no live output, artifact or background handle.

Owner decision 2026-10-27 accepts only ref-shaped outside-file disclosure
caused by deliberate concurrent same-user metadata mutation after checking:
an object-id line or symbolic reference may come from any same-user-readable
file, including one outside a repository. The revision-only execution and
post-run discard are required; neither supplies atomic binding of every child
open. No broader content disclosure, helper execution, file writes or transport
is accepted. An unsafe repository at check time still refuses. Visible floors retain precedence; a checked command follows
the normal sandbox route, while unsandboxed automatic execution, including
headless, requires the current-format exact raw-word rule. Separately governed
host Git services remain under their existing controls.

Verified launcher admission is limited to the canonical host Bash/PowerShell
tools. A sealed in-process handle binds the original raw command, dialect and
cwd to the verified absolute image and owned argv/environment. One literal
simple outer command qualifies; wrappers, compound syntax, redirects and state
changes refuse. Execution consumes the plan while rule and cache identity keep
the original raw text. Other consumers and manual terminals cannot mint proof.
The only registered nested recipe is the exact-only Bash form below; the outer
syntax restriction leaves its payload opaque. Exact-approved evaluator payloads
retain their existing semantics and are not inspected to discover a Git
invocation or mint Git proof.

Configuration-dependent programs require an argv proof that implicit user and
system settings cannot add execution, arguments, uploads or output writes.
Native `wget` has no positive grammar. Native `curl` is provable only when its
first argument is exactly `-q` or `--disable`, including after a wrapper;
later or grouped suppression and explicit `-K`/`--config` inputs remain
unproven. Existing upload, destructive and sensitive-path floors keep precedence.
An exact or broad allow cannot repair a missing configuration proof, and no
exact rule is offered. A case-insensitive alias that also names a known native
program must satisfy both grammars across supported editions; a missing native
grammar refuses. Direct `curl` and `wget` aliases therefore remain unproven.
Full cmdlet names retain their own grammar, and native delegation never uses an
alias grammar. Detection retains the alias union for visible floors.

PowerShell startup has its own proof boundary. Managed macOS/Linux parser and
execution launches isolate CurrentUser configuration with a fresh owned
`XDG_CONFIG_HOME`, override AllUsers configuration with an owned `-SettingsFile`,
disable module autoload and import only absolute `$PSHOME` Utility/Management
manifests before caller text. Import failure terminates the process; there is
no module-search fallback. Unsandboxed HOME is preserved.

Outer PowerShell comments remain unproven: comment directives can act before
the prelude. The single lexer marks every outer line/block comment without a
directive-name allowlist and still inspects visible floors. Quoted `#` data is
unaffected.

Startup proof follows the selected protected executable and installation, not
an OS name. Parser and execution never resolve PowerShell through PATH or a
user/agent-writable tree. Missing admission refuses native parsing. Candidate proof and refusal are
cached by platform and complete candidate/root specification for the process
lifetime; newly installed or repaired paths require
an application restart. On macOS installation access evidence must consist of
complete plain permission records; extended or unfamiliar metadata refuses.
On Windows both the protected System32 5.1 installation and modern
installations remain unproven. The former has an unresolved user-registry
session-configuration boundary; the latter can select an endpoint from user
JSON before the prelude. This is not inferred from ordinary CurrentUser
execution policy alone. Protected image admission does not prove startup.
These paths offer no exact allow, require per-call consent and deny headless;
executable admission still precedes any parser spawn. MXC parses inside confinement and receives internal
AST bytes under a separate bound, without the display-output truncation.

The shared executable verifier preserves the outer PowerShell installation
proof and verifies host-declared files/trees and ancestors. It does not prove
arbitrary transitive dependencies or binary signatures; fixed OS images retain
the protected OS loader/library trust boundary. Nested launcher admission uses
one generic operation over declarative recipes with complete startup guards,
owned argv/environment and the matching host-only execution handle. The sole
registered recipe is the closed macOS/Linux (`darwin`/`linux`) Bash literal-code form in the
[canonical recipe table](../architecture/permission-policy-design.md#shell-credential-and-sink-classification).
Its opaque payload can use only the existing current-format exact-rule
exception for the complete original command; broad rules cannot authorize it.
Python path initialization, fish data roots, Node crypto startup, nested
PowerShell configuration, zsh system startup and Windows startup remain
unresolved and unproven. The outer host's startup authority does not transfer
to any nested runtime.

Local transcription is an accepted host-trust residual and does not itself
disable cmdlet automatic allowance. It is separate from executable settings;
profile suppression must not be described as disabling all configuration.

Runtime-dependent execution, including substitutions, variables, splats,
loops, callbacks, generated strings and runtime argv, produces no persistent
suggestion. A registered evaluator grammar may recognize a fully literal,
single outer builtin `eval` or `Invoke-Expression` payload on a separately
proven host as the narrow exception. The verified Bash recipe uses the same
exception; other nested forms cannot acquire it. The grammar must consume every
option and operand; unknown options, including unsupported common parameters,
refuse. A common parameter on `Invoke-Expression`, for example, is unsupported
unless that closed grammar lists it. Only a current-format exact rule for the
complete outer text may then authorize it, and the payload is not analyzed. A
rule authorizes that command text; it is not proof of the command's effects. The
static result, explicit restrictions and visible floors remain authoritative.

**5. Shell verdict.** The blanket `shell → high` in `resolveUserApprovalVerdict` is no longer the first answer.
- An unreviewed shell ask carries the host's rule-classifier verdict (`ApprovalRequest.ruleVerdict`): read-only is LOW, ordinary is MEDIUM, destructive is HIGH.
- Destructive commands stay once-only.
- With no verdict at all, the fallback is still HIGH (fail closed).

**6. Persistence.**
- "Always allow" for a project writes the per-project rule file in Ave home: `<ave home>/permissions/project-rules/<identity>.json`. Identity, repository discovery, the home boundary, and retained legacy rules follow [Project Rule Scope](../architecture/permission-policy-design.md#project-rule-scope). The file is re-read when it changes on disk. Ave never writes rules into the user's repository.
- "Everywhere" writes the user-global scope, which is Store A (`<ave home>/permissions.json`) extended in place.
- Deny-always uses the same files.
- Stored broad allow wildcards load inert rather than corrupting the file. Settings lists each with a localized reason and Remove action; it never matches. Other rules continue to work, unrelated writes preserve the inert entry unchanged, and a new broad wildcard is refused at save.
- Session approvals, including retained shell entries and eligible browser, terminal and other exact tool approvals, are held in memory under the root conversation: the conversation and every sub-agent spawned from it, at any depth, share it, and separate root conversations never do. A session approval without a conversation is refused (`missing-session`), and the dock disables "Allow for session" for such a request and says why. The root comes from one resolver, `createRootSessionResolver` over the sub-agent runner's recorded origins (live and restored children), which the judge also uses. An app restart clears all session approvals.

**7. Approval storage and retained floors.** Existing Store B entries are never converted to command rules. Non-shell matching remains unchanged; plain-shell execution does not reuse them.
- The shared approval content presents an editable host-derived shell rule suggestion in both the conversation dock and the approval lane card. Project scope is selected initially; Everywhere writes the user file. A saved command rule creates no exact Store B approval.
- For eligible non-shell requests, Allow for session records an exact Store B approval under the root conversation id. It does not write a rule file or authorize another root conversation. Shell requests instead save a session command rule when the host offers an exact rule and has a session id; retained Store B shell entries remain inert. Existing entries keep their original identities.
- The destructive floor reads each command's argv: recursive or forced deletion in any option order, recursive or world-writable permission changes, raw disk writers and `find -delete` ask on every invocation.
- **Irreversible commands never become allow rules,** exact or wildcard. The dock does not suggest them, the store refuses them, and the host rejects a save with `invalid-rule`. These commands require per-call consent, and deny rules may still name them. The list (`isIrreversibleShellArgv`):
  - Always: `mv`, `cp`, `install`, `tee` (any file operand without `-a`), `truncate`, `unlink`, `dropdb`.
  - `git clean` unless `-n`/`--dry-run`; `git reset --hard/--merge/--keep`; `git restore` unless index-only (`--staged` without `--worktree`); `git stash drop/clear`.
  - `git checkout` with any operand, because `git checkout <name>` restores a file of that name as readily as it switches branch. The destructive-floor exception is `-b <new> [<start>]` without `--` or paths; it does not grant an allow because checkout remains unproven. `-f`, `-p`, `-B`, `--ours`, `--theirs` and `--` are always refused.
  - `git prune`; `git gc --prune*`; `git tag -d/--delete`; `git remote remove/rm`; `git pull -f/--force`; `git reflog expire/delete`; `git worktree remove -f/--force` and `git worktree prune`; `git update-ref -d/--stdin`; `git fetch -f/--force/-p/--prune/--prune-tags` and `+ref` refspecs.
  - `git switch -f/-C/--discard-changes`; `git branch -d/-D/-M/-C/-f/--delete`; `git push -f/-d/--force/--force-with-lease/--delete/--mirror/--prune`, and `+ref` or `:ref` refspecs.
  - `docker`/`podman`/`nerdctl`/`docker-compose` `prune`/`rm`/`rmi`, and `compose down -v/--volumes/--rmi`.
  - `kubectl delete/drain`, and `kubectl apply/replace --prune/--force`.
  - `gh … delete`, `gh api -X/--method DELETE`; `helm uninstall/delete`; `terraform`/`tofu` `destroy`, `apply -destroy` and `state rm`; `aws` `rm`/`rb`/`delete-*`/`terminate-*`/`remove-*` operations and `--delete`.
  - `rsync --delete*`/`--remove-source-files`; `ln -f`; `redis-cli flushall/flushdb`; `npm`/`pnpm`/`yarn` `unpublish`; `xattr -c/-d`.
  - A dynamic word counts as the worst case.
- `chmod` modes count as world-writable when written as long octal modes (`00777`), when copied from another class (`o=u`, `o=g`), and with `--reference=`. A leading removal such as `-x` or `go-w` is the mode operand, not an option. An unreadable mode is not guessed to be world-writable.
- The sensitive-path floor also covers what a search reads, not only its literal arguments (rounds 5 and 6).
  - A recursive content search whose root is at or above a secret-holding directory is floored: `grep` (`-r`, `-R`, `--recursive`, `-d recurse`, `--directories recurse` or `=recurse`) and `rg`, which always recurses. Secret-holding directories include the home, `/`, `~/.config`, `~/Library/Application Support`, the Ave home and `/proc`.
  - A search that follows symlinks is floored when a followed link resolves into a sensitive path, or when the walk passes 5000 entries without ruling that out:
    - GNU `grep -R` and `grep --dereference-recursive` on every platform;
    - BSD `grep -S` on macOS, where `-R` alone does not follow;
    - `rg -L`/`--follow`;
    - `find -L`/`-follow` for links below the root, and `-H` for root links.
  - `find` without following only lists names, so its roots are not floored, consistent with `ls -R ~`, `du -a ~` and `rg --files`.
  - BSD `find` leading options (`-E -X -d -s -x`, `-f <path>`) are parsed; `-f`'s value is a root.
  - A dynamic root is an ordinary ask.
- Known limits of the floor (accepted, round 6):
  - A recursive search inside a project still reads that project's own `.env`, which matches only the unanchored `**/.env` pattern.
  - The floor checks paths, not the content of repository history or raw objects. Only the [checked repository-read grammar](../architecture/permission-policy-design.md#checked-repository-reads) can supply native Git proof; retained exact or prefix rules cannot repair a refused form or repository input.
  - The symlink check is a point-in-time scan. A link created between the decision and the run (TOCTOU) is not seen.
  - The 5000-entry cap means `rg -L` or `find -L` over a large repository (for example one with `node_modules`) always asks.
- The floor also checks git object paths: `<rev>:<path>` and `:<path>` operands (`git show HEAD:.env`, `git cat-file -p HEAD:.env`) and pathspecs after `--` (`git log -p -- .env`) are floored like `cat .env`.
- Secret stores added to `sensitive-paths.ts` (round 5):
  - `/proc/*/environ`, `/proc/*/mem` and `/proc/*/fd/**`, together with their `task/*` and `map_files` forms; `cmdline` and `status` stay readable.
  - Chromium-family `Cookies`, `Login Data`, `Web Data` and `Local State` under `~/Library/Application Support`, `~/.config` and Windows `User Data`, which covers Chrome, Edge, Brave, Arc and Chromium.
  - Firefox `logins.json`, `key4.db` and `cookies.sqlite` under `Firefox/Profiles` and `.mozilla/firefox`.
- `git remote -v`, `git remote show <name>`, `git remote get-url`, `git reflog` and `git worktree list` remain outside the checked repository-read grammar and unproven. Retained narrowing and destructive floors still apply independently.
- The dock names the directory a project rule applies to, which is the repository root when one is found, not the execution directory.
- A rule save reports `invalid-rule` for a rule that fails validation or does not cover the command, and `rule-save-failed` when a valid rule cannot be written.
- Settings presents user and project rules together with persistent and session exact approvals in one revocable list. Project enumeration preserves the identity stored in each file, including retained exact-directory scopes. A file whose stored root no longer derives its own name is reported as unavailable, and its rules are still listed and revocable by that stored identity without rewriting the root.
- An edited rule is normalized by one shared function before it is checked. For shell exact rules, it preserves every raw word, quote character and argument byte while normalizing only whitespace between words. The dock previews that form, and the host save path applies the same function; the rule store's parser stays strict for every other writer. The host validates edited rules against the live command and the same refused-prefix policy used by the rule store. A save failure keeps the approval pending. Credential, destructive and other forced one-shot requests cannot acquire remembered allows.
- A corrupt Store A, Store B or project file fails clearly with a visible error.
- Corrupt files are never silently dropped and never overwritten.

**8. Writes.**
- Edit rules apply to every canonical file tool with category `write` and declared path fields, including write, edit, multi-edit, patch, delete, move, copy and archive extraction. Move and copy include both source and destination; extraction includes the archive and destination. Relative globs are anchored to the discovered project root, even when the invocation cwd is a subdirectory. Rules reject `.` and `..` components, duplicate separators and unsupported glob syntax; `**` must occupy a whole path segment. Separators have one canonical spelling. Literal backslashes in POSIX targets or resolved names are refused rather than interpreted as directory separators.
- The matcher consumes the executor's sealed canonical target identities. Every target must be covered by an allow; deny and ask need only one matching target. Sensitive paths and project escapes through symlinks or parent components retain a per-call gate, including for new files and unresolved links.
- An absolute external Edit grant admits only the current invocation's sealed file targets through the existing directory and execution gates. A generic tool allow never grants an external path. No directory scope is propagated to later calls.
- Sensitive paths and Ave's own config, permission and hook files are floors, checked before any allow rule. So are the sandbox's protected control files wherever they appear in a target path, inside or outside the project (`.git`, including hooks and config, `.githooks`, `.husky`, `.vscode`, `.claude` settings, hooks and commands, `.idea/workspace.xml`, `.pre-commit-config.yaml`, `.envrc`, `lefthook.yml` and shell profiles). They are matched with the same case folding as sensitive paths (macOS and Windows fold case). An `Edit(**)` or absolute external allow still asks before writing them, and reads are unaffected. The match covers the whole absolute path, so a project that itself lives under a protected segment (for example `~/.vscode/extensions/<ext>/` or `~/.claude/commands/`) asks before every write; this fails toward asking.
- Symlink escapes ask.

**9. Network.** `WebFetch(domain:...)` rules govern the builtin mediated fetch. Hostnames are case-normalized with a trailing DNS dot removed; a rule port matches the URL's effective port. Only a leading `*.` wildcard is accepted, and it excludes the apex. A wildcard needs at least two labels after `*.`. Public suffixes are not detected, so `*.co.uk` matches every `.co.uk` site. The existing network guard checks each actual redirect destination before transport. A rule-authorized fetch follows destinations covered by an allow. A completed per-call approval also covers ordinary redirects within its initial origin; deny rules and fresh sensitive requests still win. Unapproved ask or uncovered destinations fail with an explicit error. Host allows apply to public fetches; private-network opt-ins retain their existing separate approval identity and policy. Sensitive request screening and SSRF checks remain independent. A screened request (for example, a credential-looking query) is not a floor: a `WebFetch` allow never covers it, and it follows the mode like a fetch without a rule. A redirect that is screened after a rule-authorized or per-call-approved fetch still needs a new decision. Fetches admitted solely by general tool or mode policy retain that policy; destination ask/deny rules and floors still apply at every hop. Rules never inspect shell command text, change plugin domain grants or confine shell egress.

Domain deny and ask rules also feed the browser's existing host-mediated allow-list for navigation and new tabs. A domain allow never skips the browser's own per-site approval. Both paths install the existing origin guard before loading: cross-origin redirects and observed main-frame navigations are refused, and same-origin redirects retain the checked host and effective port.

Domain rules identify URL hostnames, not resolved IP addresses: an IP-literal URL can bypass a rule for its DNS name. IPv6 literals cannot be represented by `WebFetch(domain:...)`. Rules accept only ASCII hostnames, so internationalized names must use punycode; URL parsing uses WHATWG normalization to `xn--` hostnames.

**10. MCP.**
- Always-allow is per tool by default; per server is an explicit option.
- Rules match the server id and original tool name retained by the host adapter. An `Mcp(...)` allow covers only a tool with an explicit non-destructive hint. A destructive annotation, or no such hint, is not a floor: the tool follows the mode and ask/deny rules as before, and only the allow rule does not cover it. Annotations never auto-allow by themselves.

**11. Out-of-directory.** The host resolves file, parent and project-root candidates through `editDepthCandidates`, using existing repository discovery and directory validation. Each candidate is an ordinary Edit rule in the same store; duplicate, sensitive, filesystem-root and wildcard-bearing literal candidates are refused. Connecting these candidates to the dock's depth picker is a separate UI task.

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
All automated review enters the judge engine, including auto mode, foreground
LOW/MEDIUM review, headless execution and the authoritative shadow baseline.
Absent judge settings or a valid empty configured chain use the default builtin
reviewer chain. Classification and failure behavior remain unchanged, including
eligible host-built-in `meta` calls, except for the unified pause and resume
behavior below.
Automated review requires a conversation or task session identity and a
host-created invocation identity; either missing identity is an explicit
contract error.

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

- A valid empty chain turns the configured chain off; automated review uses the
  default builtin reviewer chain through the same engine.
  The earlier single-stage `provider: "off" |
  "builtin-llm" | "external"` form is accepted on read and serialized as a
  chain on save. Mixing the two forms is invalid.
- A configured chain defaults to `shadow`. Shadow records the chain's result
  without applying it; the builtin reviewer chain remains authoritative.
  Shadow observations create no deferred entries and do not count as blocks.
  The authoritative baseline still participates in the shared breaker once per
  request, including pause and resume.
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
  not the persisted mode or normalizer defaults. A missing file or block leaves
  the configured chain off and uses the default builtin reviewer chain; a parsed
  rejected shadow chain retains the baseline described above.
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
The implicit builtin chain adds no stage or whole-chain timeout beyond the
classifier's existing retry, streaming and transport limits. Explicitly
configured chains retain their configured budgets. Caller cancellation still
propagates in both cases.

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
and appends an item to the existing `DeferredQueue`. A paused breaker routes
interactive requests to the normal user approval card; without an available
user, it denies with a reason naming the threshold. The existing approval card
and notification surfaces explain the pause in English and Korean.
Every allow remains automated for pause checks unless the host has consumed
verified fresh native human consent for that exact action. Policy grants,
remembered approvals, reviewer decisions, parent decisions and sealed rationale
receipts do not establish that provenance.
Only a verified allow answer to the current signed card from a registered
application window's exact main frame can establish fresh consent and resume
the paused breaker. Rules, peers, agents and headless outcomes cannot do so.
The renderer supplies the answer; the host alone mints its provenance and supplies
`remoteControllerOrigin` and parent-adjudication facts. Subframes, webviews,
plugin, `render_html`, MCP-app and other non-app origins or partitions remain
rejected.

The explicit owner registry provides delivery correctness. Every attachment
and lifecycle update goes through `updateApprovalSurface`; readers receive a
resolve-only registry view. Main chat adoption and restore, side-panel load,
tab detachment, work pane and Work Board attachments register their current
surface. Fresh and resumed children register live parent links; scheduled and
background runs register their trusted surface or no surface. The resolver
never infers a missing owner from chat holders, persisted ancestry or focus.
User-driven attachments legitimately transfer registration between app
windows, including a replacement primary adopting a cached conversation, and
existing children follow their parent. A currently unattached window's answer
is rejected and audited without settling the card or creating fresh consent.

App windows are one trust level. A renderer that can perform an allowed attach
can then answer that conversation's card; delivery binding is not isolation
against a compromised app renderer. Defending against that requires a
trusted-chrome approval surface with a main-process-drawn prompt plus native
input proof, which the current design does not provide.
A new request without a registered live surface denies with
`no approval surface` under the headless semantics. Owner closure without a
turn abort leaves an already pending card until the normal five-minute deny
timeout; it never auto-approves. A registered replacement owner can answer
before timeout.
Remembered grants and scope proposals share this
[delivery and registered-frame contract](../architecture/permission-policy-design.md#automated-judge-chain).
One synchronous final gate runs immediately before the tool handler, after all
asynchronous hooks and route admission. It rechecks cancellation, required audit
integrity and writability, breaker state and plugin/remote authority, with no
await before handler entry. A paused invocation returns to the normal forced
one-shot native approval card interactively or denies when no user is available.
After a card or renewed route admission, the same gate runs again. Verified
fresh human consent bypasses only the pause requirement, never the other checks.
Permission-request hooks and signed ask-audit preparation remain bounded and
cancellable. Only the late card's user wait moves outside the tool execution
ceiling and retains the normal five-minute card timeout; actual execution
remains bounded and cancellable.
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

**8. Breaker.** One chain-owned breaker counts successful classifier blocks per
root conversation across all automated lanes. A final non-allow verdict counts
once per host invocation identity, including a builtin foreground `ask`.
Scope review, ordinary review and cache assessments of the same invocation
cannot count it again; distinct invocations count separately even with identical
arguments. Intermediate stage verdicts, shadow observations, classifier failures,
timeouts and separate host safety rejections
do not count. The thresholds are fixed at 3 consecutive or 20 total blocks.
The block is counted after the provider and host hook complete, before audit
append. A stop during append does not undo that completed block; a stop before
review completion counts nothing.

An allowed action resets only the consecutive count. The total persists for the
session and resets only when its own threshold triggers a fallback. Reaching
either threshold pauses automation: the triggering request and subsequent
requests require normal manual approval when a user is available, or deny with
the threshold reason when nobody can answer. Authenticated human approval of a
prompted action resumes automation and clears the consecutive count; it does
not otherwise reset the total. Parent-agent, away-authority and remembered
automatic approvals cannot resume it.

Subagents resolve to the same root conversation for breaker and judge audit
identity. Deferred entries retain the actual requesting session so later
approval returns to the correct conversation. Rewiring settings does not create
a fresh counter for that conversation.

**9. Hooks.** `beforeJudge` may redact the judge's input or short-circuit to
ask/deny. It cannot change the executing invocation. `afterJudge` may only keep
or downgrade a decision (`allow → ask → deny`).

**10. Audit and verification.** The existing writer records root session,
invocation identity, tool, argument hash, redacted request, provider id/version,
rationale, latency and fallback. Each executed stage records its verdict,
confidence, model and latency.
Normal builtin review and the authoritative shadow baseline retain the resolved
reviewer model in that stage audit.
Active decisions use the HMAC-protected permission audit; shadow uses the shadow
channel. Active audit failure prevents execution.

Module tests establish chain and adapter semantics. Call-site acceptance also
requires parity through the real foreground and headless dispatch lanes,
trace/cancellation and failure parity, threshold and resume behavior,
deferred/root-session integration, settings write
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

## Rule implementation

### Where the code is

- `src/permissions/rules/rule-specifier.ts`: the grammar and pure host/MCP identity matchers.
- `src/permissions/rules/scoped-rule-matcher.ts`: edit, network and MCP precedence, mandatory scoped gates and host-resolved depth candidates.
- `src/permissions/rules/shell-prefix-policy.ts`: the suggestion; `shell-prefix-values.ts` holds the refused-prefix list and destructive/irreversible classification.
- [shell-argument-grammar.ts](../../src/permissions/rules/shell-argument-grammar.ts): baseline positive argv proof and closed command, wrapper and literal-evaluator grammars.
- [verified-shell-command.ts](../../src/permissions/verified-shell-command.ts): sealed host-launcher proof and execution identity, using the closed [launcher](../../src/permissions/rules/verified-launcher-argv.ts) grammar.
- `src/permissions/rules/shell-rule-matcher.ts`: the AST walk and deny/ask/allow evaluation.
- `src/permissions/rules/rule-files.ts`: rule validation and `PermissionRulesFileCorruptError`.
- `src/permissions/rules/project-rule-files.ts`: per-project files in Ave home.
- `src/permissions/rules/rule-scopes.ts`: the project-scope cache for the synchronous decision path.

### Decision path

`PermissionManager.checkDetailed` uses two host-built context fields:

- `ruleSubject`: a shell command with its dialect, sealed native edit targets, a mediated fetch URL, or the original MCP server/tool identity;
- `projectRulesCwd`, which the tool pipeline loads through `ensureProjectRulesLoaded` before a synchronous decision. Relative Edit globs use that scope's project root. Bash and PowerShell command rules both use the resolved user, project or session scope.

An unsandboxed shell input over 2,000 characters immediately asks at L6 or
denies headless before project loading and all later command processing. The
sandboxed 8,000-character envelope and aggregate 64 KiB eligible quoted-heredoc
data bounds are checked before general inspection; stronger non-command denies may still refuse either path. For
other inputs, checks run in this order:

1. Deny decides at layer 1.
2. A corrupt Store A, project file or Store B returns a forced ask that names the file for every non-read call. Reads keep the normal matrix so the app stays usable while the file is repaired. Settings identifies unavailable files without overwriting them; the user repairs the file outside the rule list. A corrupt Store B no longer blocks every tool call; the error is logged with the file name.
3. An identified sensitive-path or credential/sink signal decides at layer 2 as
   a forced, never-remembered prompt, before any allow rule or saved approval.
4. Explicit ask rules decide at layer 2 as forced, never-remembered prompts.
   They also win over `allow` mode.
5. Within-cap syntax refusal, unknown or incomplete argv grammar, runtime argv,
   or runtime-dependent `unproven` input decides at layer 2 as a forced prompt,
   or denies headless. A Lane B input-length or structural-cap refusal reached
   before static analysis instead follows the L6 ordinary unsandboxed ask, or
   denies headless. A current-format exact rule is the sole allow path for a
   qualifying literal-evaluation command whose closed grammar consumed every
   option and operand. Cap refusals never qualify, and no broad rule or saved
   approval satisfies the exception.
6. Applicable allow rules for `static-complete` requests decide at layer 3 and
   eligible non-shell saved approvals at layer 5. Broad shell allows apply only
   to sandboxed requests. Unsandboxed requests require an exact rule; unsandboxed
   headless requests deny without one. Sandboxed `static-complete` headless
   requests follow the normal sandbox route.
7. Remaining requests follow their category and mode path at layer 6.

The Layer-numbered gates already in place (remote controller, overlay, strict) are unchanged.

### Shell matching authority boundary

The permission policy does not recover an allow by simulating runtime shell
behavior. `static-complete` is earned only when a registered command grammar
consumes the command name and every argument. An unknown command, unknown
option, missing operand, unsupported form, unconsumed argument, runtime argv,
parse or lexer refusal, structural-limit hit, variable-dependent callee or
argument, substitution, splat, loop, callback, generated string or same-input
filesystem dependency is `unproven`. Within-cap refusal receives a foreground
L2 modal or headless deny. A Lane B length or structural-cap refusal reached
before static analysis follows the ordinary unsandboxed L6 ask, or denies
headless. No broad rule, mode, reviewer or ordinary exact rule can repair either
result. One unproven stage makes the whole command input unproven; another
proven stage does not retain an independently reusable allow result.

`changesState` is conservative at the registered command-family level, not a
claim that this invocation was observed writing. Families that can write through
implicit or alternate modes mark all admitted forms possible-write. This covers
every positively parsed native `curl`, `sort` and `uniq` form, including
read-looking forms.
Their presence in a multi-command input refuses the whole input. Their baseline flags and grammars live in
[shell-argument-grammar.ts](../../src/permissions/rules/shell-argument-grammar.ts);
sealed launcher proof uses the verified command owner and launcher grammar
linked above. The analyzer does not refine the flag through file-state or provenance
simulation. That source also limits `printf` to known non-state-mutating format
conversions; an incomplete, unknown or state-mutating conversion is unproven.

A single outer command with a fully literal evaluation payload is the sole
exception. Its registered evaluator or verified launcher grammar must consume
every option and operand and identify the payload as literal. Unknown options,
including unsupported common parameters, refuse rather than falling back to ordinary
command mode. After that positive proof, a current-format exact rule may
authorize the complete original text of direct builtin `eval`,
`Invoke-Expression` on a proven outer host, or the host-bound Bash recipe.
The key preserves quote style and raw content. The payload stays opaque, so the
floor neither reparses it nor infers paths or effects from it. Without that
exact rule the request remains `unproven`, including in the sandboxed lane.

File-, stdin- and network-backed content remains an accepted indirection limit
only after a registered grammar consumes the known outer command and every
literal operand. The contents are not read to predict execution or treated as
proof of effects. Script and build forms outside their registered grammar have
no fallback proof.
Runtime argv producers such as `xargs`, command-launching `find` forms, parallel
runners, and PowerShell pipelines into `&` or `Start-Process` are unproven and
cannot use any exact or broad rule. Any multi-command input containing an
invocation that can change aliases, shell options, functions, `PATH`, the
environment, cwd or a file is unproven as a whole, regardless of position; the
floor does not simulate whether another invocation observes the change. A
visible sensitive path, credential
source or upload sink in the literal outer command still forces per-call consent
before any rule. The canonical contract and precedence are defined in
[Shell Credential And Sink Classification](../architecture/permission-policy-design.md#shell-credential-and-sink-classification).

### Scoped rule storage

`Edit`, `WebFetch` and `Mcp` use the existing validated global and project rule files. Malformed rules fail the whole file closed; no second store or conversion of exact approvals is introduced. Their subjects are built from host-created file/fetch instances or the registered MCP adapter identity rather than a tool-name resemblance.

### Shell classification buckets

The shell floor returns the three outcomes owned by the
[permission-policy contract](../architecture/permission-policy-design.md#shell-credential-and-sink-classification):

| Outcome | Static evidence | Decision without another controlling rule |
|---|---|---|
| `visible-floor` | A sensitive path, credential source, upload sink or retained catalogue effect is directly visible in the literal outer command | Foreground L2 ask with `forceModal`; headless deny; no saved approval, allow rule or mode bypass |
| `unproven` | Lane B refuses the input length or a structural cap before static analysis | Foreground L6 ask under the ordinary unsandboxed exact-rule requirement; headless deny; no rule, mode or reviewer can repair it |
| `unproven` | Lane A exceeds a cap, or either lane has a within-cap syntax refusal, unknown or incompletely consumed argv grammar, runtime argv, or runtime-dependent callee or argument | Foreground L2 ask with `forceModal`; headless deny; no broad rule, mode or reviewer can repair it |
| `static-complete` | A registered grammar consumes every command and literal argument in the original parse with no runtime-state dependency | Normal sandbox route, including headless; unsandboxed execution requires a current-format exact rule and unsandboxed headless denies without it |

A `visible-floor` wins over the other outcomes. Hard denies, destructive and
irreversible commands, explicit asks and independent execution gates retain
their existing precedence. Character, quoted-data, total-token and structural
limits close the request immediately under the lane-specific L6/L2 routing
above; there is no work-step or elapsed-time decision budget.

### Retained credential and sink floors

Sensitive-path arguments to shell commands remain enforced by
`src/tools/shell-path-policy.ts` at execution, independently of rules.

The static pass checks literal outer argv, redirects and file-input operands.
It retains direct sensitive-path checks and the existing credential-store,
certificate-export and upload-sink catalogue. A directly written sender with a
literal file input remains a floor; a plain GET or `git push` does not establish
exfiltration by itself. These floor checks are independent of positive argv
proof and therefore still win when the command is otherwise unproven. A
registered wrapper grammar may expose a literal downstream sender, but its
boundary is represented once as an index range over the original argv. The pass
does not scan every suffix or infer safe arguments from wrapper options.

The same rule applies to PowerShell. Directly written credential commands,
certificate exports, native transfer tools and literal upload parameters retain
their catalogue effects. Detection may normalize a module-qualified command
name, basename, executable suffix and platform case without changing the raw
rule key. Variables, subexpressions, splats, script blocks, callbacks, loops,
generated strings and file mutations are `unproven`; the floor does not carry
their values, sources or effects into later commands.

PowerShell cmdlets use a closed parameter grammar. Unsupported parameters,
including non-ASCII dash spellings, are unproven. The registered HTTP cmdlets
are possible-write only when the recognized `-OutFile` parameter is present;
their visible credential and upload floors still run independently. Launcher
encoded-option detection remains a separate positive character proof.

Literal evaluation payloads are deliberately outside this inspection. A payload
containing a credential path or upload command remains opaque; only visible
literal operands outside the payload receive floors. The exact rule is approval
of the complete outer text, not certification of the payload. File-, stdin- and
network-backed content remains an accepted limit only for a known outer command
whose registered grammar consumed every argument.

### Runner identities

Wrapper and interpreter tokens remain in the complete raw rule identity; an
inner-only key cannot authorize the outer input. Package task/exec/runner forms
have no positive-proof grammar because implicit configuration can add startup
code or execution options. No suffix summary or unknown-option fallback proves
them. Known native wrappers retain index-range delegation; both outer grammar
and delegated argv must be proven.

The host-bound Bash literal-code recipe is the only nested interpreter form
with positive proof, and is exact-only with an opaque payload. Its installation,
startup and execution binding follow the canonical recipe contract linked
above. Script, module, stdin, interactive and unregistered literal-code forms
remain unproven and ineligible for every exact or broad allow. Visible outer
paths and upload sinks retain their floors regardless of a rule.

### Dialect-scoped rules and grants

`Bash(...)` rules match Bash and `PowerShell(...)` rules match PowerShell at
user, project or session scope. New shell allows carry the current canonical
version. Unversioned and wrong-version allows remain silently inert; deny and
ask rules retain their narrowing authority regardless of version. The key keeps
the program token and every argument exactly as written, including module
qualifiers and quote style. Detection-only name normalization never changes it.

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

Visible credential/sink floors coexist with the sandbox's filesystem and
egress boundary. Sandbox defaults, platform availability and network enforcement
belong to the
[architecture contract](../architecture/architecture.md#os-execution-sandbox-and-plugin-workers).
These floors inspect visible input; decoded payload contents do not feed the
permission decision. Shell URLs and remote package/registry sources alone do
not replace credential/sink evidence. Unsandboxed permission follows literal
proof and exact-rule coverage rather than inferred egress safety.

The decision-table and classifier checks establish policy-analysis behavior.
Native shell execution and proxy/sandbox egress behavior are not validated by
this change.

### Approval rules UI

Settings accepts canonical `Bash(...)` and `PowerShell(...)` rules. Shell rules
preserve raw words and normalize only whitespace between them. The dock saves
through the same `PermissionManager.addRulePersist` method. Revocation uses
`removeRulePersist` for rules and the existing Store B revoke method for exact
approvals. Each row identifies its decision, source and user, project,
persistent or conversation scope. Revoking an entry affects subsequent
permission checks; it does not answer an open approval request. Failed saves
and revocations remain visible.

## Tests

- `src/permissions/__tests__/shell-sandbox-rules.test.ts` covers actual-route auto-allow, exact-only unavailable matching, floors, deny/ask precedence, repeated native host retries, unchanged subsequent sandbox plans and reviewer escalation.
- `src/permissions/__tests__/rules-language.test.ts` covers:
  - the grammar;
  - the refused list;
  - bounded prefix suggestions and irreversible commands;
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
