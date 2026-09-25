# Plugin HostApi as a versioned protocol

Status: design, decided; implementation starts with the wire step (§9.4). It follows
the retirement of the `ave-plugin-sdk` repository: a plugin repository now vendors the
contract (`public-contract.ts` and the manifest schema) from ave at a release tag and
holds the copy to a recorded sha256 (`docs/design/multi-source-git-marketplace.md` §5.6;
the official repository's `contract/sources.json` and `tools/vendor.mjs`). This document
turns the in-process `PluginHostApi` object into a published, versioned, language-neutral
protocol, so that every Ave code plugin runs in its own process and consumes the host the
way an MCP server consumes a client.

Anchors: `docs/architecture/architecture.md` (Plugin Runtime, MCP↔plugin execution
parity, OS Execution Sandbox And Plugin Workers),
`docs/blueprints/plugin-process-isolation.md` (the shipped process boundary this design
builds on), `docs/architecture/mcp-alignment-design.md` (the loopback topology and the
deferred wire migration), `src/plugins/public-contract.ts` (the contract source of truth).

Every claim about current code names a `file:line` in the `d036d87c6` checkout (ave
main after the multi-source git marketplace merged); claims about the official marketplace
repository name its commit `6a4d3b3df`. Claims about other hosts cite their official
documentation.

---

## 0. What is already true, and what this document changes

The process boundary exists. It is not the open question.

- `OUT_OF_PROCESS_PLUGIN_IDS` routes `vega-helper`, `lyra-mail`, `local-indexer`,
  `meeting` and `orion-api` into a confined child process
  (`src/plugins/isolation/out-of-process-plugins.ts:856-858`; commit `72b8c3b50`,
  2026-08-26, "admit orion-api out-of-process — 5/5"). The set is frozen and read by no
  configuration, manifest field or environment variable; a plugin moves only through a
  reviewed commit (`out-of-process-plugins.ts:7-12`). `vega-helper` is being retired — its
  alerts move to a host alert contract that plugins declare, under a separate design —
  and when it leaves the set, the routing census and the conformance fixtures of §9.4
  shrink to four.
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
   each side refuses a mismatched constant (host: `host-api-dispatcher.ts:2009-2013`;
   child: `plugin-child-main.ts:164`) and there is no way to ask the host what it serves.
2. The reverse channel is not JSON-RPC, so an off-the-shelf JSON-RPC or MCP library
   cannot speak it (`child-stream-multiplex.ts:46-65` classifies frames by which fields
   they happen to carry).
3. The JS plugin still consumes `PluginHostApi` as a typed object built by a host-shipped
   child runtime (`plugin-child-runtime.ts:5-9`), so the vendored contract types remain the only
   way to write a plugin.
4. Two host-side plugin-specific tables exist that AGENTS.md forbids: the routing census
   itself, and `PLUGIN_ENVELOPE_GRANTS` for `local-indexer`
   (`out-of-process-plugin.ts:317-360`).
5. `resolveApiKey` ships the raw credential into the child (`host-api-wire.ts:1628-1645`,
   `host-api-child.ts:397-421`).
6. The `git` plugin, the `templates/plugin` scaffold (official repository) and the official `hello-world` plugin
   (`plugins/hello-world/source` in the official repository, a source package built and
   released like the other four) are not on the isolated path
   (`out-of-process-plugins.ts:856-858` lists five ids; `template` is "not installed; a
   scaffold, out of scope", `:854`).

`docs/blueprints/plugin-process-isolation.md:3-6` records Stages 1-8 as shipped and points
Stages 9-10 here.

---

## 1. Goal and non-goals

The owner's six reasons for the Claude Code / Codex "manifest schema plus protocol, no
host SDK" model hold only because plugin code runs outside the host process. Ave now
has the process. This track makes the contract match it.

| # | Reason | Ave gains it? | How |
|---|---|---|---|
| 1 | Executable parts are separate processes; a compile-time type cannot guarantee the other side anyway | **Yes** | Already true for 5/5 first-party plugins (§0). The remaining plugins move by default (§9). |
| 2 | Contract is language neutral | **Yes** | The reverse channel becomes JSON-RPC 2.0 (`ave/host/*`) with a host-published JSON Schema (§3, §6): an Ave peer channel beside MCP, so a non-JS plugin needs a JSON-RPC library or the generated client next to its MCP server library (§3.1). A plugin may ship its own executable instead of a JS entry (§2.1). |
| 3 | Same plugin loads in several hosts | **Partial, deliberately** | The manifest is already an Agent Plugins 1.0.0 document with `extensions["ai.agent-connector.ave"]` (`schemas/plugin-manifest.schema.json:5`, `public-contract.ts:36-37`). Skills, hooks and `mcpServers` contributions are portable. The `ave/host/*` surface is Ave-only by design: audio capture, floating dock, auth partitions and work proposals have no portable equivalent, and pretending otherwise would produce a lowest-common-denominator API. |
| 4 | Host and plugins release independently through version and capability negotiation, plus report-and-ignore for unknown fields | **Yes** | `ave/instance/construct` carries the host protocol version and the capability list, and the MCP half negotiates per request (`2026-07-28`); unknown optional fields are reported and ignored; unknown methods fail loudly (§3.2, §3.3). |
| 5 | Host isolates and sandboxes at the boundary | **Yes on macOS/Linux; filesystem+network only on Windows** | ASRT (`architecture.md:1013-1020`). The Windows process-confinement gap is decided in decision 3 (§13): admission does not depend on it, and a `process` entry is refused on Windows (§2.2, §7.3). |
| 6 | Run-time errors are covered by `$schema` editor validation, a validate CLI and clear failure at load | **Yes** | Manifest schema already exists; the protocol schema and a host-built validate CLI are added (§6, §10). |

Non-goals:

- Replacing MCP for tool execution. Tools already travel as MCP `tools/call`
  (`out-of-process-plugin.ts:1397`) and register through `plugin-tool-from-mcp.ts`; the
  parity invariant (`architecture.md:980-1012`) is preserved untouched.
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
`pluginDataDir` (`public-contract.ts:2153`). A `process` entry is admitted only for an
install whose artifact came through the release or archive rung of the plugin artifact
ladder with a sha256 pin (marketplace design §6.2) — the same provenance a host-secret
grant requires (§10.3). A tree-rung install, a direct install and a local development
install with `process` are refused with `process-entry-requires-pinned-artifact` (§7.3).

Both forms go through `spawnConfinedChild` and nowhere else
(`out-of-process-plugin.ts:9-11`, `confined-child.ts:1-22`). The deny floor
(`~/.ave/secrets`, `~/.ssh`, `~/.aws`) is owned by that primitive, not by callers
(`confined-child.ts:15-21`).

### 2.2 Sandboxing per platform

| Platform | Substrate | Confines | Source |
|---|---|---|---|
| macOS | ASRT `sandbox-exec` profile, allow-list grant mode | filesystem, process, network | `architecture.md:1014-1017`, `confined-child.ts:42-44` |
| Linux | ASRT bwrap `--bind` / `--unshare-net`, allow-list grant mode | filesystem, process, network | same; UDS reachability `worker-spawn.ts:17-22` |
| Windows | srt-win with per-process ACL grants, deny-only grant mode | filesystem, network. **No process confinement** | `architecture.md:1018-1020`, `confined-child.ts:43-46`, `out-of-process-plugin.ts:970` |

The child is confined exactly as much as the host is: `features.osToolSandbox` decides for
the host's own tools, its workers and its plugin children alike; when it is off the child
is spawned unwrapped and nothing marks it confined, so the reviewer grants no
sandbox-based relaxation (`out-of-process-plugin.ts:13-21`, `sandbox-gate.ts:20`).
This design does not change that rule. It does add one requirement: a plugin with a
`process` entry (non-JS) **must** run under a wrap whose published `confines` includes
`process` (`architecture.md:1017-1020`); when the sandbox is off, or when the substrate
confines only filesystem and network — srt-win, `deny-only`, `out-of-process-plugin.ts:970`
— it does not load, because an arbitrary executable with no confinement is a different risk class than a JS
module the host's own runtime evaluates (§7.3).

The filesystem envelope is `{pluginRoot, pluginDataDir, socketDir, workerRunRoot}` for
read and `{pluginDataDir, socketDir}` for write (`out-of-process-plugin.ts:717-718`).
Widening it today is a host-side table keyed by plugin id
(`PLUGIN_ENVELOPE_GRANTS`, `:317`). This design moves the declaration into the manifest:

```jsonc
"sandbox": {
  "read":  [{ "kind": "hostDirectory", "segments": ["runtime"], "why": "..." },
            { "kind": "hostDirectory", "segments": ["certs"],   "why": "..." }],
  "write": [{ "kind": "userChosenDirectory", "configKey": "indexStorageRoot", "why": "..." },
            { "kind": "userChosenDirectory", "configKey": "workspace",         "why": "..." }]
}
```

The host keeps the authority: `hostDirectory` is restricted to a closed allow-list of
`~/.ave` subtrees the host is willing to expose, `userChosenDirectory` must resolve to an
absolute path the user set (`out-of-process-plugin.ts:600-660` already implements the
resolution and refusal; the example is `local-indexer`'s own grant set, `:317-360`), and a grant that pierces the sensitive deny floor
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

Framing: before the wire step the host↔child channel is LSP-style `Content-Length` framing
(`stdio-framing.ts:1-17` on `d036d87c6`), shared with the experimental stdio arm
(`src/mcp/experimental/stdio-child-transport.ts`, `stdio-server-loop.ts`). The host's
external MCP client speaks the MCP `2026-07-28` stdio binding, "newline-delimited
JSON-RPC over a byte stream" (`mcp-client.ts:2365-2368`, `:2453-2458`;
[MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)).
For a language-neutral protocol an off-the-shelf MCP server library will emit
newline-delimited frames. Decision 1 (§13): **the published protocol is newline-delimited**,
per MCP; the host decoder and the host-shipped JS runtime switch in the same release
(§9.4), so no JS plugin sees the change.

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

- `getInstalledPluginIds` excludes the caller (`public-contract.ts:1270-1276`) using the
  host's binding, never a wire field.
- `emitEvent` authority is the manifest of the bound plugin; the child's local
  pre-check remains a courtesy that preserves the synchronous throw and is re-decided
  host-side (`host-api-child.ts:32-36`).
- `agentApproval.respond` HMAC/nonce (`public-contract.ts:1891-1896`) stays as is; the
  connection binding is an additional check, not a replacement.

### 2.5 Lifecycle

```
spawn ──► ave/instance/construct ──► ave/instance/start ──► [generation published]
  ──► ave/instance/onPublished ──► operate (tools/call, resources/read, ave/host/*)
  ──► ave/instance/stop (bounded) ──► pipe close ──► SIGTERM ──► SIGKILL
```

- There is no `initialize`. The host speaks the stateless MCP `2026-07-28` revision
  (`protocol-constants.ts:18`; `mcp-client.ts:376-383`): every request carries the
  protocol version in `_meta["io.modelcontextprotocol/protocolVersion"]` and the plugin's
  MCP server rejects a mismatch per request (`plugin-mcp-server.ts:13-17`, `:238-250`);
  `server/discover` answers capabilities from the manifest (`:112`) and a client MAY call
  it first ([MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
  The host is the MCP client and the plugin process the MCP server, exactly as the
  loopback arm frames it (`plugin-child-runtime.ts:5-9`, `plugin-mcp-server.ts:1-11`). The
  host calls neither `tools/list` nor `server/discover` on this channel, because the
  manifest already names the tools: today it sends only `construct`, `tools/call`,
  `start`, `onPublished`, `stop` and `readUiResource` (`out-of-process-plugin.ts:1362-1458`).
  A `process`-entry plugin must still serve `server/discover`, because the revision
  requires it and the validate CLI calls it (§10.2).
- `ave/instance/construct` carries what `PluginConstructParams` carries today: the
  verified manifest (never re-read from disk in the child, `plugin-instance-wire.ts:59-63`),
  the context, `declaredToolNames`, and now the **host protocol version and served
  capability list** (§3.2). The reply names the implemented tools, whether the instance
  serves UI resources, and its lifecycle hooks (`:84-92`); the protocol adds the plugin's
  required capability list (§3.2).
- `onPublished` is the plugin's startup; a failure there is recorded as degraded and
  dispatch opens so each call reports its own reason (`runtime/index.ts:3293-3317`).
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
  explicit host action (the existing `restartPlugin` path, `runtime/index.ts:3406`,
  which `config.set` also takes, `out-of-process-plugin.ts:910-911`). Automatic restart is rejected here because a plugin
  that crashes on a specific input would loop, and a loop hides the input.
- Host death: the child exits when its stdin ends (`plugin-child-main.ts:319-326`). A
  `process`-entry plugin must implement the same rule; the conformance suite spawns it,
  closes stdin and asserts exit within 5 s (§10).

---

## 3. Protocol

### 3.1 Shape: one JSON-RPC 2.0 session, MCP for the plugin-served half, `ave/host/*` for the host-served half

Decision: keep MCP unchanged for everything the plugin *serves* (`tools/list`,
`tools/call`, `resources/read` for `ui://`), and make everything the plugin *calls on
the host* a JSON-RPC method under `ave/host/`, on the same stream, as a separate Ave
peer channel. Notifications go both ways with the same `notifications/` convention.

Why this and not the alternatives:

- MCP `2026-07-28` has one request direction: the client sends requests and the server
  answers them — "Servers MUST NOT initiate JSON-RPC requests, and clients do not send
  JSON-RPC responses"; sampling, elicitation and roots travel as `InputRequiredResult`
  answers that the client retries ([MCP patterns](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns)).
  `ave/host/*` is therefore **not MCP**: it is an Ave-owned JSON-RPC 2.0 peer channel
  that shares the stream and the framing with the MCP half and lives outside MCP's
  message patterns, as `ave/instance/*` already does. JSON-RPC `id`s and the `ave/`
  prefix keep the two halves apart, and one decoder per direction serves both. A non-JS
  author pairs a stock MCP server library (tools, `ui://` resources) with a JSON-RPC
  library or the client generated from the schema (§6.2) for `ave/host/*` and
  `ave/instance/*`, multiplexed onto the same stdin and stdout the way the reference
  runtime does it; no MCP library will speak that half for them.
- The current reverse channel is a bespoke shape distinguished by field presence
  (`child-stream-multiplex.ts:52-64`). It was chosen so the two contracts could not
  collide; JSON-RPC `id` + a namespaced `method` gives the same guarantee. JSON-RPC
  treats a method name as opaque; the `ave/` prefix is what keeps these methods apart
  from every name MCP defines, the way a reverse-domain prefix keeps a `_meta` key apart
  from MCP's own.
- Mapping hostApi onto standard client features (sampling for `callLlm`, elicitation
  for `pickFolders`) loses the host's own semantics — `callLlm` carries the host rate
  window and key resolution; `pickFolders` is an OS dialog, not a form — and
  `mcp-alignment-design.md:1-12` already recorded that the full wire migration is not
  the direction. Rejected in §12.4.

Method naming: `ave/host/<path with "." replaced by "/">`. So `storage.read` is
`ave/host/storage/read`, `agentApproval.request` is `ave/host/agentApproval/request`.
The lifecycle methods keep `ave/instance/*` (`plugin-instance-wire.ts:38-45`):
`construct`, `start`, `onPublished` and `stop` stay, `shutdown` is added (§3.4) and
`readUiResource` folds into MCP `resources/read` (§5), so the set stays at five.
Tool names keep `^[a-zA-Z_][a-zA-Z0-9_]*$` (AGENTS.md); protocol method names are
host-owned and are not in that namespace.

Params are a JSON object, never a positional array, so a field can be added without
shifting an argument. Every method's params and result are described by JSON Schema
(§6.1); the four-axis contract table (`host-api-wire.ts:590-1005`) is the generator's
input, not a second hand-written list.

### 3.2 Version and capability negotiation at connect

Two versions travel, because two contracts change for different reasons
(`plugin-instance-wire.ts:22-28`):

1. **MCP protocol version**, per request. Ave speaks the stateless `2026-07-28`
   revision (`protocol-constants.ts:18`; `mcp-client.ts:376-383`): every MCP request
   carries `_meta["io.modelcontextprotocol/protocolVersion"]`, an unsupported value is
   rejected with `-32022` and the supported list (`plugin-mcp-server.ts:238-250`), and
   `server/discover` is mandatory on the server side
   ([MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).
   Nothing is negotiated at connect for the MCP half.
2. **Ave host protocol version.** The plugin declares it once, in the manifest
   (`requires.hostProtocol`, §6.4), so an installer or a marketplace sync can decide
   compatibility without spawning anything. A host serves a *set* of protocol versions,
   not one. Before it spawns, the host checks the declared version against that set; at
   `ave/instance/construct` it tells the plugin which version this connection speaks and
   what that version serves:

```jsonc
// host → plugin (construct params, additions)
"hostProtocol": {
  "version": "1",                                  // the manifest's requires.hostProtocol; integer-as-string
  "capabilities": ["storage/read", "storage/write", "callLlm", "hostFetch",
                   "startAudioCapture", "attachFloatingPanel", ...]   // every ave/host method served at that version
}
// plugin → host (construct result, additions)
"pluginProtocol": {
  "requires": ["storage/read", "callLlm"]          // methods the plugin will not run without
}
```

Rules:

- The host refuses the load with `incompatible-host-protocol` when the manifest's
  `requires.hostProtocol` is not in its served set (before spawning), or when a
  `requires` entry is not in `capabilities` (at construct). This is the same fail-closed
  shape as `markIncompatibleAppVersion` (`runtime/index.ts:2875-2892`) and surfaces in
  the same plugin-status UI. The version is never negotiated on the wire: the manifest is
  the one declaration, and the construct reply carries no second copy that could
  disagree with it.
- A breaking change adds version `N+1` to the served set; it does not replace `N`.
  Version `N` leaves the set only through the deprecation shape of §9.3 — a warning in
  the plugin-status UI, the replacement, and an app-version boundary announced in advance.
  This is what lets host and plugins release independently (reason 4): without it every
  breaking bump would strand every installed plugin on the same day.
- A plugin **may** call a method not in `requires` and handle `method-not-found`; that is
  how optional members (`hostFetch?`, `spawnWorker?`, `resolveApiKey?`,
  `getAppPreference?` are optional today, `public-contract.ts:1319, 1371, 1410, 1762`)
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
| plugin→host notification | `notifications/ave/log` `{ message, meta? }` | `context.log(message, meta?)` lines (`public-contract.ts:2209`), tagged `plugin:<id>` by the host; today `kind: "log"` with the same two fields (`host-api-wire.ts:136-141`, sent from `plugin-child-runtime.ts:348-356`) |
| host→plugin notification | `notifications/ave/config/snapshot`, `notifications/ave/installedPlugins/snapshot`, `notifications/ave/preferences/snapshot` | the three child-local snapshots; today `config-snapshot`, `installed-plugins`, `preference-snapshot` (`host-api-wire.ts:152-215`; sent from `out-of-process-plugin.ts:1224-1316`, consumed at `plugin-child-runtime.ts:634-672`) |
| either direction | `notifications/cancelled` | replaces `kind: "abort"` (`host-api-wire.ts:131-135`; §3.5) |

Those rows cover all eight `kind`s of today's `HostApiNotification` (`host-api-wire.ts:98-215`);
a frame the router does not recognise is dropped (§9.4 item 4), so a missing row would
be a stale `config.get` or a lost log line, not an error. `peer-gone` is never sent; it
is what each side does locally when the pipe closes (`host-api-wire.ts:85-92`).

Audio: `startAudioCapture` returns `{ subscriptionId, captureId, opened }`; each frame is
a `notifications/ave/subscription` with `{ kind: "frame", seq, pcm: <base64 int16 LE
mono>, peak }` and the end is `{ kind: "end", reason, detail? }`
(`host-api-wire.ts:1669-1684`, `public-contract.ts:2347-2364`). `seq` is gap-free; a gap
means lost audio and the plugin can say so (`:2349-2351`). No backpressure signal is
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
([MCP progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)).
Optional, not required in protocol `1`.

### 3.5 Cancellation

`notifications/cancelled` `{ requestId, reason }` in either direction — MCP's own
notification host→plugin
([MCP cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)),
and the same shape reused by the Ave peer channel plugin→host, where MCP defines no
pattern (§3.1) — replaces the bespoke `signalChannelId` and abort-channel notification
(`host-api-wire.ts:125-135`, `:1607-1618`). The two directions have different targets:
host→plugin names an in-flight `tools/call`; plugin→host names an in-flight
`ave/host/*` request, and the host aborts the `AbortController` it holds for
`hostFetch`, `callLlm` and `resolveApiKey`. The host→plugin direction is reserved: a
`PluginToolHandler` (`public-contract.ts:2213`) takes no `AbortSignal` today, so the
child drops that notification until the handler contract gains a signal, and the host
does not send it. A cancelled `ave/host/*` request still gets a reply — an error with
`data.code` `host-internal` and `data.name` `AbortError` — although MCP says a receiver
SHOULD NOT respond to a cancelled request: the child's typed client holds a pending
entry per request id, and the reply is what releases it. A non-JS runtime must expect
that reply. The
plugin's `AbortSignal` in the typed client maps to sending the notification for the
in-flight request id. A cancellation naming an id that is not in the receiving
direction's pending table is dropped, like any unrecognised frame (§9.4 item 4). MCP
Tasks are not adopted; `spawnWorker` and `startAudioCapture` are subscriptions, not
tasks, because their lifetime is owned by the plugin's disposer.

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
| `storage.resolve` (:1078) | local | child-local | none; pure lexical join under `pluginDataDir` with shared traversal rejection (blueprint §3.1) | none |
| `storage.read/readText/readJson/list/exists` (:1080-1098) | req | plain-json → plain-json / `read` encoded (base64) | host containment (`plugin-storage-containment.ts`), read effect recorded | 16 MiB cap (`host-api-wire.ts:471`) |
| `storage.write/writeJson/rm/mkdir` (:1086-1100) | req | encoded/plain-json → void | effect ledger write, `effect-boundary-denied` possible | same cap |
| `storage.writeEncrypted/readEncrypted` (:1117-1125) | req | plain-json | host encryption provider; `plugin-storage-encryption-unavailable` is a real error, not a fallback | ciphertext never leaves host; plaintext crosses the pipe (as it does the heap today) |
| `config.get` (:1247) | local | snapshot | none | snapshot push ordering (§3.4) |
| `config.set` (:1252) | req | plain-json → void | triggers plugin reload (restart of the child) | unchanged |
| `config.onChange` (:1258) | sub | handler-registration → handle, child-disposable | secret keys arrive redacted (`SECRET_REDACTED_SENTINEL`, `host-api-wire.ts:1141`) | notification stream |
| `emitEvent` (:1263) | notif | plain-json → void | manifest `emittedEvents`, denial audit host-side | child pre-check keeps the sync throw; host re-decides |
| `onEvent` (:1268) | sub | handler-registration | none | notification stream |
| `getInstalledPluginIds` (:1276) | local | snapshot | caller excluded by host binding (§2.4) | none |
| `onPluginsChanged` (:1295) | sub | handler-registration | none | notification stream |
| `getSecret` (:1306) | req | plain-json → plain-json | four-tier `runSecretGate` (`host-api-factory.ts:784-808`); **value crosses**, by design: an allow-listed secret is granted to this plugin | audit unchanged. See §4.1 |
| `resolveApiKey` (:1319) | sub | encoded → handle, child-disposable | gate + permission revoke signal (`host-api-factory.ts:764-773`) | **raw key stops crossing** (§4.1); `bearer()` removed from the contract |
| `callLlm` (:1349) | req | encoded → plain-json | host provider, host rate window, `effect-boundary-denied` | cancellation via `notifications/cancelled` |
| `hostFetch` (:1371) | req | encoded → encoded | Tier A egress gate, allow-list, SSRF (`host-fetch-guard.ts:9-20`); partition cookies attached host-side (`host-api-factory.ts:1031`) | bodies buffered and capped at 16 MiB; gains `auth: { lease }` (§4.1) |
| `logEvent` (:1377) | notif | plain-json → void | tagged `plugin:<id>` by host | none |
| `onShutdown` (:1388) | sub | handler-registration, host-terminated | 5 s per handler (`:1384-1386`) | becomes `ave/instance/shutdown` request (§3.4) |
| `spawnWorker` (:1410) | sub | plain-json → handle | worker envelope must be within the plugin's envelope (`host-api-dispatcher.ts:1160-1161`); command is a host-spawned process | `{ socketPath, pid }` cross; stdout/stderr/exit are notifications (`host-api-wire.ts:1652-1666`) |
| `openAuthWindow` (:1437) | UI | plain-json → plain-json | host-owned BrowserWindow, cookie host allow-list (`auth-window-service.ts:10-16`) | with `retainCookies` the values stay in the partition; the reply carries names or the final URL only |
| `authRedirect.open/wait/close` (:1474-1484) | req | plain-json | host loopback listener, one per plugin | unchanged |
| `pickFolders` (:1510) | UI | plain-json | OS dialog, user consent is the dialog | unchanged; the chosen paths do not widen the envelope unless declared (§2.2) |
| `resolveMappedDriveRoot` (:1530) | req | plain-json | host replaces a `powershell.exe` spawn (blueprint §10) | unchanged |
| `listAudioInputDevices` (:1536) | req | plain-json | renderer permission state | unchanged |
| `startAudioCapture` (:1551) | sub | plain-json → handle | host-owned renderer capture (`audio-capture.ts:4-14`); microphone/system permission is the OS prompt | frames as notifications (§3.4, §8) |
| `attachFloatingPanel` / `resizeFloatingPanel` (:1579, :1594) | sub / req | plain-json → handle / plain-json | one host-owned dock, height clamped (`floating-dock.ts:11-24`) | `detached` notification |
| `openAuthPartitionViewer` (:1632) | UI | plain-json → void | partition owned by the caller; URL host in `auth.partitionDomains` (`auth-partition-viewer-service.ts:15-19`) | unchanged |
| `clearAuthPartition` (:1660) | req | plain-json → void | partition name must be the caller's | unchanged |
| `getAuthPartitionCookies` (:1685) | req | plain-json | gated read; **values cross** (`public-contract.ts:195-202`) | see §4.1: stays, but is the one member that hands a session credential to the plugin |
| `openExternalUrl` (:1713) | UI | plain-json → void | host webView preference policy | unchanged |
| `probePrivateHost` (:1742) | req | plain-json | host resolver; result is a boolean | unchanged |
| `getAppPreference` (:1762) | local | snapshot | `HOST_PUBLIC_PREFERENCE_KEYS` allow-list (`app-preference.ts:33`) | none |
| `triggerConversation` (:1785) | req | plain-json | overlay staging only; a user click starts the turn (`:1765-1767`) | unchanged |
| `hasRoutineBySource` (:1801) | req | plain-json | none | unchanged |
| `proposeWork` / `withdrawWorkProposal` (:1827, :1841) | req | plain-json | declared `WorkProposalKind`, `effect-boundary-denied` | unchanged |
| `agentApproval.request/respond` (:1868-1896) | req | plain-json | ApprovalGate; `respond` carries nonce+HMAC | connection binding added (§2.4) |

What becomes impossible or different out of process, summarised:

- Nothing synchronous can cross. The eleven sync members already have their decision
  (blueprint §3.1: child-local, snapshot, notification, or a contract change). The only
  contract break already taken was `getSecret` becoming a Promise.
- No live object crosses: `Response`, `Uint8Array`, handles are reconstructed from JSON
  (`host-api-wire.ts:242-260`). A plugin cannot pass a function, a stream or a `Date`.
- A plugin cannot open a window, a socket, a dialog or a child process of its own. Each
  of those has a host-mediated form in the table; the blueprint's admission test is that
  the plugin contributes data and the host contributes code (blueprint §10, `:1030-1033`).
- `require("electron")` yields nothing (blueprint §4, measured by
  `confined-plugin-child.test.ts`).

### 4.1 Secret handling

Rule: a secret leaves the host process only when the plugin's *contract* is to hold it,
and the document says which members those are.

- `getSecret` — the value crosses. That is the member's purpose: an allow-listed,
  four-tier-gated read of a secret the plugin was granted (`host-api-factory.ts:784-808`).
  Used by `meeting` (1 site), `local-indexer` (2), `git` (2). Unchanged.
- `getAuthPartitionCookies` — values cross (`public-contract.ts:195-202`). Used only by
  `orion-api` (`ave-plugin-orion` at `1fc4909`, `src/sessionVault.ts:35-40`) to drive a browser context whose
  requests the host cannot issue. Unchanged, but named here as the one remaining
  session-credential export, and gated by the same install-time approval as
  `auth.partitionDomains`.
- `resolveApiKey` — today the raw key crosses so the child stub's `bearer()` can return
  it (`host-api-wire.ts:1628-1631`). **Change:** the lease reply carries
  `{ subscriptionId, vendor, baseUrl }` only, `bearer()` is removed from the contract,
  and `hostFetch` gains `init.auth = { lease: <subscriptionId> }`; the host attaches
  `Authorization` at the egress chokepoint the same way it already attaches partition
  cookies (`host-api-factory.ts:1031`). Revocation then needs no child-side copy to
  forget (`host-api-child.ts:397-403`). A plugin that must hand the key to a vendor SDK
  with its own HTTP client declares `capabilities: ["secrets:raw-api-key"]` (the manifest capability pattern is
  `^[a-z][a-z0-9:-]*$`, `schemas/plugin-manifest.schema.json:261`; the id joins the
  host-enforced `KNOWN_CAPABILITY_IDS`, `src/plugins/capabilities.ts:37`), which the
  installer shows and the user approves; without it `resolveApiKey({ exposure: "raw" })`
  is refused with `effect-boundary-denied`. In the official repository at `6a4d3b3df`, `meeting` already sends its STT traffic
  through `hostFetch` (`plugins/meeting/source/src/hostPlugin.ts:1368-1380`), so the lease
  covers it; `local-indexer` forwards the host-issued bearer to an allow-listed endpoint
  itself (`plugins/local-indexer/source/src/hostPlugin.ts:221-232`), which `hostFetch`
  does not carry, so the lease step gives it either a worker egress path through the
  host or this capability. This is a contract change and is handled as a
  flag-day across the plugin sources — one change in the official marketplace repository
  (`plugins/<name>/source/`) plus `orion` and `git` — like `getSecret` was (blueprint §9, `:1003-1006`).
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
| `ui://` card (MCP App) | `uiResources[]` (`public-contract.ts:463`) | renderer, sandboxed iframe with CSP from `_meta.ui.csp` ([MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)); served over `mcp-app-protocol.ts` | host asks the plugin process for the HTML via MCP `resources/read` (today `ave/instance/readUiResource`, `plugin-instance-wire.ts:44, 98-105`); the card's `tools/call` goes host→ToolExecutor→plugin, never iframe→plugin | `plugin-ui-resource-provider.ts`, `mcp-app-protocol.ts:5` |
| Embedded module (sidebar) | `ui[]` kind `embedded-module`, slot `sidebar` (schema `:201`) | renderer, `plugin-ui-shell.html` in a per-plugin partition served by `ave-plugin://asset` (`plugin-asset-protocol.ts:85`, `html-preview-partition.ts:161-165`) | `bridge.callTool` / `bridge.onEvent` through preload IPC → main → tool registry → `tools/call` | `src/preload/internal-api-surface.ts` |
| Floating panel | `ui[]` slot `floating` + `attachFloatingPanel` | renderer card inside the host-owned dock window (`floating-dock.ts:11-30`) | `ave/host/attachFloatingPanel` opens a subscription; `detached` arrives as a notification | `floating-dock-surface.ts:17` |
| Auth window | none; `openAuthWindow` at call time | main process BrowserWindow (`auth-window-service.ts:10-12`) | request/reply; cookies retained in `persist:plugin-auth:<id>` | `auth-window-service.ts:115` |
| Auth partition viewer | `auth.partitionDomains` | main process hardened BrowserWindow (`auth-partition-viewer-service.ts:1-23`) | request/reply | `:86` |

Decision: **plugin UI code never runs in the plugin process.** The plugin process serves
bytes (`resources/read`) and answers tool calls; the renderer runs the UI in a sandbox the
host owns. That is the split MCP Apps standardises, and it is why the UI half needs no
new protocol: `ui://` is MCP, the bridge is host IPC, and the dock/auth surfaces are
host-side actions with a JSON reply. `readUiResource` is folded into MCP
`resources/read`, which the child's MCP server already serves (`plugin-mcp-server.ts:137`),
with `mimeType: "text/html;profile=mcp-app"`, so a non-JS plugin serves its card with a
stock MCP server library (§9.4 item 5).

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
the emitted file differs from the committed one (`check:plugin-host-protocol-schema`,
carried by the `build` script beside `scripts/check-generated-assets.mjs`, so CI
`build-and-test` runs it).
A method's `.errors` is every code in the closed set except `protocol-version-mismatch`
(which only `construct` returns), not the member's own contract list: the dispatcher
classifies a failure by the error class thrown, whichever member threw it, so
`detached-operation`, `manifest-integrity-violation` or `subscription-unknown` can cross
on members whose contract list omits them. The member's own codes are named in the
entry's `description`. Narrowing the enum per member would first need the dispatcher to
narrow what it returns.
The completeness test that today walks the real hostApi object
(`hostapi-effect-completeness.test.ts:11-16`) gains a sibling that walks the schema:
every dispatchable path has a schema entry and vice versa.

Published the way the rest of the contract is (§6.3): the file lives in the ave tree,
and a plugin repository vendors it at an app release tag into `contract/` with its sha256
recorded in `contract/sources.json`. It is mirrored at
`https://former-site.invalid/schemas/plugin-host-protocol/1/<app tag>/protocol.schema.json`, served
from `web/public/schemas/` and added by the release change that bumps the app version —
the site deploys on every `web/**` merge, so the copy must travel with the tag, not ahead
of it (decision 6). The `$id` is that tagged URL and is never reassigned: an additive
change within protocol `1` (§3.3) ships in a new app tag and therefore under a new `$id`
(Agent Plugins conformance, "Never reassign a published canonical schema identifier",
[checklist](https://agent-plugins.org/client-implementers/conformance)).
`.../plugin-host-protocol/1/protocol.schema.json` is a documented moving alias to the
newest tag's copy, for editors; a plugin pins the tag through `contract/sources.json`,
never the alias.

### 6.2 Typed clients

| Client | Who generates | From | Ships as |
|---|---|---|---|
| TypeScript types (`PluginHostApi` and friends) | none: the file itself | `public-contract.ts` | the vendored copy in the plugin repository's `contract/` (marketplace design §5.6), unchanged |
| JS reference runtime (`plugin-child-main.js`) | host build | `src/plugins/isolation/*` | **inside the app**; a JS plugin never vendors it. The host runs it for every `entry` plugin (`out-of-process-plugin.ts:200-204`) |
| Protocol-level TS client (JSON-RPC stubs) | host build | protocol schema | emitted beside the schema under `schemas/plugin-host-protocol/<version>/` and vendored with it; used by the conformance tests and by authors who want to speak the protocol from JS without the reference runtime |
| Other languages | plugin author or community, from the schema | protocol schema | not Ave-maintained. The conformance suite (§10) is the guarantee, not a maintained SDK. An author pairs a stock MCP server library (tools, `ui://`) with a JSON-RPC library or this generated client for `ave/host/*` and `ave/instance/*`, which no MCP library speaks (§3.1). This is how MCP handles its own SDKs: at the protocol level, generated from `schema.ts` |

### 6.3 How this builds on the vendored contract

The SDK repository is retired. A plugin repository copies `public-contract.ts` and
`plugin-manifest.schema.json` from ave at a release tag into `contract/`, and two
checks hold the copy to the sha256 recorded in `contract/sources.json`: an offline hash
check in every CI run and a networked check against the file at the recorded tag
(marketplace design §5.6). The official repository's `sources.json` pins ave
`v0.10.0` and names `tools/vendor.mjs sync contract --ref <tag> --app <checkout>` as the only
way to refresh a copy (`vendor.mjs:15`). Under this design:

- the **manifest schema** stays exactly that: host-owned, vendored, hash-checked;
- the **TS types** stay vendored for JS authors, but they are now a *client* of the
  protocol, not *the* contract: the schema is the contract, the types are regenerated
  from the same source, and the hash check on the types proves what the check on the
  schema proves;
- the **protocol schema** joins the vendored set: `tools/vendor.mjs` copies
  `schemas/plugin-host-protocol/<version>/protocol.schema.json` and `sources.json`
  records its hash. It is the artifact a plugin pins with `requires.hostProtocol`, and
  the validate CLI checks the plugin against it without the app.

The contract version stays the app version (§5.6): a plugin that uses a member first
served in release X sets `requires.minAppVersion` to X or later, and
`requires.hostProtocol` says which protocol version it speaks. The SDK-owned skill
package schema is already gone; the host owns `schemas/skill-package.schema.json`.

### 6.4 `minAppVersion` and the protocol version

`requires.minAppVersion` is enforced at install, at load and at manifest validation. At install, a git install requires
the field and holds it to the descriptor's value
(`src/marketplace/resolve/manifest-rules.ts:59`, `:79-83`; marketplace design §5.3), and
version choice drops a version whose `minAppVersion` the app does not satisfy
(`src/marketplace/catalog/aggregate.ts:83`; §6.1). At load, the host refuses an
incompatible manifest (`runtime/index.ts:2875-2892`), and manifest validation checks the
format (`manifest-validation.ts:931-948`). It answers "does this app have the features I
need", which includes UI slots, marketplace behaviour and everything the protocol does
not cover.

Add `requires.hostProtocol` (integer-as-string, e.g. `"1"`). Rules:

- Each app version publishes the set of host protocol versions it serves (§3.2); the
  mapping is in the release notes and in each schema's `x-ave-app-version-range`.
- A plugin declares `hostProtocol`; the host refuses the load when the version is not in
  its served set (§3.2). `minAppVersion` remains additive: a plugin may set both.
- In the git marketplace (`docs/design/multi-source-git-marketplace.md`) the descriptor
  and the index copy carry `minAppVersion` so a sync can pick the newest version the app
  can run (§6.1, §6.2). `requires.hostProtocol` joins it: the descriptor gains
  `hostProtocol`, the index copies it, the install plan holds the staged manifest's value
  to the descriptor's the way `manifest-rules.ts` holds `minAppVersion`, and version
  choice drops a version whose protocol the app does not serve, exactly as it drops one
  whose `minAppVersion` is too new.
- Capability-level needs are expressed by `requires` in `construct`, not in the manifest,
  because they are only knowable from the running host.
- A `hostProtocol` mismatch is a distinct refusal code from `incompatible-app-version`,
  so the Doctor can say "update the app" versus "this plugin was built for a different
  protocol".

---

## 7. Security

### 7.1 What improves

- **Isolation**: no shared heap, no Electron, one structural chokepoint, a separate crash
  and hang domain, per-plugin resource accounting (blueprint §4, `:422-448`). All of it
  is already in force for the five isolated plugins; the protocol extends it to every
  plugin and to non-JS plugins.
- **Secrets**: `resolveApiKey` stops exporting the raw key (§4.1); credentials attach at
  the egress chokepoint; partition cookie values already never leave the host.
- **Effect ledger**: `hostObservable` is recorded `true` for `source:"plugin"` tools
  (`invocation-execution.ts:1047`). Out of process it remains true and becomes
  *structurally* true: a plugin cannot reach a host effect except through a
  `ave/host/*` request that the dispatcher records
  (`host-api-factory.ts:539-540` composition, `host-api-dispatcher.ts:6-10`). The
  completeness test that guards the wrapper today (`hostapi-effect-completeness.test.ts`)
  becomes a schema/dispatcher parity test (§6.1).

### 7.2 What must be preserved

- **Permission chokepoints**: tool execution still enters through the single
  `ToolExecutor` pipeline with Layer-1 deny, ApprovalGate, audit and the effect-ledger
  shadow (`architecture.md:980-989`). The plugin process is reached by `tools/call`
  *after* those stages, exactly as the loopback arm is today
  (`out-of-process-plugin.ts:1397`). No protocol method bypasses a gate; `agentApproval`
  is a request *to* the gate.
- **Trust tiers**: `trustFromSource` maps `source` to a tier (`tools/types.ts:83`); a
  first-party plugin stays `medium` and an external MCP server `low`
  (`mcp-tool-adapter.ts:25`). Running out of process does **not** change the tier — an
  isolated first-party plugin is still first-party. Conversely a `process`-entry plugin
  from the marketplace is still `medium` only if its artifact came through a pinned rung
  and was admitted;
  the tier is derived from install provenance, never from the transport.
- **Host-derived identity**: `pluginId` is bound to the connection (§2.4);
  `_meta["ave/workerId"]` and self-declared categories on the wire are ignored
  (`plugin-tool-from-mcp.ts:12-17, 29-33`).
- **Egress**: every network request goes through `hostFetch`'s layered gate
  (`host-fetch-guard.ts:9-20`) and the manifest `networkAccess.allowedDomains`
  (`public-contract.ts:490-492`). ASRT network confinement is what makes that the *only*
  egress (blueprint §4, `:454-455`); a `process`-entry plugin therefore requires the
  wrap (§2.2).

### 7.3 New risks and their controls

| Risk | Control |
|---|---|
| RPC surface abuse: a plugin hammers `ave/host/*` (log flood, storage churn, `triggerConversation` spam, subscription leak) | per-(plugin, method) token bucket in the dispatcher with a refusal code `rate-limited` (new, added to the closed set); cap on open subscriptions per plugin; `WIRE_BYTES_MAX` 16 MiB per decoded payload (`host-api-wire.ts:471`), and a per-line cap in the frame decoder derived from it, whose overrun terminates the child (added with the newline framing, §9.4 item 1), so a child that never writes a newline cannot grow the host's buffer without bound. Plain-JSON values (tool results, `storage.readText`/`readJson` replies, arguments) have no payload cap of their own, so each side checks the frame against the same cap before it writes: an oversized reply becomes a `payload-too-large` error for the same id, and an oversized request rejects its caller with `payload-too-large`. The receiver's kill is reserved for a peer that skipped that check; `logEvent` key/prefix caps already exist for `getSecret` (`host-api-factory.ts:790-798`) and are generalised. Today no rate limiting exists in the dispatcher (verified by absence of any limit constant in `host-api-dispatcher.ts`). |
| Resource exhaustion: a plugin process consumes memory/CPU | Linux: a per-plugin cgroup from the workload resource controller once it is wired to the spawn path (`linux-workload-resource-controller.md:1-15` says it is not yet). macOS: `RLIMIT` in the wrapper is deferred (decision 7); Windows: Job Objects are not available through srt-win today. Until then the control is crash containment: the host survives, the plugin is marked degraded. |
| A plugin process outlives the host | child exits on stdin end (`plugin-child-main.ts:319-326`); `managed-child-processes.ts` tracks and kills process groups on app quit; a `process`-entry plugin must pass the stdin-close conformance check (§10). Residual: a hard host crash on Windows leaves the child to notice a closed pipe on its next write. |
| Arbitrary executable via `process` entry | a pinned release or archive artifact only (§2.1); a wrap whose published `confines` includes `process` (never srt-win); refused when the sandbox is off; the command must be inside the plugin root (Agent Plugins rule); no `PATH` search for a marketplace plugin. |
| Envelope widening via the manifest `sandbox` block | closed `hostDirectory` allow-list; `userChosenDirectory` requires a user-set absolute path; deny-floor piercing requires install-time approval (§2.2). |
| Windows: no process confinement | unchanged from `architecture.md:1018-1020`; admission does not depend on it (decision 3); a `process` entry is refused on Windows because srt-win is a wrap that does not confine processes (§2.2); the Doctor names the confinement each plugin runs under. |
| Confused deputy through the host's own credentials | `hostFetch` attaches a lease only to a URL that passes the allow-list for *that* plugin; the lease id is per plugin per session and is refused on any other connection. Matches the MCP security guidance on token passthrough ([MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)). |

---

## 8. Performance

- **Audio.** 16 kHz mono int16 is 32 KB/s raw, about 43 KB/s base64; 48 kHz is 96 KB/s
  raw, about 128 KB/s base64. At `frameMs` 100 that is 10 notifications per second of
  roughly 4-13 KB each — well inside what a pipe and a JSON parser handle. The
  base64 cost is the price of JSON over stdio (blueprint §5.2, `:526-531`). If a future
  plugin needs multi-channel 48 kHz for long sessions, the escape hatch is a
  host-allocated UDS carrying raw PCM, negotiated as capability `audio/rawSocket`; not in
  protocol `1`.
- **Large payloads.** `hostFetch` bodies and storage reads are buffered and capped at 16
  MiB. A plugin that needs more streams through its own `spawnWorker` or through
  storage in chunks. No chunked body streaming in protocol `1`.
- **Startup cost per plugin.** One Electron-as-Node process per plugin
  (`out-of-process-plugin.ts:955-967`), ASRT wrap, `construct`, `start`. The blueprint asked for the Stage 6 measurement (`:990`); this document does
  not have a measured RSS or wall-clock number and marks it **UNVERIFIED**. The
  conformance suite (§10) records both per plugin so the number exists before every
  install goes out of process (§9.1).
  Plugins start in parallel, and the loopback projection is unchanged, so the user-visible
  cost is the slowest plugin, not the sum.
- **Per-call latency.** One JSON round trip per hostApi call. Members on hot paths
  (`config.get`, `storage.resolve`, `getInstalledPluginIds`, `getAppPreference`) are
  child-local already; `logEvent` and `emitEvent` are notifications and never wait.

---

## 9. Migration

### 9.1 Steps

| Step | Scope | Proof | Contract change for plugins |
|---|---|---|---|
| Isolated five (done) | five first-party plugins out of process on the internal wire | `OUT_OF_PROCESS_PLUGIN_IDS`, `out-of-process-plugin.test.ts`, `confined-plugin-child.test.ts` | none |
| Wire (§9.4) | reverse channel becomes JSON-RPC `ave/host/*`; `construct` negotiation; newline framing; identity fields off the wire; schema generator + parity gate | golden-fixture conformance suite passes against the JS reference runtime for all five plugins | **none** — the reference runtime is host-shipped |
| Lease | secrets lease (`bearer()` removed, `hostFetch` `auth.lease`), a host egress path for `local-indexer`'s bearer or its `secrets:raw-api-key` (§4.1), `sandbox` manifest block replaces `PLUGIN_ENVELOPE_GRANTS`, dispatcher rate limits | every plugin source builds against the new contract; `local-indexer` manifest carries its grants | **flag-day**: `resolveApiKey` callers (`meeting`, `local-indexer`), `local-indexer` manifest |
| Publication | protocol schema and TS client vendored with the contract (§6.3); validate CLI; `process` entry and `hostProtocol` in the descriptor and index; `requires.hostProtocol` declared by the official plugins | validate CLI passes for every official plugin (`plugins/*/source`), `templates/plugin`, `orion` and `git` with the app not running; a non-JS smoke plugin (Python: a stock MCP server library plus a JSON-RPC library for the Ave peer channel) passes conformance | none for existing plugins |
| Admission | out-of-process by default for every install and every source (decision 3); `git`, `hello-world`, `templates/plugin`, `orion` (company git) onto the path; adversarial fixture | fixture attempts the four escapes (blueprint §9 Stage 9) and is denied; `allPluginsAreOutOfProcess` true for the official index | `git`: confirm no ambient axis (it uses `openAuthWindow`, `openExternalUrl`, `getSecret`, `callLlm`, `clearAuthPartition` — all mediated) |
| Loader removal | remove the in-process loader and the routing census | `importPluginFactory` has no call site in main; `OUT_OF_PROCESS_PLUGIN_IDS` deleted | none |

Dual-run period: from the wire step until loader removal. Both loaders coexist as a
per-plugin routing decision from a host-owned set, never as a runtime fallback: a failed
child fails the call (`out-of-process-plugins.ts:14-15`, blueprint `:992-1001`). That is
why the coexistence needs no No-Fallback exemption.

### 9.2 Order of plugins

For the wire step (§9.4), in validation order: smallest surface first, so a wire defect
is found where it is cheapest to read. The four official plugins are cited in the
official repository (`OFFICIAL_MARKETPLACE.url`, `src/marketplace/sources/official.ts:27`)
at its commit `6a4d3b3df`, under `plugins/<name>/source/`; `orion` and `git` are cited in
their own repositories at a pinned commit, since `orion` moves to company git and `git` keeps
its own repository.

1. `vega-helper` — `triggerConversation`, `callLlm`, `onEvent`, `config`,
   `hasRoutineBySource`, `getInstalledPluginIds`, `onPluginsChanged`
   (`plugins/vega-helper/source/src/hostPlugin.ts:1038`); no worker, no window, no audio.
2. `lyra-mail` — `authRedirect`, `openAuthWindow`, `openAuthPartitionViewer`,
   `clearAuthPartition`, `storage.*Encrypted`, `probePrivateHost`
   (`plugins/lyra-mail/source/src/auth/msal-client.ts:113`); exercises the UI-action members.
3. `local-indexer` — `spawnWorker` with the Python worker over UDS, `pickFolders`,
   `resolveMappedDriveRoot`, `resolveApiKey`
   (`plugins/local-indexer/source/src/localIndexerPlugin.ts:582`); exercises handles,
   worker notifications and the `sandbox` manifest block.
4. `meeting` — `startAudioCapture`, `attachFloatingPanel`, `spawnWorker` (ffmpeg),
   `resolveApiKey`, `callLlm` (`plugins/meeting/source/src/ffmpegRuntime.ts:112`);
   exercises the streaming path and the secrets lease.
5. `hello-world` (`plugins/hello-world/source` in the official repository, built and
   released through the same flow as the other four, marketplace design §6.3) and
   `templates/plugin` (official repository; `your-plugin-id`, `config.get` only) — the
   marketplace admission
   path end to end.
6. `orion-api` in company git — `openAuthWindow` ×5, `getAuthPartitionCookies`,
   `spawnWorker` ×3 (`ave-plugin-orion` at `1fc4909`, `src/nativeAdClient.ts:91-96`), `probePrivateHost`;
   the largest surface and the one the blueprint records as "three unrelated problems"
   (`:1061`). It is not in the official index, so an install reaches it as a custom
   source from company git or as a policy `additional` (managed) source; admission does
   not depend on which (decision 3). Last, and after the company-git move, so its cadence
   is decoupled.
7. `git` — not yet isolated; `openAuthWindow` ×4, `getSecret`, `callLlm`,
   `openExternalUrl`, `clearAuthPartition` (`ave-plugin-draco` at `46a7139`, `src/hostPlugin.ts:2194-2349`).
   Admissible by the blueprint's data-not-code test; joins at the admission step.

### 9.3 Removal condition for the in-process path

Per AGENTS.md a coexistence needs a deprecation owner and a removal condition, not a
permanent shim.

- **Condition (state, not date):** `allPluginsAreOutOfProcess(installedPluginIds)`
  (`out-of-process-plugins.ts:872-879`) is true for every plugin in the official
  marketplace index and for every plugin the routing set names, **and** the conformance
  suite has passed for two consecutive app releases, **and** the in-process arm has
  needed no change in those releases — verifiable in the history of
  `src/plugins/runtime` and `plugin-loader.ts`, since there is no fleet telemetry.
- **Owner:** the organization owner role (the repository's sole maintainer; decision 5),
  recorded as that role in `TODO.md` when the wire step starts.
- **Version boundary:** the removal ships no later than two minor releases after the
  admission step lands, or the owner records why not in `TODO.md`.
- **What is deleted:** `importPluginFactory` from main (`plugin-loader.ts:77`, the
  child keeps it), the loopback in-process arm, `OUT_OF_PROCESS_PLUGIN_IDS` and
  `isOutOfProcessPlugin`, `PLUGIN_ENVELOPE_GRANTS`, and the `ChildLocalPath` /
  in-process branches of `runtime/index.ts` around `createHostApi`
  (`runtime/index.ts:2049-2058`).

### 9.4 The wire step: implementation plan

Scope is the "Wire" row of §9.1. Nothing a plugin author sees changes: the `PluginHostApi`
object the reference runtime hands to a JS plugin keeps every member and signature, the
manifest gains one optional field, and no plugin under `~/.ave/plugins` is rebuilt or
migrated.

#### Wire changes, by file

1. **Framing.** `src/mcp/stdio-framing.ts` becomes newline-delimited: `frameMessage`
   emits `JSON.stringify(message) + "\n"` (the stringifier escapes every newline inside a
   string, so one message is one line), and `StdioFrameDecoder` splits the byte buffer on
   `0x0A` before decoding and refuses a line longer than a cap derived from
   `WIRE_BYTES_MAX` (the overrun is a contract violation that terminates the child; the
   sender checks the same cap first and turns an oversized frame into a
   `payload-too-large` error, so only a peer that skipped the check is terminated), so a multi-byte character split across chunks decodes intact —
   the rule `mcp-client.ts` applies at `:2453-2458`. A line that is not a JSON object is
   dropped, never thrown on, as today. The Content-Length path is deleted in the same
   change; its callers are `child-stream-multiplex.ts:23`, `plugin-child-main.ts:32`, the
   experimental stdio arm (`src/mcp/experimental/stdio-child-transport.ts`,
   `stdio-server-loop.ts`) and their tests. `mcp-client.ts` keeps its own line parser: it
   is the external boundary and has its own tests.
2. **Reverse channel.** In `host-api-wire.ts`, `HostApiEnvelope`, `HostApiRequest` and
   `HostApiReply` (`:49-83`) become JSON-RPC 2.0 request and response objects; the
   envelope's `wire` field goes with it, and `HOST_API_WIRE_VERSION` (`:46`) together with
   `PLUGIN_INSTANCE_WIRE_VERSION` (`plugin-instance-wire.ts:29`) become one
   `HOST_PROTOCOL_VERSIONS_SERVED` in `host-api-wire.ts`, so no version check survives in
   the old shape (`host-api-dispatcher.ts:2009-2013`). From this change on `construct`
   carries `hostProtocol: { version }`, and the child's check at
   `plugin-child-main.ts:164` becomes a membership check of that version against the
   runtime's own served set — the reference runtime is host-shipped, so the two sets are
   equal by construction, and the check exists so a stale bundle fails loudly instead of
   answering a version it does not speak. So no commit is without a version check, and
   the constant has a user in the PR that exports it (the knip baseline warns on unused
   exports, `knip.jsonc:13`). The method name is
   `ave/host/<path with "." as "/">`, produced and parsed by two total functions over
   `HostApiPath`. Params are a JSON object: each `HOSTAPI_PATH_CONTRACTS` entry
   (`:590-1005`) gains a fifth axis, `params`, the argument names in order; the child stub
   maps a positional call to that object and the dispatcher maps it back before the
   handler runs, so the handlers in `host-api-factory.ts` do not change. A test holds each
   name list to the parameter names of the member in `public-contract.ts`, read with the
   TypeScript compiler API, so the axis cannot drift from the signature. Errors become
   JSON-RPC `error` objects with `data.code` from the closed set (`:312-333`);
   `plugin-mismatch` and `generation-mismatch` leave the set and `wire-version-mismatch`
   is renamed `protocol-version-mismatch`. The eight `kind`-keyed notification shapes
   (`:98-215`) get the names of §3.4: the three subscription messages,
   `notifications/ave/log`, the three snapshot notifications and `notifications/cancelled`.
3. **Identity off the wire.** `pluginId` and `generationId` leave every message.
   `HostApiDispatcher.resolve` (`host-api-dispatcher.ts:2008-2020`) drops the two
   comparisons: the dispatcher is already constructed per child with the plugin id it
   serves, and the generation is the process (§2.4). The stamping sites go with them:
   in the child, `plugin-child-runtime.ts:251-254` (requests), `:350-353` (log),
   `:371-373` and `:413-416` (subscription release and abort), which read
   `context.generationId` (`:91`); on the host, the three snapshot sends in
   `out-of-process-plugin.ts:1224-1226`, `:1261-1263` and `:1311-1313`.
4. **Routing.** `classifyMultiplexedMessage` (`child-stream-multiplex.ts:46-65`)
   discriminates on JSON-RPC fields only: a request whose `method` starts with
   `ave/instance/` is an instance request, `ave/host/` a host request, `notifications/`
   a notification, any other `method` an MCP request; `id` with `result` or `error` is a
   response, matched against the pending table of the direction it arrived on.
   `notifications/cancelled` is routed by direction (§3.5). Anything else is dropped, as
   today: the host drops every server-direction frame (`plugin-child-transport.ts:193-199`)
   and the child answers an `ave/host/*` request with `-32601` (today it refuses the
   `host-api-request` shape, `plugin-child-main.ts:270-278`).
5. **Negotiation.** There is no `initialize`: the MCP half stays on the stateless
   `2026-07-28` revision the host already speaks — per-request
   `_meta["io.modelcontextprotocol/protocolVersion"]` checked by the child's server
   (`plugin-mcp-server.ts:238-250`) and `server/discover` (`:112`) — and the Ave
   negotiation travels only in `construct`. `PluginConstructParams`
   (`plugin-instance-wire.ts:65-82`) already carries `hostProtocol.version` (item 2) and
   gains `hostProtocol.capabilities`;
   `PluginConstructResult` (`:84-92`) gains `pluginProtocol: { requires }`; both drop
   `wire` (item 2). `capabilities` is derived from the dispatcher's **bound** table — the
   `implemented` entries of `options.table` (`host-api-dispatcher.ts:1927`), never the
   static `HOSTAPI_DISPATCH_TABLE` (`:268-316`), which marks every path unimplemented or
   child-local — mapped through the path→method function, so a host that leaves
   `hostFetch`, `spawnWorker`, `resolveApiKey` or `getAppPreference` unbound does not
   advertise them and the four child-local paths (`storage.resolve`, `config.get`,
   `getInstalledPluginIds`, `getAppPreference`; `:269`, `:281`, `:285`, `:289`) are never
   methods. In the same
   change `onShutdown` delivery becomes the `ave/instance/shutdown` request (§3.4) and
   `readUiResource` folds into MCP `resources/read`, which the child's server already
   serves (`plugin-mcp-server.ts:137`); `PLUGIN_INSTANCE_METHODS` stays at five.
6. **Manifest.** `requires.hostProtocol` (`^[1-9][0-9]*$`) is added to
   `schemas/plugin-manifest.schema.json` beside `minAppVersion` (`:689`), to the manifest
   type in `public-contract.ts`, and to the format gate in `manifest-validation.ts` beside
   the `minAppVersion` one (`:931-948`). The load check lives in `runtime/index.ts` beside
   the two `markIncompatibleAppVersion` call sites (`:3733`, `:5286`), as a sibling
   `markIncompatibleHostProtocol`, so it runs for every load path and not only the
   out-of-process spawn: a declared version outside the served set is refused with
   `incompatible-host-protocol`. An `entry` plugin that declares nothing speaks the newest
   served version: the host's own runtime speaks for it, so there is nothing to negotiate.
   A `process` entry that declares nothing is refused; the entry itself is accepted only
   at the publication step, so in this step the rule is a schema rule with no call site.
   Because the schema's `requires` object is closed (`additionalProperties: false`,
   `:698`), an older app rejects a manifest that declares `hostProtocol` with a schema
   error rather than `incompatible-app-version`; so a plugin that declares it must set
   `minAppVersion` to the first release whose schema carries the field or later, a rule
   the validate CLI and `manifest-rules.ts` enforce at the publication step. The vendored
   copy of the schema in a plugin repository refreshes on its next `tools/vendor.mjs
   sync`; until then the field is absent from the copy and an unrefreshed copy validates
   every manifest it did.
7. **Schema generator and parity gate.**
   `scripts/generate-plugin-host-protocol-schema.ts` (run with `node --import tsx`, the
   pattern `check:i18n-catalog` uses) reads `HOSTAPI_PATH_CONTRACTS`, the
   `ave/instance/*` method table and the notification shapes, and chooses the type
   source per axis: a `plain-json` argument or result is described from the member's
   type in `public-contract.ts`; an `encoded` or `handle` axis is described from the
   `Wire*` type that is its wire form in `host-api-wire.ts` (`WireBytes` `:482`,
   `WireRequestInit` `:1352`, `WireHttpResponse` `:1371`, `WireCallLlmOptions` `:1607`,
   `WireResolveApiKeyOptions` `:1614`, `WireApiKeyLease` `:1633`, `WireWorkerHandle`
   `:1652`, `WireAudioCaptureHandle` `:1669`, `WireFloatingPanelHandle` `:1687`), never
   from the `Uint8Array`, `AbortSignal`, `RequestInit`, `Response` or function types of
   the contract; a `handler-registration` member is described as its subscription result.
   The TypeScript-to-JSON-Schema conversion uses `ts-json-schema-generator`, a build-time
   dev dependency that is never bundled — the one new dependency of this step; a
   hand-written walker over the compiler API is the fallback if it cannot read the two
   source files (see UNVERIFIED). It writes `schemas/plugin-host-protocol/1/protocol.schema.json`,
   committed, with `$defs.methods` holding the 44 non-child-local paths plus the five
   instance methods. `check:plugin-host-protocol-schema` regenerates to a temporary file
   and byte-compares; it joins the `build` chain beside
   `scripts/check-generated-assets.mjs`, so CI `build-and-test` runs it.
   `src/plugins/isolation/__tests__/host-protocol-schema-parity.test.ts` asserts every
   non-child-local `HostApiPath` and every instance method has a `$defs.methods` entry and
   vice versa, every error code in the schema is in the closed set, and
   `$defs.capabilities` equals what the bound table advertises for a host with every
   optional member bound.

#### Tests

- Framing: the existing round trip (`src/mcp/__tests__/stdio-server-loop.test.ts:31`)
  passes for any symmetric format, so it gains a byte-literal assertion — the frame is
  the JSON text plus `0x0A`, with no header — and a hand-written newline stream that
  splits a multi-byte character across two chunks.
- Updated in place, because they write the wire shape directly:
  `out-of-process-plugin.test.ts`, `plugin-child-runtime.test.ts`,
  `child-process-config-wire.test.ts`, `confined-plugin-child.test.ts` (which gains the
  stdin-close-exits and stdout-discipline checks of §2.5),
  `config-subscription-paths.test.ts`, `host-api-storage-members.test.ts`,
  `host-api-boundary-contract.test.ts`, `host-api-service-members.test.ts`,
  `host-api-interaction-members.test.ts`, `src/mcp/__tests__/stdio-server-loop.test.ts`,
  `src/mcp/__tests__/test-helpers.ts` and
  `src/permissions/__tests__/hostapi-serialization-conformance.test.ts`. The identity
  mismatch test in `host-api-boundary-contract.test.ts` becomes its inverse: a request
  whose params carry a forged `pluginId` or `generationId` is attributed to the bound
  plugin and the forged fields are reported as unknown (§3.3).
- Golden fixtures under `src/plugins/isolation/__tests__/fixtures/host-protocol/1/`:
  `methods/<method>.json`, one request/response pair per method and one per error code;
  `notifications/<name>.json`, one frame per notification kind, all eight of §3.4; and
  `plugins/<id>/` for `vega-helper`, `lyra-mail`, `local-indexer`, `meeting` and
  `orion-api`, each a fixture entry module that calls exactly the members that plugin uses
  (the §9.2 survey) beside that plugin's `extensions["ai.agent-connector.ave"]` block, with
  `expected.jsonl`, the frame sequence the reference runtime must produce.
  `host-protocol-golden.test.ts` replays each over in-memory paired streams (the
  substitution `out-of-process-plugin.test.ts:1-10` makes) against the real
  `plugin-child-main` runtime and compares frames after canonical key ordering and id
  normalisation. The harness lands with the first wire change (PR 2 below) so every
  later change is caught by it; once the schema exists (PR 4) every golden frame is also
  validated against `protocol.schema.json`, which is what ties the goldens to the schema.
- Negotiation (PR 3), in `out-of-process-plugin.test.ts` and `plugin-child-runtime.test.ts`:
  a manifest with `requires.hostProtocol: "2"` is refused with `incompatible-host-protocol`
  and the spawn count stays zero, while the same manifest without the field loads; a
  dispatcher whose bound table leaves `hostFetch` unimplemented sends construct params
  whose `capabilities` omit `hostFetch`, and a plugin whose `requires` names it is
  refused at construct; `ave/instance/shutdown` is awaited before `stop`, and a handler
  that overruns the bound gets the child killed (`plugin-child-transport.ts:141-146`).
  Each of these fails if its behaviour is removed.
- Real process: `confined-plugin-child.test.ts` runs the `meeting` fixture through a real
  confined child in the macOS and Linux jobs of `ci.yml`.
- In the app, for every PR that changes the wire (PRs 1-3): start the app from the
  worktree and confirm over CDP that the five installed plugins are active and one tool
  call per plugin round-trips. The nightly Playwright lifecycle spec does not cross this
  wire — it installs a fixture plugin that is not in the routing set and calls an external
  MCP fixture — so it is not evidence here.

#### Gates

`bun run typecheck`; `bun run test:vitest -- run src/plugins/isolation src/plugins
src/mcp src/permissions` while iterating, then `bun run test`; `bun run build` (which
carries `check:import-cycles`, the generated-asset checks and the new schema check);
`check:knip:engine` against its baseline; `.github/scripts/naming-gate.sh` against
`origin/main`; the pre-push hook; CI `build-and-test` and `naming-gate` green before each
merge, read from the check rollup.

#### Why installed plugins keep working

The reference runtime bundle `dist/src/main/plugin-child-main.js`
(`scripts/build-main-esbuild.mjs:46`) and the host change in the same app release; a
plugin's `dist/` imports nothing from the wire, because the contract package is not a
runtime dependency (marketplace design §5.6); the `PluginHostApi` shape is unchanged; the
in-process arm is untouched. So the five installed plugins run unmodified, and an app
downgrade is equally safe because the pair travels together.

#### Commits and pull requests

Each is based on `main` after the previous one merges, so a merged PR's branch deletion
cannot close the next. Each carries the documentation that describes the behaviour it
changes, so no page lags a merged change.

1. `feat(plugins): the plugin channel is newline-delimited` — item 1 and its tests, with
   the framing sentences in `docs/architecture/mcp-alignment-design.md:250-259`, blueprint
   §5.2 and the `src/mcp/experimental/*` headers.
2. `feat(plugins): the reverse channel is JSON-RPC ave/host/*` — items 2 (with the
   version half of the `construct` negotiation), 3 and 4, the
   updated suites, the forged-identity test and the golden harness with the per-method
   goldens and the five plugin fixtures; blueprint §2.2 describes the new reverse
   channel. The largest of the four; it is one rewrite of `host-api-wire.ts` and its two
   ends, and splitting the shapes from the identity removal would leave a commit that
   carries identity in a params object nothing checks.
3. `feat(plugins): construct negotiates the host protocol` — items 5 and 6, the
   negotiation tests above, goldens updated; blueprint §2.1 and §3.1 (rows `onShutdown`, `readUiResource`) follow.
4. `feat(plugins): the host protocol schema is generated and gated` — item 7, the parity
   test, schema validation of every golden frame, the header at `public-contract.ts:1-8`
   (which still names the retired SDK generator as the copier of that file) and this
   page's §6.1 status.

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
4. **Adversarial fixture** (admission step): read `~/.ave/secrets/`, direct egress,
   `require("electron")`, monkey-patch a host internal, name another plugin's id, replay a
   lease id on another connection — each denied.
5. **Cross-language smoke**: a minimal Python plugin using a stock MCP server library for
   tools and a JSON-RPC library (or the generated client) for `ave/host/*` and
   `ave/instance/*` on the same stream passes 1-3.

### 10.2 Validating without the app: the validate CLI

`ave-plugin validate <dir>` is built from an ave entry as a `tools/vendor/` bundle:
`tools/vendor.mjs` already holds ave entries built with `bun build` by a recorded bun
version, byte-reproducible and hash-checked like the contract copies (`vendor.mjs:5-11`;
`tools/vendor/marketplace-check.js` is one today), so a plugin repository takes it with
`vendor.mjs sync tools/vendor --ref <tag> --app <checkout>`. It replaces the per-plugin
drift scripts such as `plugins/meeting/source/scripts/validate-hostapi.mjs` in the
official repository (which imports the vendored `@ave/plugin-contract`, `:27`). It:

1. validates `plugin.json` against the manifest schema and the Ave `extensions` rules,
   including `requires.hostProtocol`;
2. spawns the plugin (JS through the bundled reference runtime, or its `process` entry)
   against a **mock host** that serves the real dispatch table with fake handlers, runs
   `server/discover` → `construct` → `start` → `tools/call` → `stop`, and asserts the
   protocol rules (framing, stdout discipline, exit on stdin close, no unknown method);
3. cross-checks `emitEvent`/`onEvent` names against the manifest's declared events and
   `bridge.callTool` targets against `app`-visible tools — the checks the meeting script
   does today (`validate-hostapi.mjs:6-15`);
4. exits 0/1 and prints the exact schema path of each failure.

The same binary runs in the plugin repos' CI, so a plugin author never needs a host
checkout or the app to know the plugin will load.

---

## 11. Reference-host comparison

| Host | Where plugin code runs | How the contract is shared | Compatibility declaration | Isolation | Language support |
|---|---|---|---|---|---|
| **Ave today** | five first-party plugins in a confined child process; others in the main process (`out-of-process-plugins.ts:856-858`, `plugin-loader.ts:77-81`) | `public-contract.ts` and the manifest schema vendored by each plugin repository at an app tag with hash checks (`contract/sources.json`, marketplace design §5.6); the header at `public-contract.ts:1-8` still names the retired SDK generator as the copier | `requires.minAppVersion` (`schemas/plugin-manifest.schema.json:689`) | ASRT for isolated plugins (`out-of-process-plugin.ts:954-986`); none in-process | JavaScript only |
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
   receipt-anchored — the install receipt records the artifact and manifest hashes
   (`plugin-install-receipt.ts:68-86`, `registry-manifest-trust.ts`); an id allow-list
   would be a regression.
4. "All APIs experimental" as the stability statement. A published protocol version with
   report-and-ignore is the stronger promise and the one the six reasons ask for.

---

## 12. Rejected alternatives

1. **Stay in-process and drop the types.** Keeps every cost (shared heap, Electron
   reachable, hang domain, no per-plugin accounting) and gains nothing: reasons 1-5 all
   require the process boundary. Also moot: the five first-party plugins with host surface are already out.
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
   `agentApproval` as elicitation, storage as resources, secrets as OAuth. In
   `2026-07-28` sampling and elicitation are `InputRequiredResult` answers to a client
   request, not server-initiated calls, so a plugin could ask for anything only while
   answering a tool call. Loses host
   semantics (rate window, key gate, OS dialogs, the approval HMAC), forces a bespoke
   `_meta` dialect to carry what standard messages cannot, and was already set aside
   when the wire migration was deferred (`mcp-alignment-design.md:1-12`).
   Tools and `ui://` resources *do* stay pure MCP; that is the part where "unchanged"
   is right.
5. **`utilityProcess.fork`.** Cannot be argv-wrapped by ASRT (blueprint §5.2,
   `:507-513`). Already rejected there.
6. **A second channel (UDS or extra fd) for the reverse direction.** More attack surface
   through the sandbox wrap for a multiplex JSON-RPC gives for free
   (`child-stream-multiplex.ts:5-11`).
7. **Keeping the bespoke `callId`/`kind` envelope and only publishing its schema.** A
   schema for a non-standard frame still needs a hand-written client in every language;
   JSON-RPC gets those clients for free.
8. **Automatic child restart on crash.** Hides the crashing input and turns a plugin
   defect into a CPU loop; explicit restart keeps the failure visible (§2.5).

---

## 13. Decisions

| # | Decision | Reason |
|---|---|---|
| 1 | The plugin channel is newline-delimited, per the MCP `2026-07-28` stdio binding ("newline-delimited JSON-RPC over a byte stream", [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)). | An off-the-shelf MCP server library frames that way, and the host's external MCP client already does (`mcp-client.ts:2365-2368`, since `97b400ecf`). The host decoder and the reference runtime switch together (§9.4), so no installed plugin sees it. |
| 2 | `resolveApiKey` stops exporting the raw key: `bearer()` leaves the contract, `hostFetch` gains `auth.lease`, and raw exposure exists only under `capabilities: ["secrets:raw-api-key"]` with install-time approval (§4.1). | The credential attaches at the egress chokepoint the way partition cookies already do; the capability makes the exception visible to the user and countable by the host. `meeting` needs no exception (its STT egress already goes through `hostFetch`); `local-indexer` forwards the bearer itself, so the lease step must give it a worker egress path or the capability (§4.1). |
| 3 | Out-of-process admission is decided the same way on every platform and for every install source — official, managed, custom, direct, local development, and origin-less legacy entries (`legacy-plugins.ts:90-93`). A code plugin loads out of process under the confinement the host chose for itself: `features.osToolSandbox`, off by default on every platform (`sandbox-gate.ts:20-21`); while it is off the child is spawned unwrapped (`out-of-process-plugin.ts:13-21`). What admission promises is the process boundary — separate heap, no Electron, own crash domain, one structural chokepoint — not OS confinement; OS confinement is whatever the substrate publishes (`architecture.md:1017-1020`): filesystem, process and network on macOS and Linux, filesystem and network on Windows. Only a non-JS `process` entry requires a wrap whose `confines` includes `process`, so it never loads on Windows and does not load anywhere with the sandbox off (§2.2). The Doctor's plugin report names, per plugin, the confinement it runs under. | An earlier draft refused custom and direct code plugins on Windows and admitted official and managed ones. Rejected on evidence: `origin.sourceOrigin` alone is not evidence, because the registry file is user-writable and `src/plugins/registry.ts:300-311` checks only shape, legacy migration binds `official` by plugin id with `artifactSha256: null` (`legacy-plugins.ts:95-124`), and a removed `additional` source leaves `managed` behind, so a sound version would need the host-secret evidence chain (`grants.ts:87-106`); it would grant the official and managed sources a privilege the marketplace design forbids (§10: the badge is the only thing the official source grants; §10.5); it would refuse `orion-api` and `git` on Windows, since neither is in the official index (`marketplace.json` at `6a4d3b3df` lists `hello-world`, `local-indexer`, `meeting`, `lyra-mail`, `vega-helper`) while `orion-api` already runs out of process there (`out-of-process-plugins.ts:857`); and its rationale was false by default on every platform, because with the sandbox off macOS and Linux run a custom plugin without process confinement too. |
| 4 | A non-JS `process` entry is in the schema from protocol `1`; marketplace admission for it waits for the admission step. | The protocol is language-neutral from its first published version, and admission needs the adversarial fixture first. |
| 5 | The deprecation owner of the in-process loader is the organization owner role of `former_org` (the repository's sole maintainer) — a role, recorded as such in `TODO.md` when the wire step starts; ave has no `CODEOWNERS` file. | AGENTS.md requires a named owner and a removal condition for any coexistence (§9.3). |
| 6 | The protocol schema is canonical in the ave tree at a release tag and vendored like the rest of the contract (§6.3); its `$id` carries the app tag; `former-site.invalid` mirrors every tagged copy from `web/public/schemas/`, with `/1/protocol.schema.json` as a documented moving alias for editors. The validate CLI is a `tools/vendor/` bundle built from an ave entry (§10.2). | A release tag plus a sha256 in `contract/sources.json` is what the contract already pins; `tools/vendor.mjs` already holds bundles built from ave entries with a recorded bun version (`vendor.mjs:5-11`); release assets would be a second publication of the same bytes. The tag in `$id` is what keeps an additive revision (§3.3) from changing the bytes behind one identifier, since the site deploys on every `web/**` merge, not on tags. |
| 7 | Per-plugin resource limits on macOS are deferred: crash containment ships first, and the conformance suite records RSS and startup time per plugin. | No number exists to size an `RLIMIT` against. |

### Owner decisions still open

None. Decision 5 names a role, not a person, so nothing waits on the owner.

---

## UNVERIFIED in this document

- The RSS and wall-clock startup cost of one plugin child (§8). No measurement exists in
  the checkout; the conformance suite is asked to produce it.
- Whether `ts-json-schema-generator` 2.9.0 reads `public-contract.ts` and
  `host-api-wire.ts`: it pins its own TypeScript `^5.9.3` while ave compiles with
  TypeScript `^7.0.2` (`package.json:198`). Its `--functions hide` option and custom type
  formatters cover function-typed members, but the generator avoids them by reading the
  `Wire*` types for encoded and handle axes (§9.4 item 7). If the two files do not parse
  under 5.9, the fallback is a compiler-API walker using the app's own TypeScript.
- Whether the stock MCP server SDKs (Python, TypeScript) already speak `2026-07-28`
  (`server/discover`, the per-request `_meta` version). The Publication cross-language
  smoke and the validate CLI's `server/discover` probe (§10.2) both depend on it.
