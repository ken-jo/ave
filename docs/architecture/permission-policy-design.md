# Permission Policy Design

This document describes the current permission-policy contract for Ave tool
execution. Korean source history is preserved at
[docs/ko/architecture/permission-policy-design.md](../ko/architecture/permission-policy-design.md).

## Purpose

The permission system prevents tools from executing merely because an LLM or a
plugin requested them. The host classifies the request, applies hard safety
rules, asks the user or reviewer where required, and records the result.

## Policy Files

[policy-store.ts](../../src/permissions/policy-store.ts) reads the user and
system-admin `policy.json` files. For the permission reader, a valid file is a
JSON object with numeric `version:1`. Mistyped `requireExplicitApproval` and
`managed` booleans are normalized to their safe value, `true`.
The numeric top-level `version:1` is required even when the managed file only
configures `marketplaces` or `service`. Without it, the permission reader forces
explicit approval and locks user editing; the section readers remain independent.
A valid admin file takes precedence for each field it states. Unstated admin
fields fall through to the user value or the default. In particular, a valid
admin file that omits `requireExplicitApproval`
preserves an explicit user `false`, even if the admin file sets `managed:true`.
An explicit admin `false` also overrides user `true`; precedence is not limited
to tightening. Without either file stating the field, explicit approval stays on.
The flag controls explicit decisions on approval cards; execution-mode,
hard-deny, and reviewer gates still apply independently.

[admin-policy-file.ts](../../src/lib/admin-policy-file.ts) classifies a failed read
as absence only when it reports `ENOENT` and `lstat` confirms no directory entry.
A dangling symlink, `ENOTDIR`, or an inconclusive entry probe remains unreadable.
All three administrative policy readers use this classification. Marketplace
policy returns a blocked result on unreadable input; service resolution throws
instead of falling back to the public endpoint.

For the permission reader, unreadable files, invalid JSON, non-object JSON,
or a missing, mistyped, or unsupported version produce a
conservative permission policy: `requireExplicitApproval:true`, `managed:true`,
and user edits locked. Loading does not fall back to a permissive user policy,
and saving rejects before creating or opening user state. Diagnostics record
the path and failure reason without policy contents or parser exception text.
Any valid admin file also locks app-mediated user-policy edits, including one
that omits `managed` or sets it to `false`.
An invalid user file contributes no permission fields and does not create an
administrative edit lock when the admin file is absent.

### Project Rule Scope

[project-rule-files.ts](../../src/permissions/rules/project-rule-files.ts) stores project rules in the application home, keyed with the same canonical realpath and platform case folding as exact approvals. Sessions below a normal repository share the nearest eligible repository root; nested repositories keep their own rules. A `.git` directory needs a valid regular `HEAD` file and `objects` and `refs` directories. A regular `.git` file must contain a single `gitdir:` path resolving to that metadata. Linked worktrees resolve their common store through `commondir` and must have a `gitdir` backlink to this checkout's marker. Their identity remains the checkout, not the shared metadata directory. Discovery bounds reads on opened regular metadata files without launching a subprocess. An invalid or unreadable marker stops discovery and leaves the session scoped to its own cwd.

The canonical user home and every ancestor of home are excluded as inherited roots, including for sessions elsewhere below such an ancestor. A session whose cwd is exactly one of those directories keeps that exact identity. Symlink resolution precedes discovery and home-boundary comparisons, and Windows comparisons use the same case folding as exact approvals.

Existing rule files are retained unchanged. Rules previously keyed to home or an ancestor remain available only to sessions at that exact canonical cwd; child and sibling folders no longer load them. There is no automatic copying, deletion, or expansion of those approvals. The existing project rules UI can inspect and remove them when that exact directory is selected.

## Policy Inputs

| Input | Meaning |
| --- | --- |
| Tool source | Builtin, plugin, or MCP. Used for display and audit; not a bypass. |
| Tool category | Read, write, shell, network, browser, meta, or other declared categories. |
| Trust origin | User keyboard, LLM tool argument, plugin UI, local API, routine, or headless task. |
| Project context | Normalized project root/name used for scope and audit. |
| Policy mode | Default, strict, auto-review, or allow mode. |
| Execution surface | Foreground chat, background routine, inline plugin/MCP surface, or local API. |

## Decision Order

1. Validate the tool exists in the registry.
2. Validate the schema, category, and path fields declared by the provider.
3. Apply hard-deny rules: denied sensitive-path operations, invalid manifests,
   sandbox limits, explicit deny policies, and unsafe origin combinations.
4. Resolve policy mode.
5. If reviewer mode is active, request a reviewer verdict for eligible calls.
6. Route to user approval, inline allow, deferred queue, or deny.
7. Execute only after the decision is resolved.
8. Write audit data for allow, ask, deny, deferred, reviewer unavailable, and
   reviewer failure outcomes.

Hard-deny rules always run before reviewer or user approval. A user approval
does not make an invalid tool definition valid.

Shell policy consumes the canonical [typed analysis and prepared execution
contract](architecture.md#process-boundaries). The path and
structural checks inspect every declared command-bearing field using the same
original command, interpreter facts and statement scopes. They do not infer
execution from a second scan of dequoted text. A `grep` pattern remains text
even when it contains path separators, regular-expression escapes, or dollar
anchors. Input files, pattern files supplied with `-f`/`--file`, exclusion files,
and redirection targets remain subject to path checks. Shell substitutions are
checked separately because they execute commands before argument passing.

For `git commit`, the operand classifier in
[shell-path-policy.ts](../../src/tools/shell-path-policy.ts) recognizes message
values as data, including attached option values. Path-like text in a literal
message does not request filesystem access. Directory options, file-backed
messages, templates and pathspec files retain path checks. Unsupported option
arity is refused rather than used to infer later operand roles. Classification
preserves the original command bytes; substitutions, redirections and commit
mutation still receive their normal checks.

Literal dollars and percent markers remain exact filename bytes in Bash,
including quoted `$PWD` and `%CD%`. Only typed active expansions use the
prepared environment and point-of-use bindings. A known expansion is checked
as its exact result; an unknown path or executable remains unresolved. Path
resolution follows symlinks before parent components and refuses unresolved
links. The four exact standard-stream operands `/dev/null`, `/dev/stdin`,
`/dev/stdout` and `/dev/stderr` are recognized before host descriptor resolution.
Other descriptor paths receive ordinary checks.

Pure output data does not acquire a path role because it contains a slash or
dollar. Its executed substitutions and expansion effects are still inspected.
Supported default/alternate parameter operands preserve conditional evaluation;
simple arithmetic output is admitted only when its dependency values are known
numeric data and no mutation or nested execution is present. Its computed value
is not inferred for path authority. Unknown command outcomes preserve possible
states through conditions and loops; a pre-execution filesystem observation
cannot decide a later cwd after a possible shared filesystem mutation.

The structural pass follows command text supplied through a child shell's
`-c`, heredoc or here-string. It does not read a script file or infer its
contents from an earlier write. Script-file execution remains subject to
write-risk classification, path authority, approval and the execution sandbox.
Opaque loading into the current shell through `source` or `.` is explicitly
unsupported because it could replace the state used for later path decisions.

Read-only evidence comes from the existing risk contract. Unknown executables
and mutating commands retain the write boundary, including an absolute command
path; widening reads never supplies a read-only proof for execution. Redirect
targets carry their own effect independently of the command's argument roles.

Debugger command options (`-ex`, `-iex`, `-eiex` and their documented long
forms) carry program text. Executable, symbol, core, directory and command-file
options remain path operands. After an argument-forwarding option or a possible
abbreviation, later arguments receive no debugger option exemptions because
they may belong to the child program.
Potential abbreviations of value-taking options consume their value
conservatively so that an option-looking filename cannot claim a later operand.
Program-text classification does not make debugger execution read-only: tool
risk review and the execution sandbox govern the program's internal effects,
as they do for other interpreters. Shell substitutions are still checked before
the debugger receives the resulting argument.

The `sqlite3` [argument contract](../../src/tools/shell-sqlite-arguments.ts)
defines the supported options and consumes their values before assigning positional roles.
Role assignment first requires a fixed argument count after shell expansion.
Unknown quoted scalar data may occupy one value slot; unresolved word splitting,
globbing or array multiplicity cannot shift subsequent option or positional roles.
The database operand and `-init` file remain paths; later operands and `-cmd`
values carry SQL or dot-commands. Formatting and numeric option values are data.
Database URI filenames are decoded before normal sensitive-path, symlink and
directory checks. SQL length does not affect its role or grant authority.
Literal filenames in supported SQL and dot-command operations receive the same
path checks. SQL table names are recognized in their structural context, including
single-quoted, qualified and grouped sources, joins and `IN` table forms.
Expression strings and aliases keep their data role. Explicit `.shell` and
`.system` commands re-enter structural and path inspection using the CLI's
argument construction for its POSIX system shell;
the Windows system-shell dialect is unsupported. Computed filenames,
extension loading, file-backed virtual tables, command pipes, cwd changes,
unknown options and unsupported dot-command forms are refused before approval
or execution. Database URIs combined with alternate file-opening modes are also
refused because those modes can interpret filename bytes differently. Conditional
home-directory expansion is unresolved; file-loading modes keep `:memory:` as a path.
Positional script-file detection is unsupported when it can change later argument
roles; explicit `-init` and `.read` keep their program-file path checks.
Those program files and database-resident code are not read or evaluated
by this pass; they retain write-risk review and execution sandbox controls.
This contract does not establish read-only execution or change permission grants.
Shell redirects and substitutions remain independently checked.

For `find`, starting points and file-valued primaries remain paths. Name/path
patterns, regular expressions, timestamps, numeric tests, and output formats
are expression values. In particular, `-printf` takes one format, while
`-fprintf` takes an output file followed by a format. Each primary consumes
its documented operands before the next primary is read. Unsupported or
incomplete expression syntax keeps conservative path checking. The shared
operand classifier consumes canonical argv, so interleaved redirections do
not consume expression operands. File redirect targets remain independently
checked; descriptor duplication/closing consumes no argv operand. A missing
redirect target is a parse failure, distinct from an explicitly empty word.
This role classification does not relax recursive mutation/execution restrictions
or shell redirection and substitution checks.

Compiler path options preserve the complete value: `-Iinclude/sub` names
`include/sub`, and `-ooutput/tool` names `output/tool`. Known options consume
one argument; unknown and sysroot-dependent forms retain conservative checking.
The same operand classifier checks redirects separately.

HTTP and HTTPS query values remain URL data. An equals sign does not create
a local path operand. Output options, redirects and shell substitutions keep
their normal checks.

The [archive-listing parser](../../src/shared/shell-tar-listing.ts) supplies
both risk and path classification. Only recognized listing options with
explicit local archive files establish a read operation. Entry names select
archive contents; archive files retain sensitive-path and optional read-boundary
checks. Mutation, unknown options, file- or environment-supplied options,
remote transports and expandable option words remain conservative.
Redirects and hidden execution still affect risk.

Supported grammar is not the same as supported authority analysis. Arithmetic
commands, C-style loops, unsupported declaration or shell-state operations,
dynamic shell programs and unproven expansion effects are explicitly declined.
The strict grammar also declines an unfinished heredoc and a variable-shaped
literal delimiter accepted by some native Bash forms; it does not return an
earlier partial command. Version-dependent arithmetic command endings with a
continuation between their closing parentheses are also declined rather than
assigned arithmetic authority. These are documented limits, not native-equivalence
claims. [shell-policy-unsupported.test.ts](../../src/tools/__tests__/shell-policy-unsupported.test.ts)
retains these refusal cohorts, while
[shell-authority-native.test.ts](../../src/tools/__tests__/shell-authority-native.test.ts)
compares supported argv, state and owned filesystem effects with the actual
native shell. PowerShell's separate function/method restriction and public
lifecycle coverage are described in the architecture contract.

## Shell Credential And Sink Classification

Host-shell credential and exfiltration analysis uses three buckets. An
identified floor takes precedence over an ordinary reason in the same input.
Existing hard-deny, destructive, explicit-ask, origin and explicit-host-execution
requirements keep their own authority.

| Bucket | Evidence | Permission behavior |
| --- | --- | --- |
| Floor | Sensitive/credential paths in argv, redirects, file-input values or literal inline code; retained credential-store, certificate-export and transport/sink catalogue effects | Per-call ask with `forceModal`, before allow rules or saved grants; never remembered |
| Ordinary | Parser refusal, budget exhaustion, opaque bindings, retained file-execution provenance, or an opaque package/code-runner prefix | `ordinaryAsk` / `ordinaryShellAsk` at layer 6 without `forceModal`; applicable rules and saved grants may satisfy it |
| Normal | Neither a floor nor an ordinary reason | Existing category, mode, rules and grants |

Ordinary asks remain rememberable under the existing approval-scope and risk
requirements. A parser refusal cannot establish a `Bash(...)` allow-rule match,
but it does not invalidate an otherwise applicable tool allow rule or saved
grant. An analysis failure retains visible credential and upload checks rather
than replacing an identified floor with an ordinary reason.

Hidden code alone limits `Bash(...)` allow-rule coverage; it does not create an ordinary ask. Statically bound direct interpreter inline and script-file forms follow normal mode handling without explicit restrictions, credential/sink evidence, opaque bindings or retained file-execution provenance. Existing deny/ask command-rule visibility behavior remains in force, and an allow rule does not prove script contents.

These are permission-classifier outcomes, not execution admission. A hard deny
cannot be approved. A floor's forced ask requires per-call consent but cannot
override a denied path operation or unsupported execution form. An ordinary
runner call such as `npx prettier .` can receive a covering command rule;
`source ./setup.sh`, declined by the separate path-authority contract, remains
rejected even after a permission grant. Deny rules decide before shell floor
prompts; independent execution gates can still reject an approved request.

`SHELL_PREFIX_POLICY.packageRunners` owns opaque runner identities, including `npm`, `pnpm`, `yarn` and `bun`. The shared prefix analysis reports `opaque runner prefix` through the shared `SHELL_PREFIX_POLICY.wrappers` grammar, including versioned runner spellings and supported executable/script suffixes. Runner options, source URLs, package forms and registry choices have no separate classifier policy. They do not establish a floor by themselves. File-input values such as `--env-file=.env`, including an implicit `.env` for a valueless `--env-file`, still receive sensitive-path inspection.

Code-executing runners keep their runner and proven literal command in a
persistent command prefix; an inner-only rule cannot authorize the runner.
Runners are never stripped as allow-rule-transparent wrappers. Their opacity
or unknown option spelling alone adds no hidden-code blocker. Existing opaque
syntax can retain structural rule blockers where matching cannot prove argv.
Runner argv remains available to raw command rules regardless of task spelling;
this does not expose or prove the effects of package/script contents.

Persistent runner-prefix validation requires a literal command boundary. An
option-shaped word before the command prevents persistence unless a literal
`--` establishes that boundary. No per-option arity or known-safe task table is
used. `npx tsc`, `npm test`, `pnpm dlx tsc` and `corepack pnpm install` retain
grantable persistent prefixes. Ambiguous forms remain ordinary and may be
covered by applicable exact-input saved grants, subject to independent gates.
Classifying a local argument as data does not grant execution, prove read-only
effects or establish a runner command boundary.

Literal downstream command candidates are inspected for known credential,
reader and sender effects only, without inferring safe argv from runner options.
Thus `npx curl -T file http://e` retains its upload floor; a plain GET or
`git push` does not establish exfiltration by itself.

The structural parser, sink vocabulary, Windows credential rows and general file provenance remain in force. Later execution of a file written, copied, moved, renamed, downloaded or extracted within the same input retains its ordinary reason unless an independent credential/sink is identified. Copied sender identities retain sink inspection. No package-task coupling infers execution from an arbitrary earlier file write or reads a manifest. Nonliteral `Invoke-Item` remains an ordinary ask without an independent floor.

PowerShell script blocks and `pwsh`/`powershell` inline command text use the PowerShell catalogue. Other interpreter code receives generic credential/sink inspection without inheriting PowerShell command meanings. Known catalogue effects remain floors through shared wrappers, process-launcher payloads, background execution and static or opaque transport splats. Sink-only wrapper inspection preserves the forwarded native command identity and grants no rule coverage.

`Bash(...)` rules remain dialect-scoped. PowerShell has no per-command rule
language or project command-rule scope today. Existing tool allow rules and
saved grants can satisfy its ordinary asks; no new command-rule grammar is
implied.

The sink catalogue is retained because shell egress has not been delegated to a
proxy. The OS tool sandbox remains opt-in; its current network allowlist is
shared and strict, without per-domain approval or denial UI. Windows host-shell
execution remains a plain child. This classification contract changes neither
sandbox/proxy behavior nor the normal sandbox-off approval path. Native shell
execution and egress behavior are outside the classifier validation evidence.
The [implementation design](../design/permissions-always-allow-and-judge.md#shell-classification-buckets)
records the retained credential and sink coverage. The guest risk grading below
is a separate contract.

## Shell Execution And Explicit Host Approval

### Route-neutral execution foundation

Shell authorization and execution location are separate decisions. The
route-neutral contract in
[execution-router.ts](../../src/permissions/execution-router.ts) defines three
possible substrates:

| Route | Intended boundary | Current availability |
| --- | --- | --- |
| `workspace-sandbox` | OS-enforced workspace-scoped shell | Mapped from a full ASRT shell plan. |
| `disposable-container` | Disposable Linux guest | Available through either strict same-process operator attestation or the host-native workload broker. These are distinct authorities. |
| `host` | Current-user host shell | Mapped from a legacy plain-shell plan. Existing approval rules remain authoritative. |

The Host hashes the normalized request into an immutable `EffectEnvelope`,
issues a generation-bound `ExecutionCapability`, and produces an immutable
`ExecutionPlan` with the chosen route, decision and fallback. Raw command text
does not enter the route projection. Stable identities cover the effect digest,
cwd, unresolved requirements, runtime limits, capability generation and final
decision, so a changed request or capability generation cannot reuse the same
identity. Structural lookalikes are not host-issued capabilities, plans or
grants.

`workspace-sandbox` requires the issued legacy plan to declare both filesystem
and process confinement as `true`; an omitted legacy `confines` field is not
treated as full confinement by the route-neutral layer. The capability
generation is captured with the legacy plan at issuance and must match the
route capability. A later sandbox generation cannot be paired with that stale
plan, and a grant cannot be issued after its generation becomes stale.

The legacy `HostShellExecutionPlan` still supplies workspace-sandbox and
plain-child mechanics. Without a workload broker, the router orders a full
workspace sandbox first, a live operator-attested disposable guest second, and
an unconfined host last. An active workload broker is exclusive: it advertises
only `disposable-container`, so a broker outage or rejected capability cannot
become local execution.

After normal authorization, each disposable invocation receives an immutable
one-shot `ExecutionGrant`. A shell grant binds the final command, resolved cwd,
runtime limits, legacy plan and capability generations. A canonical-file grant
binds the exact host-created tool instance, schema-normalized input, guest cwd,
broker identity and generation. The consumer checks object identity, route,
effect digest and current generations, then consumes the grant once. Missing,
forged, replayed, mismatched, expired or stale grants fail closed. Audit metadata
records the chosen route and a public-safe capability projection.

Shell path results distinguish a hard policy boundary from an
`analysis-uncertain` requirement. An uncertain default request may not select
the host route automatically. The same-process operator-attested route can
satisfy dynamic, recursive and guest path-boundary uncertainty, but it retains
the host shell grammar, structural and sensitive-path checks before spawning in
that already-confined process.

The host-native broker route has a different boundary. The controller cannot
open the workload filesystem directly, and the workload is created without
host binds, devices, Compose secrets/configs, added Linux capabilities or
controller environment. The executor therefore does not canonicalize guest
paths against the host filesystem and does not run the host Bash structural
parser on a command that the broker executes inside the guest. Guest paths are
normalized with POSIX semantics against the capability-bound guest cwd or HOME.
Normal tool authorization, reviewer policy, audit, request bounds and deadlines
remain mandatory. PowerShell has no broker backend and fails closed.

The reviewer grades a routed invocation against the substrate its effects land
on. When the executor selects `disposable-container` for a shell **through the
workload broker**, or the brokered canonical route for a file tool, it records
that host-derived `DisposableSubstrate` on the invocation's permission context
(assigned on every invocation, so a value inherited on a caller's context never
survives onto a host-routed call), and
[sandbox-capability.ts](../../src/permissions/sandbox-capability.ts) resolves
the reviewer capability to `disposable-container` (verified; filesystem and
process confined, network not claimed) ahead of the host-shell plan, whose
`none` describes a plain child that call never spawns. The rule classifier
then grades guest-scoped effects as such. A read or write of any guest path
is LOW. A guest shell is graded first match wins:

1. **Destructive → MEDIUM** (a structured denial on the headless lane, an ask
   in the foreground). Matched on raw text and on tokens, so quoted command
   names, long options and `--` count; a dangerous long option matches when
   its spelling is a prefix of the dangerous name, the way GNU and git resolve
   abbreviations. This covers `rm`/`unlink`/`shred`/`truncate`/`dd`,
   `find -delete`, `git clean`, `git reset --hard`, `git checkout -- <path>`
   and `git checkout .`, `git restore` without `--staged`, `git stash
   drop`/`clear`, rsync `--del*`/`--remove-source-files`, tar
   `--remove-files`, git ref deletion and forced ref overwrite (`git branch
   -d`/`-D`/`--delete`/`-f`/`-M`/`-C`, `git tag -d`/`--delete`/`-f`, `git
   checkout -B`, `git switch -C`, `git fetch --prune`/`--prune-tags`/`--force`,
   a forced refspec with a destination on `git fetch`/`git pull`
   (`+main:main`; a bare `+main` only updates remote-tracking refs, which the
   default refspec already forces), `git remote remove`/`prune`, `git mv -f`),
   `git checkout <tree-ish> <path>…` (two or more operands; a single operand,
   `git checkout f.txt`, cannot be told from a branch switch on the line and
   stays LOW — a stated limit), abandoning an in-progress merge,
   rebase or pick (`--abort`, `--skip`, `--quit`), the deleting git forms
   that are not on the allowlist at all (`git gc`, `git prune`, `git reflog
   expire`/`delete`, `git worktree remove`/`prune`, `git notes
   remove`/`prune`, `git update-ref -d`, `git symbolic-ref -d`, `git push
   --delete`/`--force`/`:ref`/`+ref`), and inline interpreter code (`python -c`, `node -e`,
   `perl -e`, `ruby -e`, `php -r`, a program read from stdin or a `data:`
   URL), whose effects cannot be graded from the line. Only deletion and
   discard verbs are destructive: a content edit, including emptying a file
   through a redirect (`> f`), `cp /dev/null f` or an editor (`sed -i d f`),
   is a plain edit and is not graded as destructive in the guest. History
   rewrites the reflog can recover (`git reset` without `--hard`, `git commit
   --amend`, `git rebase`) stay LOW; `git branch -f`/`-D` are destructive
   because they can drop an unmerged ref the reflog of `HEAD` never held.
   Removing regenerable state stays LOW too: build outputs and packages
   (`cargo clean`, `mvn clean`, `npm prune`, `apt-get purge`/`autoremove`)
   and `rmdir`, which only removes an empty directory, are not user work.
2. **Not on the guest allowlist → MEDIUM**, because the guest does not
   confine network. A leaf's argv and supported command structure must be
   visible on the line, subject to the script and planted-file limits below:
   any `$` expansion or backtick, any `NAME=value`
   environment assignment (including through `env`), `xargs`, or a
   `/dev/tcp`/`/dev/udp` path makes it ineligible. An eligible leaf must then
   match its tool's argv spec exactly: every option an exact allowlisted
   spelling for that tool and subcommand (so an abbreviation or an unknown
   letter in a short cluster fails, and no option value may carry a URL or a
   remote `host:path` — a `:` before any `/` — since tar, rsync and cp-like
   tools open a connection for that form: `tar -cf host:/a.tar` stays MEDIUM,
   and so does the same value after `--force-local`, which is admitted only
   for local archives. Options whose value is text rather than a file — a
   commit message, a format, a pattern, a date — are declared per tool and keep
   only the URL check, so `git commit -m "fix: x"` stays LOW. Toolchain
   flags passed through to another tool are parsed into their own words: go
   `-ldflags` admits only `-s`, `-w`, `-X name=value`, `-buildid=`,
   `-linkmode=internal` and similar, and `-gcflags`/`-asmflags` only
   optimisation, diagnostic, define and include flags, so `-extld`,
   `-extldflags`, `-linkmode=external`, `-importcfg` or any unknown tool
   flag is not LOW; a cargo `--target` must be a triple-shaped name, never a
   `.json` target spec path that can name the linker (a name that is not
   built in resolves through rustc's target search, so a planted target file
   is the planted-file limit); `rustc -C`, `cargo rustc` and
   `RUSTFLAGS` are not allowlisted), and
   every positional the tool's predicate — a bare package spec for installs
   (no URL, VCS or `@`-URL form, no source, registry, index or config
   option; a local path only as an editable target, `-e .`, or a requirement
   or constraint file, `-r requirements.txt`), a local path word (path
   characters only, so never a command string or a `host:path`), a literal
   git clone/fetch source (including the scp form `git@host:repo.git`), or for
   `curl`/`wget` a plain public URL with exact GET-only options. Wrappers that
   run another program (`uv run`, `bundle exec`, `bun run`, `bun x`, `npx`,
   `pnpm exec`, `yarn dlx`, …) grade the wrapped argv as a command of its own.
   `bun run <name>` is graded this way by design: bun resolves the same word
   to a package script, a file or a binary, and the line cannot tell which, so
   a script name that is not itself an allowlisted command (`bun run build`)
   stays MEDIUM, unlike `npm run <script>`. A name that coincides with an
   allowlisted command (`bun run test`, `bun run tsc`) grades as that command
   and is LOW; the script it may run instead is the same stated limit as
   `npm run <script>` below.
   A tool whose first positional is a subcommand names the allowed words
   explicitly (`git submodule update|init|status|sync`, never `foreach`), and
   options that name a program to run (`sort --compress-program`, `split
   --filter`, `install --strip-program`, `rg --pre`, `fd --exec`, `ag
   --pager`) are refused even on verbs that are otherwise local. That
   program-option guard is the host's own: the host read-only classification
   (`host-risk-inspector.ts`) uses the same check, so on the host too a
   read-only verb handed a program (`sort --compress-program` and its
   abbreviations, `ag --pager`, `rg --pre`/`--hostname-bin`, `fd --exec`/`-x`)
   is an execution, not a read. The host also resolves GNU getopt
   abbreviations of write flags (`sed --in-pl`, `sort --out`), treats
   `GIT_CONFIG_PARAMETERS` as an execution-selecting environment variable, and
   does not read `git reflog expire`/`delete` as an inspection: they rewrite
   the reflog.
   Everything else — any shell binary, `exec`, `eval`, `builtin`,
   `source`/`.`, BusyBox, aliases, a pipe or here-doc into a shell, unknown
   verbs, a path-qualified program outside the system bin directories, input
   the tokenizer cannot parse — stays MEDIUM.
3. **Otherwise LOW.**

**This does not detect every way data can leave the guest.** These channels
are not inspected and rely on the guest's own egress policy:

- The literal URL path, hostname and DNS lookup of an allowed download or
  clone are themselves a channel; a plain public URL is not proof that
  nothing is carried.
- Script files run by an allowlisted interpreter (`python3 x.py`,
  `node x.js`), and build, test and package tools that run project or package
  code (`make` including `make --eval` and `make SHELL=`, `npm run <script>`,
  `pytest -p`, install and build scripts, git hooks), and programs run from
  a module reference (`go run <module>@latest`).
- awk's `/inet/tcp` special files.
- Files an earlier guest write planted: config files (`.curlrc`, `.wgetrc`,
  `pip.conf`, `.npmrc`, `.git/config`) and requirement or constraint files
  (`pip install -r requirements.txt` reads `--index-url` and URL lines from
  the file).
- `git ext::` transports in a clone source are refused here and are also
  blocked by git's default `protocol.ext.allow`.

A listening server such as `python -m http.server` is inbound only and is not
egress.

Network-category tools are graded by the network rules exactly as on the
host. The
operator-attested container never becomes a substrate: it is same-process, the
shell is a plain child of the controller sharing its `~/.ave`, pid namespace
and environment, so that route keeps the host-shell plan grading. Approval
requests for a broker-routed shell carry the guest capability rather than the
host plan of a child that never spawns. The verdict
cache keys by the guest identity, so a host verdict never serves a guest call
and vice versa. An unverified or partially confined guest earns no relaxation.

The [Linux workload resource controller](linux-workload-resource-controller.md)
is a separate unwired foundation. Its cgroup-v2 leaf limits and OOM evidence do
not issue either disposable authority. The Docker broker independently binds
and revalidates the exact container cgroup's `memory.events` for OOM evidence.

Execution location, configuration, authentication and OS identity are separate
properties. ASRT launches processes on the current host with a temporary HOME
and configuration profile for each invocation. It does not inherit the user's
terminal login state. Plain execution uses the host HOME and filtered child
environment. Both run as the current OS user; selecting host execution grants
no administrator privileges. The final host-owned execution plan determines
confinement; a temporary HOME alone is not an OS sandbox.

Bash and PowerShell accept `executionMode: "default" | "host"` and an optional
`justification`. Omission keeps the default route. An explicit host request
requires a nonblank justification and foreground execution. The host selects
the final plan after input hooks and before environment capture and path
analysis. Outside an operator-attested guest, host mode selects plain execution
without OS confinement and requires a fresh exact-action `allow-once`, including
in allow mode or when sandboxing was already disabled. Sensitive-path,
directory, command and dynamic-syntax checks remain mandatory on that route.

Only a response from the verified local desktop renderer can authorize this
explicit request. The approval displays the exact command, cwd and justification
and states that the command runs once as the current user without the OS sandbox.
Headless and remote-controller requests are denied before approval. Automatic,
remembered, plugin, platform and parent-agent decisions cannot authorize host
mode. The signed approval receipt binds the final action; an opaque permit is
consumed once before spawn. Changed commands, cwd, plans or request fields and
replayed permits fail closed. The parser and plan in
[host-shell-execution-plan.ts](../../src/permissions/host-shell-execution-plan.ts),
the [approval gate](../../src/permissions/approval-gate.ts) and
[execution permit](../../src/permissions/host-shell-execution-permit.ts) own this
contract.

Inside a live operator-attested disposable one-shot, `executionMode: "host"`
means the strongest shell authority reachable by that process, which is still
the disposable guest. The router therefore selects `disposable-container` and
does not present or require an approval for an unconfined host it cannot reach.
If reacquisition fails or the capability changes before grant issuance, the
invocation fails closed instead of degrading to a plain host child.

Every plain-shell call requiring one-shot consent exposes its complete command
and resolved working directory before the decision. If sensitive-data masking
would change its arguments or working directory, the gate rejects the request
before parking it. Masking is retained; hidden command bytes cannot receive an
execution permit through a redacted display.

Host execution is not a credential broker. Programs may consult host
configuration, but the environment filter does not forward token variables or
the SSH agent, and authentication success is not guaranteed. Without OS
confinement, this feature cannot guarantee that arbitrary programs never read
credential files. The actual environment remains owned by
[safe-env.ts](../../src/tools/safe-env.ts) and the prepared invocation.
[shell-execution-environment.ts](../../src/shared/shell-execution-environment.ts)
provides shared descriptions for the system prompt and approval UI; the prompt
describes the default route, while the approval describes the final call's plan.

## Default Allowed Roots

Layer 1 seeds its allow-list from the project root, the application data root
(`aveHome()`) and the application scratch directory, as
[allowed-directories.ts](../../src/permissions/allowed-directories.ts)
computes them. The scratch directory
([ave-scratch.ts](../../src/shared/ave-scratch.ts)) is `ave-scratch-<uid>`
under the platform temp root: boot creates it with `0o700`, and it is offered —
to the model in the environment block of the system prompt as
`scratchDirectory`, and to the allow-list — only while it still verifies as a
real directory (not a symlink) that this account owns and no other account can
read. The check is a per-call `lstat` at each offer, not a guarantee across the
gap to the write itself. The name is keyed by uid and a digest of the
application home, so an isolated `AVE_HOME` gets its own scratch directory. A
directory another local account planted first under a shared `/tmp` fails the
check and is reported at boot; the prompt then says no scratch directory is
available, and nothing substitutes the temp root for it. The rule classifier
does not treat depth below the verified scratch root as a signal, so a staged
build tree there is graded like any other scratch write. The platform temp roots themselves are not a Layer 1 default; the
conversation loop adds them to its per-turn base set
([base-allowed-directories.ts](../../src/permissions/base-allowed-directories.ts)),
where the world-writable `/tmp` tradeoff is stated. Layer 0 still hard-blocks
sensitive leaves beneath any default root, and `permissions.additionalDirectories`
extends the list rather than replacing it.

## Saved-Session Reads

Tool policy permits reads of the configured primary session store and denies
write and delete effects. Its root comes from
[sessionStorePath](../../src/shared/session-store-path.ts) under the application
data root resolved by `aveHome()`; `AVE_HOME` relocation applies to storage and
read policy together. This grants no access to another session-store namespace,
credentials, audit or routine state.

The per-turn environment context publishes the exact application root and
primary session-store path as JSON through the same path helpers. These are
operational tool inputs; audit path redaction does not apply to them. The model
uses the absolute store path with `list_files` and `read_file` rather than
inferring it from a shell's temporary HOME. Publishing a path does not grant
access or change shell expansion and permission checks.

[sensitive-paths.ts](../../src/permissions/sensitive-paths.ts) owns the namespace
classification and canonical-path checks. Supported file reads and shell
commands with proven read effects can reach this root even when ordinary reads
are confined to working directories. A linked session root or an escaping path
cannot widen that grant, and other sensitive-path rules still apply inside it.
Only the builtin shell wrapper receives that root through
`getBuiltinShellSessionReadPolicy` in
[asrt-sandbox.ts](../../src/permissions/asrt-sandbox.ts). The global read-deny
floor still protects sessions from confined plugin, MCP and terminal processes.
The builtin projection retains other sensitive paths, nested exclusions and
trusted custom read denies; a conflicting protected ancestor suppresses the
session grant. `getBuiltinShellReadPolicy` composes invocation reads for both
shell dialects. It omits redundant read grants strictly above HOME, which
otherwise cause the native runtime to reapply the HOME deny after narrower
grants. Surviving read candidates cannot reopen another protected deny; write
grants and the sensitive write-deny floor remain intact.
Removing a read-deny pattern alone
does not establish this contract: both the file gates and actual sandboxed reads
must enforce the same boundary. Structured transfers retain their write-effect
checks on both endpoints.

## Structured File Transfers

`copy_path` declares `sourcePath` and `destinationPath`; `extract_archive` declares `archivePath` and `destinationPath`. Both tools are builtin writes, and both endpoint fields are declared in `pathFields`. The executor resolves these paths for the existing scope checks and write approval. Approval reuse is bound to the semantic operation and both resolved paths.

At execution, [file-access-policy.ts](../../src/tools/file-access-policy.ts) applies the existing FileTool gate with a write effect to both endpoints and every reached child. A transfer's source therefore remains confined to the invocation's admitted `cwd` and extra allowed directories even when ordinary reads are unfenced. Sensitive-path checks, canonical resolution and existing path grants retain their usual authority. Outside requests use the existing approval route; the tools do not grant themselves access or widen the roots. Allow mode does not bypass these checks.

The [structured transfer contract](architecture.md#structured-file-transfers) defines the absent exact destination, ownership, supported entries and cleanup limits. These tools add no shell exemption: recursive shell copying, archive creation and shell extraction remain denied. Guidance can recommend `copy_path` for supported copying or `extract_archive` for tar/gzip extraction; ZIP extraction and archive creation remain unavailable.

## Policy Modes

| Mode | Behavior |
| --- | --- |
| Default | Allows low-risk workspace reads; asks for mutation, network, shell, and out-of-scope access. |
| Strict | Asks for reads as well as mutation. Useful for high-control sessions. |
| Auto-review | Uses the reviewer for eligible write/network/shell calls and host-built-in `meta` calls declared with `decisionOverride: "ask"`. The same configured enabled threshold (low or medium) applies to every eligible call; higher verdicts ask or defer, while `off` keeps the explicit foreground approval path. |
| Allow | Allows after hard gates and audit. Sensitive paths, invalid manifests and sandbox rules remain enforced. An ordinary shell reason still asks without an applicable allow rule or saved grant. |

## Foreground And Headless Behavior

Foreground requests use one bottom-floating, non-modal approval dock because the user is present.
The dock shares the routed canvas, does not create a backdrop or focus trap, and
keeps the surrounding page readable and operable while execution remains
blocked on an explicit decision. Headless requests must not interrupt the user
with a surprise foreground surface. Non-low headless requests move to the
deferred queue and surface through a queue button or history view.

Process-level approval availability is a separate host capability. Native
`--exec` keeps the normal main-chat tool and egress scope rather than setting
the routine `headless` loop flag. Instead, exec-mode mints a host-issued
unattended turn authority (`UnattendedTurnAuthority`) for each turn it runs,
and the query loop projects that authority onto the turn's tool permission
context as the unattended (`headless`) policy lane marked `ownerUnattended`.
The owner started the turn with nobody to ask, so an ask on that lane follows
the routine contract: mutating builtin calls route to the reviewer (LOW allows;
MEDIUM and HIGH deny with a structured tool error the model sees), an
out-of-directory request is recorded in the deferred queue and denied for the
turn, and explicit host execution fails closed. Unlike a background routine,
the turn is the owner's own gesture, so their allow rules (layer 3) and "Allow
always" grants (layer 5) still apply before the reviewer lane does. The
authority is never parsed from chat input, is minted per turn, and is spent by
the turn that carries it, so a retained session's later turns, which arrive
through remote surfaces, cannot inherit or replay it. A turn without that authority that still
requires explicit authorization ends with the typed `authorization-required`
terminal, which the model cannot retry; that remains the outcome for an
attached client's turn and for a child agent boundary re-issued through
`agent_spawn`. Routine loops keep their existing `headless` deny/defer/reviewer
semantics even when the containing process also lacks an approval surface.

Closing a deferred modal does not grant permission and does not delete the audit
record. It leaves the item pending or closed according to the queue state.

An unanswered approval that expires is distinct from a user or parent refusal.
Host-owned expiration and rejected-request outcomes propagate through
[approval-outcome.ts](../../src/tools/pipeline/approval-outcome.ts) to tool and
directory approval results and audit reasons. Expiration does not grant access,
change the approval deadline or alter command timeouts and cancellation.

### Headless operator container attestation

A Linux one-shot launch may name an operator-produced attestation with
`--exec-operator-attestation=<absolute-path>`. An explicit attestation is
verified before the service graph, model connection, or installed plugins
start. Absence preserves the ordinary headless behavior. The option is invalid
without `--exec`, with `--set-secret`, or on a non-Linux host.

The JSON document is limited to 64 KiB, rejects duplicate and unknown members,
and has these exact top-level fields: `version`, `audience`, `keyId`,
`issuedAt`, `notBefore`, `expiresAt`, `claims`, and `signature`. Version is
`ave-operator-container-attestation/v1`; audience is `ave-headless-exec`.
The host opens one regular-file descriptor and bounds the read to 64 KiB plus
one rejection byte, so a metadata race cannot cause an unbounded read. The
validity window is at most five minutes. `signature` is an Ed25519 signature
over the canonical JSON encoding of the other seven fields: object keys are
sorted recursively by UTF-16 code units, arrays retain their input order,
strings and the schema's safe integers use `JSON.stringify` encoding, and the
result is signed as UTF-8 bytes.

`keyId` selects only
`/etc/ave/operator-trust.d/<keyId>.pub`. The document cannot carry a public
key. The trust directory must resolve to that fixed canonical path, be owned by
root, exclude group and other writes, and reside on a read-only mount. The host
opens the directory and PEM public-key file without following their final path
components, resolves the opened descriptors through `/proc/self/fd`, and
requires both descriptors to identify the same read-only mount. It obtains
metadata and bytes from that one opened key descriptor. The key must resolve
within the directory, be root-owned, have no write bits, and contain an Ed25519
public key. Tests may inject a different root into the non-authoritative
verifier, but the production issuer cannot select one from the command line or
environment.

The signed `claims` object contains exact fields for:

- operator-established `disposable`, `noHostMounts`, `noHostNamespaces`, and
  `noInheritedSecrets` assertions, all set to true;
- the current mount, PID, network, IPC, UTS, cgroup, and user namespace links;
- the cgroup v2 membership path and finite `memory.max`, `pids.max`, and
  `cpu.max` values, read through descriptors on one read-only cgroup v2 mount;
- a normalized mount-info digest and normalized root-mount tuple;
- the boot ID, PID, and `/proc/self/stat` start-time ticks;
- the normalized `uid_map` and `gid_map`, each fixed to the full host identity
  mapping `0 0 4294967295`;
- all four real/effective/saved/filesystem user IDs plus `NoNewPrivs`, `Seccomp`,
  `CapInh`, `CapPrm`, `CapEff`, `CapBnd`, and `CapAmb` from `/proc/self/status`.

The verifier reads those facts from the current process and requires an exact
match after signature verification. `NoNewPrivs=1`, seccomp filter mode,
non-root real, effective, saved, and filesystem user IDs, full host identity
maps, and finite resource limits are mandatory. Every signed capability set
must exclude
`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `SYS_ADMIN`,
`SYS_PTRACE`, `SYS_MODULE`, `SYS_RAWIO`, `NET_ADMIN`, `BPF`, `PERFMON`, and
`CHECKPOINT_RESTORE`; other signed bits remain visible to later policy rather
than being rejected implicitly. The membership path is interpreted relative to
the cgroup namespace root; the host does not compare it with mountinfo's
host-relative cgroup root. It opens the membership directory and each limit
file, then rejects any descriptor whose mount ID differs from the selected
cgroup v2 mount or whose kernel filesystem type is not cgroup v2.

The verifier resolves `/proc/self` once to `/proc/<pid>` and uses only that
numeric path for process observations. The process files `mountinfo`, `cgroup`,
`status`, `stat`, `uid_map`, and `gid_map` must be opened on the procfs mount
covering that numeric directory; namespace and `fdinfo` paths must use that same
mount rather than a nested proc bind. Independent `statfs` checks require the
kernel's procfs magic before mount-table contents are trusted. The boot ID may
reside on another procfs submount. These checks and the host identity maps stop
an unprivileged user namespace from substituting a namespace-local UID-0 trust
root. A privileged host administrator remains inside the operator trust
boundary. The signed mount digest exposes the remaining procfs view to the
operator.

The signer must run outside the attested process's namespaces, keep its private
key unavailable to the process, and observe the exact target PID from the host
side after creation. It must independently establish the no-host-mounts,
no-host-namespaces, no-inherited-secrets, disposable-lifecycle, and limit
claims. The signer also owns termination and disposal enforcement. The host
verifier cannot derive those host-relative properties from inside the
container.

Successful production verification issues a frozen, host-owned capability
tracked by weak identity. Injectable verification used by tests returns only
inert evidence and cannot invoke the private capability issuer. Public and
audit projections contain only an ID, generation, expiry, fingerprints, the
four boolean isolation assertions, and resource limits. They contain no
signature, public-key bytes, process fields, namespace links, paths, or mount
inventory. The signed v1 expiry remains an authority deadline: production
checks it before publication, at every acquire, again after the asynchronous
process/confinement observation, and synchronously when a one-shot lease is
consumed. Every acquire also re-reads and matches the exact process identity,
namespaces, cgroup, mounts, status and limits. A long-lived operator must obtain
a newly signed attestation; renewal semantics must use an explicit new contract
if they differ from v1. Each
grant-minting acquire returns a nominal lease bound to that exact capability
generation, and execution-grant issuance consumes the lease once. A forged,
replayed, or stale lease cannot mint a grant. Controller termination revokes
the in-memory capability and all leases; attested-process termination changes
the observed process identity and makes the next acquire fail. These lifecycle
events and the signed expiry are the v1 revocation boundaries.
The grant-minting acquire runs after asynchronous PreToolUse hooks, plugin
admission, rate checks, and audit-readiness checks. The handler receives the
grant at the final effect boundary, with no intervening await that could make
the observed confinement stale before dispatch.

The execution router consumes this capability only for builtin shell work in
the same attested Linux one-shot. The capability does not itself authorize a
tool,
skip structural command checks, alter reviewer outcomes, or make a non-attested
process disposable. The v1 profile remains strict: the four isolation claims,
including no host mounts and no inherited secrets, are all mandatory. Workloads
that need a bounded artifact mount or a different capability set require a
separately specified profile/version and cannot weaken v1 by convention.
The benchmark Docker `main` process therefore uses the separate broker contract
below rather than presenting itself as this attested process.

### Terminal permission-audit proof

The native runtime exposes one internal pre-boot command,
`--verify-permission-audit=<challenge>`, for a stopped host. The 64-lowercase-
hex challenge binds a public `ave-permission-audit-proof/v1` receipt to its
collector. The verifier requires explicit absolute `AVE_HOME` and protected
`AVE_SECRET_KEY_FILE` inputs, opens the existing encrypted audit HMAC secret
read-only, and never creates, repairs, or replaces audit authority.

Every permission-audit-looking directory entry must have the canonical
`YYYY-MM-DD.permission-audit.jsonl` name. The verifier stable-opens each
owner-only 0600 regular single-link file, verifies its complete HMAC chain and
the separately stored daily seal for every nonempty file, and rejects directory
or file changes during the read. Success writes exactly one public JSON receipt
with basename/date/SHA-256/byte/entry metadata. Secret material, stored seals,
paths, rows, and entry fields never cross this boundary. `AuditLogger.close()`
stops new permission appends and drains the accepted append tail before this
proof may freeze the files.

The packaged launcher removes the inherited Node preload/module-search and
Node/Electron process-role variables named by
`ave-headless-launch-environment/v1` before starting the runtime. The native
dispatcher reserves bare, malformed, and duplicate proof forms, so none can
fall through into normal host boot. Failure output is one stable public error
code (`invalid-arguments` before verification or `verification-failed` after
it starts); raw filesystem and decryption errors remain inside the process.

### Host-native workload broker

The brokered Linux route keeps the Ave controller, controller profile,
encrypted provider secret, external key, broker credential, receipts and logs
on the host. Harbor's incoming mounts and persistent controller environment are
discarded. Task files and role logs cross later through Docker copy; `main`
receives no host bind, Docker socket, capability file, Unix socket, receipt or
controller environment.

The environment binds the route to exactly one Docker Compose service
`main` container. The published workload identity contains the 64-hex container
ID, `sha256:` image ID, fresh generation, boundary fingerprint, guest cwd and
guest HOME. The broker's host-only binding additionally pins Docker `StartedAt`,
the trial ID and Compose project/service/container-number labels. Startup
rejects effective Compose configuration with host binds,
devices, device rules, `cap_add`, Compose secrets/configs, privileged mode,
host PID/IPC/UTS/network/user namespaces or controller transport environment.
Before every effect, the broker rechecks the exact container and image,
`StartedAt`, labels, running state, no binds or devices, private cgroup
namespace, finite memory/swap/PID limits, `no-new-privileges`, non-host
namespaces and no-restart policy. It also pins the container's cgroup-v2
`memory.events` device/inode and `memory.max`.

The host publishes `ave-workload-broker-capability/v1` only after Docker event
monitoring and identity evidence are live. The document contains the absolute
socket path, a random bearer token of at least 32 bytes, UTC expiry, exact
workload identity, ordered allowed operations and request/response byte limits.
It is one owner-owned mode `0400` regular file in a host-only mode `0700`
control directory. The socket is mode `0600` in a separate owner-owned mode
`0700` directory. Ave rejects symlinks, changed inode metadata, wrong owners or
modes, an unbound socket path, expiry and handshake field/order mismatches before
constructing host services. The capability read holds its real parent directory
open and rechecks both the directory and file path bindings before accepting the
document. It repeats the exact handshake before every operation.

Only host-created builtin Bash and canonical file-tool instances can receive
broker grants. Canonical file operations are `read`, binary read, list, glob,
grep, write, edit, patch, move, copy, extract and delete. Background Bash start,
read and kill retain the same broker capability and session ownership. A plugin
or MCP tool that copies a builtin name or schema is not canonical and receives
no grant. Once broker mode is active, missing or invalid authority returns a
typed broker error and never calls a host shell, host path resolver or local
file implementation.

Foreground and background shell terminals use the closed statuses `exited`,
`signaled`, `timed-out`, `cancelled`, `oom-killed`, `transport-failed` and
`cleanup-unproven`. A terminal result carries exit code, signal, timeout and
cancellation flags, cgroup OOM delta, `ownedResourcesZero` and the hash-chained
receipt digest. `oom-killed` requires an increased cgroup-v2 OOM counter; exit
137 or `SIGKILL` alone is insufficient. Timeout, cancellation, transport
failure or unproven identity triggers fail-closed removal when the broker cannot
otherwise prove the Docker exec is gone. `cleanup-unproven` is the only terminal
status allowed to report `ownedResourcesZero=false`.

The host controller runs under a separate Linux child subreaper. After the turn,
the supervisor terminates and reaps the controller process group and adopted
descendants, and publishes its own zero-resource receipt. Broker release then
stops accepting requests, proves that broker-owned exec handles are zero,
removes the bearer capability and socket, and records `broker_released` while
retaining the exact running `main` container for the shared verifier. If that
proof fails, the broker removes `main` and verification is suppressed. Final
environment teardown force-removes the exact container, proves its absence,
records `cleanup_completed` and `broker_stopped`, and then removes remaining
Compose resources. These receipts validate lifecycle ownership; they do not
claim a benchmark score or task correctness.

## Reviewer Failure

Reviewer input separates host-computed policy facts from OS isolation. The host
supplies the existing rule verdict, execution directory, and canonical declared
path checks using the same resolver and containment predicates as the rule
classifier. These facts describe declared operands; they do not attest that a
plugin or custom tool has no other effects. A builtin file operation running
inside the host process has no OS sandbox, but its file-path gates still apply.
Weak isolation or missing conversational purpose preserves the rule floor and
does not alone establish an out-of-scope or destructive write. The model can
still raise risk for additional effects or uncertainty, and the host retains
the maximum of the rule and model verdicts. Reviewer framework changes invalidate
cached verdicts. DLP filtering applies to the policy-fact projection as well as
tool arguments and conversation context.

Reviewer failure is not a silent allow. If the provider is missing, times out, or
returns malformed output, the host fails closed:

- foreground calls ask the user with explicit reviewer-unavailable context;
- headless calls defer or deny according to configured failure behavior;
- audit records include the reviewer failure path.

A windowless host reports `authorization-required` only after a completed
policy outcome actually needs human consent. Missing reviewer wiring, timeout,
malformed output, and provider failure remain ordinary failed assessments;
exit `77` does not claim that approval can repair them.

An unavailable or failed assessment does not prevent the user from remembering
an ordinary request. The approval gate derives `persistentAllowAllowed` from
host-owned request context and typed reviewer outcomes. The dispatcher issues
exact-input-bound evidence from its existing raw-input rule trace; the gate
uses this evidence without reclassifying display data. A conservative HIGH
display during assessment failure is separate from a completed HIGH judgment.
Completed HIGH judgments, changed sandbox state and mandatory one-shot requests
retain their restrictions, including explicit host execution, remote controllers
and sealed rationale approvals.

“Always allow” stores the exact tool, canonical arguments, source, trust origin
and invocation working-directory identity. Existing tool-specific identity and
the host shell's sealed execution plan remain part of the key. The versioned
directory scope prevents reuse across projects. Older unscoped allows no longer
match scoped requests; existing policy rules and exact denials retain their
identity and precedence. Exact rejections remain independent of cwd. The host
captures the canonical directory before displaying its scope and recording its
frozen identity. The UI does not create a wildcard rule. Recording
requires fresh user intent and a live host approval snapshot. On subsequent
calls, hard denies and per-invocation approval requirements still run before the
remembered-decision lookup. Both memory consumers compare current deterministic
risk with the stored reuse ceiling, separately from conservative display risk.

## Plugin And MCP Tools

Plugins and MCP servers use the same path as builtin tools. The tool provider
must declare schemas. Manifest categories are optional provider metadata; the
host derives the effective category per invocation and policy logic remains
host category- and origin-driven.

Low-trust MCP tools cannot lower their risk solely through a reviewer verdict
when hard policy requires explicit approval.

## Local API Permission Mutation

Local API calls that mutate permission mode route through the approval gate as
agent actions. The renderer-facing reason defaults to English. The gate owns the
final explicitness requirements and denial behavior.

## Audit Requirements

Audit records should include:

- tool name and source;
- category and permission mode;
- trust origin;
- project identity when available;
- decision and decision reason;
- reviewer verdict or reviewer failure state;
- deferred queue state for headless requests.

Audit records must not contain raw secrets or unnecessary private payload data.

## Test Coverage

The permission scenario board and unit tests under `src/permissions/__tests__`
encode the expected behavior for default, strict, auto-review, reviewer
failures, invalid plugin manifests, MCP tools, overlay prompt imports, and
headless deferred queue behavior.
