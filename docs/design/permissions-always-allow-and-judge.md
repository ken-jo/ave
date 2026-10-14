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
- interpreters, alone or with an option (`python -c`, `node -e`);
- wrappers at any length (`env`, `xargs`, `sudo`, `eval`, `exec`, `source`, `timeout`, `nice`, …);
- package runners alone (`npx`);
- multi-verb tools alone or with a leading option (`git`, `git -c`, `npm`);
- `npm exec`, `bun x` and similar.

Refused prefixes can still be approved once or for the session.

**5. Shell verdict.** The blanket `shell → high` in `resolveUserApprovalVerdict` is no longer the first answer.
- An unreviewed shell ask carries the host's rule-classifier verdict (`ApprovalRequest.ruleVerdict`): read-only is LOW, ordinary is MEDIUM, destructive is HIGH.
- Destructive commands stay once-only.
- With no verdict at all, the fallback is still HIGH (fail closed).

**6. Persistence.**
- "Always allow" for a project writes the per-project rule file in Ave home: `<ave home>/permissions/project-rules/<identity>.json`. The identity is the Store B working-directory identity of the project root (sha256 of the case-folded canonical realpath). Ave never writes rules into the user's repository.
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
2. A corrupt rule file returns a forced ask that names the file.
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

They cannot see inside:
- code passed as a string (`bash -c`, `python -c`, `eval`, awk programs);
- `find -exec`;
- unsupported syntax.

When any deny or ask `Bash(...)` rule exists and the command contains one of these, the decision is a forced ask, even in `allow` mode. This is a known limit: the shell grammar cannot evaluate such strings, and the result is to ask rather than to guess.

### Not yet enforced

`Edit`, `WebFetch` and `Mcp` rules parse but are not enforced yet. Writing them is refused, and a file that holds one is corrupt. This stops a stored rule from being a silent no-op that the user believes is in force. P1c lifts this by adding their kinds to `ENFORCED_RULE_KINDS`.

### Shell floors

Shell floors reuse the rule classifier's destructive regex (`isDestructiveShellText`). Sensitive-path arguments to shell commands remain enforced by `src/tools/shell-path-policy.ts`, independently of rules.

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
