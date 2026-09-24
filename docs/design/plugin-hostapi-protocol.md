# Plugin HostApi as a versioned protocol

Status: design, not implemented. This is the next track after the owner's decision to
retire the `ave-plugin-sdk` repository and ship the contract (types and manifest schema)
as ave release assets. It proposes turning the in-process `PluginHostApi` object
into a published, versioned, language-neutral protocol, so that every Ave code plugin
runs in its own process and consumes the host the way an MCP server consumes a client.

Anchors: `docs/architecture/architecture.md` (Plugin Runtime, MCP↔plugin execution
parity, OS Execution Sandbox And Plugin Workers),
`docs/blueprints/plugin-process-isolation.md` (the shipped process boundary this design
builds on), `docs/architecture/mcp-alignment-design.md` (the loopback topology and the
deferred wire migration), `src/plugins/public-contract.ts` (the contract source of truth).

Every claim about current code names a `file:line` in the `35e82405c` checkout. Claims
about other hosts cite their official documentation.

---

## 0. What is already true, and what this document changes

The process boundary exists. It is not the open question.

- `OUT_OF_PROCESS_PLUGIN_IDS` routes `vega-helper`, `lyra-mail`, `local-indexer`,
  `meeting` and `orion-api` into a confined child process
  (`src/plugins/isolation/out-of-process-plugins.ts:856-858`; commit `72b8c3b50`,
  2026-08-26, "admit orion-api out-of-process — 5/5"). The set is frozen and read by no
  configuration, manifest field or environment variable; a plugin moves only through a
  reviewed commit (`out-of-process-plugins.ts:7-12`).
- The child is spawned through `spawnConfinedChild` with `process.execPath` under
  `ELECTRON_RUN_AS_NODE=1`, piped stdio, ASRT wrap when the host's own sandbox is on,
  and `deny-only` grant mode on Windows (`out-of-process-plugin.ts:954-986`).
- The child speaks two contracts on one framed stdio stream: host→child is JSON-RPC
  (MCP `tools/call` plus five `ave/instance/*` lifecycle methods,
  `plugin-instance-wire.ts:38-45`), child→host is a **non-JSON-RPC** envelope keyed by
  `callId`/`kind` (`host-api-wire.ts:55-83`, `child-stream-multiplex.ts:13-18`).
- Every one of the 48 hostApi paths has a four-axis wire contract (arguments, result,
  lifetime, error set) in `HOSTAPI_PATH_CONTRACTS` (`host-api-wire.ts:590-1005`), and
  `out-of-process-plugin.test.ts` fails if a path is left unbound
  (`out-of-process-plugins.ts:35-38`).

What is **not** true yet, and what this document designs:

1. The wire is a private TypeScript contract. A plugin cannot be written against it in
   another language, no schema is published, and nothing negotiates a version at connect:
   the child refuses a mismatched constant (`host-api-dispatcher.ts:2009-2012`,
   `plugin-child-main.ts:164`) and there is no way to ask the host what it serves.
2. The reverse channel is not JSON-RPC, so an off-the-shelf JSON-RPC or MCP library
   cannot speak it (`child-stream-multiplex.ts:46-65` classifies frames by which fields
   they happen to carry).
3. The JS plugin still consumes `PluginHostApi` as a typed object built by a host-shipped
   child runtime (`plugin-child-runtime.ts:5-9`), so "types as release assets" remains the
   only way to write a plugin.
4. Two host-side plugin-specific tables exist that AGENTS.md forbids: the routing census
   itself, and `PLUGIN_ENVELOPE_GRANTS` for `local-indexer`
   (`out-of-process-plugin.ts:317-360`).
5. `resolveApiKey` ships the raw credential into the child (`host-api-wire.ts:1628-1645`,
   `host-api-child.ts:397-421`).
6. The `git` plugin, the `template` scaffold and the marketplace hello-world are not on
   the isolated path (`out-of-process-plugins.ts:856-858` lists five ids; `template` is
   "not installed; a scaffold, out of scope", `:854`).

Note for the reviewer: `docs/blueprints/plugin-process-isolation.md:3` still reads
"Status: design, not implemented". The code and `git log` say Stages 5-8 shipped. That
line is stale and should be corrected in the same change that lands this page.

---

## 1. Goal and non-goals

The owner's six reasons for the Claude Code / Codex "manifest schema plus protocol, no
host SDK" model hold only because plugin code runs outside the host process. Ave now
has the process. This track makes the contract match it.

| # | Reason | Ave gains it? | How |
|---|---|---|---|
| 1 | Executable parts are separate processes; a compile-time type cannot guarantee the other side anyway | **Yes** | Already true for 5/5 first-party plugins (§0). The remaining plugins move by default (§9). |
| 2 | Contract is language neutral | **Yes** | The reverse channel becomes JSON-RPC 2.0 (`ave/host/*`) with a host-published JSON Schema (§3, §6). A plugin may ship its own executable instead of a JS entry (§2.1). |
| 3 | Same plugin loads in several hosts | **Partial, deliberately** | The manifest is already an Agent Plugins 1.0.0 document with `extensions["ai.agent-connector.ave"]` (`schemas/plugin-manifest.schema.json:5`, `public-contract.ts:36-37`). Skills, hooks and `mcpServers` contributions are portable. The `ave/host/*` surface is Ave-only by design: audio capture, floating dock, auth partitions and work proposals have no portable equivalent, and pretending otherwise would produce a lowest-common-denominator API. |
| 4 | Host and plugins release independently through version and capability negotiation, plus report-and-ignore for unknown fields | **Yes** | `initialize` (MCP) plus `ave/instance/construct` carries the host protocol version and the capability list; unknown optional fields are reported and ignored; unknown methods fail loudly (§3.2, §3.3). |
| 5 | Host isolates and sandboxes at the boundary | **Yes on macOS/Linux; filesystem+network only on Windows** | ASRT (`architecture.md:999-1006`). The Windows process-confinement gap stays an owner decision (§7.3, §13). |
| 6 | Run-time errors are covered by `$schema` editor validation, a validate CLI and clear failure at load | **Yes** | Manifest schema already exists; the protocol schema and a host-built validate CLI are added (§6, §10). |

Non-goals:

- Replacing MCP for tool execution. Tools already travel as MCP `tools/call`
  (`out-of-process-plugin.ts:1397`) and register through `plugin-tool-from-mcp.ts`; the
  parity invariant (`architecture.md:966-998`) is preserved untouched.
- Mapping the whole HostApi onto MCP client features (sampling, elicitation). Rejected in
  §12.4; `mcp-alignment-design.md:1-12` already deferred the full wire migration.
- Multi-host portability of Ave-specific host capabilities.
- Changing the trust model. Trust stays host-derived from install source and signature,
  never from where the code runs (§7.2).

---

## 2. Process model

### 2.1 One process per plugin, two ways to produce it

Today every isolated plugin is a Node process running the host-shipped
`plugin-child-main.js` (`scripts/build-main-esbuild.mjs:46`,
`out-of-process-plugin.ts:200-204`), which imports the manifest `entry` with the same
`importPluginFactory` the in-process loader uses (`plugin-child-main.ts:14-16`,
`plugin-loader.ts:77-81`).

The protocol keeps that as the **reference runtime** and adds a second, language-neutral
way to produce the process:

```jsonc
// extensions["ai.agent-connector.ave"] — exactly one of the two
"entry": "dist/hostPlugin.js"                    // JS module; host spawns its reference runtime
"process": { "command": "./bin/plugin", "args": [] }   // any executable; speaks the protocol itself
```

`process.command` follows the Agent Plugins stdio rule: a bare executable name or a
`./`-relative path inside the plugin root, with `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`
expanded in `args` and `env` and both variables set in the child environment
([Agent Plugins §9.1](https://agent-plugins.org/specification)). `PLUGIN_DATA` is
`pluginDataDir` (`public-contract.ts:2157`). A `process` entry is admitted only for a
signed marketplace artifact or an admin install; a local-dev sideload with `process` is
refused with `process-entry-requires-signed-artifact` (§7.3).

Both forms go through `spawnConfinedChild` and nowhere else
(`out-of-process-plugin.ts:9-11`, `confined-child.ts:1-22`). The deny floor
(`~/.ave/secrets`, `~/.ssh`, `~/.aws`) is owned by that primitive, not by callers
(`confined-child.ts:15-21`).

### 2.2 Sandboxing per platform

| Platform | Substrate | Confines | Source |
|---|---|---|---|
| macOS | ASRT `sandbox-exec` profile, allow-list grant mode | filesystem, process, network | `architecture.md:1000-1003`, `confined-child.ts:42-44` |
| Linux | ASRT bwrap `--bind` / `--unshare-net`, allow-list grant mode | filesystem, process, network | same; UDS reachability `worker-spawn.ts:17-22` |
| Windows | srt-win with per-process ACL grants, deny-only grant mode | filesystem, network. **No process confinement** | `architecture.md:1004-1006`, `confined-child.ts:43-46`, `out-of-process-plugin.ts:970` |

The child is confined exactly as much as the host is: `features.osToolSandbox` decides for
the host's own tools, its workers and its plugin children alike; when it is off the child
is spawned unwrapped and nothing marks it confined, so the reviewer grants no
sandbox-based relaxation (`out-of-process-plugin.ts:13-21`, `sandbox-gate.ts:20`).
This design does not change that rule. It does add one requirement: a plugin with a
`process` entry (non-JS) **must** run wrapped; when the sandbox is off it does not load,
because an arbitrary executable with no confinement is a different risk class than a JS
module the host's own runtime evaluates (§7.3).

The filesystem envelope is `{pluginRoot, pluginDataDir, socketDir, workerRunRoot}` for
read and `{pluginDataDir, socketDir}` for write (`out-of-process-plugin.ts:717-718`).
Widening it today is a host-side table keyed by plugin id
(`PLUGIN_ENVELOPE_GRANTS`, `:317`). This design moves the declaration into the manifest:

```jsonc
"sandbox": {
  "read":  [{ "kind": "hostDirectory", "segments": ["runtime"], "why": "..." },
            { "kind": "hostDirectory", "segments": ["certs"],   "why": "..." }],
  "write": [{ "kind": "userChosenDirectory", "configKey": "indexStorageRoot", "why": "..." }]
}
```

The host keeps the authority: `hostDirectory` is restricted to a closed allow-list of
`~/.ave` subtrees the host is willing to expose, `userChosenDirectory` must resolve to an
absolute path the user set (`out-of-process-plugin.ts:600-660` already implements the
resolution and refusal), and a grant that pierces the sensitive deny floor
(`certs/corp-ca.pem`, `:338-340`) requires install-time approval like `networkAccess`.
This closes the AGENTS.md "no plugin-specific branches in the host" violation without
weakening the envelope.

### 2.3 Transport: stdio

Stdio, not a Unix domain socket. The blueprint's reason stands: ASRT confinement works by
wrapping argv, and a second channel would have to be carried through the sandbox wrap as
well (`child-stream-multiplex.ts:5-11`, blueprint §5.2). The pipes are the identity
(§2.4). A UDS is still used where a *worker* the plugin spawns must be reached from the
host (`worker-spawn.ts:12-29`), and that stays a `spawnWorker` concern, not a protocol
transport.

Framing: the shipped channel is LSP-style `Content-Length` framing
(`stdio-framing.ts:1-17`), and the host's external MCP client uses the same framing
(`mcp-client.ts:2366, 2451-2460`). The MCP 2025-11-25 stdio transport instead specifies
newline-delimited messages that MUST NOT contain embedded newlines, with `stderr` free
for logging
([MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)).
For a language-neutral protocol an off-the-shelf MCP server library will emit
newline-delimited frames. Decision: **the published protocol is newline-delimited**, per
MCP; the host decoder and the host-shipped JS runtime switch in the same release, so no
JS plugin sees the change. This is Open Question 1 because it also touches the external
MCP client.

Stdout is the protocol; the reference runtime rebinds `console.*` and `process.stdout`
to stderr before plugin code runs (`plugin-child-main.ts:18-25`). A `process`-entry plugin
owns that discipline itself; the conformance suite checks it (§10).

### 2.4 Identity binding

The host spawns the process and owns both ends of its pipes. Identity is therefore the
connection: the host attributes every inbound message to the `pluginId` it spawned that
connection for, and the plugin never names itself.

Today the envelope carries `pluginId` and `generationId` and the dispatcher refuses a
mismatch (`host-api-wire.ts:49-59`, `host-api-dispatcher.ts:2015-2018`). In the protocol
those fields are **removed from the wire**: a field the receiver must ignore or refuse is
a field an author will try to set. The generation is the process — a new incarnation
spawns a new child with a fresh id minted per factory call
(`out-of-process-plugin.ts:1130-1133`) — so generation pinning becomes "this connection
is this generation", enforced by the host closing the pipe when the generation retires
(`:1421-1443`).

Consequences that must hold:

- `getInstalledPluginIds` excludes the caller (`public-contract.ts:1274-1280`) using the
  host's binding, never a wire field.
- `emitEvent` authority is the manifest of the bound plugin; the child's local
  pre-check remains a courtesy that preserves the synchronous throw and is re-decided
  host-side (`host-api-child.ts:32-36`).
- `agentApproval.respond` HMAC/nonce (`public-contract.ts:1895-1900`) stays as is; the
  connection binding is an additional check, not a replacement.

### 2.5 Lifecycle

```
spawn ──► initialize (MCP, host→plugin) ──► ave/instance/construct ──► tools/list
  ──► ave/instance/start ──► [generation published] ──► ave/instance/onPublished
  ──► operate ──► ave/instance/stop (bounded) ──► pipe close ──► SIGTERM ──► SIGKILL
```

- `initialize` is the MCP handshake: protocol version and capabilities
  ([MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)).
  The host is the MCP client, the plugin process is the MCP server, exactly as the
  loopback arm already frames it (`plugin-child-runtime.ts:5-9`,
  `plugin-mcp-server.ts:1-11`).
- `ave/instance/construct` carries what `PluginConstructParams` carries today: the
  verified manifest (never re-read from disk in the child, `plugin-instance-wire.ts:59-63`),
  the context, `declaredToolNames`, and now the **host protocol version and served
  capability list** (§3.2). The reply names the implemented tools, lifecycle hooks and
  the plugin's required capability list (`:84-92`).
- `onPublished` is the plugin's startup; a failure there is recorded as degraded and
  dispatch opens so each call reports its own reason (`runtime/index.ts:3306-3330`).
  Unchanged.
- `stop` is bounded by `TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs` (10 s,
  `tool-timeout-policy.ts:133`, `out-of-process-plugin.ts:1425-1432`), then the pipe
  closes, then SIGTERM→SIGKILL through the managed-child registry.
- Crash: a dead child is a failed call, never a hung one; every pending request rejects
  and every host-side subscription the child opened is released
  (`plugin-child-transport.ts:17-21`, `subscription-ledger.ts:5-18`). A request that
  outlives its deadline kills the child (`plugin-child-transport.ts:141-146`). There is
  **no automatic restart inside a generation** and no retry in-process
  (`out-of-process-plugins.ts:14-15`); the plugin is marked degraded and restart is an
  explicit host action (the existing `restartPlugin`/`config.set` path,
  `out-of-process-plugin.ts:910`). Automatic restart is rejected here because a plugin
  that crashes on a specific input would loop, and a loop hides the input.
- Host death: the child exits when its stdin ends (`plugin-child-main.ts:319-326`). A
  `process`-entry plugin must implement the same rule; the conformance suite spawns it,
  closes stdin and asserts exit within 5 s (§10).

---

## 3. Protocol

### 3.1 Shape: one JSON-RPC 2.0 session, MCP for the plugin-served half, `ave/host/*` for the host-served half

Decision: keep MCP unchanged for everything the plugin *serves* (`tools/list`,
`tools/call`, `resources/read` for `ui://`), and make everything the plugin *calls on
the host* a JSON-RPC method under `ave/host/`, on the same session, in the reverse
direction. Notifications go both ways with the same `notifications/` convention.

Why this and not the alternatives:

- MCP already is a bidirectional JSON-RPC session — sampling, elicitation and
  `roots/list` are server→client requests. A host-capability namespace in the reverse
  direction is MCP-shaped without being MCP-defined, so the plugin can use any JSON-RPC
  library and any MCP server library, and one decoder serves both halves.
- The current reverse channel is a bespoke shape distinguished by field presence
  (`child-stream-multiplex.ts:52-64`). It was chosen so the two contracts could not
  collide; JSON-RPC `id` + a namespaced `method` gives the same guarantee, and MCP itself
  reserves the `ave/` style prefix pattern for vendor methods the way `_meta` keys are
  namespaced.
- Mapping hostApi onto standard client features (sampling for `callLlm`, elicitation
  for `pickFolders`) loses the host's own semantics — `callLlm` carries the host rate
  window and key resolution; `pickFolders` is an OS dialog, not a form — and
  `mcp-alignment-design.md:1-12` already recorded that the full wire migration is not
  the direction. Rejected in §12.4.

Method naming: `ave/host/<path with "." replaced by "/">`. So `storage.read` is
`ave/host/storage/read`, `agentApproval.request` is `ave/host/agentApproval/request`.
The five lifecycle methods keep `ave/instance/*` (`plugin-instance-wire.ts:38-45`).
Tool names keep `^[a-zA-Z_][a-zA-Z0-9_]*$` (AGENTS.md); protocol method names are
host-owned and are not in that namespace.

Params are a JSON object, never a positional array, so a field can be added without
shifting an argument. Every method's params and result are described by JSON Schema
(§6.1); the four-axis contract table (`host-api-wire.ts:233-292`) is the generator's
input, not a second hand-written list.

### 3.2 Version and capability negotiation at connect

Two versions travel, because two contracts change for different reasons
(`plugin-instance-wire.ts:22-28`):

1. **MCP protocol version** in `initialize`, per MCP: the client sends the latest it
   supports, the server answers with the same or its own latest, and the client
   disconnects if it cannot speak the reply
   ([MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)).
   The host proposes `MCP_PROTOCOL_VERSION` (`protocol-constants.ts:17-18`).
2. **Ave host protocol version** in `ave/instance/construct`:

```jsonc
// host → plugin (construct params, additions)
"hostProtocol": {
  "version": "1",                                  // integer-as-string; bumps on any breaking change
  "capabilities": ["storage/read", "storage/write", "callLlm", "hostFetch",
                   "startAudioCapture", "attachFloatingPanel", ...]   // every ave/host method this host serves
}
// plugin → host (construct result, additions)
"pluginProtocol": {
  "version": "1",
  "requires": ["storage/read", "callLlm"]          // methods the plugin will not run without
}
```

Rules:

- The host refuses the load with `incompatible-host-protocol` when the plugin's version
  is not one the host serves, or when a `requires` entry is not in `capabilities`. This is
  the same fail-closed shape as `markIncompatibleAppVersion`
  (`runtime/index.ts:2883-2900`) and surfaces in the same plugin-status UI.
- A plugin **may** call a method not in `requires` and handle `method-not-found`; that is
  how optional members (`hostFetch?`, `spawnWorker?`, `resolveApiKey?`,
  `getAppPreference?` are optional today, `public-contract.ts:1323, 1375, 1414, 1766`)
  are expressed without `undefined` checks.
- Capabilities are method names, not feature flags, so the list is derived from the
  dispatch table and cannot drift from what is actually served.

### 3.3 Unknown-field rules

- Unknown **method** → JSON-RPC `-32601` with `data.code = "path-unknown"`. Never
  routed, never guessed (`host-api-dispatcher.ts:12-16`).
- Unknown **optional field** in params or result → accepted and ignored, and the host
  writes one diagnostic log line per (plugin, method, field) per session. This is the
  Agent Plugins report-and-ignore rule
  ([manifest: unknown and invalid fields](https://agent-plugins.org/plugin-authors/manifest))
  applied to the wire, and it is what lets a plugin built against protocol `1` run on a
  host that serves `1` plus additive fields.
- Unknown **required** field, wrong type, or a value JSON cannot carry →
  `argument-marshalling-rejected` / `result-marshalling-rejected`; refused, never
  coerced (`host-api-dispatcher.ts:16-22`, `loopback-transport.ts:15-27`).
- `_meta` on any params/result is reserved for MCP and host use; a plugin's own
  metadata goes under a reverse-domain key, matching MCP `_meta` conventions.

Additive changes (new optional field, new method, new capability) do not bump the host
protocol version. Renaming, removing, changing a type, or changing a default does.

### 3.4 Streaming and notifications

Everything that outlives its reply becomes a subscription with a host-allocated id and a
two-sided lifetime; this is the shipped `SubscriptionLedger` mechanism
(`subscription-ledger.ts:5-28`) given JSON-RPC names.

| Direction | Message | Purpose |
|---|---|---|
| plugin→host request | `ave/host/onEvent`, `config/onChange`, `onPluginsChanged`, `onShutdown`, `startAudioCapture`, `spawnWorker`, `attachFloatingPanel`, `resolveApiKey` | returns `{ subscriptionId }` (or a handle carrying one) |
| host→plugin notification | `notifications/ave/subscription` `{ subscriptionId, payload }` | one event, one frame, one worker chunk, one config change |
| host→plugin notification | `notifications/ave/subscription/closed` `{ subscriptionId, reason: "revoked" }` | host ended it (plugin retired, dock slot detached, capture surface lost) |
| plugin→host notification | `notifications/ave/subscription/release` `{ subscriptionId }` | plugin called its disposer |
| host→plugin request | `ave/instance/shutdown` | replaces `onShutdown` delivery: a **request** the host awaits (bounded), preserving today's "host awaits the handler" semantics (blueprint §3.1 row `onShutdown`) |

`peer-gone` is never sent; it is what each side does locally when the pipe closes
(`host-api-wire.ts:85-92`).

Audio: `startAudioCapture` returns `{ subscriptionId, captureId, opened }`; each frame is
a `notifications/ave/subscription` with `{ kind: "frame", seq, pcm: <base64 int16 LE
mono>, peak }` and the end is `{ kind: "end", reason, detail? }`
(`host-api-wire.ts:1669-1684`, `public-contract.ts:2351-2368`). `seq` is gap-free; a gap
means lost audio and the plugin can say so (`:2353-2355`). No backpressure signal is
added: the host emits at the cadence it was asked for, and stdio buffering is bounded by
the OS pipe. Rationale and numbers in §8.

Config: `config.get` stays child-local against a host-pushed snapshot, with the snapshot
delivered as `notifications/ave/config/snapshot` at construct and re-pushed before the
`config.set` reply, so a plugin that sets-then-gets sees its own write (blueprint §3.1,
row `config.get`). `getInstalledPluginIds` and `getAppPreference` use the same snapshot
form (`host-api-dispatcher.ts`: `childLocalHostApiPath` for `storage.resolve`,
`config.get`, `getInstalledPluginIds`, `getAppPreference`).

Progress: long host operations (`callLlm`, `spawnWorker` startup) may carry an MCP
`progressToken` in `_meta` and emit `notifications/progress`
([MCP progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)).
Optional, not required in protocol `1`.

### 3.5 Cancellation

MCP `notifications/cancelled` `{ requestId, reason }` in either direction
([MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation))
replaces the bespoke `signalChannelId` and abort-channel notification
(`host-api-wire.ts:125-130`, `:1607-1618`). The host holds the `AbortController` for
`hostFetch`, `callLlm` and `resolveApiKey`; the plugin's `AbortSignal` in the typed client
maps to sending `notifications/cancelled` for the in-flight request id. MCP Tasks
(experimental in 2025-11-25) are not adopted; `spawnWorker` and `startAudioCapture` are
subscriptions, not tasks, because their lifetime is owned by the plugin's disposer.

### 3.6 Error model

JSON-RPC `error` with a numeric `code` in the implementation-defined range and a required
`data.code` from the closed string set that already exists
(`host-api-wire.ts:312-333`):

- boundary refusals: `wire-version-mismatch` (renamed `protocol-version-mismatch`),
  `plugin-inactive`, `path-unknown`, `path-not-dispatchable`, `path-not-implemented`,
  `argument-marshalling-rejected`, `result-marshalling-rejected`, `payload-too-large`,
  `subscription-unknown`;
- host decisions the plugin branches on: `effect-boundary-denied`,
  `manifest-integrity-violation`, `detached-operation`, `plugin-storage`,
  `plugin-storage-encryption-unavailable`;
- `host-internal` for anything else, deliberately opaque.

`plugin-mismatch` and `generation-mismatch` disappear with the wire fields (§2.4). Per
AGENTS.md there is no default value, no silent skip and no catch-and-fake: an
unimplemented path throws `path-not-implemented` (`host-api-dispatcher.ts:12`), and a
typed client that receives a `data.code` it does not know throws a generic
`PluginHostApiError` carrying the code rather than mapping it to something it does know.

---

## 4. Conversion table for every `PluginHostApi` member

Legend — form: **req** JSON-RPC request; **notif** notification; **sub** request that
opens a subscription; **local** child-local against a host-pushed snapshot; **UI** the
host performs a user-facing action and the plugin only receives the outcome. Authority
column names the chokepoint that stays host-side. "Wire today" is from
`HOSTAPI_PATH_CONTRACTS` (`host-api-wire.ts:590-1005`).

| Member (`public-contract.ts`) | Form | Wire today (args → result, lifetime) | Authority and consent | What changes out of process |
|---|---|---|---|---|
| `storage.resolve` (:1082) | local | child-local | none; pure lexical join under `pluginDataDir` with shared traversal rejection (blueprint §3.1) | none |
| `storage.read/readText/readJson/list/exists` (:1084-1102) | req | plain-json → plain-json / `read` encoded (base64) | host containment (`plugin-storage-containment.ts`), read effect recorded | 16 MiB cap (`host-api-wire.ts:471`) |
| `storage.write/writeJson/rm/mkdir` (:1090-1104) | req | encoded/plain-json → void | effect ledger write, `effect-boundary-denied` possible | same cap |
| `storage.writeEncrypted/readEncrypted` (:1121-1129) | req | plain-json | host encryption provider; `plugin-storage-encryption-unavailable` is a real error, not a fallback | ciphertext never leaves host; plaintext crosses the pipe (as it does the heap today) |
| `config.get` (:1251) | local | snapshot | none | snapshot push ordering (§3.4) |
| `config.set` (:1256) | req | plain-json → void | triggers plugin reload (restart of the child) | unchanged |
| `config.onChange` (:1262) | sub | handler-registration → handle, child-disposable | secret keys arrive redacted (`SECRET_REDACTED_SENTINEL`, `host-api-wire.ts:1141`) | notification stream |
| `emitEvent` (:1267) | notif | plain-json → void | manifest `emittedEvents`, denial audit host-side | child pre-check keeps the sync throw; host re-decides |
| `onEvent` (:1272) | sub | handler-registration | none | notification stream |
| `getInstalledPluginIds` (:1280) | local | snapshot | caller excluded by host binding (§2.4) | none |
| `onPluginsChanged` (:1299) | sub | handler-registration | none | notification stream |
| `getSecret` (:1310) | req | plain-json → plain-json | four-tier `runSecretGate` (`host-api-factory.ts:774-800`); **value crosses**, by design: an allow-listed secret is granted to this plugin | audit unchanged. See §4.1 |
| `resolveApiKey` (:1323) | sub | encoded → handle, child-disposable | gate + permission revoke signal (`host-api-factory.ts:754-763`) | **raw key stops crossing** (§4.1); `bearer()` removed from the contract |
| `callLlm` (:1353) | req | encoded → plain-json | host provider, host rate window, `effect-boundary-denied` | cancellation via `notifications/cancelled` |
| `hostFetch` (:1375) | req | encoded → encoded | Tier A egress gate, allow-list, SSRF (`host-fetch-guard.ts:9-20`); partition cookies attached host-side (`host-api-factory.ts:1039`) | bodies buffered and capped at 16 MiB; gains `auth: { lease }` (§4.1) |
| `logEvent` (:1381) | notif | plain-json → void | tagged `plugin:<id>` by host | none |
| `onShutdown` (:1392) | sub | handler-registration, host-terminated | 5 s per handler (`:1388-1390`) | becomes `ave/instance/shutdown` request (§3.4) |
| `spawnWorker` (:1414) | sub | plain-json → handle | worker envelope must be within the plugin's envelope (`host-api-dispatcher.ts:1160-1161`); command is a host-spawned process | `{ socketPath, pid }` cross; stdout/stderr/exit are notifications (`host-api-wire.ts:1652-1666`) |
| `openAuthWindow` (:1441) | UI | plain-json → plain-json | host-owned BrowserWindow, cookie host allow-list (`auth-window-service.ts:10-16`) | with `retainCookies` the values stay in the partition; the reply carries names or the final URL only |
| `authRedirect.open/wait/close` (:1478-1488) | req | plain-json | host loopback listener, one per plugin | unchanged |
| `pickFolders` (:1514) | UI | plain-json | OS dialog, user consent is the dialog | unchanged; the chosen paths do not widen the envelope unless declared (§2.2) |
| `resolveMappedDriveRoot` (:1534) | req | plain-json | host replaces a `powershell.exe` spawn (blueprint §10) | unchanged |
| `listAudioInputDevices` (:1540) | req | plain-json | renderer permission state | unchanged |
| `startAudioCapture` (:1555) | sub | plain-json → handle | host-owned renderer capture (`audio-capture.ts:4-14`); microphone/system permission is the OS prompt | frames as notifications (§3.4, §8) |
| `attachFloatingPanel` / `resizeFloatingPanel` (:1583, :1598) | sub / req | plain-json → handle / plain-json | one host-owned dock, height clamped (`floating-dock.ts:11-24`) | `detached` notification |
| `openAuthPartitionViewer` (:1636) | UI | plain-json → void | partition owned by the caller; URL host in `auth.partitionDomains` (`auth-partition-viewer-service.ts:15-19`) | unchanged |
| `clearAuthPartition` (:1664) | req | plain-json → void | partition name must be the caller's | unchanged |
| `getAuthPartitionCookies` (:1689) | req | plain-json | gated read; **values cross** (`public-contract.ts:197-204`) | see §4.1: stays, but is the one member that hands a session credential to the plugin |
| `openExternalUrl` (:1717) | UI | plain-json → void | host webView preference policy | unchanged |
| `probePrivateHost` (:1746) | req | plain-json | host resolver; result is a boolean | unchanged |
| `getAppPreference` (:1766) | local | snapshot | `HOST_PUBLIC_PREFERENCE_KEYS` allow-list (`app-preference.ts:33`) | none |
| `triggerConversation` (:1789) | req | plain-json | overlay staging only; a user click starts the turn (`:1769-1771`) | unchanged |
| `hasRoutineBySource` (:1805) | req | plain-json | none | unchanged |
| `proposeWork` / `withdrawWorkProposal` (:1831, :1845) | req | plain-json | declared `WorkProposalKind`, `effect-boundary-denied` | unchanged |
| `agentApproval.request/respond` (:1872-1900) | req | plain-json | ApprovalGate; `respond` carries nonce+HMAC | connection binding added (§2.4) |

What becomes impossible or different out of process, summarised:

- Nothing synchronous can cross. The eleven sync members already have their decision
  (blueprint §3.1: child-local, snapshot, notification, or a contract change). The only
  contract break already taken was `getSecret` becoming a Promise.
- No live object crosses: `Response`, `Uint8Array`, handles are reconstructed from JSON
  (`host-api-wire.ts:242-260`). A plugin cannot pass a function, a stream or a `Date`.
- A plugin cannot open a window, a socket, a dialog or a child process of its own. Each
  of those has a host-mediated form in the table; the blueprint's admission test is that
  the plugin contributes data and the host contributes code (blueprint §10, `:1027-1030`).
- `require("electron")` yields nothing (blueprint §4, measured by
  `confined-plugin-child.test.ts`).

### 4.1 Secret handling

Rule: a secret leaves the host process only when the plugin's *contract* is to hold it,
and the document says which members those are.

- `getSecret` — the value crosses. That is the member's purpose: an allow-listed,
  four-tier-gated read of a secret the plugin was granted (`host-api-factory.ts:774-800`).
  Used by `meeting` (1 site), `local-indexer` (2), `git` (2). Unchanged.
- `getAuthPartitionCookies` — values cross (`public-contract.ts:197-204`). Used only by
  `orion-api` (`ave-plugin-orion/src/sessionVault.ts:35-40`) to drive a browser context whose
  requests the host cannot issue. Unchanged, but named here as the one remaining
  session-credential export, and gated by the same install-time approval as
  `auth.partitionDomains`.
- `resolveApiKey` — today the raw key crosses so the child stub's `bearer()` can return
  it (`host-api-wire.ts:1628-1631`). **Change:** the lease reply carries
  `{ subscriptionId, vendor, baseUrl }` only, `bearer()` is removed from the contract,
  and `hostFetch` gains `init.auth = { lease: <subscriptionId> }`; the host attaches
  `Authorization` at the egress chokepoint the same way it already attaches partition
  cookies (`host-api-factory.ts:1039`). Revocation then needs no child-side copy to
  forget (`host-api-child.ts:397-403`). A plugin that must hand the key to a vendor SDK
  with its own HTTP client declares `capabilities: ["secrets.rawApiKey"]`, which the
  installer shows and the user approves; without it `resolveApiKey({ exposure: "raw" })`
  is refused with `effect-boundary-denied`. This is a contract change and is handled as a
  flag-day across the plugin repositories, like `getSecret` was (blueprint §9, `:1000-1003`).
- `hostFetch` with partition cookies — cookie values never leave the host
  (`auth-partition-cookie-jar.ts:5-13`). Unchanged.
- `config.onChange` for a secret key delivers the redaction sentinel, never the value
  (`host-api-wire.ts:1141-1146`). Unchanged.
- `storage.writeEncrypted` plaintext crosses from plugin to host (the plugin authored
  it); ciphertext and the key never cross.

---

## 5. UI surfaces: which process owns what

| Surface | Declared | Code runs in | Reaches the plugin process by | Source |
|---|---|---|---|---|
| `ui://` card (MCP App) | `uiResources[]` (`public-contract.ts:465`) | renderer, sandboxed iframe with CSP from `_meta.ui.csp` ([MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)); served over `mcp-app-protocol.ts` | host asks the plugin process for the HTML via MCP `resources/read` (today `ave/instance/readUiResource`, `plugin-instance-wire.ts:44, 98-105`); the card's `tools/call` goes host→ToolExecutor→plugin, never iframe→plugin | `plugin-ui-resource-provider.ts`, `mcp-app-protocol.ts:5` |
| Embedded module (sidebar) | `ui[]` kind `embedded-module`, slot `sidebar` (schema `:201`) | renderer, `plugin-ui-shell.html` in a per-plugin partition served by `ave-plugin://asset` (`plugin-asset-protocol.ts:90`, `html-preview-partition.ts:161-165`) | `bridge.callTool` / `bridge.onEvent` through preload IPC → main → tool registry → `tools/call` | `src/preload/internal-api-surface.ts` |
| Floating panel | `ui[]` slot `floating` + `attachFloatingPanel` | renderer card inside the host-owned dock window (`floating-dock.ts:11-30`) | `ave/host/attachFloatingPanel` opens a subscription; `detached` arrives as a notification | `floating-dock-surface.ts:17` |
| Auth window | none; `openAuthWindow` at call time | main process BrowserWindow (`auth-window-service.ts:10-12`) | request/reply; cookies retained in `persist:plugin-auth:<id>` | `auth-window-service.ts:115` |
| Auth partition viewer | `auth.partitionDomains` | main process hardened BrowserWindow (`auth-partition-viewer-service.ts:1-23`) | request/reply | `:86` |

Decision: **plugin UI code never runs in the plugin process.** The plugin process serves
bytes (`resources/read`) and answers tool calls; the renderer runs the UI in a sandbox the
host owns. That is the split MCP Apps standardises, and it is why the UI half needs no
new protocol: `ui://` is MCP, the bridge is host IPC, and the dock/auth surfaces are
host-side actions with a JSON reply. `readUiResource` is folded into MCP
`resources/read` with `mimeType: "text/html;profile=mcp-app"` so a non-JS plugin serves
its card with a stock MCP server library.

---

## 6. Contract publication

### 6.1 The host-owned protocol schema

One JSON Schema document per host protocol version, generated by the host build from the
same sources the dispatcher compiles against:

```
schemas/plugin-host-protocol/1/protocol.schema.json
  $defs.methods["ave/host/storage/read"].params / .result / .errors
  $defs.methods["ave/instance/construct"] ...
  $defs.notifications["notifications/ave/subscription"] ...
  $defs.errorCodes            (the closed set, host-api-wire.ts:312-333)
  $defs.capabilities          (every served method name)
```

Generation, not authorship: `HOSTAPI_PATH_CONTRACTS` supplies the axes,
`public-contract.ts` supplies the types (via the existing mechanical-mirror rule at
`public-contract.ts:1-8`), and a generator script emits the schema. A CI gate fails when
the emitted file differs from the committed one, in the same spirit as
`scripts/sync-sdk-schemas.mjs --check` and `.github/workflows/sdk-schema-drift.yml`.
The completeness test that today walks the real hostApi object
(`hostapi-effect-completeness.test.ts:11-16`) gains a sibling that walks the schema:
every dispatchable path has a schema entry and vice versa.

Published as **ave release assets** next to `plugin-manifest.schema.json` and the
`public-contract.d.ts` bundle, and mirrored at a stable URL
(`https://former-site.invalid/schemas/plugin-host-protocol/1/protocol.schema.json` from `web/`,
Open Question 6). The `$id` is the stable URL; it is never reassigned to different
contents (Agent Plugins conformance, "Never reassign a published canonical schema
identifier",
[checklist](https://agent-plugins.org/client-implementers/conformance)).

### 6.2 Typed clients

| Client | Who generates | From | Ships as |
|---|---|---|---|
| TypeScript types (`PluginHostApi` and friends) | host build, mechanical | `public-contract.ts` | release asset (`public-contract.d.ts` + `.js` constants), unchanged from the interim plan |
| JS reference runtime (`plugin-child-main.js`) | host build | `src/plugins/isolation/*` | **inside the app**; a JS plugin never vendors it. The host runs it for every `entry` plugin (`out-of-process-plugin.ts:200-204`) |
| Protocol-level TS client (JSON-RPC stubs) | host build | protocol schema | release asset, used by tests and by authors who want to speak the protocol from JS without the reference runtime |
| Other languages | plugin author or community, from the schema | protocol schema | not Ave-maintained. The conformance suite (§10) is the guarantee, not a maintained SDK. This is how MCP handles it: SDKs exist at the protocol level, generated from `schema.ts` |

### 6.3 How this replaces "types as release assets"

The interim step publishes `public-contract.ts` types and the manifest schema as release
assets, and consumers vendor a pinned copy with a byte-equality check. Under this design:

- the **manifest schema** stays exactly that (host-owned, release asset, vendored copy);
- the **TS types** stay as a release asset for JS authors, but they are now a *client*
  of the protocol, not *the* contract: the schema is the contract, and the TS types are
  regenerated from the same source, so a byte-equality check against the types proves
  nothing the schema check does not already prove;
- the **protocol schema** becomes the artifact a plugin pins (`requires.hostProtocol`),
  and the validate CLI checks the plugin against it without the app.

`schemas/sdk/` (the SDK-owned skill-package schema snapshot,
`schemas/sdk/README.md:1-9`) is orthogonal and is resolved by the SDK-removal track,
not here.

### 6.4 `minAppVersion` and the protocol version

`requires.minAppVersion` is enforced at load (`runtime/index.ts:2883-2900`) and its
format at manifest validation (`manifest-validation.ts:912-930`; the comment at
`:916-917` says install and load — the install-side call site is not verified in this
document). It answers "does this app have the features I need", which includes UI slots,
marketplace behaviour and everything the protocol does not cover.

Add `requires.hostProtocol` (integer-as-string, e.g. `"1"`). Rules:

- Each app version publishes exactly one served host protocol version, and the mapping
  is in the release notes and in the schema's `x-ave-app-version-range`.
- A plugin declares `hostProtocol`; the host refuses the load when it does not serve that
  version (§3.2). `minAppVersion` remains additive: a plugin may set both.
- Capability-level needs are expressed by `requires` in `construct`, not in the manifest,
  because they are only knowable from the running host.
- A `hostProtocol` mismatch is a distinct refusal code from `incompatible-app-version`,
  so the Doctor can say "update the app" versus "this plugin was built for a different
  protocol".

---

## 7. Security

### 7.1 What improves

- **Isolation**: no shared heap, no Electron, one structural chokepoint, a separate crash
  and hang domain, per-plugin resource accounting (blueprint §4, `:419-445`). All of it
  is already in force for the five isolated plugins; the protocol extends it to every
  plugin and to non-JS plugins.
- **Secrets**: `resolveApiKey` stops exporting the raw key (§4.1); credentials attach at
  the egress chokepoint; partition cookie values already never leave the host.
- **Effect ledger**: `hostObservable` is recorded `true` for `source:"plugin"` tools
  (`invocation-execution.ts:1047`). Out of process it remains true and becomes
  *structurally* true: a plugin cannot reach a host effect except through a
  `ave/host/*` request that the dispatcher records
  (`host-api-factory.ts:518-519` composition, `host-api-dispatcher.ts:6-10`). The
  completeness test that guards the wrapper today (`hostapi-effect-completeness.test.ts`)
  becomes a schema/dispatcher parity test (§6.1).

### 7.2 What must be preserved

- **Permission chokepoints**: tool execution still enters through the single
  `ToolExecutor` pipeline with Layer-1 deny, ApprovalGate, audit and the effect-ledger
  shadow (`architecture.md:966-975`). The plugin process is reached by `tools/call`
  *after* those stages, exactly as the loopback arm is today
  (`out-of-process-plugin.ts:1397`). No protocol method bypasses a gate; `agentApproval`
  is a request *to* the gate.
- **Trust tiers**: `trustFromSource` maps `source` to a tier (`tools/types.ts:83`); a
  first-party plugin stays `medium` and an external MCP server `low`
  (`mcp-tool-adapter.ts:25`). Running out of process does **not** change the tier — an
  isolated first-party plugin is still first-party. Conversely a `process`-entry plugin
  from the marketplace is still `medium` only if its artifact is signed and admitted;
  the tier is derived from install provenance, never from the transport.
- **Host-derived identity**: `pluginId` is bound to the connection (§2.4);
  `_meta["ave/workerId"]` and self-declared categories on the wire are ignored
  (`plugin-tool-from-mcp.ts:12-17, 29-33`).
- **Egress**: every network request goes through `hostFetch`'s layered gate
  (`host-fetch-guard.ts:9-20`) and the manifest `networkAccess.allowedDomains`
  (`public-contract.ts:492-494`). ASRT network confinement is what makes that the *only*
  egress (blueprint §4, `:451-452`); a `process`-entry plugin therefore requires the
  wrap (§2.2).

### 7.3 New risks and their controls

| Risk | Control |
|---|---|
| RPC surface abuse: a plugin hammers `ave/host/*` (log flood, storage churn, `triggerConversation` spam, subscription leak) | per-(plugin, method) token bucket in the dispatcher with a refusal code `rate-limited` (new, added to the closed set); cap on open subscriptions per plugin; `WIRE_BYTES_MAX` 16 MiB per message (`host-api-wire.ts:471`); `logEvent` key/prefix caps already exist for `getSecret` (`host-api-factory.ts:780-788`) and are generalised. Today no rate limiting exists in the dispatcher (verified by absence of any limit constant in `host-api-dispatcher.ts`). |
| Resource exhaustion: a plugin process consumes memory/CPU | Linux: a per-plugin cgroup from the workload resource controller once it is wired to the spawn path (`linux-workload-resource-controller.md:1-15` says it is not yet). macOS: `RLIMIT` via the wrapper is Open Question 7; Windows: Job Objects are not available through srt-win today. Until then the control is crash containment: the host survives, the plugin is marked degraded. |
| A plugin process outlives the host | child exits on stdin end (`plugin-child-main.ts:319-326`); `managed-child-processes.ts` tracks and kills process groups on app quit; a `process`-entry plugin must pass the stdin-close conformance check (§10). Residual: a hard host crash on Windows leaves the child to notice a closed pipe on its next write. |
| Arbitrary executable via `process` entry | signed artifact or admin install only; mandatory ASRT wrap; refused when the sandbox is off; the command must be inside the plugin root (Agent Plugins rule); no `PATH` search for a marketplace plugin. |
| Envelope widening via the manifest `sandbox` block | closed `hostDirectory` allow-list; `userChosenDirectory` requires a user-set absolute path; deny-floor piercing requires install-time approval (§2.2). |
| Windows: no process confinement | unchanged from `architecture.md:1004-1006`; third-party out-of-process admission on Windows is Open Question 3. |
| Confused deputy through the host's own credentials | `hostFetch` attaches a lease only to a URL that passes the allow-list for *that* plugin; the lease id is per plugin per session and is refused on any other connection. Matches the MCP security guidance on token passthrough ([MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)). |

---

## 8. Performance

- **Audio.** 16 kHz mono int16 is 32 KB/s raw, about 43 KB/s base64; 48 kHz is 96 KB/s
  raw, about 128 KB/s base64. At `frameMs` 100 that is 10 notifications per second of
  roughly 4-13 KB each — well inside what a pipe and a JSON parser handle. The
  base64 cost is the price of JSON over stdio (blueprint §5.2, `:523-528`). If a future
  plugin needs multi-channel 48 kHz for long sessions, the escape hatch is a
  host-allocated UDS carrying raw PCM, negotiated as capability `audio/rawSocket`; not in
  protocol `1`.
- **Large payloads.** `hostFetch` bodies and storage reads are buffered and capped at 16
  MiB. A plugin that needs more streams through its own `spawnWorker` or through
  storage in chunks. No chunked body streaming in protocol `1`.
- **Startup cost per plugin.** One Electron-as-Node process per plugin
  (`out-of-process-plugin.ts:955-967`), ASRT wrap, `initialize`, `construct`, `tools/list`,
  `start`. The blueprint asked for the Stage 6 measurement (`:987`); this document does
  not have a measured RSS or wall-clock number and marks it **UNVERIFIED**. The
  conformance suite (§10) records both per plugin so the number exists before Phase 4.
  Plugins start in parallel, and the loopback projection is unchanged, so the user-visible
  cost is the slowest plugin, not the sum.
- **Per-call latency.** One JSON round trip per hostApi call. Members on hot paths
  (`config.get`, `storage.resolve`, `getInstalledPluginIds`, `getAppPreference`) are
  child-local already; `logEvent` and `emitEvent` are notifications and never wait.

---

## 9. Migration

### 9.1 Phases

| Phase | Scope | Proof | Contract change for plugins |
|---|---|---|---|
| 0 (done) | five first-party plugins out of process on internal wire v1 | `OUT_OF_PROCESS_PLUGIN_IDS`, `out-of-process-plugin.test.ts`, `confined-plugin-child.test.ts` | none |
| 1 | reverse channel becomes JSON-RPC `ave/host/*`; `initialize` + `construct` negotiation; newline framing; identity fields off the wire; schema generator + parity gate | golden-fixture conformance suite passes against the JS reference runtime for all five plugins | **none** — the reference runtime is host-shipped |
| 2 | secrets lease (`bearer()` removed, `hostFetch` `auth.lease`), `sandbox` manifest block replaces `PLUGIN_ENVELOPE_GRANTS`, dispatcher rate limits | each plugin repo builds against the new contract; `local-indexer` manifest carries its grants | **flag-day**: `resolveApiKey` callers (`meeting`, `local-indexer`), `local-indexer` manifest |
| 3 | schema + TS client published as release assets; validate CLI; `process` entry accepted in the schema | validate CLI passes for all seven plugins with the app not running; a non-JS smoke plugin (Python, stock MCP server library) passes conformance | none for existing plugins |
| 4 | out-of-process by default for every install; `git`, hello-world, `template`, `orion` (company git) onto the path; adversarial fixture | fixture attempts the four escapes (blueprint §9 Stage 9) and is denied; `allPluginsAreOutOfProcess` true for the catalog | `git`: confirm no ambient axis (it uses `openAuthWindow`, `openExternalUrl`, `getSecret`, `callLlm`, `clearAuthPartition` — all mediated) |
| 5 | remove the in-process loader and the routing census | `importPluginFactory` has no call site in main; `OUT_OF_PROCESS_PLUGIN_IDS` deleted | none |

Dual-run period: Phases 1-4. Both loaders coexist as a per-plugin routing decision from
a host-owned set, never as a runtime fallback: a failed child fails the call
(`out-of-process-plugins.ts:14-15`, blueprint `:989-998`). That is why the coexistence
needs no No-Fallback exemption.

### 9.2 Order of plugins

For the *protocol* migration (Phase 1 validation order), smallest surface first, so a
wire defect is found where it is cheapest to read:

1. `vega-helper` — `triggerConversation`, `callLlm`, `onEvent`, `config`,
   `hasRoutineBySource`, `getInstalledPluginIds`, `onPluginsChanged`
   (`ave-plugin-vega-helper/src/hostPlugin.ts:1038`); no worker, no window, no audio.
2. `lyra-mail` — `authRedirect`, `openAuthWindow`, `openAuthPartitionViewer`,
   `clearAuthPartition`, `storage.*Encrypted`, `probePrivateHost`
   (`ave-plugin-lyra-mail/src/auth/msal-client.ts:113`); exercises the UI-action members.
3. `local-indexer` — `spawnWorker` with the Python worker over UDS, `pickFolders`,
   `resolveMappedDriveRoot`, `resolveApiKey`
   (`ave-plugin-local-indexer/src/localIndexerPlugin.ts:582`); exercises handles,
   worker notifications and the `sandbox` manifest block.
4. `meeting` — `startAudioCapture`, `attachFloatingPanel`, `spawnWorker` (ffmpeg),
   `resolveApiKey`, `callLlm` (`ave-plugin-meeting/src/ffmpegRuntime.ts:112`);
   exercises the streaming path and the secrets lease.
5. hello-world (synthesised by the marketplace server — the synthesis code was not
   located in this checkout's siblings; see UNVERIFIED) and `template`
   (`your-plugin-id`, `config.get` only) — the marketplace admission path end to end.
6. `orion-api` in company git — `openAuthWindow` ×5, `getAuthPartitionCookies`,
   `spawnWorker` ×3 (`ave-plugin-orion/src/nativeAdClient.ts:91-96`), `probePrivateHost`;
   the largest surface and the one the blueprint records as "three unrelated problems"
   (`:1058`). Last, and after the company-git move, so its cadence is decoupled.
7. `git` — not yet isolated; `openAuthWindow` ×4, `getSecret`, `callLlm`,
   `openExternalUrl`, `clearAuthPartition` (`ave-plugin-draco/src/hostPlugin.ts:2194-2349`).
   Admissible by the blueprint's data-not-code test; joins in Phase 4.

### 9.3 Removal condition for the in-process path

Per AGENTS.md a coexistence needs a deprecation owner and a removal condition, not a
permanent shim.

- **Condition (state, not date):** `allPluginsAreOutOfProcess(installedPluginIds)`
  (`out-of-process-plugins.ts:872-879`) is true for every plugin in the official
  marketplace index and for the five bundled plugins, **and** the conformance suite has
  passed for two consecutive app releases with no in-process load in telemetry.
- **Owner:** the ave maintainer who owns `src/plugins/runtime` (Open Question 5
  asks the owner to name the person).
- **Version boundary:** the removal ships no later than two minor releases after Phase
  4 lands, or the owner records why not in `TODO.md`.
- **What is deleted:** `importPluginFactory` from main (`plugin-loader.ts:77`, the
  child keeps it), the loopback in-process arm, `OUT_OF_PROCESS_PLUGIN_IDS` and
  `isOutOfProcessPlugin`, `PLUGIN_ENVELOPE_GRANTS`, and the `ChildLocalPath` /
  in-process branches of `runtime/index.ts` around `createHostApi`
  (`runtime/index.ts:2057-2066`).

---

## 10. Validation strategy

### 10.1 Conformance tests (host repo)

1. **Schema ↔ dispatcher parity.** Every `HostApiPath` has a schema entry, every schema
   method has a handler, every error code in the schema is in the closed set. Modelled on
   `hostapi-effect-completeness.test.ts` (walks the real object) and
   `hostapi-serialization-conformance.test.ts` (every member is JSON-representable or
   owes a decision, `:1-20`).
2. **Golden fixtures.** One JSON request/response pair per method and per error code,
   replayed over in-memory paired streams against the real child runtime — the
   substitution `out-of-process-plugin.test.ts:1-10` already makes.
3. **Real confined child.** `confined-plugin-child.test.ts` keeps proving the
   confinement half with a real process (`out-of-process-plugin.test.ts:12-16`); it gains
   the stdin-close-exits and stdout-discipline checks.
4. **Adversarial fixture** (Phase 4): read `~/.ave/secrets/`, direct egress,
   `require("electron")`, monkey-patch a host internal, name another plugin's id, replay a
   lease id on another connection — each denied.
5. **Cross-language smoke**: a minimal Python plugin using a stock MCP server library and
   hand-written `ave/host/*` calls passes 1-3.

### 10.2 Validating without the app: the validate CLI

`ave-plugin validate <dir>` is built from the host repo and published as a release
asset (a single-file Node executable), replacing the per-plugin drift scripts such as
`ave-plugin-meeting/scripts/validate-hostapi.mjs` (which today imports
`@ave/plugin-sdk`, `:28`). It:

1. validates `plugin.json` against the manifest schema and the Ave `extensions` rules,
   including `requires.hostProtocol`;
2. spawns the plugin (JS through the bundled reference runtime, or its `process` entry)
   against a **mock host** that serves the real dispatch table with fake handlers, runs
   `initialize` → `construct` → `tools/list` → `start` → `stop`, and asserts the
   protocol rules (framing, stdout discipline, exit on stdin close, no unknown method);
3. cross-checks `emitEvent`/`onEvent` names against the manifest's declared events and
   `bridge.callTool` targets against `app`-visible tools — the checks the meeting script
   does today (`validate-hostapi.mjs:6-15`);
4. exits 0/1 and prints the exact schema path of each failure.

The same binary runs in the plugin repos' CI, so a plugin author never needs the SDK
repository or the app to know the plugin will load.

---

## 11. Reference-host comparison

| Host | Where plugin code runs | How the contract is shared | Compatibility declaration | Isolation | Language support |
|---|---|---|---|---|---|
| **Ave today** | five first-party plugins in a confined child process; others in the main process (`out-of-process-plugins.ts:856-858`, `plugin-loader.ts:77-81`) | `public-contract.ts` mirrored by an SDK package (`public-contract.ts:1-8`); manifest schema host-owned | `requires.minAppVersion` (`schemas/plugin-manifest.schema.json:695`) | ASRT for isolated plugins (`out-of-process-plugin.ts:954-986`); none in-process | JavaScript only |
| **Ave target** | every plugin in its own confined process | host-published JSON Schema for `ave/host/*` + MCP; TS types generated; reference JS runtime host-shipped | `requires.minAppVersion` + `requires.hostProtocol`; capability list at `construct` | ASRT on macOS/Linux; fs+network on Windows | any language (stdio JSON-RPC); JS via reference runtime |
| **Claude Code** | outside the host: MCP servers (stdio/HTTP), hook commands with JSON on stdin, LSP servers; skills/commands/agents are files ([plugins reference](https://code.claude.com/docs/en/plugins-reference), [hooks](https://code.claude.com/docs/en/hooks)) | manifest (`plugin.json`, `name` the only required field) + hook/MCP JSON conventions; no host SDK | none beyond the manifest; `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` | process boundary; no host-imposed sandbox for hook commands | any (subprocess) |
| **Codex** | outside the host: portable `plugin.json` + `mcp.json` + `skills/`; hooks as scripts; `.codex-plugin/plugin.json` compatibility overlay ([Codex plugins](https://developers.openai.com/codex/plugins/build)) | Agent Plugins schemas; OpenAI-specific settings under `extensions.com.openai` | Agent Plugins `$schema` version; per-plugin MCP approval policy in user config | process boundary; MCP servers and hooks are separate processes; hooks not trusted by install alone | any (subprocess) |
| **OpenClaw** | **in-process** with the Gateway for native plugins: "not sandboxed ... a malicious native plugin is equivalent to arbitrary code execution" ([architecture](https://docs.openclaw.ai/plugins/architecture)); compatible bundles (Agent Plugins/Codex/Claude/Cursor) are metadata packs ([bundles](https://docs.openclaw.ai/plugins/bundles)) | typed SDK `openclaw/plugin-sdk/*` subpaths, all APIs "experimental" ([sdk overview](https://docs.openclaw.ai/plugins/sdk-overview)); `openclaw.plugin.json` manifest with mandatory `configSchema` ([manifest](https://docs.openclaw.ai/plugins/manifest)) | `package.json` `openclaw.compat.pluginApi` / `minGatewayVersion` and `peerDependencies.openclaw` ([building plugins](https://docs.openclaw.ai/plugins/building-plugins)); named compatibility adapters with a ≤3-month or version-bounded removal ([compatibility](https://docs.openclaw.ai/plugins/compatibility)) | none for native plugins; allow-lists by plugin id only ("does not verify source provenance") | JS/TS (managed instances compile TS) |
| **VS Code** | in a separate **extension host** process (local Node.js, web worker, or remote) ([extension host](https://code.visualstudio.com/api/advanced-topics/extension-host)) | `vscode` API typings (`@types/vscode`) over an RPC layer with proxied `MainThread*`/`ExtHost*` objects ([rpcProtocol.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensions/common/rpcProtocol.ts)) | `engines.vscode` semver range in `package.json` | one process for all extensions; no OS sandbox; extensions cannot touch the DOM | JS/TS (Node or web worker) |
| **Obsidian** | in the app renderer process, `Plugin` subclass with `onload`/`onunload` ([anatomy](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Getting%20started/Anatomy%20of%20a%20plugin.md)) | `obsidian` npm typings | `manifest.json` `minAppVersion` ([manifest](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Reference/Manifest.md)) | none; community review guidelines | JS/TS |

### 11.1 OpenClaw, explicitly

OpenClaw is the closest comparison to Ave *today* and the clearest example of the path
the owner rejected: a rich in-process typed SDK, versioned against host releases by
`peerDependencies` and `compat.pluginApi`, with the security consequence stated in its
own docs. Against the other hosts:

- Like Ave-today and VS Code, OpenClaw hands plugins a typed object; unlike VS Code it
  does not even put them in a separate process.
- Like Claude Code and Codex, it reads Agent Plugins bundles, but only as content packs
  (skills, hooks, MCP configs) with "a narrower trust boundary" — which is a tacit
  admission that portable plugins and native plugins have different trust models.
- Its versioning answer is *discipline* (pin, test, adapters, deprecation windows), not
  negotiation.

What Ave should adopt from OpenClaw:

1. **Manifest-first validation without executing code** — every native plugin ships a
   manifest and a JSON Schema for its config, validated "before the plugin runtime loads".
   Ave already does this for the manifest; the mandatory `configSchema` idea is worth
   taking for `manifest.config`, so `config.set` rejects a key the plugin never declared
   instead of storing it.
2. **A written deprecation policy with a bounded window**: "warning start date,
   replacement, docs link, and either a final removal date no more than three months
   after the warning starts or an explicit version boundary". §9.3 uses the same shape,
   which also satisfies AGENTS.md.
3. **Capability ownership as a design rule** (one plugin owns one company's or one
   feature's surface) — useful guidance for the marketplace, not a protocol matter.

What Ave should not adopt, and why:

1. In-process native plugins. The owner's decision, and OpenClaw's own warning.
2. A branded per-plugin SDK facade (`openclaw/plugin-sdk/<plugin-id>`). OpenClaw itself
   now discourages it; Ave has no SDK to hang it on.
3. `plugins.allow` by id without provenance. Ave identity is host-derived and
   signature-anchored (`registry-manifest-trust.ts`, `plugin-install-receipt.ts`); an
   id allow-list would be a regression.
4. "All APIs experimental" as the stability statement. A published protocol version with
   report-and-ignore is the stronger promise and the one the six reasons ask for.

---

## 12. Rejected alternatives

1. **Stay in-process and drop the types.** Keeps every cost (shared heap, Electron
   reachable, hang domain, no per-plugin accounting) and gains nothing: reasons 1-5 all
   require the process boundary. Also moot: five of seven plugins are already out.
2. **VS Code-style extension host** (one process for all plugins, RPC-proxied objects).
   One crash still takes every plugin down; the proxied-object model is a typed TS API
   by construction (`rpcProtocol.ts` marshals proxies of `MainThread*` interfaces), so it
   restores the SDK the owner is removing; and one shared process cannot be given
   per-plugin filesystem and network envelopes, which is the whole confinement story
   (`out-of-process-plugin.ts:717-718`).
3. **WebAssembly components.** Attractive isolation and language neutrality, but every
   plugin today depends on Node (`spawnWorker` clients, ffmpeg, Python), the host has no
   WASM runtime and the WASI component model would need a second host-capability
   binding layer on top of the JSON one; the OS sandbox already gives the isolation.
   Revisit only if a plugin class appears that needs neither processes nor sockets.
4. **MCP unchanged for everything**: model `callLlm` as sampling, `pickFolders` and
   `agentApproval` as elicitation, storage as resources, secrets as OAuth. Loses host
   semantics (rate window, key gate, OS dialogs, the approval HMAC), forces a bespoke
   `_meta` dialect to carry what standard messages cannot, and was already set aside
   when the wire migration was deferred (`mcp-alignment-design.md:1-12`).
   Tools and `ui://` resources *do* stay pure MCP; that is the part where "unchanged"
   is right.
5. **`utilityProcess.fork`.** Cannot be argv-wrapped by ASRT (blueprint §5.2,
   `:504-510`). Already rejected there.
6. **A second channel (UDS or extra fd) for the reverse direction.** More attack surface
   through the sandbox wrap for a multiplex JSON-RPC gives for free
   (`child-stream-multiplex.ts:5-11`).
7. **Keeping the bespoke `callId`/`kind` envelope and only publishing its schema.** A
   schema for a non-standard frame still needs a hand-written client in every language;
   JSON-RPC gets those clients for free.
8. **Automatic child restart on crash.** Hides the crashing input and turns a plugin
   defect into a CPU loop; explicit restart keeps the failure visible (§2.5).

---

## 13. Open questions for the owner

1. **Framing: newline-delimited (MCP spec) or `Content-Length` (current).**
   Recommended: newline-delimited for the plugin protocol, switching the host decoder and
   the reference runtime together; leave the external MCP client's framing to its own
   track after confirming which framing the external servers it talks to actually use.
2. **`resolveApiKey` raw exposure: remove `bearer()` outright, or keep it behind a
   declared capability?** Recommended: remove from the default path; raw exposure only
   via `capabilities: ["secrets.rawApiKey"]` with install-time approval, as in §4.1.
3. **Third-party (marketplace) out-of-process plugins on Windows without process
   confinement.** Recommended: not by default. On Windows, marketplace plugins with a
   `process` entry are refused, and JS plugins load only under `installPolicy: "admin"`
   until srt-win or a Job-Object wrapper gives process confinement. Same as the
   blueprint's §7.4 deferral, now with a concrete rule.
4. **Non-JS `process` entry in protocol `1` or later?** Recommended: in the schema now
   (so the protocol is language-neutral from its first published version), marketplace
   admission for it gated to Phase 4.
5. **Deprecation owner for the in-process loader.** Recommended: the ave
   maintainer who owns `src/plugins/runtime`, named in `TODO.md` when Phase 1 starts,
   with the §9.3 state condition and the two-minor-release boundary.
6. **Where the protocol schema is canonical.** Recommended: ave GitHub release
   assets are canonical (they are what `requires.hostProtocol` pins); `former-site.invalid`
   mirrors them for editor `$schema` resolution.
7. **Per-plugin resource limits on macOS.** Recommended: defer; ship crash containment
   and the conformance-suite RSS measurement first, decide on `RLIMIT` in the wrapper
   once there is a number.

---

## UNVERIFIED in this document

- The RSS and wall-clock startup cost of one plugin child (§8). No measurement exists in
  the checkout; the conformance suite is asked to produce it.
- Install-time enforcement of `minAppVersion`. `manifest-validation.ts:916-917` says
  "install + load"; only the load gate (`runtime/index.ts:2883-2900`) and the format gate
  were located.
- How the marketplace server synthesises the hello-world plugin. Only
  `agent-marketplace/server/seed-digests.json` references it; the Python server source
  was not read.
- Which plugins hand the `resolveApiKey` bearer to a vendor SDK rather than to
  `hostFetch` (decides how many need `secrets.rawApiKey` in Phase 2). `meeting` and
  `local-indexer` call `resolveApiKey`; their HTTP paths were not traced.
- Whether external MCP servers the host connects to accept `Content-Length` framing
  today (`mcp-client.ts:2366`), which bears on Open Question 1.
