# Sandbox Isolation

Status: Decided and shipped, with the per-OS runner design superseded by a single sandbox runtime package. Section 3 describes the current code; sections 1 and 2 record the question and the options that were weighed.

The permission layers (deny rules, allowed directories, the approval gate, the reviewer) decide whether a tool call may run. None of them physically confines what the spawned process does afterwards. This record covers the OS-level confinement layer, how its presence is reported to the reviewer and the approval surface, and the audit channel that records each reviewed call. Product intent lives in [the vision](../vision/README.md).

## 1. Question

Can a tool process spawned by the app (shell, terminal, MCP stdio server, plugin child, hook) be confined so that it cannot reach the network or write outside an allowed set, on macOS, Linux and Windows, without per-invocation elevation, and can the reviewer be told honestly how strong that confinement is?

Four filters were applied to every candidate mechanism:

| Filter | Requirement |
|---|---|
| Egress | Blocks network egress from the confined process; evidence graded as kernel-enforced, best-effort policy, or unverified. |
| Overhead | Added tool latency at most 30% of the unconfined run. |
| License | Usable without a commercial license. |
| Deployable | Ships with the app or the OS; at most a one-time administrator step, never elevation per call. |

## 2. Options considered

Candidates were described by property:

| Option | Property | Outcome |
|---|---|---|
| Linux user-namespace wrapper (network namespace + bind mounts) | Kernel-enforced egress block, low overhead, OS package | Kept; it is the Linux backend today (`bwrap`). |
| Linux filesystem-only LSM policy | Confines files, not network | Rejected alone; reserved as the `fs-only` kind. |
| macOS profile-based policy sandbox driven by a per-run profile | Best-effort: early profiles left loopback, DNS and local sockets open | Initially accepted as partial; replaced by the runtime's macOS backend, which routes egress through a loopback proxy. |
| macOS per-app declarative entitlements | Strong, but static per app and incompatible with dynamic tool egress | Rejected. |
| Windows capability-SID container + job object | Strong egress block in principle; compatibility with the packaged app unproven | Chosen on paper; never shipped. |
| Windows job object alone | Process limits only | Rejected (no network or filesystem confinement). |
| Linux guest VM on every OS ("everywhere container") | Doubles the audit surface, 10-20% overhead, guest image versioned apart from the app | Rejected. |
| Guest VM only as a fallback where the native option is partial | Hundreds of MB to GB of download, second deployment path | Rejected. |
| Network-only isolation | Leaves filesystem and process unconfined while letting the reviewer see "sandboxed" | Rejected: a sandbox confines filesystem, process and network, or it does not claim isolation. |
| Bundled binaries vs OS dependencies vs hybrid | Bundling adds a binary-verification and update burden; hybrid keeps two paths forever | OS dependencies chosen, with one later exception (see 3.1). |

Decisions that still hold:

- No fallback runner. If confinement cannot activate, the capability is `none` and the reviewer's no-downgrade rule applies; nothing silently substitutes a weaker mechanism.
- Partial confinement is reported as partial, not rounded up to full or down to none.
- Capability reaches the reviewer through the prompt formatter (`formatSandboxCapabilityForPrompt`), not through `src/permissions/evaluation-context.ts`.
- MCP child processes are a confined spawn path like any other.
- Reviewer directives: missing stated intent blocks a downgrade the same way weak isolation does; exact user decisions are remembered per tool and canonical input (3.5); a HIGH verdict shows a read-only reason and only offers one-shot allow or deny.

Superseded: the original design registered one runner per OS behind a host-owned `SandboxRunner` interface, each reporting its own kind. That registry and those kinds were removed. A proposed reject-and-retry loop with a reviewer hint and a retry cap was not built.

## 3. What shipped

### 3.1 One sandbox runtime, one `asrt` kind

Confinement is provided by the `@anthropic-ai/sandbox-runtime` package (pinned in `package.json`), loaded only in the main process by `src/permissions/asrt-sandbox.ts`. Every platform reports `kind: "asrt"`; what is actually confined is carried separately in `confines` (`src/shared/sandbox-capability-info.ts`):

| Platform | Backend | `confines` | Install |
|---|---|---|---|
| macOS | OS built-in sandbox, egress through the runtime's loopback proxy | filesystem, process, network | Nothing to install. |
| Linux | `bwrap`, plus `socat` and `ripgrep` | filesystem, process, network | OS packages. The workspace terminal also needs util-linux `script` at `/usr/bin/script` (installed by default: `bsdutils` on Debian and Ubuntu, `util-linux` elsewhere). |
| Windows | Vendored `srt-win` helper running tools as a dedicated low-privilege `srt-sandbox` account; filesystem by ACL, egress by an OS packet filter and the loopback proxy | filesystem, network (no process isolation) | One-time administrator setup from Settings. |

The Windows helper is the one bundled binary: it ships inside the package and is unpacked from `app.asar` (`getVendoredSrtWinExePath`). On Windows every confined process runs as the same account, so filesystem confinement protects the host, not one plugin from another.

The write jail for a spawn comes from `src/permissions/sandbox-write-jail.ts` (the plugin's data directory, user-authorized directories), sensitive paths are read- and write-denied by the floors in `asrt-sandbox.ts`, and each confined process gets a private HOME and temp directory (`sandbox-process-home.ts`). `linux-sandbox-wrap.ts` hardens the generated Linux argv.

### 3.2 Boot gate

`src/boot/steps/sandbox-init.ts` decides once per process, with `decideSandboxGate` in `sandbox-gate.ts`:

- Two scopes over one ASRT runtime. The shell sandbox is on by default on macOS and Linux and off on Windows; extension confinement is off by default everywhere. The shell sandbox (`features.osToolSandbox`, or `AVE_SANDBOX_ENABLED=1`) confines host shells: the bash and PowerShell tools and the workspace terminal. Extension confinement (`features.pluginWorkerConfinement`, or `AVE_PLUGIN_WORKER_CONFINEMENT=1`) confines plugin workers, plugin children, plugin hooks and MCP stdio servers. ASRT initializes when either scope is requested; each spawn path reads only its own scope (`isShellSandboxActive`, `isPluginWorkerConfinementActive`), and the host-shell plan reads `detectShellSandboxCapability`. Settings load derives `pluginWorkerConfinement` from the stored `osToolSandbox` whenever the file lacks the boolean (a file an older build wrote, including after a downgrade), so an install that had `osToolSandbox: true` gets both scopes and every other install neither. Booting with `AVE_SANDBOX_ENABLED=1` and no worker request logs a warning that extension processes run unconfined.
- Dependencies present: initialize and publish the capability (`activate`).
- Dependencies missing with the Settings toggle: stay unconfined, report `none`, warn loudly (`degrade`).
- Dependencies missing with `AVE_SANDBOX_ENABLED=1` or `AVE_PLUGIN_WORKER_CONFINEMENT=1` on macOS or Linux: refuse to start (`abort`). Windows never aborts, so first run can reach the install step.

The outcome is written to the boot audit log and shown in the Permissions tab.

### 3.3 Capability as the reviewer's source of truth

`src/permissions/sandbox-capability.ts` owns the capability. `detectSandboxCapability()` returns the published capability, or `{ kind: "none", confidence: "verified" }` when nothing was published.

- `SandboxKind`: `none`, `asrt`, `disposable-container`, `partial`, `fs-only`. Only `none` and `asrt` are produced for host tools today; `disposable-container` belongs to a [brokered guest route](../architecture/permission-policy-design.md#host-native-workload-broker); `partial` and `fs-only` are reserved.
- Confidence: `verified`, `assumed`, `policy-best-effort` (reserved; no current backend reports it).
- `isWeakSandbox()` is true for `none`, `partial` or `assumed`. The reviewer framework (`src/shared/permission-reviewer-framework.ts`) then forbids an LLM downgrade of a rule MEDIUM or HIGH to LOW; `risk-classifier.ts` composes `max(rule, llm)`.
- `sandboxRelaxesCategory()` decides relaxation per tool category from `confines`: network needs network, read/write/meta need filesystem, shell needs filesystem and process. On Windows, shell calls therefore never relax.

The approval surface renders the capability card (`tool-approval-sandbox`) from the same value.

### 3.4 Confined spawn paths

| Path | Where |
|---|---|
| Shell tools | `src/tools/shell-tools.ts` (`wrapToolCommand`) |
| Integrated terminal | `src/main/terminal/pty-manager.ts` (`wrapWorkerCommand`; on macOS `wrapTerminalCommand`, which grants `file-ioctl` on the shell's own pty slave only, through the trampoline in `terminal-tty-handoff.ts`; on Linux the shell runs on its own pty under util-linux `script` inside the sandbox, `terminal-inner-pty.ts`) |
| MCP stdio servers | `src/mcp/mcp-client.ts` |
| Out-of-process plugins | `src/plugins/isolation/out-of-process-plugin.ts` through `spawnConfinedChild` |
| Bundled hook and server processes | `src/sandbox/wrap-bundled-command.ts`, used by `src/hooks/script-hook-runner.ts` and the MCP client |

The `uv` setup commands in `src/main/python-runtime.ts` are deliberately not confined: they run at boot, before the sandbox is initialized, and need package-index egress.

Network policy for all of these is one shared allow-list; see [network-restricted evaluation](./network-restricted-eval.md).

### 3.5 Exact user-decision memory and canonical keys

`src/permissions/user-approval-store.ts` holds exact allow and deny decisions in `~/.ave/permissions/user-approvals.json` (directory `0o700`, file `0o600`, atomic writes).

- It is separate from the glob rules edited in Settings; a foreground approval never widens those rules.
- Key: SHA-256 of tool name, canonical args, source, and, when present, trust origin and approval cache key, joined by NUL. When a working directory is bound, that hash is wrapped again with the directory identity through `canonicalStringify`. A low-trust caller therefore cannot reuse a high-trust approval.
- Scope `session` (memory only) or `persistent` (disk). A completed HIGH assessment and mandatory one-shot approvals are never stored as allows; exact denies may persist at any risk.
- A memory hit composes `max(fresh rule verdict, stored verdict)`; a fresh rule verdict above the stored one forces a new approval.

`src/shared/canonical-json.ts` (`canonicalStringify`) makes record and lookup keys symmetric: object keys sorted, `undefined` members dropped, array order kept with nested objects canonicalized, depth capped at 100, and only true ancestor cycles marked. It is shared by the main process and the renderer, and should only receive JSON-clean values.

### 3.6 S2 sandbox audit fields

Each reviewed call writes one `SandboxAuditEntry` (`src/audit/sandbox-audit.ts`), separate from the permission-gate audit entries in `audit-schema.ts`. `buildSandboxAuditEntry()` always sets `timestamp` itself.

| Field | Type | Meaning |
|---|---|---|
| `timestamp` | string | ISO 8601 time the entry was built. |
| `tool.name` | string | Tool name. |
| `tool.args` | string | Tool input as JSON, DLP-masked by the caller. |
| `tool.source` | string | Tool source (`builtin`, `plugin` or `mcp`). |
| `tool.trustOrigin` | `ToolTrustOrigin`, optional | Trust origin of the call. |
| `tool.approvalCacheKey` | string, optional | Authority-sensitive approval identity. |
| `sandbox.kind` | `SandboxKind` | Capability used for this call's verdict. |
| `sandbox.confidence` | `verified` / `assumed` / `policy-best-effort` | Capability confidence. |
| `sandbox.events` | `SandboxEvent[]` | `{ type: "egress_attempted", blocked, target }` or `{ type: "fs_write_attempted", blocked, path }`. |
| `sandbox.spawnLatencyMs` | number | Spawn to first stdout byte, in ms. |
| `sandbox.overheadPercent` | number | `spawnLatencyMs / totalExecutionMs * 100`, two decimals. |
| `reviewer.ruleVerdict` | `low` / `medium` / `high` | Deterministic rule verdict. |
| `reviewer.llmVerdict` | `low` / `medium` / `high` or `null` | LLM verdict; `high` when it fails closed; `null` when no LLM verdict exists (memory hit, rule-only, host-determined, fallback to rules). |
| `reviewer.finalVerdict` | `low` / `medium` / `high` | `max(rule, llm)`, or `max(rule, stored)` on a memory hit. |
| `reviewer.compositionRulesTriggered` | `{ rule, reason }[]` | Rules that changed the outcome. |
| `reviewer.userApprovalUsed` | object or `null` | `memoryHit`, `nlJustification` (masked, or `null`), `verdictAtApproval` (or `null`); `null` when no interactive approval was involved. |

Sink (`src/audit/sandbox-audit-sink.ts`): one JSON line per entry appended to `~/.ave/audit/<YYYY-MM-DD>.sandbox.jsonl`, with the date in UTC like the permission-gate channel, directory `0o700`, file `0o600`. The sink applies no DLP; callers mask `args` and `nlJustification`. Write failures are swallowed at the call sites so audit never blocks a tool.

Current producers are `PermissionManager.dispatchReviewer` (`src/permissions/permission-manager.ts`) and the approval-memory skip (`src/tools/pipeline/approval-memory-skip.ts`). Both run before execution, so `events` is always `[]` and `spawnLatencyMs` and `overheadPercent` are `0`, meaning "not measured". The only composition rule recorded today is `host-determined`.

## 4. Risks that remain

- Windows has no process isolation, and all confined processes share one account.
- The Linux CI job that runs the full suite has no `bwrap`; live confinement is measured only in the dedicated jobs (see the evaluation page).
- Runtime-observed events and overhead are defined in the schema but not populated.

## Related

- [Network-restricted evaluation](./network-restricted-eval.md)
- [Permission policy design](../architecture/permission-policy-design.md)
- [Architecture](../architecture/architecture.md)
- [Plugin process isolation](../blueprints/plugin-process-isolation.md)
