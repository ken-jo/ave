# User hooks

Ave runs trusted command hooks through the existing `ScriptHookManager` and `runOneHookScript` pipeline. See the [runtime design](../architecture/hook-runtime-expansion-design.md) for trust, permission composition, and gated handler types.

## Configuration

Configure user hooks in `~/.config/ave/hooks/hooks.json`. Legacy `pre-*.sh`, `post-*.sh`, and `perm-*.sh` files remain in that directory. Application preferences remain in `ave-settings.json` under the application user-data directory. Hooks are not loaded from application preferences or a workspace settings file.

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

Commands use argv. Ave explicitly expands a leading `~` in each argument; it does not expand variables, quoting, pipes, or substitutions. Use an array for paths or arguments containing spaces. A string command is split on whitespace. A command must reference a local script or executable that can be hashed for trust. Relative paths resolve from the hook process's working directory; absolute paths are preferable.

New or changed scripts and configuration are quarantined at discovery. Review them with `/permission hooks list`, then enroll the reviewed file with `/permission hooks accept hooks.json` or `/permission hooks accept pre-check.sh`. Accepting `hooks.json` approves that configuration and its local script anchors: argv[0] when it is a file path, otherwise the first later path-like argument. Use one explicit script path before other file arguments. PATH-resolved interpreters are not content-pinned. Discovery runs at startup and when hook trust commands refresh the registry; hashes are not rechecked before every invocation. Enrollment requires local user input.

Enrollment does not grant shell authority. Production user commands also pass the existing shell permission rules and approval gate before spawning. Matching shell allow rules alone do not authorize interpreter scripts; the existing permission mode and approval policy still apply. A deny rule refuses execution; an ask requires an explicit allow-once response. An unavailable approval surface cannot authorize execution. Hooks never override a tool permission denial or dispatch privileged chat commands. Remote-controller turns suppress external hooks.

Launch assumes host-side hook files remain stable during admission and sandbox preparation. File identity is not pinned against concurrent replacement by another host process; discovery-time hashes and path checks do not provide that guarantee.

When OS isolation is active on macOS or Linux, user hooks use the existing sandbox wrapper, sensitive-path floors, network policy, disposable HOME, and a separate hook temporary directory. Only the hook's cwd is added as a write scope. An exact canonical script beneath the protected hook configuration directory can be re-allowed for reading; anchors in other protected locations, including links escaping the hook directory, do not receive a read exception. The hooks configuration directory stays write-protected. A wrap failure refuses execution. User hooks follow the existing host shell execution plan: an unavailable requested sandbox or a partially confined Windows backend requires an exact, gate-authenticated allow-once receipt for host execution. The runner rechecks the admitted sandbox generation before spawning. Bundled plugin hooks retain their existing confined relay. With OS isolation disabled, shell permission checks still apply and no OS confinement is claimed.

Matchers follow the [hooks reference](https://code.claude.com/docs/en/hooks#matcher-patterns) (accessed 2026-10-25). Omit the matcher, or use `""` or `"*"`, to match all. A pattern containing only letters, digits, `_`, `-`, spaces, `,` and `|` is a case-sensitive exact name or list of exact names: `Edit|Write` and `Edit, Write` match either name exactly. Any other pattern is a case-sensitive, unanchored JavaScript regular expression: `Edit.*` also matches `NotebookEdit`; `^Edit$` matches only `Edit`. Script `# ave-hook-matcher:` headers use the same syntax, including lists with spaces. Matchers compile once per registry build.

Existing glob patterns need review: `*danger*` is invalid regex. For tool-name containment use a regex such as `.*write.*`; inspect prompt content inside the hook script instead. `mcp_hr_*` is valid regex but also matches `prefix_mcp_hr_query` and even `mcp_hr`; use `^mcp_hr_.*$` to retain the old prefix behavior. An invalid `PreToolUse` or `PermissionRequest` matcher denies every call dispatched through that event, with the file and matcher in the reason. Governed plugin operations (`resolvedPluginOperation`) skip `PreToolUse`, and remote-controller turns disable external hooks, including invalid-matcher guards. Other matcher-bearing events refuse the invalid hook without changing event control flow. Boot uses the existing system notification surface to name refused matchers and ignored fields. `/permission hooks list` also shows load errors. Quarantine and trust enrollment do not erase invalid guard failures: repair or remove the invalid file, including the canonical quarantined copy, then refresh hook trust or restart. Timestamped forensic copies in `.disabled/` are excluded from both matcher diagnostics and the hook list; unsuffixed system-quarantined files retain their guards.

`UserPromptSubmit` and `Stop` have no matcher support: a configured matcher is ignored with a boot notice, and every trusted hook for the event runs. `SubagentStop` still matches `agent_type`, like `SubagentStart`. Tool events, including `PostToolUseFailure` and `PermissionDenied`, match the tool name. `PreCompact` and `PostCompact` match `manual` or `auto`; `SessionEnd` matches its reason. `SessionStart` matches `source` (`startup`, `resume`, or `clear`); `Notification` matches `notification_type` (`agent_completed` for Ave's turn-end notification). Missing optional subjects use the empty string; callers without an explicit session source or notification type use `startup` or `agent_completed`. No event matches a session ID or prompt text.

Pattern and subject limits are each 256 UTF-16 code units, covering long tool and scoped `mcp__server__tool` names and lifecycle categories. To bound backtracking at those lengths, each quantified atom and each `|` inside a group counts as a choice point. Regexes may contain at most two choice points, or three when the pattern starts with `^` and has no top-level `|`. Top-level alternatives such as `Edit|Write` do not count. Quantified groups and backreferences are refused, and numeric repetition bounds cannot exceed 256. This accepts the reference's matcher examples, including `mcp__.*__write.*`, while refusing nested repetition such as `(\w+)+-`. Longer patterns are invalid and use the event's failure policy above. Oversized subjects deny `PreToolUse` and `PermissionRequest` with the file and matcher in the reason; observation events skip the affected hook. These limits also apply to plugin configuration parsing. No matcher is evaluated for the two events without matcher support.

## Events

Every invocation receives one newline-terminated JSON object on stdin. The public envelope is `{schema_version: 1, hook_event_name: string, session_id: string, cwd: string}`. `hook_event_name` is one of the exact event names below. `cwd` is the hook process's actual working directory, which defaults to the host process's cwd; it is not a promise of the conversation's workspace root. The discriminated TypeScript schema is [`HookJsonInput`](../../src/hooks/hook-contract.ts).

Existing camelCase fields remain available alongside the public fields. All inputs retain `sessionId` and `trustOrigin`. Tool events retain `hookType` and `event` aliases `pre`, `post`, and `perm`; lifecycle events use their full event name. Tool events also retain `source`, `category`, and optional `mcpServerId` and `pluginId`.

| Event | Additional input | Effect of denial |
| --- | --- | --- |
| `PreToolUse` | `tool_name: string`, `tool_input: object` | Refuses the tool |
| `PostToolUse` | Tool input plus optional `tool_response: string`, `is_error: boolean` | Feedback; the tool already ran |
| `PermissionRequest` | `tool_name: string`, `tool_input: object` | Refuses the pending permission request |
| `UserPromptSubmit` | `prompt: string`; legacy optional `inputOrigin`, `route`, `classification` | Refuses the turn |
| `PostToolUseFailure` | Optional `tool_name: string`, `error: string`, `duration_ms: number` | Observe only |
| `PermissionDenied` | Optional `tool_name: string`, `deny_reason: {layer?: number, source: string, reason?: string}` | Observe only |
| `SessionStart` | Optional `source: "startup" \| "resume" \| "clear"`, `session_meta: object` | Observe only; before the first turn after session creation or loading |
| `SessionEnd` | Optional `reason: string`, `session_meta: object`, `stop_reason: string` | Observe only; session switch or reset, not a crash/shutdown guarantee |
| `Notification` | Optional `message: string`, `notification_type: string` (`agent_completed`) | Observe only; turn-end notification |
| `Stop` | Optional `stop_reason: string`, `tool_count: number`, `duration_ms: number`, `stop_hook_active: boolean` | A block at a clean end continues the turn; see below |
| `PreCompact` | Optional `reason: string`, `trigger: "manual" \| "auto"`, `token_estimate: number` | Observe only |
| `PostCompact` | Optional `trigger: "manual" \| "auto"`, `messages_before: number`, `messages_after: number`, `tokens_before: number`, `tokens_after: number` | Observe only |
| `SubagentStart` | Optional `agent_id: string`, `agent_type: string` | Observe only |
| `SubagentStop` | Optional `agent_id: string`, `agent_type: string`, `stop_reason: string`, `stop_hook_active: boolean` | A block at a clean end continues the sub-agent run; see below |

Fields depend on the dispatch site; an unavailable optional field is omitted. Prompt text, top-level tool input strings and string-array items, tool output, error text, denial text, and notification text are DLP-redacted before dispatch. Nested tool objects and session metadata retain the existing caller-owned redaction responsibility. No transcript path or permission-mode field is promised by this contract.

## Results and failures

| Outcome | Meaning |
| --- | --- |
| Exit `0`, empty stdout or `{}` | Successful no-op; normal tool permission checks remain authoritative |
| Exit `0`, supported JSON | Applies the decision below |
| Exit `2` | Denial with bounded stderr as the reason; stdout cannot override it |
| Other nonzero exit or signal | Failure with exit/signal and stderr diagnostics; blocking events fail closed |
| Malformed, unsupported, or oversized output | Explicit failure; blocking events fail closed |
| Timeout or spawn/wrap/admission failure | Explicit failure; blocking events fail closed |

`PreToolUse`, `PermissionRequest`, and `UserPromptSubmit` enforce denials. Tool hook denials, post-tool feedback, and `PostToolUseFailure` feedback reach the model through the tool result path. A refused prompt is reported to the user before the model is called. Observe-only lifecycle events report failures to the host log and preserve turn/session control flow; events other than `PostToolUseFailure`, `Stop`, and `SubagentStop` do not inject context. The hook chain stops at its first denial, including for observation events. Legacy files run first in filename order, followed by configured handlers in file order.

`Stop` and `SubagentStop` follow the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) (accessed 2026-10-22) when a turn ends cleanly (`end_turn`). Exit `2` (its stderr) or `{ "decision": "block", "reason": "..." }` keeps the run going: the reason is added to the conversation as a host-generated input and the model takes another round. `stop_hook_active` is `true` while such a continuation is in progress; check it to avoid blocking forever. At most 8 consecutive continuations run per turn, matching the reference default; the next block ends the turn with a notice. `continue: false`, a legacy `action: "deny"`, and any failure end the run normally. A cancelled turn never continues. Top-level turns use `Stop`; sub-agent runs use `SubagentStop`. Other outcomes, such as errors, interruptions, and round caps, still dispatch `Stop` or `SubagentStop` observe-only.

Handlers default to a five-second ceiling. `timeoutMs` is a positive integer in milliseconds, clamped to 5000 by configuration parsing; invalid configuration budgets warn and use the default. Execution expiry terminates the managed process/group and reports `hook timed out after <budget>ms`. Approval waiting uses the existing approval gate's separate deadline. Stdout and stderr each have a 16 KiB capture bound. Oversized stdout fails rather than accepting a truncated decision. Keep decisions and diagnostics concise.

Supported exit-0 output forms:

```json
{ "action": "deny", "reason": "Run the focused check first" }
```

The legacy `action` is `allow` or `deny`; its required reason retains the existing 280-character bound. The event-independent form is:

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

These event-specific decisions accept `allow` or `deny`; `allow` only means the hook does not object. A mismatched event, `ask`, permission updates, input mutation, or context-injection fields are rejected as unsupported output. Hook-specific decision objects on other events are unsupported. Legacy JSON wrapped in a code fence remains accepted.

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

HTTP, model, input-mutation, and background hooks are outside the supported contract.

## Differences from Claude Code hooks

Compared with the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), accessed 2026-10-25. **Intended** marks a deliberate security or design choice; **gap** marks a difference that could be closed; **owner decision** marks a behavior change still awaiting the owner.

| Area | Claude Code | Ave | Status |
| --- | --- | --- | --- |
| Events | 33 events, including `Setup`, `PostToolBatch`, `StopFailure`, `ConfigChange`, `FileChanged`, `WorktreeCreate`, and model-switch events | The 14 events above | Intended for now |
| Common input | `transcript_path`, `permission_mode`, `prompt_id`, `scratchpad_dir`, `effort`, and `agent_id`/`agent_type` in agent contexts | `schema_version`, `hook_event_name`, `session_id`, `cwd` only | Gap |
| `SessionStart` | `source`: `startup`, `resume`, `clear`, `compact`, `fork` | `source`: `startup`, `resume`, `clear`; `session_meta`; compaction does not start a session and no fork event exists | Implemented for available session transitions |
| `SessionEnd` | `reason`: `clear`, `resume`, `logout`, `prompt_input_exit`, `other` | `reason`: `new-conversation`, `load-session` | Gap (value set) |
| `PreCompact` / `PostCompact` | `trigger` (`manual`/`auto`), `custom_instructions`; `compact_summary` after | Same `trigger`; legacy `reason` on PreCompact and token/message counts; no instructions or summary | Implemented trigger; remaining fields are gaps |
| `Notification` | Fires per notification with `message`, `title`, `notification_type` | Fires once at turn end with assistant text and `notification_type: "agent_completed"` | Gap (notification coverage) |
| `Stop` / `SubagentStop` | `stop_hook_active`, `last_assistant_message`; `decision: "block"` or exit 2 continues the turn, capped at 8 | Same continuation and cap with `stop_hook_active`; no `last_assistant_message` | Implemented; `last_assistant_message` is a gap |
| Matchers | `\|`/`,` exact-name lists, otherwise an unanchored JavaScript regex; `if` on tool events | Same matching rules within 256-unit pattern/subject caps and restricted repetition; invalid pre/permission guards deny their event; no `if` | Intended bounds and fail-closed guards; `if` is a gap |
| Lifecycle matcher subject | Source, trigger, notification type, agent type, or error type; ignored on `UserPromptSubmit` and `Stop` | Source, compaction trigger, turn-end notification category, agent type (including SubagentStop), or Ave SessionEnd reason; prompt/Stop matchers ignored with notice | Implemented for available event values |
| Other nonzero exit | Non-blocking error unless `onFailure: "block"` | Fails closed on blocking events | Intended |
| Exit 2 on non-blocking events | Ignored on `PostToolUse` and `Notification` | Denial result; observe-only events log it | Intended |
| Plain stdout on exit 0 | Added as context on `UserPromptSubmit` and `SessionStart` | Non-JSON output is an explicit failure | Intended |
| Decision output | `ask`, `defer`, `updatedInput`, `updatedPermissions`, `updatedToolOutput`, `additionalContext`, `systemMessage`, `suppressOutput`, `terminalSequence` | Rejected as unsupported output; only allow/deny | Intended |
| Handler types | `command`, `http`, `mcp_tool`, `prompt`, `agent`; `async` and `asyncRewake` | Trusted local argv `command` only | Intended |
| Execution | Matching hooks run in parallel; identical handlers deduplicated | Sequential; the chain stops at the first denial | Intended |
| Timeouts | 600 s default; 30 s on `UserPromptSubmit`; 1.5 s `SessionEnd` budget | 5 s ceiling | Intended |
| Configuration | User, project, local, and managed settings; plugin `hooks/hooks.json`; skill and subagent frontmatter | `~/.config/ave/hooks/hooks.json` with hash enrollment; bundled plugin hooks run in their own relay | Intended |
