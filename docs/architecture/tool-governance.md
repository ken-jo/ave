# Tool Governance

Status: Implemented. Source files and tests named below are authoritative when
they disagree with this page.

This page owns the shared governance model for every tool the host can run:
where tools come from, how much they are trusted, the single execution
pipeline they all pass through, and the controls (rate limiting, kill switch,
DLP, audit) applied on that path. Product context: [Vision](../vision/README.md).

## 1. Scope

Tools reach the registry from three sources (`ToolSource` in
`src/shared/permission-review-status.ts`):

| Source | Examples | Origin |
| --- | --- | --- |
| `builtin` | `web_search`, `web_fetch`, `agent_spawn` | Shipped with the host |
| `plugin` | Manifest-declared plugin tools | Installed plugin, reached through HostApi |
| `mcp` | `mcp_<prefix>_<name>` | Third-party MCP server |

Invariant: whatever the source, every invocation passes through one executor
pipeline (section 3) and produces an audit record (section 8).

## 2. Trust levels

Trust is derived from source only, by `trustFromSource` in
`src/tools/types.ts`:

| Source | Trust | Rate limit (section 9) |
| --- | --- | --- |
| `builtin` | `high` | none |
| `plugin` | `medium` | 60 calls/minute |
| `mcp` | `low` | 20 calls/minute |

There is no per-tool trust override. Trust selects the rate-limit bucket and is
recorded on every audit row; permission decisions are made by the permission
layer (section 4), not by trust alone.

## 3. Single execution pipeline

`ToolExecutor` (`src/tools/executor.ts`, implemented in
`src/tools/executor-implementation.ts`) is the only path from a model or UI
tool call to `tool.execute`. The stages, as marked in code:

| Stage | Location | Behavior |
| --- | --- | --- |
| Lookup | `src/tools/invocation-runner.ts` | `ToolRegistry.findByName`; an unknown name is denied and audited |
| Step 2: PreToolUse hooks | `src/tools/invocation-runner.ts` | `HookRunner` (`src/hooks/hook-runner.ts`) may block or rewrite input; plugin operation policy is resolved against the final input (`src/tools/plugin-operation-governance.ts`) |
| Step 2.5: shell pre-validator | `src/tools/invocation-runner.ts` | Structural validation of shell commands |
| Step 2.6: allowed directories | `src/tools/invocation-runner.ts` | Filesystem scope check against the working directory and authorized extra roots |
| Step 3: permission | `src/tools/invocation-authorization.ts` | Source-aware permission decision (section 4) |
| Step 5: rate limit | `src/tools/invocation-execution.ts` | Trust-based token bucket (section 9) |
| Audit-chain check | `src/tools/invocation-execution.ts` | When the permission audit chain is required and not writable, the call is blocked |
| Step 6: execute | `src/tools/invocation-execution.ts` | Runs the tool |
| Step 7: PostToolUse hooks | `src/tools/invocation-execution.ts` | Post hooks and feedback merge |
| Step 7b: DLP | `src/tools/invocation-execution.ts` | Masks display and audit surfaces (section 11) |
| Step 8: audit + result | `src/tools/invocation-execution.ts` | Always runs, including on error paths |

Pipeline rules:

1. No code executes a registered tool except through this pipeline.
2. Every early return (unknown tool, hook block, permission deny, rate limit)
   writes an audit record before returning an error result.
3. Execution failure does not skip audit.

Locked by `src/tools/__tests__/executor-public-contract.test.ts`,
`src/tools/__tests__/executor-mcp-plugin-parity.test.ts`, and
`src/tools/__tests__/executor-audit-chain.test.ts`.

## 4. Permission model

Step 3 delegates to `PermissionManager` (`src/permissions/permission-manager.ts`).
Each tool declares a `category` (`read`, `write`, `shell`, `network`, `meta`);
the permission layer combines category, source, host-derived risk
classification (`src/permissions/reviewer/risk-classifier.ts`), user rules, and
reviewer verdicts. The decision order, approval memory, and reviewer lanes are
specified in [Permission Policy Design](./permission-policy-design.md); this
page does not restate them.

## 5. MCP governance (trust: low)

`McpGovernance` (`src/mcp/mcp-governance.ts`) gates MCP servers before any of
their tools are registered.

### 5.1 Policy and deny-by-default

- Policy file: `<ave home>/governance/mcp-policy.json`.
- `defaultPolicy` is always `deny`; a policy that sets anything else is forced
  back to `deny`.
- Missing file: the built-in default policy applies (no managed servers,
  user-approved servers allowed). Unparseable file: the default policy applies
  with user-approved servers disabled.
- The policy may also list `bundledServers` (package, server, and a 64-hex
  fingerprint) for MCP servers shipped inside plugins.

### 5.2 Server validation (layer 1)

`validateServer` blocks a server when it has no approval, its approval is
`revoked` or `pending`, the global server count is exceeded, the configured
transport differs from the approved one, or the stdio command, environment, or
URL fails validation.

### 5.3 Tool registration (layer 3)

`validateToolRegistration` requires an `approved` server whose approval grants
the `tools` capability, enforces the approval's `maxTools`, and namespaces every
tool as `mcp_<toolNamePrefix>_<name>`. A namespaced name that already exists in
the registry is rejected (no shadowing). The prefix keeps MCP tools disjoint
from builtin and plugin names and lets a server's tools be removed as a group.

Request methods are gated per approved capability by
`validateRequestCapability` (`tools`, `resources`, `prompts`); unclassified
methods are denied.

### 5.4 Policy refresh

`startPolicyRefresh` re-reads the policy on an interval. Servers newly revoked,
or no longer admissible, are passed to `McpManager.handlePolicyWithdrawal`
(wired in `src/boot/steps/mcp-setup.ts`), which runs the kill switch
(section 10.1) for each.

Tests: `src/mcp/__tests__/mcp-governance.test.ts`.

## 6. Registry governance

`ToolRegistry` (`src/tools/registry.ts`) is the single registration source for
every consumer.

- Tool names must match `TOOL_NAME_PATTERN` (`^[a-zA-Z_][a-zA-Z0-9_]*$`,
  `src/tools/types.ts`). Names are registered verbatim; there is no rewriting
  or aliasing.
- `registerBatch` rejects plugin and MCP tools that declare the host-only
  `meta` category, a `decisionOverride`, or `categoryForInput`. Builtin `meta`
  tools must declare a supported `decisionOverride`
  (`src/tools/__tests__/registry-meta-governance.test.ts`).
- Plugin and MCP tools must carry their owner id (`pluginId` / `mcpServerId`).
  Same-name versioning is allowed only within one owner.
- Owner tool sets are replaced atomically (`replacePluginTools`,
  `reservePluginReplacement`, `reserveMcpReplacement`); failed validation leaves
  the live registry untouched (`src/tools/__tests__/registry-atomicity.test.ts`).
- Deny rules (`setDenyRules`) remove tools from `getVisibleTools`, and
  `getModelVisibleTools` further removes app-only MCP Apps tools. A denied tool
  never appears in the model-facing schema list. `findByName` still resolves
  app-only tools so their calls go through the same gate
  (`src/tools/__tests__/registry-model-exposure.test.ts`).
- Plugin teardown fires the runtime's `onDisable` hook
  (`src/boot/steps/plugin-runtime/lifecycle.ts`), which notifies
  `ConversationLoop.onPluginDisabled`; the host keeps running without the
  plugin.

## 7. Builtin tools (trust: high)

Builtins are registered in `src/boot/tools.ts`; native file and shell tools live
in `src/tools/file-tools.ts` and `src/tools/shell-tools.ts`. Each tool's
permission behavior follows from its declared `category` in its own source
file, not from a fixed table here.

### 7.1 `web_fetch`: screen the request, not the destination

`web_fetch` (`src/tools/web-fetch.ts`) always has category `network`, so it is
withheld from unattended lanes, is not covered by an away-authority read grant,
and has no standing allow rule.

For a public destination, `screenEgressRequest`
(`src/permissions/reviewer/risk-classifier.ts`) grades the request from the URL
alone; nothing a tool or plugin asserts about itself is used.

| Request shape | Risk |
| --- | --- |
| Public host name, screen passes | low (runs without a prompt) |
| Credential-shaped token in the URL (same patterns as `scrubSecretsForLLM`) | high |
| Path + query + fragment longer than 512 characters | high |
| Opaque run of 32+ characters in a host label or path segment | high |
| Query name, query value, or fragment of 32+ characters | high |
| Userinfo in the authority (`user:pw@`) | high |
| Routable address literal instead of a host name | medium |
| Private-network opt-in, loopback, non-routable address | graded by the existing network rules |

When approval is needed, "always allow" is remembered per host as
`web_fetch:host:<host>`; private-network requests use a separate
`web_fetch:host:private-network:<host>` key.

Known limit: data split into sub-threshold pieces across segments or across
many requests is not visible to a per-request screen. The 512-character tail
rule bounds one request; the category restrictions above bound the rest.
Content-addressed URLs (for example a 40-character commit hash) are
indistinguishable from payloads and prompt once.

Tests: `src/permissions/reviewer/__tests__/web-fetch-egress-screen.test.ts`.

## 8. Audit log

`AuditLogger` (`src/audit/audit-logger.ts`) writes JSONL under
`<ave home>/audit/`, partitioned by UTC day:

- `<date>.jsonl` - telemetry channel (turns, tool calls, approvals, kill
  switch, DLP, errors).
- `<date>.permission-audit.jsonl` - hash-chained permission audit channel.
- `<date>.permission-shadow.jsonl`, `<date>.sandbox-gate.jsonl` - dedicated
  channels.

Tool calls are recorded as `AuditEntry` rows with `type: "tool_call"` and a
`toolCalls[]` element carrying `name`, `isError`, `source`, `trust`,
`executionTimeMs`, `toolUseId`, `permissionDecision`, `permissionReason`,
`rateLimitRemaining`, and `terminationReason`
(`ok | ceiling | user-abort | error | indeterminate`). Input is sanitized before
it is written.

Rotation defaults: active file rotated at 10 MB or 7 days, archives deleted
after 30 days. Querying and dashboards are covered in the
[Observability Guide](../references/observability-guide.md).

## 9. Rate limiting

`RateLimiter` (`src/tools/pipeline/rate-limiter.ts`) is a token bucket owned by
each `ToolExecutor` and consumed at Step 5.

| Trust | Capacity and refill |
| --- | --- |
| `high` | unlimited (`remaining` reported as `Infinity`) |
| `medium` | 60 tokens, refilled continuously at 60 per minute |
| `low` | 20 tokens, refilled continuously at 20 per minute |

- Buckets are keyed by `<trust>:<toolName>`; each tool has its own bucket.
- A bucket starts full; each call consumes one token.
- An empty bucket returns `be_executor.rateLimitExceeded` as an error result,
  and the call is audited with `rateLimitRemaining: 0`.
- There is no per-session cap.

Tests: `src/tools/__tests__/executor-rate-limiter.test.ts`.

## 10. Kill switch

### 10.1 Kill switch

`McpManager.killSwitch(serverId)` (`src/mcp/mcp-manager.ts`) retires an MCP
server immediately:

1. Disconnect the client; pending requests on it reject.
2. `ToolRegistry.unregisterByMcp(serverId)` removes every tool that server
   contributed in one pass.
3. Clear bundled ownership and the runtime approval for the server.
4. Write an audit row with `type: "kill_switch"`.
5. Signal the renderer (`onServerDisconnected`) so MCP App cards are disabled.

Triggers: the renderer IPC channel `CHANNELS.mcp.kill`
(`src/ipc/domains/plugins.ts`, host-renderer sender only) and policy withdrawal
(section 5.4). Tests: `src/mcp/__tests__/mcp-manager-disconnect.test.ts`.

## 11. Data loss prevention

Step 7b masks sensitive data on the renderer callback and audit surfaces only.
The `tool_result` returned to the model is not modified, so later tools still
receive the user's operational data.

- Credentials are always masked, regardless of settings.
- PII (`PII_PATTERNS` in `src/shared/dlp.ts`: Korean resident numbers, email,
  Korean and US phone numbers, credit cards) is masked when the
  `privacy.piiRedactEnabled` setting is on.
- A hit writes an extra audit row whose `permissionDecision` is `dlp_masked`
  and lists the detected pattern kinds.

Tests: `src/audit/__tests__/dlp-mask-sensitive.test.ts`,
`src/audit/__tests__/dlp-redact.test.ts`.

## Related

- [Vision](../vision/README.md)
- [Architecture](./architecture.md)
- [Permission Policy Design](./permission-policy-design.md)
- [MCP Alignment Design](./mcp-alignment-design.md)
- [Plugin Tool Schema Design](../references/plugin-tool-schema-design.md)
- [Observability Guide](../references/observability-guide.md)
- [Tool Result `kind` Sentinels](../references/tool-result-kind-sentinels.md)
