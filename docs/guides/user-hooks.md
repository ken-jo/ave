# User hooks

Ave runs trusted command hooks through the existing `ScriptHookManager` and `runOneHookScript` pipeline. See the [runtime design](../architecture/hook-runtime-expansion-design.md) for trust, permission composition, and gated handler types.

## Configuration

Configure user hooks in `~/.config/ave/hooks/hooks.json`. Legacy `pre-*.sh`, `post-*.sh`, and `perm-*.sh` files remain in that directory. This is the existing hook configuration location, alongside Ave's separate permission configuration; application preferences remain in `ave-settings.json` under the application user-data directory. Hooks are not loaded from application preferences or a workspace settings file.

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

Commands use argv, with no implicit shell expansion. Use an array for paths or arguments containing spaces. A string command is split on whitespace. A command must reference a local script or executable that can be hashed for trust.

New or changed scripts and configuration are quarantined. Review them with `/permission hooks list`, then enroll the reviewed file with `/permission hooks accept hooks.json` or `/permission hooks accept pre-check.sh`. Enrollment requires local user input. Hook approval cannot override a tool permission denial.

Matchers use anchored, case-sensitive globs: `*` matches any sequence, `?` one character. Omit the matcher, or use `""` or `"*"`, to match all. Tool events match the tool name; `UserPromptSubmit` matches the prompt; other lifecycle events match the session ID.

## Events

Every invocation receives one JSON object on stdin. Existing camelCase fields remain available. Tool events use `hookType` and `event` aliases `pre`, `post`, and `perm`; lifecycle events use their full event name.

| Event | Additional input | Effect of denial |
| --- | --- | --- |
| `PreToolUse` | `toolName`, `source`, `category`, `input` | Refuses the tool |
| `PostToolUse` | Tool input plus `toolOutput`, `isError` | Feedback; the tool already ran |
| `PermissionRequest` | Tool input | Refuses the pending permission request |
| `UserPromptSubmit` | `inputText`, optional `inputOrigin`, `route`, `classification` | Refuses the turn |
| `PostToolUseFailure` | `toolName`, `errorMessage`, `durationMs` | Observe only |
| `PermissionDenied` | `toolName`, `denyReason` | Observe only |
| `SessionStart` | `sessionMeta` | Observe only; once before the session's first turn |
| `SessionEnd` | `stopReason` when supplied | Observe only; session switch or reset |
| `Notification` | `message` | Observe only; turn-end notification |
| `Stop` | `stopReason`, `toolCount`, `durationMs` | Observe only; does not continue the turn |
| `PreCompact` | `reason`, `tokenEstimate` | Observe only |
| `PostCompact` | `messagesBefore`, `messagesAfter`, `tokensBefore`, `tokensAfter` | Observe only |
| `SubagentStart` | `agentId`, `agentType` | Observe only |
| `SubagentStop` | `agentId`, `agentType`, `stopReason` when supplied | Observe only |

Fields depend on the dispatch site; an unavailable optional field is omitted. All events carry `sessionId` and `trustOrigin`. Free-text input is redacted before dispatch. No transcript path is promised by this contract.

## Current result contract

The existing runtime requires `{ "action": "allow" | "deny", "reason": "..." }` on stdout. Nonzero exit, malformed output, spawn failure, and timeout produce a denial. Blocking events enforce it; observe-only events record it without changing control flow. Handlers default to a five-second ceiling and `timeoutMs` can shorten it. Output capture is bounded to 16 KiB.

HTTP, model, input-mutation, and background hooks are outside the supported contract.
