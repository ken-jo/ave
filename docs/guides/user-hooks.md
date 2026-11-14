# User hooks

Ave runs reviewed command and HTTP hooks through one trust and dispatch pipeline. See the [runtime design](../architecture/hook-runtime-expansion-design.md) for source policy, permission composition and handler limits.

## Configuration

Configure user hooks in `~/.config/ave/hooks/hooks.json`. Legacy `pre-*.sh`, `post-*.sh`, and `perm-*.sh` files remain in that directory. Application preferences remain in `ave-settings.json` under the application user-data directory. Hook source trust and administrator policy are separate from ordinary application preferences.

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [{
      "matcher": "bash",
      "hooks": [{
        "type": "command",
        "command": ["node", "~/.config/ave/hooks/check-command.cjs"],
        "timeoutMs": 5000
      }]
    }]
  }
}
```

Commands use argv. Ave explicitly expands a leading `~` in each argument; it does not expand variables, quoting, pipes, or substitutions. Use an array for paths or arguments containing spaces. A string command is split on whitespace. A command must reference a local script or executable that can be hashed for trust. Only the executable/script anchor is resolved against the directory containing `hooks.json` and bound to an absolute path for hashing and execution. Other argv values remain unchanged: for example, `--output=/tmp/result.json` keeps its option semantics and `data/input.json` remains a relative data argument. Changing the invocation's working directory cannot substitute a different file for the reviewed script. Changing any configured argument still changes the definition hash and requires re-trust.

New or changed scripts and configuration are quarantined and skipped until you trust their current hash. Open **Settings → Permissions → Review hook trust** to inspect source, hash and state, then choose **Trust this hash** or **Disable**. These controls apply to the displayed source, so identically named files from different sources remain distinct. The user-source CLI alternative is `/permission hooks list`, then `/permission hooks accept hooks.json` or `/permission hooks accept pre-check.sh`. Accepting `hooks.json` approves that configuration and its local script anchors: argv[0] when it is a file path, otherwise the first later non-option path-like argument. Use one explicit script path before other file arguments. PATH-resolved interpreters are not content-pinned. A changed definition needs a new review; trust is not a blanket grant for future edits. Enrollment requires local user input and uses the existing lockfile and quarantine.

Administrator-managed hooks are trusted by policy and cannot be disabled through user controls. Administrator `allowManagedHooksOnly` excludes user, system, project and plugin hook sources. A user-level disable-all affects non-managed hooks only. Project hooks need both a trusted project and a reviewed definition; user and system hooks remain independent of project trust. No hook signing is required.

| Source | Location and review |
| --- | --- |
| User | `~/.config/ave/hooks/`; review the current script or `hooks.json` hash |
| System | `hooks/` beside the administrator policy file; reviewed as a non-managed source |
| Project | `<project>/.ave/hooks/`; trust the project in the review surface, then trust each listed definition |
| Managed | The administrator policy file's `hooks` field; trusted by policy |
| Plugin | The installed package's reviewed hook definition and fingerprint; package updates can require renewed consent |

Sources run in order: managed, user, system, plugins in their existing activation order, then the current trusted project. Within a source, legacy scripts run by filename before declarative handlers in file order. Any denial stops the chain; a later source cannot undo it or grant target permission.

The administrator policy is `/Library/Application Support/Ave/policy.json` on macOS, `/etc/ave/policy.json` on Linux, and `%ProgramData%\Ave\policy.json` on Windows. Only that protected source supplies managed hooks or HTTP exceptions. Ave loads this policy at startup; restart after changing its hook or network policy. Changed managed-policy bytes invalidate the previously loaded hooks until restart; policy is not reloaded live. For example:

```json
{
  "allowManagedHooksOnly": true,
  "allowedHttpHookUrls": ["https://hooks.example.test/check"],
  "httpHookAllowedEnvVars": ["HOOK_TOKEN"],
  "hooks": {
    "PreToolUse": [{
      "matcher": "bash",
      "hooks": [{ "type": "http", "url": "https://hooks.example.test/check" }]
    }]
  }
}
```

To temporarily disable non-managed hooks, set `"disableAllHooks": true` at the top level of the user `hooks.json`. It cannot suppress managed hooks. A malformed or unreadable administrator policy refuses non-managed execution and supplies no managed hooks or HTTP exceptions; fix the policy before relying on hook execution.

Enrollment does not grant shell authority. Hook commands enter the central permission pipeline with their actual argv, cwd, sandbox plan and trusted turn context. Auto requests consume reviewer evidence before any human fallback; ordinary cards may offer their supported rule and scope choices. Forced floors remain one-shot. Headless requests that require a human deny with no-retry guidance. Policy, normalized effect and physical cwd identity are rechecked before spawn. Hooks never override target-tool permission or dispatch privileged chat commands. Authenticated, session-bound remote users run hooks through the same path as local users; see the [owner decision 2026-11-02](../architecture/permission-decision-tree.md).

After asynchronous approval and sandbox preparation, Ave synchronously rechecks the trusted definition's current hash immediately before spawning a command or sending an HTTP request. A changed definition is refused. This is a final content check, not an immutable execution snapshot: another process with the same user's filesystem authority can still replace a file between that hash read and the OS spawn. Hooks are not copied to a relocated execution path or pinned against that narrow replacement race.

When OS isolation is active on macOS or Linux, user hooks use the existing sandbox wrapper, sensitive-path floors, network policy, disposable HOME, and a separate hook temporary directory. Only the hook's cwd is added as a write scope. An exact canonical script beneath the protected hook configuration directory can be re-allowed for reading; anchors in other protected locations, including links escaping the hook directory, do not receive a read exception. The hooks configuration directory stays write-protected. A wrap failure refuses execution. User hooks follow the actual host shell execution plan and ordinary mode/human routing. Host execution consumes a one-use exact-action receipt: a policy/reviewer allow binds that exact action, while any supported authenticated human allow choice supplies the same native receipt. Remembering a rule does not make the spawn receipt reusable. The runner rechecks the admitted sandbox generation before spawning. Bundled plugin hooks retain their existing confined relay. With OS isolation disabled, shell permission checks still apply and no OS confinement is claimed.

Matchers follow the [hooks reference](https://code.claude.com/docs/en/hooks#matcher-patterns) (accessed 2026-10-25). Omit the matcher, or use `""` or `"*"`, to match all. A pattern containing only letters, digits, `_`, `-`, spaces, `,` and `|` is a case-sensitive exact name or list of exact names: `Edit|Write` and `Edit, Write` match either name exactly. Any other pattern is a case-sensitive, unanchored JavaScript regular expression: `Edit.*` also matches `NotebookEdit`; `^Edit$` matches only `Edit`. Script `# ave-hook-matcher:` headers use the same syntax, including lists with spaces. Matchers compile once per registry build.

Existing glob patterns need review: `*danger*` is invalid regex. For tool-name containment use a regex such as `.*write.*`; inspect prompt content inside the hook script instead. `mcp_hr_*` is valid regex but also matches `prefix_mcp_hr_query` and even `mcp_hr`; use `^mcp_hr_.*$` to retain the old prefix behavior. An invalid `PreToolUse` or `PermissionRequest` matcher denies every call dispatched through that event, with the file and matcher in the reason. Governed plugin operations (`resolvedPluginOperation`) skip `PreToolUse`. Other matcher-bearing events refuse the invalid hook without changing event control flow. Boot uses the existing system notification surface to name refused matchers and ignored fields. `/permission hooks list` also shows load errors. Quarantine and trust enrollment do not erase invalid guard failures: repair, remove or explicitly disable the invalid file, then refresh hook trust or restart.

Every disabled copy remains visible in `/permission hooks list`, including timestamped copies. A `.disable-cause` sidecar beside each stored file distinguishes automatic system quarantine from an explicit user disable. System-quarantined copies retain invalid-matcher guards regardless of their suffix; user-disabled copies do not contribute guards. Missing or invalid cause records are treated as system quarantine, with an explanation in the list and invalid-matcher notice. Accepting a stored copy restores its original hook name and removes its sidecar; rejecting it deletes both. Use the exact listed filename to accept, disable or reject a timestamped copy. Accept refuses to overwrite an active file with the same original name. Keep a sidecar with its disabled file when moving stored copies manually.

`UserPromptSubmit` and `Stop` have no matcher support: a configured matcher is ignored with a boot notice, and every trusted hook for the event runs. `SubagentStop` still matches `agent_type`, like `SubagentStart`. Tool events, including `PostToolUseFailure` and `PermissionDenied`, match the tool name. `PreCompact` and `PostCompact` match `manual` or `auto`; `SessionEnd` matches its reason. `SessionStart` matches `source` (`startup`, `resume`, or `clear`); `Notification` matches `notification_type` (`agent_completed` for Ave's turn-end notification). Missing optional subjects use the empty string; callers without an explicit session source or notification type use `startup` or `agent_completed`. No event matches a session ID or prompt text.

Pattern and subject limits are each 256 UTF-16 code units, covering long tool and scoped `mcp__server__tool` names and lifecycle categories. To bound backtracking at those lengths, each quantified atom and each `|` inside a group counts as a choice point. Regexes may contain at most two choice points, or three when the pattern starts with `^` and has no top-level `|`. Top-level alternatives such as `Edit|Write` do not count. Quantified groups and backreferences are refused, and numeric repetition bounds cannot exceed 256. This accepts the reference's matcher examples, including `mcp__.*__write.*`, while refusing nested repetition such as `(\w+)+-`. Longer patterns are invalid and use the event's failure policy above. Oversized subjects deny `PreToolUse` and `PermissionRequest` with the file and matcher in the reason; observation events skip the affected hook. These limits also apply to plugin configuration parsing. No matcher is evaluated for the two events without matcher support.

## Events

Every invocation receives one newline-terminated JSON object on stdin. The public envelope is `{schema_version: 1, hook_event_name: string, session_id: string, cwd: string}`. `hook_event_name` is one of the exact event names below. `cwd` is the hook process's actual working directory, which defaults to the host process's cwd; it is not a promise of the conversation's workspace root. The discriminated TypeScript schema is [`HookJsonInput`](../../src/hooks/hook-contract.ts).

Existing camelCase fields remain available alongside the public fields. All inputs retain `sessionId` and `trustOrigin`. Tool events retain `hookType` and `event` aliases `pre`, `post`, and `perm`; lifecycle events use their full event name. Tool events also retain `source`, `category`, and optional `mcpServerId` and `pluginId`.

| Event | Additional input | Effect of denial |
| --- | --- | --- |
| `PreToolUse` | `tool_name: string`, `tool_input: object` | Refuses the tool before target approval |
| `PostToolUse` | Tool input plus optional `tool_response: string`, `is_error: boolean` | Feedback; the tool already ran |
| `PermissionRequest` | `tool_name: string`, `tool_input: object` | Refuses the pending permission request |
| `UserPromptSubmit` | `prompt: string`; legacy optional `inputOrigin`, `route`, `classification` | Refuses the turn |
| `PostToolUseFailure` | Optional `tool_name: string`, `error: string`, `duration_ms: number` | Observe only |
| `PermissionDenied` | Optional `tool_name: string`, `deny_reason: {source: string, reason?: string}` | Observe only |
| `SessionStart` | Optional `source: "startup" \| "resume" \| "clear"`, `session_meta: object` | Observe only; before the first turn after session creation or loading |
| `SessionEnd` | Optional `reason: string`, `session_meta: object`, `stop_reason: string` | Observe only; session switch or reset, not a crash/shutdown guarantee |
| `Notification` | Optional `message: string`, `notification_type: string` (`agent_completed`) | Observe only; turn-end notification |
| `Stop` | Optional `stop_reason: string`, `tool_count: number`, `duration_ms: number`, `stop_hook_active: boolean` | A block at a clean end continues the turn; see below |
| `PreCompact` | Optional `reason: string`, `trigger: "manual" \| "auto"`, `token_estimate: number` | Observe only |
| `PostCompact` | Optional `trigger: "manual" \| "auto"`, `messages_before: number`, `messages_after: number`, `tokens_before: number`, `tokens_after: number` | Observe only |
| `SubagentStart` | Optional `agent_id: string`, `agent_type: string` | Observe only |
| `SubagentStop` | Optional `agent_id: string`, `agent_type: string`, `stop_reason: string`, `stop_hook_active: boolean` | A block at a clean end continues the sub-agent run; see below |

Fields depend on the dispatch site; an unavailable optional field is omitted. Prompt text, top-level tool input strings and string-array items, tool output, error text, denial text, and notification text are DLP-redacted before dispatch. Nested tool objects and session metadata retain the existing caller-owned redaction responsibility. No transcript path or permission-mode field is promised by this contract.

## PreToolUse authorization boundary

The [permission decision tree](../architecture/permission-decision-tree.md) owns ordering. In-process argument hooks finish rewriting before authorization. The user script `PreToolUse` hook runs in admission before the target tool's permission checks and approval card. A blocked target creates no target approval card. The hook command's own shell authority remains separately enforced.

`allow` means no objection and cannot grant the target tool permission or bypass a card. Trusted or managed pre-tool and permission hooks can replace tool input; the replacement goes through complete preparation, classification and permission checks again. Earlier approval does not authorize changed arguments. Denial wins over mutation. Cancelling the turn interrupts pending hook admission and terminates only that hook’s managed process group; a late hook answer cannot start the tool.

## Results and failures

| Outcome | Meaning |
| --- | --- |
| Exit `0`, empty stdout or `{}` | Successful no-op; normal tool permission checks remain authoritative |
| Exit `0`, supported JSON | Applies the decision below |
| Exit `2` | Denial with bounded stderr as the reason; stdout cannot override it |
| Other nonzero exit or signal | Failure with exit/signal and stderr diagnostics; blocking events fail closed |
| Malformed, unsupported, or oversized output | Explicit failure; blocking events fail closed |
| Timeout or spawn/wrap/admission failure | Explicit failure; blocking events fail closed |

`PreToolUse`, `PermissionRequest`, and `UserPromptSubmit` enforce denials. Tool hook denials, post-tool feedback, and `PostToolUseFailure` feedback reach the model through the tool result path. A refused prompt is reported to the user before the model is called. Observe-only lifecycle events report failures to the host log and preserve turn/session control flow; supported `additionalContext` is delivered separately as attributed context. The hook chain stops at its first denial, including for observation events. Legacy files run first in filename order, followed by configured handlers in file order.

`Stop` and `SubagentStop` follow the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) (accessed 2026-10-22) when a turn ends cleanly (`end_turn`). Exit `2` (its stderr) or `{ "decision": "block", "reason": "..." }` keeps the run going: the reason is added to the conversation as a host-generated input and the model takes another round. `stop_hook_active` is `true` while such a continuation is in progress; check it to avoid blocking forever. At most 8 consecutive continuations run per turn, matching the reference default; the next block ends the turn with a notice. `continue: false`, a legacy `action: "deny"`, and any failure end the run normally. A cancelled turn never continues. Top-level turns use `Stop`; sub-agent runs use `SubagentStop`. Other outcomes, such as errors, interruptions, and round caps, still dispatch `Stop` or `SubagentStop` observe-only.

Handlers default to a five-second ceiling. `timeoutMs` is a positive integer in milliseconds, clamped to 5000 by configuration parsing; invalid configuration budgets warn and use the default. Execution expiry terminates the managed process/group and reports `hook timed out after <budget>ms`. Approval waiting uses the existing approval gate's separate deadline. Stdout and stderr each have a 64 KiB capture bound. Oversized stdout fails rather than accepting a truncated decision. Keep decisions and diagnostics concise.

Supported exit-0 output forms:

```json
{ "action": "deny", "reason": "Run the focused check first" }
```

The legacy decision `action` is `allow` or `deny`; its required reason retains the existing 280-character bound. Pre-tool and permission hooks also support the input replacement form below. The event-independent decision form is:

```json
{ "decision": "block", "reason": "Run the focused check first" }
```

`decision` is `block` or `allow`. `{ "continue": false, "stopReason": "..." }` also signals denial. A denial wins over an allow in the same structured response. Do not mix legacy `action` with structured control fields.

`PreToolUse` also accepts:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Run the focused check first" } }
```

`PermissionRequest` also accepts:

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": "Outside the approved scope" } } }
```

These event-specific decisions accept `allow` or `deny`; `allow` only means the hook does not object. A mismatched event, `ask`, permission updates or an unsupported field fails clearly. Legacy JSON wrapped in a code fence remains accepted.

### Context and input replacement

Return bounded context using the event's exact name:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": "The destination contains generated files." } }
```

Context is truncated to 10,000 UTF-16 code units, DLP-redacted and wrapped in a `system-reminder` carrying the hook's event, hash identity and escaped path or ID. The wrapper labels its contents as hook-provided external context. Wrapper delimiters are escaped so returned text cannot forge another hook's attribution. Tool context appears with the tool result; lifecycle context produced during an active conversation turn is recorded as an attributed conversation entry. The model and user can see that a hook influenced the context. Hook text does not gain user-keyboard provenance or permission authority. Keep credentials out of returned context.

All known events accept the context field, but automatic model/user delivery requires an active turn or tool invocation. This includes `SessionStart`, `UserPromptSubmit`, pre/post/permission hooks, and compaction/stop events fired during that turn. An out-of-turn `SessionEnd` is observation only: it cannot change an ended model request or inject context into the next session. Its parsed result remains available for audit.

A trusted or managed `PreToolUse` or `PermissionRequest` hook can return a replacement input object:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": { "command": "git status --short" } } }
```

The legacy equivalent uses `{"action":"modify","reason":"Use the bounded status command","updatedInput":{"command":"git status --short"}}`. A permission hook places its replacement inside `hookSpecificOutput.decision` alongside `"behavior":"allow"`. This allow still grants no target authority. Mutation on other events is rejected. Ave rechecks the replacement through the entire permission decision, including path/effect classification, deny rules and required approval. An unchanged replacement is a no-op. At most three changed-input restarts are allowed; further mutation denies. Sealed resumptions, authorization-lifecycle paths and late permission hooks after target-handler entry deny a replacement instead of replaying effects or using earlier permission.

Within a hook chain, later hooks receive the most recent replacement; the last successful replacement becomes the proposed input. After the chain completes, Ave starts a fresh invocation attempt, including its pre-tool chain. Write mutators so they return the same input once it has reached the intended form. A later hook denial stops the chain and discards the proposed mutation.

### HTTP handlers

An HTTP handler uses the same event payload as a command hook, encoded as a JSON POST body:

```json
{
  "type": "http",
  "url": "https://hooks.example.test/check",
  "method": "POST",
  "headers": { "Authorization": "Bearer ${HOOK_TOKEN}" },
  "timeoutMs": 5000
}
```

An administrator must configure `allowedHttpHookUrls` and, for the example header, `httpHookAllowedEnvVars: ["HOOK_TOKEN"]`. No configured URL/host allowlist means no HTTP execution. Only `http:` and `https:` targets are accepted. Allowlist entries are exact full URLs or bare exact hostnames with an optional port; a host does not include its subdomains. A bare host without a port permits either supported scheme and any port; use a full URL to constrain scheme, port, path and query together. Wildcards, URL credentials and methods other than POST are rejected. Header interpolation accepts `$VAR` and `${VAR}` only for listed, present variables. Do not put secret values directly in configuration.

Requests use the host network permission chokepoint; redirects are refused. The serialized request is limited to 64 KiB, and responses use the hook runner's output limit. The deadline cannot exceed the existing hook/network ceiling and also covers response reading. Each request audit contains the URL origin, a SHA-256 `routeDigest` of pathname plus query, hook identity, method and outcome. Raw paths, queries, fragments, headers, bodies and environment values are excluded because a webhook route can contain credentials. Managed status does not waive these controls.

Known configured/interpolated header values and their constituent environment values are scrubbed from returned strings before the response becomes a decision, diagnostic or model-visible context. Keep credentials out of endpoint responses as well as configuration.

The endpoint returns the same decision JSON shown above in its response body; no special response content type is required.

| HTTP response | Result |
| --- | --- |
| `2xx`, empty body or `{}` | Successful no-op |
| `2xx`, supported JSON | Applies the event's decision, context or input replacement |
| `2xx`, malformed, unsupported or oversized body | Failure; blocking events deny |
| `3xx` | Failure without following the redirect; blocking events deny |
| Other non-success status, timeout or network failure | Failure; blocking events deny |

Observe-only events retain their existing control-flow behavior on HTTP failures. They cannot undo a completed tool effect.

## Example script

Save this as `~/.config/ave/hooks/check-command.cjs`, then use the configuration above, review it, and enroll `hooks.json`. On the next matching `bash` invocation, authorize the hook command if shell policy asks. A blocked invocation surfaces the script's stderr in the tool result; lifecycle failures appear in the host log.

```js
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const event = JSON.parse(input);
  if (event.hook_event_name === "PreToolUse" &&
      event.tool_input.command?.includes("--force")) {
    process.stderr.write("Review the forced operation before proceeding.");
    process.exitCode = 2;
  }
});
```

For example, stdin includes `{"schema_version":1,"hook_event_name":"PreToolUse","session_id":"session-example","cwd":"/workspace","tool_name":"bash","tool_input":{"command":"git push --force"}}` plus the legacy envelope. A normal command completes with exit 0 and no stdout.

Background execution and permission-update output are outside the supported contract.

Prompt, agent and MCP-tool handler types are rejected. Their provider/result, independent child-session authority and exact server/tool invocation contracts are not yet defined; see the [specific deferral reasons](../architecture/hook-runtime-expansion-design.md#10-deferred-handler-types). This is separate from returning context or mutating input from a supported command or HTTP hook.

## Contract limits

The supported events and inputs are listed above. Hooks run sequentially and stop at the first denial. Only reviewed or managed handlers run; HTTP handlers also require administrator egress policy. Context and input replacement cannot widen authority. Permission updates and asynchronous handlers are rejected. Matcher bounds, exact hash enrollment and fail-closed blocking failures protect admission. The [permission decision tree](../architecture/permission-decision-tree.md) owns approval ordering.
