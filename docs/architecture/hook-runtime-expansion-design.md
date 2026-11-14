# Hook runtime expansion design

Owner decision 2026-11-14: **exact-definition hash trust and administrator-only managed policy**. Hook signing is not required. This decision supersedes the earlier signing prerequisite in this document and covers issues #29, #33 and #34.

The [product vision](../vision/README.md) owns positioning. The [user hook contract](../guides/user-hooks.md) owns configuration, public event names, JSON input/output and operational limits. The [permission decision tree](permission-decision-tree.md) owns authorization order; hook expansion must preserve it.

## 1. Baseline and sources of truth

The existing runtime provides command hooks, legacy `pre-*.sh` / `post-*.sh` / `perm-*.sh`, declarative `hooks.json`, lifecycle events, a hash lockfile, quarantine, explicit trust enrollment and deny-precedence composition. This expansion reuses those mechanisms rather than introducing a second trust database.

| Responsibility | Owning code |
| --- | --- |
| Script discovery, hash diff and lockfile | `src/hooks/hook-discovery.ts` |
| Config bytes and referenced-file hash | `src/hooks/hook-config-trust.ts` |
| Quarantine, review and explicit enrollment | `src/hooks/hook-trust-prompt.ts`, `src/hooks/hook-trust-commands.ts` |
| Configuration and normalized registry | `src/hooks/hook-config.ts`, `src/hooks/hook-registry.ts` |
| Dispatch, output validation and cancellation | `src/hooks/script-hook-manager.ts`, `src/hooks/script-hook-runner.ts`, `src/hooks/hook-contract.ts` |
| Target admission and permission decisions | `src/tools/`, [permission policy](permission-policy-design.md) |

The internal `post-turn-hook-chain` persists session state and remains separate from configurable hooks. Hook failures must not interrupt its persistence responsibilities.

## 2. Reference behavior and owner decision

References were read on 2026-11-14. They establish the following precedents; Ave's contract below determines its own behavior.

| Reference | Relevant documented behavior |
| --- | --- |
| [Codex hooks](https://developers.openai.com/codex/hooks) | Review binds to the current definition hash; changed or new hooks wait for trust. `/hooks` exposes source, review and disable controls. Managed hooks are policy-trusted; `allow_managed_hooks_only` excludes other sources. Project hooks require a trusted project layer; user/system hooks remain independent. `additionalContextLimit` bounds model context. |
| [Claude Code hooks](https://code.claude.com/docs/en/hooks) | Interactive settings hooks wait for workspace trust; headless/SDK settings hooks treat the folder as trusted. `allowManagedHooksOnly` and managed precedence protect administrator hooks from user `disableAllHooks`. `allowedHttpHookUrls` and `httpHookAllowedEnvVars` constrain HTTP hooks. Context strings have a 10,000-character cap and system-reminder framing. Pre-tool and permission hooks support `updatedInput`. |
| [VS Code agent hooks](https://code.visualstudio.com/docs/agent-customization/hooks) | Its Local harness requires trusted workspaces and `chat.useHooks` for agent-scoped hooks. The current page distinguishes the shared runtime, which does not use that Local setting. |

These references do not specify cryptographic hook signing as the trust requirement. The owner's selected controls are explicit review of exact hashes and an administrator-controlled managed-only policy. Ave does not add a signature format, key distribution or signing store.

## 3. Goals and non-goals

Goals:

- Preserve legacy command hooks, lifecycle event names, deny precedence, DLP and command sandbox admission.
- Review every non-managed definition against its current hash. New and changed definitions are quarantined and skipped until explicitly trusted.
- Show source, current hash, trust state and trust/disable controls in the review surface.
- Load project hooks only for a trusted project; user and system sources are independent.
- Enforce administrator `allowManagedHooksOnly`; user settings cannot disable managed hooks.
- Add HTTP handlers only with explicit egress policy, bounded payloads, cancellation and safe target audit.
- Attribute bounded additional context and reclassify every mutated input through the complete permission decision.

Non-goals:

- Cryptographic signing or a second trust store.
- Hook permission grants, bypassing target approval, or reordering existing permission nodes.
- Replacing internal persistence hooks or exposing secrets in logs, audit or model context.
- Treating a handler type as supported before its invocation, cancellation and audit contracts exist; [§10](#10-deferred-handler-types) records the remaining handler decisions.

## 4. Registry and configuration

### 4.1 Normalization

Legacy files and declarative handlers share one registry. Keep the configuration source separate from handler type and runtime activation identity. A config-controlled label cannot grant managed status. Plugin definitions retain their exact reviewed version/fingerprint and generation leases.

### 4.2 Declarative handlers

The public schema remains event groups containing matchers and handlers. `command` uses argv, optional `timeoutMs`, a bound configuration directory and the existing executable trust anchor. `http` uses a URL, restricted method, optional header templates and a bounded timeout. Unsupported types fail clearly; they never degrade into a command or an ungoverned network request.

Unknown events never activate. Matchers use the existing bounded parser and the event-specific subjects documented in the [public contract](../guides/user-hooks.md#configuration); this expansion does not change matcher semantics.

### 4.3 Ordering and compatibility

Sources run in this order: managed, user, system, plugin registries in their existing activation order, then the current trusted project's hooks. Within each source, legacy files keep filename order and declarative handlers keep file order. Denial wins and stops the chain. An allow is only a hook's lack of objection, never target-tool authority. Source composition cannot alter permission-stage ordering.

## 5. Event placement

The [public event table](../guides/user-hooks.md#events) owns event input and failure semantics. `PreToolUse` remains in admission before target permission checks. `PermissionRequest` remains on the existing ask paths before a card. `PostToolUse` cannot undo completed effects. Observe-only lifecycle events retain their control-flow semantics; stop continuation retains its existing bound.

Hook commands independently pass shell admission, approval and sandbox preparation. Trusting a definition is not approval of every effect it may perform.

## 6. Security model

### 6.1 Exact hash trust and managed policy

Owner decision 2026-11-14: command resolution is deterministic rather than inferred from an executable's argument grammar. Every command runs with its cwd fixed to its bound configuration directory. Legacy scripts bind to their containing directory. Plugin commands use the physical configuration directory when present, otherwise the package directory hosting their virtual configuration. A missing or invalid bound directory refuses execution. The original project/workspace directory remains available through `AVE_HOOK_PROJECT_DIR` and remains the basis for project permission rules.

Discovery hashes the exact current definition. After the existing leading-`~` expansion, `argv[0]` retains its executable-anchor binding and content checks; bare PATH-resolved executables are not content-pinned. A command still requires at least one regular-file trust anchor. For every remaining argv token that does not start with `-`, resolve it against the fixed cwd, then resolve symlinks. If it names an existing regular file, its canonical identity and contents contribute to the trust hash. This includes bare script names, scripts after interpreters or environment launchers, preloads and multiple scripts; regular data files receive the same treatment. A missing or non-regular target remains an ordinary string argument. Other resolution or read errors are configuration errors and refuse trust and execution. This same file-set rule applies to managed and plugin definitions. The bound directory is part of command identity, so a package update that moves a command to another generation directory requires renewed consent even when file bytes are unchanged.

Argument values remain unchanged apart from existing tilde expansion and executable binding. Tokens starting with `-` remain verbatim even when they contain a path, so `--output=/tmp/result.json` retains its option semantics. The raw definition hash covers every argument, including options and operands that name no file. Changing an argument, an included file's contents or symlink target, or which operands name regular files invalidates prior review. The existing `.lockfile.json` records accepted hashes; `.disabled/` and disable-cause records retain quarantine and explicit-disable state. New, changed, trusted, disabled and removed states remain distinguishable.

Explicit enrollment accepts the exact reviewed hash. A stale review cannot trust newly changed content. User actions cannot enroll hooks through model output, plugin-origin text or another privileged command path. After asynchronous approval and sandbox preparation, the runtime synchronously resolves every non-option operand again and hashes the resulting file set immediately before command spawn; it does not only re-read previously discovered files. A mismatch refuses execution. File-based non-managed sources use the existing quarantine for re-trust; plugins invalidate package consent without moving retained generation files. Managed definitions use the same revalidation but are refused in place rather than moved out of administrator policy; restarting reloads that policy. HTTP send retains its current-definition check. This does not pin immutable file objects: a same-principal process can still replace a file between the final content read and OS spawn. The runtime retains the reviewed execution path rather than relocating a snapshot.

Binding cwd does not grant directory access. Only host-recorded reviewed file dependencies under the user-hook directory receive the existing read exception; other protected read floors and all write floors remain. Sandbox write scopes retain the original project/workspace directory, not the hook configuration directory. The existing permission node order is unchanged.

Project trust is a separate prerequisite from definition trust: accepting one hook does not grant project-wide trust, and trusting a project does not silently accept its hooks. User/system hooks do not inherit the project's status.

Only the administrator policy source can set `allowManagedHooksOnly` or supply managed hooks. With that policy enabled, user, system, project and plugin hooks are excluded. Managed hooks are trusted by policy and expose no user disable control. A user-level disable-all affects non-managed hooks only. An absent administrator policy leaves ordinary reviewed hooks available with no HTTP exceptions. An unreadable or malformed administrator policy excludes non-managed hooks and supplies no runnable managed hooks or network exceptions.

### 6.2 Timeouts and environment

Use existing timeout-policy constants and cancellation primitives. A configured timeout can lower its ceiling, not raise it. Cancellation reaches underlying processes or network operations; a late result cannot start an effect. Command environment filtering and existing sandbox behavior remain authoritative. `PWD` and the command input envelope's `cwd` identify the bound execution directory; `AVE_HOOK_PROJECT_DIR` identifies the original project/workspace directory.

Secrets from environment variables or header interpolation must not enter diagnostics, trust summaries, audit fields or model-visible context. HTTP header templates expose only explicitly allowed variable names, never an unrestricted process environment.

### 6.3 HTTP hooks

HTTP execution requires every control below:

1. Administrator `allowedHttpHookUrls`: exact full URLs or bare exact hostnames with an optional port. An absent or empty list permits no requests. Bare hosts do not include subdomains. Reject wildcards, URL credentials and unsupported schemes; match parsed targets rather than substring text.
2. POST only, a 64 KiB UTF-8 request-body cap and the runner's response/output cap. Validate serialized bytes before egress; reject an oversized response before parsing a truncated decision.
3. The existing timeout ceiling with cancellation through the request's abort controller.
4. Redirect refusal. A redirect is never followed under authority granted to its original target.
5. Administrator `httpHookAllowedEnvVars` restricts `$VAR` and `${VAR}` header interpolation. Missing or disallowed variables and invalid header/control-character values refuse the request.
6. A `hook_http_request` audit record for every attempted request target before egress, containing hook identity, URL origin, `routeDigest`, method and outcome. `routeDigest` is the SHA-256 of pathname plus query; raw paths can contain webhook credentials and must not be logged. Exclude raw path/query/fragment, header values, body content and environment values.
7. Egress through the host network chokepoint. There is no direct-fetch fallback when its transport or policy is unavailable.

These restrictions also apply to managed handlers. Trust and managed status do not grant network authority. Scrub configured/interpolated header values and their constituent environment values from returned strings before decision parsing, diagnostics or influence audit; response feedback cannot echo those credentials into logs or model context.

HTTP hooks retain the originating turn's host-bound controller and session. They use the shared live controller/session refresh after asynchronous waits and the shared synchronous revocation check at transport handoff. A revoked or mismatched authority refuses egress and records a denied request with `failureReason: "controller-authority-revoked"`.

### 6.4 Context and model-visible audit

A trusted or managed hook may return `additionalContext` on known events. Truncate text to 10,000 UTF-16 code units, escape wrapper delimiters and attach host-owned hook/event attribution. During an active turn or tool invocation, the model and user see that the text came from a hook. An out-of-turn event such as session end remains observation-only and does not queue context for a later session. Hook context is data, not a user-keyboard command or a new source of permission authority.

Context delivery must reach the next relevant model request; retaining a value only in an internal result object is insufficient. Audit the producing hook, event, bounded length and influence, without copying secrets into logs. Preserve existing DLP handling before dispatch and before delivery where appropriate.

Prompt, agent and MCP-tool handler types require the same exact hash trust, source policy and attributed context audit. Those controls alone do not define provider selection, child-session authority or MCP call identity. Their supported/deferred status must name the missing runtime contracts rather than revive signing as a prerequisite.

### 6.5 Input mutation and permission re-entry

`updatedInput` and legacy `action: "modify"` are limited to `PreToolUse` and `PermissionRequest` from trusted or managed definitions. The replacement is a validated input object; a denial takes precedence over a mutation. An invalid replacement fails closed.

A changed input re-enters complete invocation preparation and authorization: validate the envelope, derive actual tool/path/effect facts, apply admission and deny rules, forced floors, remembered/rule decisions, classification, mode/reviewer and human approval in their existing order. Discard the earlier input's approval and classification. Approval of a harmless original input cannot authorize a dangerous replacement.

Allow at most three changed-input restarts so hooks cannot mutate forever; further mutation denies. Do not rerun completed effects or replay a sealed resumption or authorization-lifecycle operation that cannot safely re-enter. A late permission hook after target-handler entry also denies a replacement because earlier handler effects cannot safely replay. Such paths deny rather than borrowing earlier authority. An unchanged replacement does not create a restart loop.

The only permission-tree delta is a mutation restart edge to the existing input-validation/admission entry. Context annotation adds no authorization node. The [decision-tree document](permission-decision-tree.md) contains the exact graph change; the PR must reproduce its Mermaid diff. Any need to reorder existing nodes requires a new owner decision.

### 6.6 DLP and input provenance

Existing dispatch redaction and trusted-origin propagation remain in force. Nested inputs retain their caller-owned DLP responsibility unless explicitly changed at their boundary. Hook output never becomes local keyboard provenance and cannot invoke privileged slash commands. Remote users retain the existing authenticated/session-bound checks.

## 7. Audit

Keep existing audit rows readable. Record hook identity, source, event, handler type, matcher, trusted hash, decision, duration and failure reason when applicable. HTTP requests additionally record origin and route digest before egress, never a raw webhook route. Context and mutation records identify that a hook influenced model context or tool input. Do not log raw headers, environment values, request bodies or secret-bearing replacements.

## 8. Delivery boundaries

Trust review, administrator policy, HTTP execution and context/mutation are separate changes within one topic PR. Shared schemas, producers, validators, consumers, fixtures and tests move together. No plugin-specific host branch is permitted. Public documentation describes shipped behavior and names any unsupported handler precisely.

## 9. Validation

Cover new/changed/trusted/managed/disabled states, stale-review rejection, project gating and source independence; managed-only override and user disable-all; deterministic cwd and file hashing for bare scripts, environment launchers, absolute interpreters, preloads, multiple scripts, symlink retargeting, edits before spawn and unchanged options; HTTP wildcard/target/method/redirect/body/response/timeout/env cases; context cap/framing/attribution; mutation reclassification, deny rules, changed paths, stale approval and restart limits.

Run focused unit/integration tests, typecheck, unused-code and lint checks. IPC/preload/settings changes also require i18n, packaging-discipline and script lock suites. The trust review flow requires the background UI E2E and screenshot/trace evidence. Validation gaps remain explicit in the PR.

## 10. Deferred handler types

The parser accepts `command` and `http`. It rejects the types below explicitly. The earlier design named them as possible capabilities but defined no invocation schema; hash trust and managed policy resolve their trust prerequisite, not their execution contract.

| Type | Missing contract required before implementation |
| --- | --- |
| `prompt` | Provider/model selection, prompt template and validated result schema, inference budget and cancellation. A context output field alone does not define a model invocation. |
| `agent` | Child-session identity and provenance, independent permission context, tool/round budget, cancellation and recursive-hook suppression. Reusing the current turn would mix authority and permit hook recursion. |
| MCP-tool | Exact reviewed server/tool binding, argument/result schema, normal executor admission and approval context, request cancellation and recursion handling. A network hook cannot stand in for an authorized MCP tool call. |

Each future type must use the same reviewed hash or managed source policy, attributed influence audit and unchanged permission order. No signature prerequisite remains.
