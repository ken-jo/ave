# Plugin HostApi as a versioned protocol

The code packages described here are called extensions in user-facing copy.

Status: design, decided; the wire step (§9.4) is implemented on `main`; the Lease step
(§9.1, §4.1, §9.5) was amended on 2026-09-27 with decisions 8-26 (§13), in two rounds
of independent review. It follows
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
documentation. The Lease amendment (§2.2, §3.2, §3.6, §4.1, §6.1, §6.3-6.4, §7, §9.1-9.3,
§9.5, decisions 8-20) cites ave at `f1a8d191e` (main, 2026-09-27, after the wire
step), the official repository at `6a4d3b3`, `ave-plugin-orion` at `2f17388` and
`ave-plugin-draco` at `d71fb95`; a citation in those sections without a repository name is
ave at `f1a8d191e`.

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
   (`out-of-process-plugin.ts:322-368` at `f1a8d191e`).
5. `resolveApiKey` ships the raw credential into the child: the wire result carries
   `key` and the child stub rebuilds `bearer()` around it (`WireApiKeyLease`,
   `host-api-wire.ts:2003-2015`; `host-api-child.ts:342-394`; the dispatcher sends
   `result.bearer()`, `host-api-dispatcher.ts:828`, all at `f1a8d191e`).
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
read and `{pluginDataDir, socketDir}` for write (`out-of-process-plugin.ts:717-723` at
`f1a8d191e`). Widening it today is a host-side table keyed by plugin id
(`PLUGIN_ENVELOPE_GRANTS`, `:322-368`), whose only entry is `local-indexer`. The Lease
step (§9.1) deletes that table and moves the declaration into the manifest, as a
**sibling** of `requires`, `capabilities`, `networkAccess` and `alerts` inside the Ave
extension object — never nested under `requires` or `capabilities`, and never a new
top-level Agent Plugins field (decision 11):

```jsonc
{
  "$schema": "https://agent-plugins.org/schemas/plugin.schema.json",
  "name": "local-indexer",
  "extensions": {
    "ai.agent-connector.ave": {
      "capabilities": ["external-auth-consumer"],
      "requires": { "minAppVersion": "0.12.0", "hostProtocol": "2" },
      "networkAccess": { "allowedDomains": ["api.openai.com"] },
      // "alerts": { "reasoning": "…", "kinds": [ … ] } would sit here as another sibling;
      // it is omitted because local-indexer declares no alerts and the block requires
      // `reasoning` and a non-empty `kinds` (schemas/plugin-manifest.schema.json:574-600)
      "sandbox": {
        "read":  [{ "kind": "hostDirectory", "segments": ["runtime"], "why": "the Python interpreter the worker executes" },
                  { "kind": "hostDirectory", "segments": ["certs"],   "why": "the corp CA bundle the worker's SSL_CERT_FILE names" }],
        "write": [{ "kind": "userChosenDirectory", "configKey": "indexStorageRoot", "why": "where the index is written" },
                  { "kind": "userChosenDirectory", "configKey": "workspace",        "why": "the worker's scratch and state directory" }]
      }
    }
  }
}
```

The runtime's flattened manifest (`flattenAgentPluginsManifest`, `public-contract.ts:105-129`)
spreads every `extensions["ai.agent-connector.ave"]` field onto the flat `PluginManifest`, so
`manifest.sandbox` needs no adapter; `PluginManifest` gains the typed field and
`schemas/plugin-manifest.schema.json` gains the closed object beside `alerts` (`:574`).

**Closed vocabulary.** The schema, the runtime hardening pass
(`src/plugins/runtime/manifest-validation.ts`) and the app's repository checker
(`src/marketplace/repository-check.ts`, which the official repository vendors as
`tools/vendor/marketplace-check.js` and rebuilds from the app tag, §6.3) validate the
same rules; the official repository's own `tools/repo.mjs` is a local
authority-extraction helper and copies the block, it does not define the rules. An entry
outside them is a manifest refusal at validation (`manifest-integrity-violation` at
load, a validate-CLI failure before), never a default:

| Rule | Value | Why |
|---|---|---|
| `sandbox` | object with optional `read` and `write` arrays; `additionalProperties: false` | closed like `requires` (`:803`) |
| `kind` | `"hostDirectory"` or `"userChosenDirectory"` — the two kinds the table has (`out-of-process-plugin.ts:265-277`; bare line numbers in this table are that file) | no new kind without a design change |
| `hostDirectory` | `read` only; `segments` must name an entry of the host catalog `HOST_DIRECTORY_CATALOG` = `{ ["runtime"], ["certs"] }`, the two subtrees the table exposes today (`:328`, `:336`); the catalog is a host constant, closed, with `piercesDenyFloor: true` on `certs` (`:343-345`) | the host owns which `~/.ave` subtrees can be exposed at all; a plugin names one, it cannot invent one |
| `userChosenDirectory` | `read` or `write`; `configKey` must name a key of the plugin's `configSchema.properties` (or `config`) with `type: "string"`; the value is read from plugin config at spawn; `undefined`, `null` and `""` mean **no extra grant** (the resolver already treats them so, `:599-603`); a non-empty value must resolve to an absolute, canonical path inside the approved-directory ceiling (`resolveUserChosenDirectory`, `:595-669`) | a config value proves nothing about who wrote it — `config.set` is a host API the plugin calls (`:295-308`) — so the ceiling, not the value, is the authority; `config.set` cannot widen the ceiling. `local-indexer` reads `indexStorageRoot` and `workspace` from config today (official repository at `6a4d3b3`, `plugins/local-indexer/source/src/hostPlugin.ts:644-650`, `:1686`) but declares neither in `configSchema.properties` (`plugin.json`, parsed: no `config` keys; the properties are the embedding, caption, scan and worker settings), so its Lease manifest **adds both as `type: "string"` properties with default `""`**; existing stored values keep working because the host reads them by key. The validator is not waived for any plugin |
| write implies read | every `write` entry is also readable (`:737-742`) | the plugin must list and reopen what it wrote |
| limits | ≤ 8 entries per list; `why` 1-400 characters, shown to the user, **informational only** | `why` is author text and is not consent evidence |
| absent or empty | the base envelope above and nothing else | a missing declaration can never recreate the deleted table's grant |
| global exclusions | `ceilingSubtractions` (`:434`, `:490-511`) keeps subtracting **every** catalog directory, canonical symlink targets included, from every plugin's approved ceiling — computed over the closed catalog, not over the deleted table | what is excluded is the class of host-owned directories, whether or not this plugin declared one |
| sensitive deny floor | `~/.ave/secrets`, `~/.ssh`, `~/.aws` stay owned by `confined-child.ts:15-21`; only a catalog entry marked `piercesDenyFloor` may sit on it, and it is `read` only | a root CA is a trust anchor, not a credential (`:343-345`) |

**Authority, consent, evidence.** `sandbox` is plugin *authority* in the marketplace
sense (marketplace design §5.2): it joins `PLUGIN_AUTHORITY_FIELDS`
(`src/marketplace/resolve/manifest-rules.ts:20-28`), `PluginAuthority`
(`src/marketplace/catalog/types.ts:78-86`), the descriptor and the index, the
`pluginAuthority` JSON schema (`schemas/marketplace/package.schema.json:352-391`) and
`AUTHORITY_FIELDS` in the official repository's `tools/repo.mjs:18`, so the staged
manifest's block is held equal to the descriptor's (`manifest-rules.ts:85-86`), the
install review shows it as a `filesystem` row group beside network hosts and secrets
(`authorityView`, `src/marketplace/app/views.ts:58-74`; `PackageSheet.tsx:78-85`), an
update that adds an entry is a widening delta and needs confirmation
(`authorityDelta`, `views.ts:83-94`; `service.ts:781-795`), and the install receipt records
the reviewed authority hash. Consent is the reviewed plan that executed the install, or
the policy file for a required managed install (`boot-installs/run.ts:4-8`); it is never
the `why` string, and never inferred for a legacy artifact from a manifest string. A
running manifest whose authority differs from the receipt is refused before activation.
**Two inputs, one shrink rule (decision 25).** A resolved envelope has two inputs: the
manifest authority above, and the user's approved-directory ceiling
(`permissions.additionalDirectories`, read live at resolution,
`out-of-process-plugin.ts:658-666`). Either can shrink independently of the other, and
the kernel envelope of a running child cannot narrow after spawn (`:682-687`), so the
rule is the same generic lifecycle action for both: **an incarnation whose resolved
envelope is no longer covered is retired, and the next spawn re-resolves from the
current inputs or refuses.**

- Manifest shrink (an update that removes an entry) goes through the update flow,
  which restarts the plugin; the new incarnation resolves the smaller block.
- Ceiling shrink (the user removes an approved root, `src/ipc/domains/workspace.ts:945-962`
  → `removePersistedWorkspaceRoot` → `permission-manager.ts:1148-1155`, which already
  prunes grants and calls `revokeAllPluginAccess` for the root) gains one host step in
  that same path, before the removal is acknowledged to the caller: the plugin runtime
  retires every incarnation whose resolved `userChosenDirectory` grants include a path
  the removed root covered and no remaining root covers (overlapping roots therefore
  keep the grant), through the existing stop path (`ave/instance/stop` → pipe close →
  SIGTERM/SIGKILL, delegated workers killed with the process group), and marks the
  plugin `sandbox-grant-outside-ceiling` in plugin status. A spawn in progress
  re-resolves at exec, so it sees the reduced set. A restart is refused with the same
  status until the plugin's config names a path inside the remaining ceiling or the
  user approves the directory again; the plugin cannot widen the ceiling from its
  config. Boot: the workspace-root reconciler runs before any plugin receives a
  HostApi (`src/boot.ts:573-582`, `source: "boot"`), so
  resolution at spawn sees the reconciled set and no incarnation is ever spawned
  against a root that no longer exists. The slice C acceptance test for workspace
  revocation asserts exactly this: remove a root while a delegated worker holds a file
  under it; the incarnation and the worker are gone before the removal call returns, no
  later access or new worker occurs, the status is set, and a restart is refused until
  the config or the ceiling changes.

When `features.osToolSandbox` is off nothing is enforced and nothing is marked confined
(as above); the block is still validated, reviewed and consented so an install is not
re-reviewed when the sandbox is turned on, and the Doctor names the plugin as unconfined.

This closes the AGENTS.md "no plugin-specific branches in the host" violation without
weakening the envelope. `local-indexer` ships exactly the four declarations above and
no other plugin gains a grant: `meeting`'s managed FFmpeg lives under its data
directory (official repository at `6a4d3b3`,
`plugins/meeting/source/src/ffmpegRuntime.ts:350-386`), `orion-api`'s native worker asks
for empty read and write sets (`ave-plugin-orion` at `2f17388`, `src/nativeAdClient.ts:655-663`:
`allowReadPaths: []`, `allowWritePaths: []` on its `spawnWorker` call), and `git`'s
external `dataDirectory` is an Admission
prerequisite, not a Lease grant (§9.2 item 7).

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
- **Served set and breaking changes (decision 9, replaces the earlier retention
  promise).** An app release serves exactly one host protocol version
  (`HOST_PROTOCOL_VERSIONS_SERVED`, `host-api-wire.ts:60`, is `["1"]` at `f1a8d191e`;
  the schema generator refuses any other cardinality,
  `scripts/lib/plugin-host-protocol-schema.ts:317-324`). A breaking change ships as
  version `L = N+1` at an **announced app boundary X** and *replaces* `N` in that
  release; the host does not keep a second runtime, schema set, codec, child stub or
  envelope policy for `N`, because "retaining `N`" would mean all of those, frozen and
  tested per version, and a version label in an array implements none of them. What the
  boundary promises instead is the deprecation shape of §9.3: the boundary is announced
  at least one minor release ahead, **tested candidate** replacements for every official
  plugin exist before the boundary is tagged and **published** replacements before the
  app draft is published (§9.3, §9.5), and an artifact that does not declare a served
  version is refused **before factory activation** with `incompatible-host-protocol`
  and an update path — on both loader arms, for every install source, offline included.
  Reason 4 (independent release) is kept by the *additive* rule of §3.3 — which is what
  a plugin built against `1` actually relies on between boundaries — not by dual-serving.
  The first boundary is the Lease step: `L = 2`, `X` = **0.12.0**, the minor after
  v0.11.0 (decision 8; matrix and cost in §6.4, sequence in §9.5).
- **Omitted declaration.** Until X an `entry` plugin that declares nothing speaks the
  newest served version (`connectionHostProtocol`, `out-of-process-plugin.ts:1121-1132`;
  the load predicate passes an absent value, `runtime/index.ts:2917-2919`). From X that
  reading ends for every code plugin: a manifest with no `requires.hostProtocol`, or one
  naming a version the host does not serve, is refused before activation by
  `markIncompatibleHostProtocol` on both arms, with the same status kind and Doctor
  text as an explicit mismatch. The rule is generic — no plugin id, no guess about
  which methods an old bundle calls — and it is deliberately stronger than a minimum
  version on the two resolver consumers, because an unrecognised old bundle's calls
  cannot be inferred from its manifest. `minAppVersion` is never used as an upper
  bound (`markIncompatibleAppVersion` checks the lower bound only,
  `runtime/index.ts:2880-2902`, and stays that way).
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

**Lease additions to the closed set (decision 16).** The set at `f1a8d191e`
(`HOST_API_WIRE_ERROR_CODES`, `host-api-wire.ts:540-560`) has no lease or rate-limit
category. Protocol `2` adds exactly these four codes; each is a thrown error on the
member that hit it, never a resolver `ok: false` (those are business outcomes and
stay a result, §4.1.5):

| `data.code` | Raised by | Meaning | Retryable | Safe `data` fields |
|---|---|---|---|---|
| `lease-unavailable` | `hostFetch` with `init.auth.lease` | the id is unknown, belongs to another plugin or another incarnation, is a raw registration rather than a lease, was released, was revoked, or was issued under an obsolete permission/secret/configuration epoch. **One code for all of them**, deliberately: distinguishing "foreign" from "unknown" would let a plugin probe another plugin's handle space. `release()` never raises it: release is an idempotent notification (§4.1.1) | no | `stage` ∈ `before-send`, `redirect`, `after-await` (the caller's id is not echoed) |
| `lease-audience-denied` | `hostFetch` | the URL, or a redirect target, is outside the lease's audience (§4.1.3), even though the plugin's network allow-list admits it | no | `origin` of the refused URL, `hop` index |
| `credential-conflict` | `hostFetch` | a lease-bearing request also carries a caller credential header, `Cookie` included (§4.1.4), or `init.auth` is malformed. **Precedence:** a malformed `auth` is `credential-conflict` at every layer — schema, wire decoder, dispatcher runtime validation and the direct in-process arm — and not §3.3's generic `argument-marshalling-rejected`, because the field is a credential selector and the two arms must agree | no | `header` name (lower-cased), never its value |
| `rate-limited` | every dispatched request | the per-(plugin, method) budget or the in-flight cap of §7.4 is exhausted | yes, after `retryAfterMs` | `method`, `retryAfterMs` (≤ 5000) |

Audit is bounded, so that a flood of refused requests cannot become unbounded audit
work: the key is `(plugin id, method, code)` — never a caller-supplied id, header or
payload — and for each key the first raise writes one `plugin_hostapi_denied` (or
`plugin_rate_limited`) entry immediately, further raises increment a counter, and one
summary entry with the count is written per 60 s while the counter is non-zero. The
per-call refusal itself is not coalesced. Entries carry the plugin id, the method, the
code and the safe fields above — never a header value, a cookie, a key, a token or an
upstream body. **Error messages are fixed, not sanitised:** the `message` a plugin
receives for the four codes is the code's fixed sentence; for `host-internal` on a
transport failure the Lease change replaces today's pass-through of `error.message`
(`host-api-dispatcher.ts:1899-1902` forwards `errorMessage(error)`) with a fixed public
message plus a bounded internal classification (`dns`, `tls`, `connect`, `timeout`,
`aborted`, `other`) in `data.kind`; a regex over arbitrary exception text was rejected
because it cannot prove the absence of credential bytes. What a lease can and cannot
report is in §4.1.2; how `local-indexer`'s broker and Python worker translate these
codes is in §4.1.7.

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
| `getSecret` (:1339 at `f1a8d191e`) | req | plain-json → plain-json | four-tier `runSecretGate` (`src/plugins/secret-access/secret-gate.ts:190-215`); host-key entitlement and provenance (`grants.ts:33-44`, `:87-111`); **value crosses**, by design: an allow-listed secret is granted to this plugin | audit unchanged. Under Lease the shared gate gains an operation axis: `getSecret` is `export`, refused for the host-provider key class for every plugin before the read; the entitlement rows stay for the resolver's `lease` operation (§4.1.6); own-namespace reads stay. See §4.1 |
| `resolveApiKey` (:1350 at `f1a8d191e`) | sub | encoded → `WireApiKeyLease` handle (`host-api-wire.ts:2003-2015`), child-disposable | gate + permission revoke signal (`host-api-factory.ts:794-827`); lease registry and epoch fencing (§4.1.2) | **raw key stops crossing** on the default `exposure: "lease"`; `bearer()` removed from the contract; `key` crosses only for `exposure: "raw"` under `secrets:raw-api-key` (§4.1.1) |
| `callLlm` (:1349) | req | encoded → plain-json | host provider, host rate window, `effect-boundary-denied` | cancellation via `notifications/cancelled` |
| `hostFetch` (:1402 at `f1a8d191e`) | req | encoded → encoded | Tier A egress gate, allow-list, SSRF (`host-fetch-guard.ts:9-20`); partition cookies attached host-side (`host-api-factory.ts:1056-1085`); per-hop recheck (`host-fetch-guard.ts:438-485`) | bodies buffered and capped at 16 MiB; gains `init.auth = { lease }` (§4.1.1) with host-owned credential injection, audience and redirect rules (§4.1.3-4.1.4); `FormData` bodies serialised by the reference runtime (§8) |
| `raiseAlert` (:1886 at `f1a8d191e`) | req | plain-json → plain-json | manifest `alerts.kinds`; alert service rate limit returns `status: "rate_limited"` as a *result* (`src/alerts/service.ts:338-339`, `:357-358`), distinct from the transport `rate-limited` error (§3.6) | unchanged; golden fixture `fixtures/host-protocol/1/methods/ave/host/raiseAlert.json` |
| `withdrawAlert` (:1893 at `f1a8d191e`) | req | plain-json → plain-json | caller's own alert kinds only | unchanged; golden fixture `.../withdrawAlert.json` |
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
  four-tier-gated read of a secret the plugin was granted
  (`runSecretGate`, `src/plugins/secret-access/secret-gate.ts:190-215`; host-key
  entitlement `grants.ts:33-44` with the provenance evaluator `:87-111`). Own-namespace
  reads (a key the plugin stored itself) are unchanged everywhere. **Under Lease a host
  provider key (the `llm.apiKey.*` class, `grants.ts:33-39`) is no longer exportable
  through this member for any plugin**: the shared gate gains an operation axis, and
  `getSecret` is the `export` operation, which the gate refuses for that secret class
  before the read (§4.1.6). The entitlement rows themselves stay, because the same gate
  decides the resolver's `lease` operation (§4.1.6, decision 17).
- `getAuthPartitionCookies` — values cross (`public-contract.ts:195-202`). Used only by
  `orion-api` (`ave-plugin-orion` at `2f17388`: the reader is bound at
  `src/sessionVault.ts:35-40` and invoked at `:65`) to drive a browser context whose
  requests the host cannot issue, **and** to read the partition's `user_id` and
  `refresh_token` cookies for the company service's token refresh, which it then sends as a JSON
  body through `hostFetch` (`src/portalClient.ts:147-161`, `:206-214`). Unchanged, but
  named here as the one remaining session-credential export, gated by the same
  install-time approval as `auth.partitionDomains`. The refresh case is recorded as the
  scope of that export at this revision; it is not a general authorisation to move
  cookie values into request bodies, and Lease does not remove it.
- `resolveApiKey` — today the raw key crosses: the wire result carries `key`
  (`WireApiKeyLease`, `host-api-wire.ts:2003-2015`), the dispatcher fills it from
  `result.bearer()` (`host-api-dispatcher.ts:828`) and the child stub rebuilds
  `bearer()` around it (`host-api-child.ts:342-394`). **Change (decision 2):** the
  default result is an opaque lease that carries no key; `bearer()` leaves the
  contract; `hostFetch` gains `init.auth = { lease }` and the host injects the
  provider credential at the egress chokepoint, the way it already injects partition
  cookies (`host-api-factory.ts:1056-1085`), rechecking on every hop
  (`host-fetch-guard.ts:438-485`). The full contract is §4.1.1-4.1.8 below.
- `hostFetch` with partition cookies — cookie values never leave the host
  (`auth-partition-cookie-jar.ts:5-13`). Unchanged; composition with a lease is §4.1.4.
- `config.onChange` for a secret key delivers the redaction sentinel, never the value
  (`host-api-wire.ts:1141-1146`). Unchanged.
- `storage.writeEncrypted` plaintext crosses from plugin to host (the plugin authored
  it); ciphertext and the key never cross.

Residual raw crossings after Lease, the complete inventory, each under its own gate:
`getSecret` for a secret **outside** the host-provider class (own-namespace keys; and
any other allow-listed, granted secret — no such grant exists at `f1a8d191e`, the table
holds only the LLM class); `getAuthPartitionCookies` for `orion-api`;
`resolveApiKey({ exposure: "raw" })` under `secrets:raw-api-key` with the receipt
evidence of §4.1.6 (no official plugin declares it); `storage.readEncrypted` plaintext
of what the plugin wrote (`lyra-mail`'s token store uses `writeEncrypted`/`readEncrypted`,
official repository at `6a4d3b3`, `plugins/lyra-mail/source/src/auth/token-store.ts:73-77`;
it is this category, not `getSecret`). Nothing else carries a credential across the
pipe. The inventory is exactly as strong as the gate rules above and no stronger.

#### 4.1.1 The lease: public types and wire shape (decision 12)

Public contract (`public-contract.ts`, replacing the inline result type at `:1350-1372`):

```ts
export interface ResolveApiKeyOptions {
  purpose: "llm" | "stt" | "embedding" | "vision";
  vendor?: "openai" | "azure-openai" | "vertex" | "anthropic";
  /** Default "lease". "raw" needs `capabilities: ["secrets:raw-api-key"]` (§4.1.6). */
  exposure?: "lease" | "raw";
  /** Cancels THIS resolve request only (§3.5). It has no effect on the lease once issued. */
  signal?: AbortSignal;
}

export interface ApiKeyLease {
  readonly exposure: "lease";
  /** Opaque, host-minted, per plugin incarnation. The only thing hostFetch accepts in init.auth. */
  readonly leaseId: string;
  readonly vendor: string;
  readonly baseUrl?: string;
  /**
   * Ends the lease: no new attachment, active uses aborted, host entry dropped. Idempotent.
   * Resolves when the local state is terminal and the release notification has been
   * written to the stream; there is no host acknowledgement (§4.1.1 rules).
   */
  release(): Promise<void>;
  /**
   * Host-side closure. Any number of listeners; a listener added after closure is invoked
   * immediately with the recorded reason; never invoked after release(). Returns an unsubscribe.
   */
  onClosed(listener: (reason: "revoked" | "peer-gone") => void): () => void;
}

export interface ApiKeyRaw {
  readonly exposure: "raw";
  readonly vendor: string;
  readonly baseUrl?: string;
  /** The credential bytes. Copied into the plugin; cannot be recalled by release(). */
  readonly key: string;
  /** Tells the host the plugin is done with the copy (audit and registry only). Idempotent. */
  release(): Promise<void>;
}

export type ResolveApiKeyDenied = {
  ok: false;
  reason:
    | "no-host-vendor" | "vendor-mismatch" | "not-whitelisted" | "user-mode-plugin"
    | "aborted" | "user-endpoint-with-host-key"          // existing, resolve-api-key.ts
    | "raw-exposure-denied"                              // capability, consent or provenance missing (§4.1.6)
    | "audience-not-allowlisted"                         // vendor origin ∩ networkAccess.allowedDomains = ∅ (§4.1.3)
    | "vendor-unsupported"                               // the normalized source has no lease scheme (§4.1.3)
    | "endpoint-unavailable"                             // the source needs a configured endpoint and has none (§4.1.3)
    | "stale-authorization"                              // the issuance snapshot changed before commit (§4.1.2)
    | "lease-limit";                                     // 32 registrations per incarnation (§7.4)
};

export type ResolveApiKeyResult =
  | ({ ok: true } & ApiKeyLease)
  | ({ ok: true } & ApiKeyRaw)
  | ResolveApiKeyDenied;

export interface HostFetchInit extends RequestInit {
  /** Attach the credential of this lease host-side. Exactly this shape; any other key is credential-conflict. */
  auth?: { lease: string };
}

resolveApiKey?(opts: ResolveApiKeyOptions): Promise<ResolveApiKeyResult>;
hostFetch?(input: string | URL, init?: HostFetchInit): Promise<Response>;
```

Wire (`host-api-wire.ts`, replacing `WireApiKeyLease` `:2003-2015`; the generated schema
under `$defs.methods["ave/host/resolveApiKey"].result`):

```jsonc
// success, lease — no key anywhere in the frame
{ "handleId": "lease_…", "ok": true, "exposure": "lease", "vendor": "azure-openai", "baseUrl": "https://…" }
// success, raw — key crosses, once, on this reply only
{ "handleId": "raw_…", "ok": true, "exposure": "raw", "vendor": "openai", "key": "sk-…" }
// denied — nothing to release, so no handleId
{ "ok": false, "reason": "audience-not-allowlisted" }
```

Rules:

- **One identifier.** The JS `leaseId`, the wire `handleId` and the subscription id in
  the host's `SubscriptionLedger` are the same string: `lease_` plus 128 bits of
  host randomness, minted per successful resolve. There is no second mapping table.
  Release is the existing `notifications/ave/subscription/release { subscriptionId }`;
  host-side closure is `notifications/ave/subscription/closed { subscriptionId,
  reason }` (§3.4); a raw result is registered the same way (prefix `raw_`) so its
  release is auditable, and a `raw_` id in `init.auth.lease` is `lease-unavailable`.
  In-process (while that arm exists, §9.3) the same registry issues the same ids; the
  id is bound to the plugin's host-api incarnation (`host-api-factory.ts:498-517`), not
  to the transport.
- **Release and closure semantics.** `release()` is a one-way notification, as today
  (`host-api-dispatcher.ts:2052-2056` closes the ledger entry with reason `disposed` and
  sends no reply; `subscription-ledger.ts:131-137` returns `false` for an unknown id).
  The Promise resolves when the stub's local state is terminal and the frame is
  written; a second call, or a call for an id the host no longer knows, is harmless
  and is counted in the bounded diagnostics of §3.6, never an error — no thrown code
  exists for release. Host closure is ordered on the stream: the resolve reply is
  written **before** any `closed` notification for that id. Registering the entry
  before the reply does not give that by itself — the dispatcher builds the reply only
  after the handler returns (`host-api-dispatcher.ts:2022-2028`), and a ledger close
  runs its teardown at once (`subscription-ledger.ts:131-135`) — so the ordering is a
  requirement the synchronous commit-and-reply section of §4.1.2 enforces: a
  revocation that lands between registration and the reply write is queued behind the
  reply, never sent ahead of it. Because the stub adopts the handle only in the
  continuation after `await`ing the reply (`host-api-child.ts:352-377`; the ledger's own
  comment names this race, `subscription-ledger.ts:99-106`), the reference runtime keeps
  a **pending-closure map** keyed by subscription id, bounded to the registration cap
  of §7.4: a `closed` that arrives before adoption is parked, and adoption drains it
  into the new entry, so the lease is created already closed and `onClosed` listeners
  are invoked on registration. Multiple listeners are allowed; each is invoked once.
- **Conditional result axis.** The denied wire result carries no `handleId`, and the
  dispatcher's result check today rejects any `handle`-axis result that is not
  `{ handleId }` (`host-api-dispatcher.ts:2165-2169`). `HOSTAPI_PATH_CONTRACTS` gains
  the result axis value `handle-or-denied` for `resolveApiKey`: a result with
  `ok: true` must be a handle, a result with `ok: false` must not carry one, anything
  else is `result-marshalling-rejected`; the schema generator emits the union. A
  fabricated denial handle is not retained to fit the old check.
- **`init.auth`** joins `WIRE_REQUEST_INIT_FIELDS` (`host-api-wire.ts:1701-1735`) and
  `WireRequestInit` (`:1721`) as `auth?: { readonly lease: string }`. The encoder keeps
  rejecting every other enumerable init field (`:1869-1882`); the decoder, the
  dispatcher's runtime validation and the generated schema accept exactly `{ lease:
  string }`. Malformed forms (`auth: {}`, `auth: { lease: 1 }`, `auth: { token }`,
  `auth` with extra keys) are `credential-conflict` before any host work.
- **One enforcement path (decision 12).** The dispatcher does **not** strip `auth`: it
  validates the wire shape and forwards the decoded `HostFetchInit`, `auth` included,
  to the factory's `hostFetch` — the same function the in-process arm calls directly
  (`host-api-dispatcher.ts:857-861` already forwards the decoded init to
  `hostApi.hostFetch`). The factory is the single place where the selector becomes
  authority: it snapshots and validates the selector (§4.1.8), resolves it in the
  registry, and hands `runHostFetchHops` a host-internal **credential-use context**
  `{ assertLive(stage), headersFor(url, hop) }` beside the existing
  `injectSessionCookie` callback (`host-fetch-guard.ts:376-382`), which is how the hop
  loop rechecks liveness and injects per hop (§4.1.2-4.1.3). The transport
  `RequestInit` is constructed from the snapshot **without** `auth`, so the spread at
  `host-fetch-guard.ts:394-406` never carries a lease id and no auth metadata reaches
  `net.fetch`. Injection is never duplicated in the dispatcher; the acceptance test
  runs child → dispatcher → factory → guard → controlled transport and asserts the lease
  reached the gate and the network init carried neither `auth` nor the id.
- **Ownership.** A lease id is accepted only from the plugin incarnation it was minted
  for. Another plugin's id, an id from a previous incarnation of the same plugin
  (restart, reload, update), a released id, a raw registration and an unknown id are
  all `lease-unavailable` (§3.6). Kinds are not confusable: a worker handle id, an audio
  capture id or a floating-panel id in `init.auth.lease` is `lease-unavailable` too.
- **Raw is copied, not leased.** `ApiKeyRaw.key` is bytes in the plugin's memory;
  `release()` and revocation cannot recall them, and the document says so rather than
  offering a `bearer()` thunk that pretends otherwise. What the host can still do after
  a raw grant is stop issuing (§4.1.6) and rotate the secret.
- The child stub is the host-shipped reference runtime, so a JS plugin sees the public
  types above and no private shape; `meeting`'s private `ApiKeyHandle` cast
  (`plugins/meeting/source/src/hostPlugin.ts:1853-1857`) and `local-indexer`'s private
  resolver cast and result wrapper that copies `out.bearer`
  (`plugins/local-indexer/source/src/hostPlugin.ts:939-1003`, the copy at `:998-1002`)
  are replaced by the vendored `ApiKeyLease` type when those plugins are rebuilt (§9.1);
  the bearer-shaped parameters its channel credential functions ignore (`:1757-1762`
  return the broker token) are simply deleted.

#### 4.1.2 Lifetime: the host-owned lease registry (decision 13)

```
resolve request ──► issuing ──► active ──► released   (plugin: release(), or its disposer)
                       │           └─────► revoked    (host withdrawal while the incarnation lives)
                       └─► denied (ok:false; reservation returned, nothing registered)
                    incarnation end / pipe close ──► every registration of that incarnation: peer-gone
```

- **States.** `issuing` begins **before the first asynchronous authority lookup** and
  ends at the commit described next; a revocation, an invalidating change or the
  caller's `signal` during it yields a denial (`"aborted"` for the signal, the existing
  merged-signal path `resolve-api-key.ts:203-211`; `"stale-authorization"` for a
  snapshot change) and registers nothing. `active` is the only state in which
  `hostFetch` attaches the credential. `released` and `revoked` are terminal; a second
  `release()` is a no-op; use after either is `lease-unavailable`. `peer-gone` is
  reserved for the end of the incarnation or connection and `revoked` for a host
  withdrawal while the incarnation survives; the two are never confused. There is **no
  wall-clock expiry**: the lease is bound to events, not to time, and an idle timer
  would add a race (a long `meeting` session, a `local-indexer` scan) without adding a
  guarantee; the bound that matters is the registration cap of §7.4.
- **Issuance is linearised (decision 26).** The invariant: *every successful issuance
  corresponds to an authorization-and-configuration snapshot that is still current at
  the moment the registration becomes visible.* Concretely, in order: (1) synchronously
  at entry, resolve the key identity — the normalized vendor from `opts.vendor` or the
  active provider (`resolve-api-key.ts:216-239`) and the key name it selects — and
  capture the snapshot `S = { incarnationId, permissionEpoch, secretGeneration(key),
  providerConfigRevision }`; (2) synchronously **reserve** one registration slot for
  the incarnation (the 33rd reservation returns `"lease-limit"` at once, so 64
  concurrent resolves cannot all observe 31 and exceed the cap); (3) run the secret
  gate (`runSecretGate`, `:288-296`), read the secret and, for a source that needs one,
  the endpoint (`:313-336`); (4) in one synchronous section with no await between
  compare and insert, compare `S` with the current counters — which, by the Record
  rule below, move synchronously with every *visible* transition, so equality proves
  that the values read at (3) are still the ones the host itself would use — and
  either register the record and send the reply, or return the reservation and answer
  `"stale-authorization"`. There is no re-read into the new epoch: a change during
  issuance is a denial, and the caller decides whether to resolve again. Raw success
  goes through the same fence; the key is copied into the reply only after the commit.
- **Record.** `{ leaseId, pluginId, incarnationId, permissionEpoch, secretGeneration,
  providerConfigRevision, source: "host-secret" | "plugin-own", vendor, purpose,
  scheme, audience, activeUses: Set<AbortController> }`. `permissionEpoch` is the count
  of `revokePluginAccess` calls for the plugin (`permission-manager.ts:817-829` aborts
  and replaces the controller today; the epoch makes that observable to the registry
  even when no controller existed). `secretGeneration(key)` and
  `providerConfigRevision` are counters over the **authorization state visible to the
  resolver**, not over disk writes. The resolver reads live store state: `get("llm")`
  clones the in-memory object (`src/data/settings-store.ts:1110-1112`) that `set`, the
  `llm` patch and `replaceLlm` mutate **before** their `commit()` resolves
  (`:1114-1116`, `:1175-1181`, `:1670-1677`), and a failed save restores the last saved
  settings in memory (`:1978-1993`; `this.saved` is that state, `:1021-1024`);
  `resolve-api-key.ts:216-239` and `:330-334` read the active provider and the Azure
  endpoint through that path. Secret readability changes outside successful writes
  too: a preset invalidation marks its keys before its own commit
  (`settings-store.ts:1555-1559`), a failed re-entry withholds the key (`:1720-1728`),
  and `secretReadable` consults the invalidating, restoring, withheld and re-entered
  bookkeeping (`:1761-1768`). Therefore `providerConfigRevision` is incremented,
  synchronously in the same job as the mutation, at **every transition of the visible
  provider configuration**: the in-memory assignment by `set`, the `llm` patch or
  `replaceLlm` of the active provider, a per-vendor endpoint or a provider preset, and
  the rollback in `drain`; a save that succeeds changes nothing visible and increments
  nothing. `secretGeneration(key)` is incremented, likewise synchronously, at every
  change of the bookkeeping `secretReadable(key)` consults and at the completion of a
  `secretStore` write or delete of the key (`:1719`, `:1751-1754`, and each key a bulk
  or plugin-secret removal deletes), because that completion is when the value
  `getSecret` returns changes; a secret write that fails without touching readability
  leaves the value, and so the generation, unchanged. The counters over-revoke by
  design: a lease bound to A is closed when B becomes visible even if B is rolled back
  a moment later, and the caller resolves again; under-revocation is the defect, and
  no counter may lag a visible transition by an await. Both counters are host-owned
  hooks on the store's mutation and rollback points — a generic "the visible secret /
  configuration state changed" signal, which the store does not have today and which
  the registry subscribes to; no plugin- or vendor-specific branch. The alternative, a
  committed-only view for lease issuance and use, is rejected: the host's own adapters
  and the resolver read the live state, so a lease bound to the committed value would
  diverge from the host's own egress during a pending save, and the store has no
  committed getter to bind to. **Acceptance (slice D, §9.6)** drives the real
  `SettingsStore` with a controllable persistence barrier under `saveSettings`
  (`:1986`), never a counter incremented by the test: (a) endpoint A committed, a write
  exposes B and its save is held, a lease resolved meanwhile binds B, the save fails
  and memory returns to A — the B-bound lease is closed `revoked` and its next use is
  `lease-unavailable` with no request sent; (b) the same with the save succeeding — the
  B-bound lease stays live and a lease issued before the write was closed when B became
  visible; (c) a preset invalidation and a failed re-entry withhold a key before,
  during and after an issuance — issuance during it is `stale-authorization`, the
  earlier lease is closed, and no use sends the withheld key.
- **Revocation events**, each ending every registration it matches with
  `notifications/ave/subscription/closed { reason: "revoked" }` and an audit line: a
  `permissionEpoch` change for the plugin; a `secretGeneration` change of the resolved
  key (write, rotation, removal, withholding); a `providerConfigRevision` change (active
  vendor, per-vendor endpoint, preset); an update, disable or uninstall of the plugin.
  The end of the host-api incarnation (dispose, `host-api-factory.ts:498-517`, which is
  also what a `config.set` restart and a crash reach) ends every registration with
  `peer-gone`. Today nothing closes an issued ledger entry on any of these: the
  dispatcher opens and tears down the entry (`host-api-dispatcher.ts:795-832`), the
  factory passes the permission revoke accessor into the resolver
  (`host-api-factory.ts:813-816`) where it aborts a resolve in flight and, through the
  listener `makeSuccess` attaches (`resolve-api-key.ts:157-186`), clears the key the
  returned closure captured — but it cannot recall bytes already copied over the wire
  nor close the dispatcher's ledger entry — and `subscription/closed` reaches the child
  at `plugin-child-runtime.ts:693-696` only when sent. The registry is that missing edge, and it is one code path for both arms,
  owned by the plugin-runtime boot step (the factory's owner), not by the dispatcher.
- **Epoch fencing at use.** Every use compares the record's `incarnationId`,
  `permissionEpoch`, `secretGeneration` and `providerConfigRevision` with the current
  values **after every await** in the hop loop (permission check, cookie preparation
  `host-fetch-guard.ts:376-382`, SSRF and DNS decision, redirect decision) and
  immediately before header injection. A stale value is `lease-unavailable` with
  `stage: "after-await"`, and the request is not sent.
- **In-flight sends.** Each `hostFetch` use registers an `AbortController` in
  `activeUses`. Revocation and `release()` abort every active use: a request whose
  bytes have not left is not sent; a request already sent has its transport aborted
  and its response body dropped unread. **What cannot be promised:** bytes already on
  the wire are at the provider; the document does not claim recall. Concurrent uses of
  one lease are allowed and independent; `local-indexer`'s per-request pattern never
  has more than one.
- **Cancellation is not lifetime.** `ResolveApiKeyOptions.signal` cancels the resolve
  request by request id (§3.5) and nothing else: after the reply the child removes its
  listener (`plugin-child-runtime.ts:264-281`) and that is the documented semantic, not
  a gap. `HostFetchInit.signal` cancels that one use. The lease ends only by
  `release()` or a host event. `meeting`'s existing release-on-session-abort
  (`plugins/meeting/source/src/hostPlugin.ts:1877-1892`) is the intended caller pattern
  and survives the migration unchanged in shape.
- **Bounded.** ≤ 32 registrations per incarnation, leases and raw registrations
  counted together, reserved at issuance entry (`lease-limit` on the 33rd); each
  registration holds one ledger entry and a listener list bounded by the plugin's own
  code; the registry is a map keyed by incarnation and is dropped whole at incarnation
  end, so restart churn cannot grow it.

#### 4.1.3 Audience: what a lease may be attached to (decision 14)

The plugin's `networkAccess.allowedDomains` says where the plugin may send *its own*
traffic. It does not say where the *host's* credential may go; that is bound at
resolve time by the host, from the credential's own source, and is intersected with the
allow-list:

The resolver normalizes the public vendor names to the host's provider records —
`anthropic → claude`, `azure-openai → azure-foundry`, `vertex → vertex-ai`
(`resolve-api-key.ts:122-129`) — and an omitted `vendor` means the **active host
provider**, whatever it is (`:216-239`), so the table is keyed by the normalized source
record, not by the request union, and every record the host can hold has a row
(`grants.ts:33-39` names the five key slots):

| Normalized source (key slot) | Lease support in 0.12.0 | Scheme (header the host injects) | Audience origin |
|---|---|---|---|
| `openai` (`llm.apiKey.openai`) | supported | `Authorization: Bearer <key>` | the origin the host's own OpenAI adapter uses: the configured OpenAI base URL if the host has one (`adapter.ts:671-675`), else `https://api.openai.com` |
| `azure-foundry` (`llm.apiKey.azure-foundry`) | supported | `api-key: <key>` | the origin of the host's configured Azure base URL (`resolve-api-key.ts:326-336`); with no configured base URL the resolve is denied `"endpoint-unavailable"` |
| `claude` (`llm.apiKey.claude`) | supported | `x-api-key: <key>` (plus the host's `anthropic-version` header) | the configured Anthropic base URL's origin if any, else `https://api.anthropic.com` |
| `gemini` (`llm.apiKey.gemini`) | **denied**, `"vendor-unsupported"` | — | deferred: no official consumer asks for it; adding it later is an additive row (`x-goog-api-key`) |
| `vertex-ai` (`llm.apiKey.vertex-ai`) | **denied**, `"vendor-unsupported"` | — | the host's Vertex provider authenticates with a project, a location and ADC/service-account credentials (`src/engine/llm/vercel/adapter.ts:737-757`); the stored string under this slot is not an access token, and a host token issuer with refresh and expiry does not exist. Deferred until one does; the lease never relabels a stored string as a token |
| plugin-own namespace shortcut (`resolve-api-key.ts:267-285`) | supported | by normalized vendor, as above | the plugin's whole allow-list: the plugin already holds this key (own-namespace `getSecret`), so the lease only saves it a header |

- **Endpoints.** The audience is *where the host itself sends this credential*: the
  host's provider configuration is the single source, and the resolver's `baseUrl`
  reports it for every supported source (today only for Azure, `:313-336`). A
  plugin-chosen endpoint never authorizes a host key: today that denial lives in the
  plugins' own helpers (`user-endpoint-with-host-key` is a resolver reason;
  `local-indexer` withholds the host key from an untrusted endpoint in
  `plugins/local-indexer/source/src/hostPlugin.ts:1176-1183`); under Lease it is
  structural, because the plugin does not choose where the credential goes. A host
  provider record whose endpoint the host has not configured and for which no default
  exists is `"endpoint-unavailable"`.
- The scheme is host-owned per source. A plugin cannot pick `api-key` for an OpenAI
  key or `Bearer` for Azure; `local-indexer`'s scheme selection
  (`plugins/local-indexer/source/src/hostPlugin.ts:1627-1628`, applied in
  `egressBroker.ts:238-245`) moves into the host with this table.
- Audience match is by **origin** (`https` only; host exact, case-folded; port
  default or explicit-equal). No path binding: Azure deployment paths and OpenAI
  endpoints vary under one origin and a path rule would bind nothing a credential does
  not already reach.
- **Private and loopback targets.** Beyond the https-only audience above, lease mode
  does not add a network rule of its own:
  the existing guard already admits a declared loopback host that resolves only to
  loopback and an allow-listed host that resolves only to private space when the
  plugin has opted into private networks (`host-fetch-guard.ts:178-212`, `:248-255`),
  and refuses everything else, link-local and metadata included. A host-secret lease
  reaches such a target only when it is the host's configured origin for that source
  **and** the plugin's independently reviewed network grant admits it — the corporate
  Azure private endpoint `meeting` describes (`plugins/meeting/source/src/hostPlugin.ts:1359-1364`)
  is exactly that case, and a blanket refusal was rejected because it would break it.
  Plain-HTTP loopback is never a lease audience (`https` only). No-lease plugin-owned
  traffic keeps the current policy unchanged.
- If the intersection of the audience with the plugin's allow-list is empty the
  resolve is denied (`audience-not-allowlisted`) so the plugin learns at issue time,
  not on its first fetch. A use whose URL is inside the allow-list but outside the
  audience is `lease-audience-denied`; the plugin's own request without `auth` to that
  URL is unaffected.
- **Redirects.** The hop loop already rechecks the network gate per hop
  (`host-fetch-guard.ts:438-453`). With a lease it also: (1) deletes every header in
  the closed `CREDENTIAL_HEADERS` list — `authorization`, `proxy-authorization`,
  `cookie`, `api-key`, `x-api-key`, `ocp-apim-subscription-key` — on **any** origin
  change, which extends the three-header list at `:475-478` that lets an `api-key`
  survive a cross-origin hop today; (2) rechecks lease liveness (§4.1.2); (3) if the
  new URL is in the audience, re-injects the credential; otherwise **refuses the
  redirect** with `lease-audience-denied` `{ hop }` — never a silent downgrade to an
  unauthenticated request, because a provider that redirected an authenticated call
  elsewhere is exactly the case the audience exists for. Same-origin redirects keep the
  injected header and re-run steps 2-3. A no-lease request's plugin-owned
  `api-key`/`x-api-key` is stripped on origin change by the same list, closing the
  current gap for plugin-key mode too; `Authorization` was already stripped.

#### 4.1.4 Conflicts: caller headers, cookies and a lease (decision 15)

- **No lease:** the plugin's own headers pass as today. `lyra-mail`'s OAuth `Bearer`
  (official repository at `6a4d3b3`, `plugins/lyra-mail/source/src/email/graphClient.ts:82`,
  `src/calendar/calendarClient.ts:35`, through `src/http/runtime-http.ts:102-107`),
  `orion-api`'s cookie-authenticated calls (`ave-plugin-orion` at `2f17388`,
  `src/hostTransport.ts:45-52`), `meeting` and `local-indexer` in plugin-owned-key mode
  and `meeting`'s unauthenticated FFmpeg download
  (`plugins/meeting/source/src/ffmpegRuntime.ts:371`) are all no-lease requests and
  keep working; a blanket ban on caller `Authorization` was rejected for that reason.
- **Lease present:** any caller header whose lower-cased name is in `CREDENTIAL_HEADERS`
  — **`cookie` included** — in any casing and including duplicates, is
  `credential-conflict` before any host work. The host is the only writer of any
  credential header on a leased request; a host-injected partition cookie is the
  separately gated composition below, not a caller header.
- **Lease + partition cookie:** allowed only when both grants independently cover the
  URL — the plugin declares `networkAccess.authCookiePartition` and the cookie injector
  is bound for it (`host-api-factory.ts:1056-1085`), **and** the URL is in the lease
  audience. Order per hop: cookie prepared first (async,
  `host-fetch-guard.ts:376-382`, `:481-485`), then lease liveness rechecked, then the
  credential injected. Rejecting the combination outright was considered and not
  chosen: a corporate Azure endpoint behind a cookie-authenticated gateway is a real
  deployment, and two independently reviewed grants are a stronger statement than a
  prohibition.
- **The complete Cookie matrix** (decision 15). Today the factory refuses a caller
  `Cookie` only for a vault-declaring plugin and passes it for every other plugin
  (`host-api-factory.ts:1048-1076`); that no-lease behaviour is kept:

  | Request | Partition declared | Caller `Cookie` | Host-injected cookie | Result |
  |---|---|---|---|---|
  | no lease | no | any | none | passes, as today |
  | no lease | yes | present | — | refused, as today (`:1056-1076`) |
  | no lease | yes | absent | injected per hop | passes, as today |
  | lease | no | present | none | `credential-conflict` |
  | lease | no | absent | none | credential injected |
  | lease | yes | present | — | `credential-conflict` |
  | lease | yes | absent | injected, then lease re-checked and injected | both attached |

#### 4.1.5 Errors: resolver results versus thrown codes

`resolveApiKey` reports business outcomes as `ok: false` (§4.1.1) so a plugin can show
"configure a key" versus "not allowed" without catching; the four thrown codes of §3.6
are protocol-level and are not retried by a correct caller except `rate-limited`. A
denied or revoked lease must never make a plugin fall back to `getSecret`, to a raw
resolve or to a direct socket; that is the catch-and-retry fallback AGENTS.md forbids,
and the acceptance tests of §9.1 assert its absence in every official caller.

#### 4.1.6 Raw exposure, `getSecret` and the scope of the guarantee (decisions 10 and 17)

- **Scope.** `secrets:raw-api-key` gates one thing: `resolveApiKey({ exposure: "raw" })`.
  The guarantee of decision 2 is therefore *"a host provider key crosses through
  `resolveApiKey` only under this capability"*. It is not a system-wide "no raw key
  ever crosses": the explicit exceptions are the inventory at the top of §4.1.
- **Entitlement to *use* versus permission to *export* (decision 17).** `getSecret` and
  `resolveApiKey` share one gate: the resolver calls `runSecretGate`
  (`resolve-api-key.ts:288-296`) exactly as `getSecret` does
  (`host-api-factory.ts:829-860`), the gate calls `evaluateHostSecretGrant`
  (`secret-gate.ts:200-208`), and that evaluator denies a missing table row **before**
  it looks at provenance (`grants.ts:87-88`; the table's only rows are `meeting` and
  `local-indexer` over the LLM class, `:41-44`). Deleting those rows would therefore
  deny every host-key lease as `not-whitelisted` — so they are **not** deleted; an
  earlier revision of this section said they were, and that was wrong. Instead the
  gate gains an **operation** input, `"lease" | "export"`, with a generic rule by
  secret class: for a secret in the host-provider class (`llm.apiKey.*`, `:33-39`) the
  `export` operation is refused at tier 2 with reason `"provider-key-not-exportable"`,
  for every plugin, before any read; the `lease` operation proceeds through the
  unchanged tiers (namespace, allow-list, table row plus provenance, active vendor).
  `getSecret` is always `export`; `resolveApiKey` is `lease` for both exposures, and
  raw adds the capability and receipt gate below on top. No plugin-id branch is added
  and no tier is skipped. Consequences in the official plugins: `local-indexer`'s
  reader branches that reach the host key through `getSecret` when no handle is
  offered (`plugins/local-indexer/source/src/hostPlugin.ts:1190`, `:1202`, reaching
  `:1062`) would now be refused, so they are removed together with its plaintext
  availability check (`.find((h) => h.bearer().length > 0)`, `:2522`); availability is
  `ok: true` from a resolve, and "configured" is answered by the resolver's
  `ok: false` reason. Own-namespace `getSecret` (plugin-own keys) is untouched;
  `lyra-mail`'s token store is encrypted plugin storage (`writeEncrypted`,
  `plugins/lyra-mail/source/src/auth/token-store.ts:73-77`), a different category that
  this rule does not touch. The table itself is a plugin-id table in the host;
  replacing it with a manifest-declared, provenance-gated entitlement is a separate
  authority change and is not part of Lease.
- **Entitlement and provenance are unchanged for both exposures.** Whether the result is
  a lease or raw bytes, the host-secret evaluator still requires the table row, the
  official source identity, a non-tree install, the running manifest hash and a pinned
  artifact with a verified receipt (`grants.ts:87-111`), and `runSecretGate` still
  applies namespace, allow-list, provenance and active-vendor rules
  (`secret-gate.ts:190-215`). The capability is an **additional** gate for raw, not a
  new way for any plugin to obtain a host key: a custom, tree or forged install
  declaring the capability is denied by provenance before the secret is read.
  Acceptance: one genuinely pinned official `meeting` or `local-indexer` artifact
  obtains a host-key lease, is refused that key through `getSecret`, and is refused
  raw bytes without current consent; a forged, custom or tree install fails before
  the secret read; the same artifact's own-namespace reads succeed.
- **Consent evidence for raw.** The capability id joins `KNOWN_CAPABILITY_IDS`
  (`src/plugins/capabilities.ts:37-49`; today only `external-auth-consumer` and
  `host:overlay` are enforced and every other string is inert, `:17-35`). Because an
  inert string in an older artifact was shown to the user as generic text
  (`PackageSheet.tsx:78-85`), unchanged manifest bytes are not evidence that the user
  approved its new meaning. Rule: the install receipt records the app version that
  reviewed the authority; raw issuance requires that version ≥ X and the capability in
  the reviewed authority; otherwise `raw-exposure-denied` and a plugin-status entry
  asking for re-review through the update flow. Removing the capability in an update
  stops future issuance; copies already exported are outside host control (§4.1.1).
  Managed required installs: the policy file is the consent (`boot-installs/run.ts:4-8`),
  recorded with the same version field. Local development and direct installs: the
  review UI shows the capability and consent is recorded the same way, but a host key
  is still denied to a tree install by provenance, so raw there can only return a
  plugin-own key. Headless (no UI): no consent can be recorded, so raw is denied unless
  a policy install carries it.
- **Ordering.** Every capability, consent, provenance and entitlement denial of raw
  happens before the secret is read; the one denial that can follow the read is the
  issuance fence's `stale-authorization` (§4.1.2), which copies nothing into the reply.

#### 4.1.7 Consumers at the reviewed revisions

| Plugin | Today | Under Lease |
|---|---|---|
| `meeting` (official repository at `6a4d3b3`) | out of process (`out-of-process-plugins.ts:856-858`); two Bearer-authenticated STT requests in the Whisper adapter, chunk STT `plugins/meeting/source/src/adapters/openaiWhisperSttProvider.ts:169-198` (live chunks of at most 6 s, `:176-180`) and file STT `:270-309`, built from `handle.bearer()` (`src/hostPlugin.ts:1911`); `sttFetch` forwards `init` unchanged to `hostFetch` (`:1359-1380`); release on session abort (`:1877-1892`); private resolver cast (`:1853-1857`); **two upload routes**: the direct `meeting_upload_file` accepts up to 25 MiB (`:191`, `:4112-4136`) and passes the whole decoded file to `pipeline.ingestAudioFile` (`:4155-4159`), while the staged route accepts up to 500 MiB (`:198`, `:435-436`), segments through FFmpeg into 30 s 16 kHz mono PCM (`:201`, `:672-685`, `:2431-2436`) and throws on a segment over the cap (`:2451-2452`); the FFmpeg download is a no-auth fetch (`src/ffmpegRuntime.ts:424-433`) | one lease per STT session (`purpose: "stt"`); the adapter sends `auth: { lease }` and no `Authorization`; plugin-owned-key mode keeps its own header on no-lease requests; FFmpeg download stays a no-lease request; the cast is replaced by `ApiKeyLease`; `FormData` bodies, the serialized-multipart cap and the routing of both upload entry points are the prerequisites of §8 |
| `local-indexer` (official repository at `6a4d3b3`) | out of process; the Python worker holds a per-session broker token only (`x-ave-egress-token`, `src/workerClient.ts:472-474`; `worker/embedding_client.py:159-167`, `:264`); the JS egress broker in the plugin child resolves the channel, injects the provider header (`src/egressBroker.ts:393-399`) and relays through `egressUpstreamFetch`, which is `hostApi.hostFetch` (`src/hostPlugin.ts:1572-1596`, wired at `:1698-1703`); the channel callbacks pass `null` handles so the reader branches reach the host key through `getSecret` (`:1629-1645` → `:1190`, `:1202` → `:1062`) | **broker with host lease attachment (decision 10)**: the broker keeps the worker token path and the Python credential routing unchanged (the worker's retry predicate does change, below); for each upstream request it resolves a lease (`purpose` `embedding` or `vision`, `vendor` from the channel), relays with `auth: { lease }` and no `api-key`/`Authorization`, awaits the **complete** buffered upstream body (the relay is already buffered, `:402-409`), then releases in `finally`; the worker's abort is linked to the use's `signal`. Plugin-owned-key mode (`readApiKeySource() !== "host"`) keeps its own header on a no-lease request. A maintained per-channel lease was rejected for the first release: it needs refresh/revoke state in the broker and a stale scan handle would be reused by query-time search (`worker/local_indexer_worker.py:573-587`); per-request costs one resolve and one release notification per upstream call, priced in §7.4, and is revisited only on measured evidence. There is no raw exception: a Python SDK on the worker side never held the shared key on the production path and does not need to. Error translation is below |
| `lyra-mail` | obtains its own OAuth token and sends it through the host-bound transport (`:82`, `:35`, `runtime-http.ts:102-107`); `getSecret` appears only as an interface member (`src/hostPlugin.ts:84`) | no-lease requests; unchanged |
| `orion-api` (`2f17388`) | bound transport (`src/hostTransport.ts:45-52`); cookie/refresh export as in §4.1 | unchanged by Lease; rebuilt and republished for `hostProtocol: "2"` |
| `git` (`d71fb95`) | in process; direct `fetch` with cookie and GitHub auth (`src/hostPlugin.ts:797-806`) and with plugin LLM keys (`:920-932`); `~` expansion of `dataDirectory` (`:824-834`) written under (`:1140`) | rebuilt and republished for `hostProtocol: "2"` under the generic rule; the direct-fetch and external-directory migrations are Admission prerequisites (§9.1, §9.2 item 7), not Lease work |
| `vega-helper`, `hello-world`, `templates/plugin` | no credential surface | republished for `hostProtocol: "2"` (vega-helper only if it is not already revoked by the alerts release, §9.5) |

**Broker and worker error translation for `local-indexer`.** Today every thrown upstream
error becomes HTTP 504 so the worker's tenacity retry and BM25-only fallback engage
(`src/egressBroker.ts:410-418`), and the worker retries broad `APIError` classes
(`worker/embedding_client.py:471-476`, loop at `:354`). With Lease the broker maps:
`lease-unavailable`, `lease-audience-denied`, `credential-conflict`,
`effect-boundary-denied` and `ok: false` resolves → **403** with body
`{ "error": "egress-denied", "reason": <code>, "terminal": true }`; `rate-limited` →
**429** with `Retry-After` from `retryAfterMs`; a cancelled use → **499**, terminal;
transport failure → **502**; upstream HTTP statuses pass through as today. The worker's
retry predicate becomes status-based: retry only 429 (honouring `Retry-After`, bounded by
the existing tenacity configuration) and 502/503/504; 403 and 499 are terminal and
produce one observable `indexer.egress.denied` event before the existing lexical-only
degradation (`worker/local_indexer.py:491-531`) takes over. Neither side ever reacquires
a key or opens a direct connection in response.

#### 4.1.8 In-process inputs: snapshot before any await

While the in-process arm exists (§9.3) the factory receives live plugin objects. It
already reads the HTTP verb exactly once so a getter cannot change it after
authorisation (`host-api-factory.ts:940-951`). The Lease change snapshots `init.auth.lease`,
the URL, the credential-relevant headers and `init.signal` into host-owned primitives
before the first await, validates them there (a malformed selector is
`credential-conflict` here exactly as on the wire, §3.6), resolves the selector into
the credential-use context of §4.1.1 and uses only the snapshot through the hop loop.
The child arm reaches this same code through the dispatcher's forwarded
`HostFetchInit`; wire JSON validation is an earlier, additional check, not a
replacement. The acceptance tests mutate getters during awaits on the in-process path
and assert both arms produce identical decisions for the same inputs.

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
  $defs.methods["ave/host/startAudioCapture"].events    (subscription payloads)
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
A member that registers a handler or returns a handle also carries `.events`: the
payload schema of the `notifications/ave/subscription` frames delivered for it (worker
output, audio frames, floating-panel events, config changes, host events, plugin
lifecycle), generated from the same types the host encodes. Without it a plugin in
another language has no machine-readable shape for what its subscriptions deliver, and
a payload change would pass the schema gate unnoticed.
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

**Status at `f1a8d191e` and what Lease adds (decisions 18-19).** The generator exists
(`scripts/generate-plugin-host-protocol-schema.ts`; `check:plugin-host-protocol-schema`
in `build`, `package.json:47`, `:60-61`) and `schemas/plugin-host-protocol/1/protocol.schema.json`
is committed. Three facts bind the Lease step:

- **Version in the bytes.** `$id` and the metadata carry the app version
  (`scripts/lib/plugin-host-protocol-schema.ts:78-79`, `:543-546`) and the check
  byte-compares (`generate-plugin-host-protocol-schema.ts:47-50`). The release helper
  regenerates after the bump (`scripts/release.mjs:105-112`), but a metadata-only
  release PR does not run it. So the schema is regenerated **on the final release
  tree at the final version** — slice E of §9.6 owns this — and the v0.11.0 release
  (PR #2559) is coordinated the same way rather than assumed to carry valid bytes after
  a rebase or bump.
- **Generation over the served set.** The generator refuses more than one served
  version (`plugin-host-protocol-schema.ts:317-324`) because it reads one set of sources.
  Under decision 9 the served set is a singleton at every release, so this is an
  invariant the generator asserts, not a blocker. It is nonetheless rewritten to
  iterate `HOST_PROTOCOL_VERSIONS_SERVED` and to write
  `schemas/plugin-host-protocol/<v>/protocol.schema.json` per served version, so that a
  future retention decision is a sources question and not a generator rewrite. Files
  of versions no longer served (`.../1/` after X) stay in the tree, byte-frozen, and
  the parity test asserts they are untouched; their presence does not mean the app
  serves `1`.
- **The web mirror has an owner.** No `web/public/schemas/` exists at `f1a8d191e`; the
  generator writes only its canonical path (`generate-plugin-host-protocol-schema.ts:33-38`).
  Two copies of one protocol version are never byte-equal across app releases, even
  when no member changed, because the generator embeds the app version in `$id` and in
  the description (`plugin-host-protocol-schema.ts:325-326`, `:541-547`); the rules
  below are written for that fact, so no historical copy is ever compared with the
  current canonical file. The mirror is delivered in two named actions, because the
  site deploys on every `web/**` merge and a tag is not a deployment event, and it is
  described by one manifest, `web/public/schemas/plugin-host-protocol/mirror.json`:
  one entry per copy, `{ protocol, appVersion, sha256, generatedFrom: <commit>,
  publishedTag: <tag> | null }`, and one `alias` per protocol version naming a
  published entry. **(E1, the pre-tag release PR)** `scripts/release.mjs` regenerates
  the schema after the bump, copies it to
  `web/public/schemas/plugin-host-protocol/<v>/v<app>/protocol.schema.json` and adds
  the entry with the copy's sha256, the commit it was generated from and
  `publishedTag: null`; that copy may deploy before the tag exists, deliberately,
  because its `$id` is the tag URL and its bytes are the bytes the tag will carry. A
  copy is in one of three states, decided from the manifest and the current
  `package.json` version: **candidate** (unpublished, `appVersion` equal to the current
  version), **orphan** (unpublished and superseded by a later bump: the tag was never
  created or was abandoned; no `contract/sources.json` pins it, and it stays where it
  is, frozen with its recorded commit and hash) or **published** (`publishedTag` set).
  `check:plugin-host-protocol-mirror`, a `build`-chain script (which changes
  `src/__tests__/packaging-discipline-source.test.ts:627-663` in the same PR), holds
  three things: every copy, in every state, is byte-equal to its recorded sha256 —
  published and orphan copies are checked against their own record only; the
  candidate copy, and only it, is additionally byte-equal to the current canonical file
  of its protocol version; and each alias is byte-equal to the published copy the
  manifest names for it, never to a candidate or an orphan. Regenerating the canonical
  file therefore changes one copy at most, the candidate. A protocol change on `main`
  while a candidate is open (E1 merged, E2 not yet) is refused by the check unless the
  candidate is regenerated in the same change, which is the same release-window freeze
  §9.5 imposes; a protocol change that must ship after the freeze ships as the next
  candidate. **(E2, the post-publication runbook step)** the `web`-only PR merged after
  the app draft is published (§9.5 step 6) sets the entry's `publishedTag` and, in the
  same commit, sets the protocol's `alias` to the **newest published copy of that
  protocol** — the promoted copy if it is the newest, otherwise the alias stays where it
  is — which is the explicit promotion mechanism; a candidate's copy cannot become the
  alias by deploying. The check enforces the newest-published rule whether or not the
  protocol has an open candidate, so two promotions of one protocol commute in either
  order (`scripts/lib/plugin-host-protocol-mirror.mjs`). The v0.11.0 release does
  not carry the mirror; E1 adds its `1/v0.11.0` copy and entry from the frozen
  canonical `1/` file with `publishedTag: "v0.11.0"` and the `1` alias naming it, so
  the first published `$id` still resolves. **Acceptance (E1):** a fixture with
  `2/v0.12.0` published, `2/v0.12.1` orphaned (E1 merged, tag abandoned, superseded)
  and `2/v0.12.2` as the candidate: regeneration at 0.12.2 changes only the candidate
  copy, the published and orphan bytes are unchanged and the check passes; editing any
  byte of a published or orphan copy, or pointing an alias at the orphan or the
  candidate, fails it; the E2 fixture proves the alias moves only together with
  `publishedTag`.

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

**Which Publication prerequisites advance into Lease (decision 18).** Because the Lease
release is a protocol boundary, the artifacts a plugin repository holds must be refreshed
from tag X, and the tooling that holds them differs per repository:

| Repository | Tool | Ref rule | Inventory | CI trigger for the upstream check |
|---|---|---|---|---|
| official (`6a4d3b3`) | `tools/vendor.mjs sync contract --ref <ref> --app <checkout>` (`:15`, `:136`) | any ref string; `contract/sources.json` pins `v0.10.0` (`:4`) | `contract/` and `tools/vendor/` per `sources.json` | scheduled or manual (`.github/workflows/validate.yml:141`, `:157-165`) |
| `orion` (`2f17388`) | `tools/contract.mjs` | release tag required (`tools/contract.mjs:16`) | **exactly two files**: `public-contract.ts` and `plugin-manifest.schema.json` (`tools/contract.mjs:19-20`; the exact count is enforced at `:28-29`) | offline check on every run; upstream verify on every non-PR run (push, schedule, dispatch) and on a PR only when it changes `contract/` (`.github/workflows/ci.yml:70-85`) |
| `git` (`d71fb95`) | `tools/vendor.mjs` | release tag required (`:17-18`, `:107-109`) | per `sources.json` | PRs that touch `contract/**`, `tools/vendor.mjs` or the workflow, plus schedule and manual (`.github/workflows/contract-verify.yml:3-11`, `:26`) |

Advanced into Lease: the protocol schema becomes a vendored artifact **now** (the
`requires.hostProtocol: "2"` pin needs the bytes it pins), so `orion`'s two-file inventory
gains `schemas/plugin-host-protocol/2/protocol.schema.json` and `tools/contract.mjs`
changes to carry it. **Checker ownership runs one way:** the app owns the repository
checker (`src/marketplace/repository-check.ts`) and its schemas and types, so the
`sandbox` rules change in the app; the official repository vendors that checker as
`tools/vendor/marketplace-check.js` — built from the app entry at a recorded ref with a
recorded bun version (`tools/vendor/sources.json:2-9`; imported by `tools/check.mjs:23`;
rebuilt by `tools/vendor.mjs:77-91`) — and rebuilds it from tag X; its own
`tools/repo.mjs` is a local authority-extraction helper whose `AUTHORITY_FIELDS` (`:18`)
and `pluginAuthority` (`:164-172`) gain `sandbox` so the descriptor it writes copies the
block. The app never vendors anything from the official repository. Still deferred
to Publication: the TS protocol client (§6.2 row 3) and the validate CLI (§10.2); the
official plugins keep their per-plugin drift scripts until then. All three tools sync
only after tag X exists (§9.5): a candidate-ref sync is development evidence and
cannot be committed as the production pin.

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
  protocol". At `f1a8d191e` the field, the schema pattern, the hardening check
  (`src/plugins/runtime/manifest-validation.ts:71`, `:1348-1349`) and the load gate
  (`markIncompatibleHostProtocol`, `runtime/index.ts:2917-2944`, status kind
  `incompatible-host-protocol`, "not locally reinstall-fixable") are implemented; the
  catalog is **not** protocol-aware: `IndexVersion` and version choice know
  `minAppVersion` only (`src/marketplace/catalog/types.ts:62-86`; `aggregate.ts:84-93`).

**The cutover matrix (decision 9; X = 0.12.0, L = `"2"`).** Protocol eligibility in
the catalog advances into Lease: the descriptor and index carry `hostProtocol`, the
install plan holds the staged manifest's value to the descriptor's, and version choice
adds a `host_protocol` exclusion beside `min_app_version` (`aggregate.ts:85`), so a
sync on X does not offer an artifact X cannot run. Both refusals are pre-activation;
nothing is spawned and no factory runs.

**Catalog format 2 (decision 24).** New fields cannot go into the index older apps
read: the index root, every version object and the authority object are closed
(`schemas/marketplace/index.schema.json:25`, `:111-113`, `:133-134`;
`package.schema.json:352-391`), `schemaVersion` is the literal `1`
(`src/marketplace/catalog/types.ts:41`, `:102`), and the app validates a **whole
package, every version included**, before it becomes a candidate
(`src/marketplace/catalog/validate.ts:258-272`), so one version carrying
`hostProtocol` or `authority.sandbox` drops the package — its old versions with it —
from every ≤ 0.11 client (reproduced by the reviewers against the checked-in schemas
with Ajv). The retained old versions the matrix below relies on therefore need a
declared second surface, not a tolerant reader:

- `marketplace.json` (`schemaVersion: 1`) stays exactly what older apps parse. From X
  it is **frozen in content**: it lists only versions with no format-2 field, which is
  every version published before X, and no later version is ever added to it. This is
  the "old app keeps its old versions" promise made concrete, and the cutoff cost made
  visible: an old client never sees a post-X version.
- `marketplace.2.json` (`schemaVersion: 2`) is the same index with the format-2 fields
  (`hostProtocol` per version, `authority.sandbox`) and carries every version, old and
  new. Descriptors (`ave-package.json`) gain `schemaVersion: 2` the same way; the
  official generator (`tools/index.mjs` in the official repository, `INDEX_PATH` at
  `tools/repo.mjs:14`) writes both files from the same descriptors, and the app's
  vendored checker validates both.
- An app at X or later reads `marketplace.2.json` and nothing else
  (`INDEX_PATH`, `src/marketplace/sources/snapshot.ts:74`, becomes the format-2 name);
  a source that has no `marketplace.2.json` reaches `SOURCE_NOT_A_MARKETPLACE` on X
  the way a source with no index does today — a missing index alone is not the
  refusal: `snapshot.ts:297-305` falls through to the conventional-layout read, and
  `:252-253` refuses only when that finds no descriptor either; on X the legacy file
  is simply not one of the indexes that read consults — because a source that has not
  adopted format 2 cannot carry a protocol-2 artifact. That is a declared format
  choice, not a fallback: there is no read of the legacy file on X and no retry. An
  app ≤ 0.11 reads `marketplace.json` as it always has. The rule is the same for the
  official source, custom sources and managed sources; a custom source author who
  wants to serve both generations publishes both files, which the official tooling
  does for them.
- Direct installs (`ave-package.json` in a repository, marketplace design §8) follow
  the descriptor's `schemaVersion`: an old app refuses a `schemaVersion: 2` descriptor
  with a schema error before install, which is the matrix's "never activated" cell.

Acceptance: an actual 0.11 binary and a 0.10 binary sync the *published post-X
official source* and still offer and install their old versions, including
`local-indexer`'s pre-sandbox version; X reads `marketplace.2.json`, offers only
protocol-2 versions, and shows the new `local-indexer` sandbox authority in review.

| App | Installed artifact | Result |
|---|---|---|
| ≤ 0.11 | old (no declaration or `"1"`, `minAppVersion` ≤ app) | runs, unchanged |
| ≤ 0.11 | new (`"2"`, `minAppVersion` X) | never listed for it: the frozen `marketplace.json` an old app reads carries no format-2 version (decision 24), so `min_app_version` is not even consulted; a direct or offline install is refused at load with `incompatible-app-version` ("update the app"); on an app whose manifest schema predates the field the closed `requires` object refuses it with a schema error. Never activated |
| X | old, declares nothing | **refused before activation**, `incompatible-host-protocol`, plugin-status "update required", with the update path: the catalog's newest eligible version if the source publishes one, otherwise the plugin's own repository named in the receipt |
| X | old, declares `"1"` | same refusal; the message names the served version |
| X | new | runs |
| X → ≤ 0.11 downgrade | new | refused with `incompatible-app-version`; the downgraded app reads the frozen `marketplace.json` (decision 24), which still lists the pre-X versions, so the user reinstalls one. A downgrade does not reverse a plugin update and does not promise that plugin data written by the new version is readable by the old one; the receipt of the last compatible version is kept so the Doctor can name it |
| any | offline, update-disabled, custom source, direct install, local development, managed/policy | the same generic rule with no exception. A managed required install is brought to the source's candidate every boot (`boot-installs/run.ts:4-8`), so it self-heals once the managed source publishes a `"2"` artifact; until then it is refused like any other |

**Cost, stated.** Every installed code plugin that was built before X — third-party
and local development installs included — stops loading on X until it is rebuilt
against the contract at tag X and republished with `requires.hostProtocol: "2"` and
`requires.minAppVersion: X`. All eight reviewed sources omit the field today
(`plugins/{meeting,local-indexer,lyra-mail,vega-helper,hello-world}/source/plugin.json`,
`templates/plugin/plugin.json` in the official repository; `orion` `plugin.json:1864`;
`git` `plugin.json:1794`), so every one of them changes. The old `local-indexer`
artifact is additionally sandbox-less once the table is deleted (§2.2), which is a
second reason it cannot be admitted on X. **Gates that hold X (one timeline, §9.5):**
*before the tag* — the boundary is announced in the v0.11.0 release notes and on the
marketplace announcement channel (marketplace design §11) no less than fourteen days
before X is tagged, and **tested candidate** artifacts of every replacement have passed
the plugin acceptance of §9.1 against a packaged candidate app; *before the app draft
is published* — every replacement has been re-vendored from tag X and **published** as
an immutable artifact, and the plugin-status refusal and its update path have been
exercised in the packaged upgrade matrix against those published artifacts. Final
artifacts cannot precede the tag they are vendored from, so "published before the tag"
is never a requirement. **Applicability:** the replacement set is every code plugin
that is published and not revoked at X — `meeting`, `local-indexer`, `lyra-mail`,
`hello-world`, `orion`, `git`; `vega-helper` only if the alerts release has not
revoked it (§9.5); `templates/plugin` is not a published artifact and is instead
validated and updated in source at X. If any gate is unmet, the app draft is not
published; a tag that fails a plugin gate is superseded by a new tag, never rewritten;
the cutoff is not softened by an id exception, a method heuristic or a retained runtime.

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
| RPC surface abuse: a plugin hammers `ave/host/*` (log flood, storage churn, `triggerConversation` spam, subscription leak) | per-(plugin, method) token bucket in the dispatcher with a refusal code `rate-limited` (new, added to the closed set); cap on open subscriptions per plugin; the numbers are §7.4. `WIRE_BYTES_MAX` 16 MiB per decoded payload (`host-api-wire.ts:709`, `:810-815` at `f1a8d191e`), and a per-line cap in the frame decoder derived from it, whose overrun terminates the child (added with the newline framing, §9.4 item 1), so a child that never writes a newline cannot grow the host's buffer without bound. Plain-JSON values (tool results, `storage.readText`/`readJson` replies, arguments) have no payload cap of their own, so each side checks the frame against the same cap before it writes: an oversized reply becomes a `payload-too-large` error for the same id, and an oversized request rejects its caller with `payload-too-large`. The receiver's kill is reserved for a peer that skipped that check; `logEvent` key/prefix caps already exist for `getSecret` (`host-api-factory.ts:790-798`) and are generalised. At `f1a8d191e` every accepted request allocates an in-flight entry before its handler runs (`host-api-dispatcher.ts:2004-2032`), `adopt` checks ended and duplicate state but no ceiling (`subscription-ledger.ts:108-115`), and log notifications go straight to the sink (`host-api-dispatcher.ts:2044-2050`); no limit constant exists in the dispatcher. |
| Resource exhaustion: a plugin process consumes memory/CPU | Linux: a per-plugin cgroup from the workload resource controller once it is wired to the spawn path (`linux-workload-resource-controller.md:1-15` says it is not yet). macOS: `RLIMIT` in the wrapper is deferred (decision 7); Windows: Job Objects are not available through srt-win today. Until then the control is crash containment: the host survives, the plugin is marked degraded. |
| A plugin process outlives the host | child exits on stdin end (`plugin-child-main.ts:319-326`); `managed-child-processes.ts` tracks and kills process groups on app quit; a `process`-entry plugin must pass the stdin-close conformance check (§10). Residual: a hard host crash on Windows leaves the child to notice a closed pipe on its next write. |
| Arbitrary executable via `process` entry | a pinned release or archive artifact only (§2.1); a wrap whose published `confines` includes `process` (never srt-win); refused when the sandbox is off; the command must be inside the plugin root (Agent Plugins rule); no `PATH` search for a marketplace plugin. |
| Envelope widening via the manifest `sandbox` block | closed `hostDirectory` allow-list; `userChosenDirectory` requires a user-set absolute path; deny-floor piercing requires install-time approval (§2.2). |
| Windows: no process confinement | unchanged from `architecture.md:1018-1020`; admission does not depend on it (decision 3); a `process` entry is refused on Windows because srt-win is a wrap that does not confine processes (§2.2); the Doctor names the confinement each plugin runs under. |
| Confused deputy through the host's own credentials | `hostFetch` attaches a lease only to a URL that is inside the lease's host-derived **audience** (§4.1.3) *and* passes the plugin's own allow-list; the allow-list alone is not enough, because it says where the plugin may send its traffic, not where the host's key may go. The lease id is per plugin incarnation and is `lease-unavailable` on any other connection; every host-injected credential header is cleared on an origin change and re-authorised per hop, including Azure `api-key` (§4.1.3); a caller cannot supply a credential header on a leased request (§4.1.4). Matches the MCP security guidance on token passthrough ([MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)). |
| A lease outlives the decision that granted it | the host registry ends it on permission revocation, secret rotation, vendor or endpoint change, plugin update/disable/uninstall and incarnation end, with epoch fencing after every await and abort of active uses (§4.1.2). Request cancellation is a separate mechanism and never stands in for it. |
| A raw grant is inferred from an old manifest string | raw issuance requires the reviewed authority and the reviewing app version ≥ X in the receipt, plus the unchanged provenance evaluator (§4.1.6). |

### 7.4 Dispatcher budgets (decision 20)

Budgets live in the dispatcher (`HostApiDispatcher`), so they apply to the child arm;
the in-process arm's direct callers are **not** budgeted, which is one more reason its
removal condition (§9.3) matters and is stated rather than hidden. Service-level limits
stay where they are and keep returning results, not errors: alerts
(`src/alerts/service.ts:338-339`, `:357-358`), work proposals
(`host-api-factory.ts:1718-1723`) and the overlay trigger
(`src/boot/steps/plugin-runtime/trigger-gate.ts:408-411`) answer `rate_limited` as a
value; the transport `rate-limited` error of §3.6 is what the dispatcher raises when a
budget below is exhausted, before the handler runs.

| Budget | Value | Key | Over budget |
|---|---|---|---|
| requests, default per method | 50/s sustained, burst 200 | (plugin id, method) | `rate-limited`, `retryAfterMs` = time to next token |
| `hostFetch` | 20/s, burst 60 | (plugin id, method) | same |
| `resolveApiKey` | 10/s, burst 30 | (plugin id, method) | same |
| `emitEvent` (notification) | 50/s, burst 200 | (plugin id) | dropped, counted; one audit line per 60 s |
| `notifications/ave/log` and `logEvent` | 100/s, burst 500 | (plugin id) | dropped, counted; one audit line per 60 s |
| in-flight requests | 64 | plugin incarnation | `rate-limited`, `retryAfterMs` 100 |
| open subscriptions, total | 256 | plugin incarnation | `rate-limited` on the opening request |
| per kind | `onEvent` 64, `config.onChange` 16, `onPluginsChanged` 4, `spawnWorker` 8, `startAudioCapture` 2, `attachFloatingPanel` 1, leases 32 (§4.1.2, its own `lease-limit` result) | plugin incarnation | same |

Rules: buckets are keyed by plugin id and survive handle churn, so opening and
releasing handles cannot reset a quota; a restart is a host action and starts a new
incarnation with fresh buckets. The registration cap counts leases and raw
registrations together and is owned by the one host-level lease registry (§4.1.2),
which both loader arms share, so the in-process arm is inside *this* cap even though it
is outside the dispatcher's request buckets. Exempt from every budget, so that cleanup
works under saturation: `notifications/ave/subscription/release`,
`notifications/cancelled`, the replies to `ave/instance/stop` and
`ave/instance/shutdown`, and a lease `release()`. Memory: each in-flight entry and
each subscription entry is one map entry; the caps above bound both maps, and both
are dropped whole at incarnation end. Diagnostics: denial and rate-limit audits are
coalesced per `(plugin id, method, code)` with a first event and a 60 s summary
counter (§3.6), so a rejected-request flood costs one refusal per call and bounded
audit work; the entry carries the plugin id, the method and the bucket, not the
payload and not a caller-chosen id.

Workload basis, stated as inputs and not as measurements: `local-indexer` sends its
embedding batches with a configured **first-attempt** throttle of 400 RPM
(`plugins/local-indexer/source/src/localIndexerPlugin.ts:501`), about 7 upstream
requests per second at the broker before retries — the throttle sits outside the
worker's retry loop (`worker/embedding_client.py:209-213` versus `:354-376`), so 400
RPM is not an upper bound on broker requests, and it says nothing about the query-time
search and caption channels. Under per-request leases each broker request is one
`resolveApiKey`, one `hostFetch` and one release notification; at the nominal rate that
is inside the `hostFetch` budget with roughly 3× headroom and inside the
`resolveApiKey` budget with about 1.4×, which is why `resolveApiKey`'s burst is 30.
`meeting` sends one STT request per live chunk of at most 6 s
(`plugins/meeting/source/src/adapters/openaiWhisperSttProvider.ts:176-180`) and holds
one lease per session. Alerts bursts and worker stdout are notifications on the
host→plugin direction and are not budgeted here. The acceptance evidence of §9.1
measures the real resolve/fetch/release counts under a scan, a query burst, a caption
pass and a meeting, with SDK and tenacity retry amplification and body-drain occupancy
included; the numbers above are provisional inputs to that test and change only with
its evidence.

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
  storage in chunks. No chunked body streaming in protocol `1` or `2`.
- **Multipart bodies and the STT upload budget (decision 21; a Lease prerequisite for
  `meeting`).** At `f1a8d191e` a `FormData` body does not cross the wire: the child
  encodes `init` immediately (`host-api-child.ts:324-333`) and `asWireBody` accepts only
  a string, a byte array, an `ArrayBuffer` or a view (`host-api-wire.ts:1908-1918`), so
  `meeting`'s chunk and file STT requests, which build `FormData`
  (`plugins/meeting/source/src/adapters/openaiWhisperSttProvider.ts:169`, `:270`) and
  forward `init` unchanged (`src/hostPlugin.ts:1359-1380`), are refused with
  `argument-marshalling-rejected` before any network. "meeting already calls `hostFetch`"
  proves the route, not that out-of-process STT works. Decision: the **reference
  runtime's `hostFetch` stub serialises a `FormData` body to bytes** with a
  runtime-generated boundary and sets `Content-Type: multipart/form-data; boundary=…`
  (refusing to do so if the caller set a conflicting `Content-Type`), preserving field
  order, file names and per-part MIME types; the wire body contract stays bytes. This
  is generic runtime behaviour, not a plugin branch, and a `process`-entry plugin does
  the same itself. **Two caps, stated separately.** The authoritative cap is the
  wire's: 16 MiB for the **entire serialized multipart body** — file bytes, every
  non-file field (`model`, `language`, `prompt`, `timestamp_granularities[]`,
  `chunking_strategy`, `:169-198`, `:270-309`), file names, part headers and boundary
  framing — because `WIRE_BYTES_MAX` is a total decoded-byte limit
  (`host-api-wire.ts:709`, `:810-815`; the encoder rejects a 17 MiB body today), and
  it is **not** raised. The **15 MiB audio target** is `meeting`'s derived budget under
  it, with the remainder bounded by the serializer: a non-file field is at most 8 KiB,
  a file name at most 255 bytes, and the framing overhead is computed, not estimated.
  Serialization is bounded, not "serialize then discover": the reference runtime
  counts as it appends, refuses with `payload-too-large` the moment the running total
  would exceed the cap or a field exceeds its own bound — before allocating the rest
  and before any host request — and stops on `init.signal`. **Both upload routes are
  covered.** The direct `meeting_upload_file` route accepts up to 25 MiB and today
  sends the whole file as one STT request (`src/hostPlugin.ts:191`, `:4112-4136`,
  `:4155-4159`); the staged route accepts up to 500 MiB and segments through FFmpeg
  into 30 s 16 kHz mono PCM pieces (`:198`, `:201`, `:672-685`, `:2431-2436`), then
  throws on an oversized segment (`:2451-2452`). Under Lease the direct route keeps
  its 25 MiB public limit and routes any accepted file whose serialized request would
  exceed the budget through the same staging segmentation instead of one request; the
  staged route keeps 500 MiB; both return the structured `file-too-large` result
  (never a thrown string) when a segment cannot be made to fit, which at 30 s of 16
  kHz mono PCM (about 0.96 MB per segment) does not occur for valid audio.
  Acceptance names three paths separately: the live chunk path, the direct upload
  path with 17-25 MiB input, and the staged path with a source above 25 MiB; each
  crosses the real child encoder into a controlled transport with the correct parts
  and file bytes; bodies just under, at and over the serialized cap; an oversized
  `prompt` with otherwise valid audio; abort and lease revocation mid-upload; host-key
  and plugin-key modes; the FFmpeg download without auth. A stubbed
  `hostApi.hostFetch` or an injected provider `fetch` is not evidence for this item.
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
| Lease (protocol `2`, app release X = 0.12.0; decisions 8-26) | credential lease: `bearer()` removed, `ResolveApiKeyResult` union, `HostFetchInit.auth` forwarded to the one factory path, host lease registry with linearised issuance and epoch fencing, audience and scheme binding by normalized source, credential-header clearing per hop including `api-key`, cookie composition, the four closed error codes, raw exposure under `secrets:raw-api-key` with receipt-bound consent, the operation rule that refuses host-provider-key export through `getSecret` and the removal of the official plugins' fallbacks (§4.1); catalog format 2 (§6.4); `sandbox` manifest block through schema, runtime, marketplace authority, descriptor/index, review, receipts and the re-vendored checker, replacing `PLUGIN_ENVELOPE_GRANTS` with the global exclusions preserved (§2.2, §6.3); protocol-aware catalog selection and the pre-activation refusal of undeclared or unserved protocols on both arms (§3.2, §6.4); dispatcher budgets (§7.4); `FormData` serialisation in the reference runtime and the 15 MiB effective STT body (§8); schema regeneration at the final version and the web mirror (§6.1); the protocol schema joins the vendored set (§6.3) | host: the gates of §9.6 per slice, then once at publication; plugins: `meeting` both STT paths in host-key and plugin-key modes through the real child encoder with abort, release and revoke; `local-indexer` startup, warm-up, scan, query outside a scan, caption, key switch and restart through the real broker with the worker holding tokens only and a synthetic marker proving no shared key leaves main on argv, env or any normal frame, lease counts returning to baseline; lease-failure paths of both plugins proven not to reach `getSecret`, a raw resolve or a socket; old `meeting`/`local-indexer` bundles refused before activation on X; the packaged upgrade matrix of §6.4 including downgrade and offline; `lyra-mail`, `orion`, plugin-key STT/indexer and the FFmpeg download unchanged; measured budgets (§7.4) | **announced boundary, not a runtime flag-day**: every code plugin republishes with `requires.hostProtocol: "2"` and `minAppVersion` X; `resolveApiKey` callers (`meeting`, `local-indexer`) migrate to the lease; `local-indexer` manifest carries its four `sandbox` declarations; publication order in §9.5 |
| Publication | TS protocol client vendored with the contract (§6.2, §6.3); validate CLI; `process` entry in the descriptor and index | validate CLI passes for every official plugin (`plugins/*/source`), `templates/plugin`, `orion` and `git` with the app not running; a non-JS smoke plugin (Python: a stock MCP server library plus a JSON-RPC library for the Ave peer channel) passes conformance | none for existing plugins; the schema vendoring, `hostProtocol` in the descriptor/index and the official plugins' declarations moved into Lease (§6.4) |
| Admission | out-of-process by default for every install and every source (decision 3); `git`, `hello-world`, `templates/plugin`, `orion` (company git) onto the path; adversarial fixture | fixture attempts the four escapes (blueprint §9 Stage 9) and is denied; `allPluginsAreOutOfProcess` true for the official index; `git`: no `fetch` call site outside `hostFetch`, its network declarations in the manifest, its external cache confined and the `~` migration/refusal tested | `git` **prerequisites (decision 22)**: its direct `fetch` for GitLab/GitHub with cookie and token headers (`ave-plugin-draco` at `d71fb95`, `src/hostPlugin.ts:797-806`) and for plugin LLM calls (`:920-932`) move to `hostFetch` with `networkAccess` declarations; its optional external `dataDirectory`, expanded from `~` today (`:824-834`) and written under (`:1140`), becomes a `sandbox.write` `userChosenDirectory` grant on `configKey: "dataDirectory"` that requires a normalised absolute path and refuses `~`. These are not Lease work; the earlier "all mediated" claim is withdrawn (§9.2 item 7) |
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
   worker notifications and the `sandbox` manifest block. Its egress at `6a4d3b3` is
   worker → JS egress broker in the plugin child → `hostApi.hostFetch`
   (`src/hostPlugin.ts:1572-1596`, `:1698-1703`; `src/egressBroker.ts:393-409`), so the
   earlier statement that it "forwards the host-issued bearer to an allow-listed
   endpoint itself, which `hostFetch` does not carry" was stale; what remains raw is
   the channel callbacks' `getSecret` reach for the host key (§4.1.7).
4. `meeting` — `startAudioCapture`, `attachFloatingPanel`, `spawnWorker` (ffmpeg),
   `resolveApiKey`, `callLlm` (`plugins/meeting/source/src/ffmpegRuntime.ts:112`);
   exercises the streaming path and the secrets lease.
5. `hello-world` (`plugins/hello-world/source` in the official repository, built and
   released through the same flow as the other four, marketplace design §6.3) and
   `templates/plugin` (official repository; `your-plugin-id`, `config.get` only) — the
   marketplace admission
   path end to end.
6. `orion-api` in company git — `openAuthWindow` ×5, `getAuthPartitionCookies`,
   `spawnWorker` ×3 (`ave-plugin-orion` at `2f17388`, `src/nativeAdClient.ts:91-96`), `probePrivateHost`;
   the largest surface and the one the blueprint records as "three unrelated problems"
   (blueprint `:1061`). Its `hostFetch` is bound once (`src/hostTransport.ts:45-52`); besides the
   browser-driving use, the partition's `user_id`/`refresh_token` cookies are read from
   the vault (`src/sessionVault.ts:65`; `src/portalClient.ts:154-161`) and sent as a JSON
   body through `hostFetch` (`:206-214`) for the company service's token refresh — a
   session-credential crossing Lease does not remove (§4.1). It is not in the official
   index, so an install reaches it as a custom source from company git or as a policy
   `additional` (managed) source; admission does not depend on which (decision 3).
   Last, and after the company-git move, so its cadence is decoupled.
7. `git` — not yet isolated; `openAuthWindow` ×4 (`ave-plugin-draco` at `d71fb95`,
   `src/hostPlugin.ts:2194-2349`), `getSecret`, `callLlm`, `openExternalUrl`,
   `clearAuthPartition`. **It is not fully mediated**: it calls global `fetch` directly
   for GitLab/GitHub pages with the partition cookie header and a GitHub token
   (`:797-806`), and for its own LLM calls with a plugin key as `api-key` or `Bearer`
   (`:920-932`); no `hostFetch` call exists in its production source. It also expands a
   `~` in its optional `dataDirectory` (`:824-834`) and writes its cache there
   (`:1140`), which the host's `userChosenDirectory` resolver would refuse
   (absolute, canonical, inside the ceiling; `out-of-process-plugin.ts:595-669`). The
   earlier "all mediated" claim is withdrawn. These are Admission prerequisites
   (§9.1, decision 22); under Lease `git` is only rebuilt against the contract at tag X
   and republished with `hostProtocol: "2"` like every other plugin. Admissible by the
   blueprint's data-not-code test once those are done; joins at the admission step.

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
  `isOutOfProcessPlugin`, and the `ChildLocalPath` / in-process branches of
  `runtime/index.ts` around `createHostApi` (`runtime/index.ts:2049-2058`).
  `PLUGIN_ENVELOPE_GRANTS` is not on this list: the Lease step deletes it (§2.2, §9.1),
  and an earlier revision of this section promised the deletion twice.

**The same shape for a host protocol version (decision 9).** Retiring protocol `N` at
app boundary X is a deprecation with the same three parts, and the Lease release is its
first instance:

- **Condition:** before the tag, tested candidate artifacts of every replacement
  (§6.4, applicability as stated there); before the app draft is published, every
  replacement is published as an immutable artifact declaring the new version with
  `minAppVersion` X, and the packaged upgrade matrix passes against those artifacts,
  including the pre-activation refusal and its update path for an old artifact.
- **Owner:** the organization owner role (decision 5), who records the boundary and
  the notice date in `TODO.md` when the Lease host slices start (§9.6).
- **Notice and boundary:** the boundary is announced in the release notes of the last
  release before X and on the marketplace announcement channel at least fourteen days
  before X is tagged; the plugin-status UI on X names the served version, the
  declared one and the update path. If the notice or the replacement artifacts are
  not in place, X is postponed; the old version is never served beside the new one.

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
   test, schema validation of every golden frame, the vendoring guidance in the
   `public-contract.ts` header, and this page's §6.1 status.

### 9.5 The Lease release: target, alerts integration and publication sequence (decisions 8 and 19)

**Target.** v0.11.0 ships first with its current scope — the wire step and the alerts
successors — and Lease ships in **0.12.0** (X), fixed by the owner. The gates below are
what the release must pass; the number grants no exemption from them.

**Alerts integration.** The alerts successors target app 0.11.0 (`policy/revocations-by-app.json`
on the official repository's `feat/alerts-successors` branch at `6672499` names
0.11.0 and lists ORION 0.22.0 among the successors; the inspected `orion` checkout is still
0.21.6, `package.json:3`). Those plugin versions are published for 0.11.0 **first**, at
their own immutable versions and pinned to the v0.11.0 tag through the release
process (`docs/development/release-process.md:66-76`: the checker's alerts release
option, minimums and the revocation selector agree). Lease then bumps every changed
plugin **again**: the next version of each after its alerts version, with
`minAppVersion` X and `hostProtocol: "2"`. A published artifact is never rewritten;
the branch's development pin (`contract/sources.json` on that branch pins commit
`b5d86c08d`, not a tag) is not a release receipt. There is no combined alerts/Lease
bump: the owner's decision is alerts versions first, Lease versions after, and this
document does not keep an exception to it. `vega-helper`'s revocation stays with
the 0.11.0 boundary and is not moved by Lease; a plugin the alerts release revokes is
outside the Lease replacement set (§6.4, applicability).

**Sequence.** Each step is a gate for the next; none is skipped because a previous
step deployed something.

1. **Candidate artifacts, before the tag.** Rebuild `meeting`, `local-indexer`,
   `lyra-mail`, `vega-helper` (only if not revoked by the alerts release),
   `hello-world`, `orion` and `git` against the candidate host contract, update
   `templates/plugin` in source, and run the plugin acceptance of §9.1 against a
   packaged candidate app. Candidate-ref syncs are development evidence only; the
   notice gate of §9.3 is met before step 2.
2. **App tag, installer held as a draft.** Slice E1 (§9.6) regenerates the schema at
   the final version, adds the tag-named mirror copy, passes the full gates once, and
   the app is tagged X. `build-installers.yml` attaches the installers to a **draft**
   release (`.github/workflows/build-installers.yml:308-316`), so the tag exists without
   a broad rollout. Nothing that must be vendored from the tag is required before it.
3. **Re-vendor from the tag.** The official repository's `tools/vendor.mjs sync`, `orion`'s
   `tools/contract.mjs` and `git`'s `tools/vendor.mjs` refresh `contract/` from tag X
   (the protocol schema included, §6.3), the official repository re-vendors the app's
   marketplace checker from the same tag, and every offline hash plus the upstream
   byte comparison passes. No hand-edited copies.
4. **Publish plugins and pins.** Publish the rebuilt plugin artifacts at their Lease
   versions, update the official index and descriptors (`hostProtocol: "2"`,
   `minAppVersion` X), verify each published manifest, hash and index entry against the
   tag, and confirm the packaged upgrade matrix of §6.4 against the *published*
   artifacts: fresh install, upgrade from an old bundle, offline refusal, consent
   update, downgrade.
5. **Publish the app draft.** Only after 4 is verified is the draft release published.
   From this point an old installed artifact is refused on X.
6. **Promote the alias (E2).** A `web`-only PR sets the copy's `publishedTag` in
   `mirror.json` and, in the same commit, points `/2/protocol.schema.json` at the newest
   published copy of protocol `2` — this copy, unless a newer one was promoted first, in
   which case the alias stays (§6.1); the mirror check holds it
   there.

Rollback: an app release X that fails step 4 stays a draft and is superseded by a new
tag, never rewritten; published plugin artifacts are never withdrawn, because an older
app still selects its older versions from the frozen `marketplace.json` (decision 24).

### 9.6 Host PR slicing and gates for the Lease step (decision 23)

Each slice is independently coherent at its own boundary: a public field, its schema,
its producers and consumers, its runtime enforcement and its tests travel together,
and no slice merges an accepted field without enforcement or a compatibility shim to
keep an intermediate commit green (AGENTS.md, "No Fallback Code"). The one stated
temporary coexistence is C's retention of `PLUGIN_ENVELOPE_GRANTS` until D (its row
below): it has an owner and a removal condition, it selects a policy source by the
manifest's declaration rather than recovering from a denial, and it adds no plugin-id
branch. Slices are based on `main` after the previous one merges.

| Slice | Scope | Focused gates | Lock suites touched |
|---|---|---|---|
| **A. Design** | this amendment; blueprint §3.2 companion correction | diff, path, naming and reference checks; the document governs runtime security and is reviewed as such, not waved through as Markdown | none |
| **B. Dispatcher budgets** | §7.4 buckets, in-flight and subscription caps, `rate-limited` in the closed set, schema and golden updates; cleanup exemptions. Independent of the resolver break, so it may land first | dispatcher boundary and service-member tests, `subscription-ledger` tests, notification floods, release/cancel/shutdown under saturation, the service-limit results preserved, golden and schema parity, generated-schema check | `host-protocol-golden`, `host-protocol-schema-parity`, `host-api-boundary-contract`, `host-api-service-members`; no channels, preload, settings or package-script change |
| **C. Sandbox authority end to end** | manifest schema and public type, runtime hardening (including the `configSchema` string-key rule), `HOST_DIRECTORY_CATALOG`, envelope resolver reading `manifest.sandbox` with `ceilingSubtractions` over the catalog, approved-root withdrawal retirement (decision 25), worker delegation, marketplace authority/descriptor/index/plan/review/delta/receipt, catalog format 2 reader and schemas (decision 24), checker update. **`PLUGIN_ENVELOPE_GRANTS` is retained in C** as the grant source for an artifact that declares no `sandbox` block, and deleted in D: while the host still serves protocol `1`, an old `local-indexer` artifact — which declares nothing, or `"1"` — passes the load gate (`runtime/index.ts:2917-2919`), so deleting the table here would silently shrink it to the base envelope; the table's owner is the organization owner role and its removal condition is D, in the same release. A declared block takes precedence over the table for the same plugin, so a new candidate is exercised through the real resolver in C | manifest schema and hardening tests; `manifest-rules`, plugin ladder, service and view tests; `PackageSheet` review tests and the changed lifecycle spec; catalog format-2 read and legacy-file freeze tests; real confined-child path-escape, sibling/symlink/cert-floor, delegated-worker and workspace-revocation tests (the decision 25 assertion), on macOS, Linux and Windows; an old sandbox-less indexer bundle still runs with its table grants in C | marketplace DTOs; `preload-shape` only if the bridge surface changes; settings suites only if consent storage becomes a setting (it does not: the receipt carries it) |
| **D. Credential lease and egress cutover — the protocol-2 boundary** | public union and `HostFetchInit`, wire types, encoder/decoder/validation, `handle-or-denied` result axis, host registry with linearised issuance and epoch fencing, secret/config generation hooks in the store, child stub with the pending-closure map, dispatcher forwarding `auth` to the factory, factory snapshot and credential-use context, guard hop loop with `CREDENTIAL_HEADERS`, audience table by normalized source, cookie matrix, raw consent and receipt version, the gate's operation axis and the official plugins' fallback removal, the four error codes with bounded audit, fixed transport messages, `FormData` bounded serialisation, **`HOST_PROTOCOL_VERSIONS_SERVED = ["2"]` with `1` retired, the refusal of undeclared or `"1"` manifests before activation on both arms, `PLUGIN_ENVELOPE_GRANTS` deleted**, catalog protocol eligibility, plugin-status update path. One release-bound contract change; `auth.lease` typing never merges ahead of its enforcement, and protocol `2` is never served before its credential implementation | resolver gate, provenance and revocation tests; child → dispatcher → factory → guard → transport integration proving the lease reaches the gate and the network init carries no auth; goldens and schema for protocol `2`; two-plugin and old-incarnation replay; issuance barriers before and after the gate, the secret read and the reply with rotate/revoke/endpoint-switch/retire at each; the settings-store visibility cases of §4.1.2 (held save that fails and rolls back, held save that succeeds, invalidation and failed re-entry withholding) driven through the real store's `saveSettings` barrier; revoke during approval, resolve, cookie lookup, redirect and body drain; revoke before child adoption; release during concurrent uses; conflicts, audience, scheme and redirect matrices for Bearer, `api-key` and `x-api-key`; alias/source fixtures including omitted vendor, `gemini` and `vertex-ai` denial and a missing Azure endpoint; raw denied before the secret read; the full cookie matrix; getter mutation on the in-process arm; rebuilt `meeting` and `local-indexer` candidates exercised as in §9.1 with a synthetic key marker; old `meeting`/`local-indexer` bundles refused before activation; no lease-failure fallback anywhere | all HostApi contract locks (`hostapi-effect-completeness`, serialization conformance, `host-api-boundary-contract`, `host-api-service-members`, `host-protocol-golden`, `host-protocol-schema-parity`, public-contract boundary tests); `channel-inventory` and `host-renderer-only-channels` unchanged (stdio methods add no Electron channel); `preload-shape` (`src/__tests__/preload-shape.test.ts:82`, `:119`) unchanged unless the plugin-status DTO grows; settings domain exports (`src/ipc/__tests__/domain-exports.test.ts:118`, `:172`) unchanged — the lease registry is ephemeral and needs no setting, and the generation counters are in-memory store state |
| **E1. Release PR, before the tag** | version and changelog, schema regenerated at the final version, the tag-named `web/public/schemas/` copy and its `mirror.json` entry with `check:plugin-host-protocol-mirror`, rollback note; coordinates the v0.11.0 release PR and the alerts successor branch at final hashes. Nothing in E1 depends on tag X existing | full pre-push once, fresh CI on the rollup (`build-and-test`, `naming-gate`), packaged smoke on the final tree per OS, the mirror check: candidate copy equal to the canonical file, every copy equal to its recorded sha256, aliases naming published entries only, with the two-versions-plus-orphan fixture of §6.1 | `package.json` scripts and `src/__tests__/packaging-discipline-source.test.ts:627-663` for the mirror check; CI composition if a required status is added |
| **E2. Release runbook, after the tag** | §9.5 steps 3-6: final-tag vendor receipts in the three plugin repositories and the official checker rebuild, plugin releases and index/descriptor pins, the §6.4 matrix against published artifacts, app draft publication, then the alias-promotion `web` PR. These are gates on the published release, not inputs to creating the tag | source/tag/vendor hash equality per repository; published manifests, hashes and index entries verified; 0.10 and 0.11 binaries against the published source; the alias changes only in a commit that sets a `publishedTag`, and always equals the newest published copy of its protocol (§6.1: a `2/v0.12.0` promotion after `2/v0.13.0` sets the tag and leaves the alias) | none in the app tree except the alias PR under `web/` |

Validation discipline: narrow tests while iterating (`bun run test:vitest -- run <dirs>`),
`bun run typecheck`, then the full `bun run test` and `bun run build` once before
publication of each slice; in-process arm tests run for D while that arm exists; a
failed or unavailable verification is recorded as such and never replaced by a
permission or lifecycle fallback that makes the test pass.

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
| **Ave today** | five first-party plugins in a confined child process; others in the main process (`out-of-process-plugins.ts:856-858`, `plugin-loader.ts:77-81`) | `public-contract.ts` and the manifest schema vendored by each plugin repository at an app tag with hash checks (`contract/sources.json`, marketplace design §5.6) | `requires.minAppVersion` (`schemas/plugin-manifest.schema.json:689`) | ASRT for isolated plugins (`out-of-process-plugin.ts:954-986`); none in-process | JavaScript only |
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
| 2 | `resolveApiKey` stops exporting the raw key on its default path: `bearer()` leaves the contract, the default result is an opaque `ApiKeyLease`, `hostFetch` gains `init.auth = { lease }`, and a host provider key crosses **through `resolveApiKey`** only under `capabilities: ["secrets:raw-api-key"]` with receipt-bound consent (§4.1.1, §4.1.6). The guarantee is scoped to `resolveApiKey`; own-namespace `getSecret`, `orion-api`'s partition-cookie export and `readEncrypted` plaintext are the inventoried exceptions (§4.1). | The credential attaches at the egress chokepoint the way partition cookies already do; the capability makes the exception visible to the user and countable by the host. Neither official consumer needs it: `meeting`'s STT egress goes through `hostFetch`, and `local-indexer`'s worker traffic already reaches `hostFetch` through its JS broker, which gains lease attachment (decision 10). The earlier text that said `local-indexer` "forwards the bearer itself" was stale at `6a4d3b3`. |
| 3 | Out-of-process admission is decided the same way on every platform and for every install source — official, managed, custom, direct, local development, and origin-less legacy entries (`legacy-plugins.ts:90-93`). A code plugin loads out of process under the confinement the host chose for itself: `features.osToolSandbox`, off by default on every platform (`sandbox-gate.ts:20-21`); while it is off the child is spawned unwrapped (`out-of-process-plugin.ts:13-21`). What admission promises is the process boundary — separate heap, no Electron, own crash domain, one structural chokepoint — not OS confinement; OS confinement is whatever the substrate publishes (`architecture.md:1017-1020`): filesystem, process and network on macOS and Linux, filesystem and network on Windows. Only a non-JS `process` entry requires a wrap whose `confines` includes `process`, so it never loads on Windows and does not load anywhere with the sandbox off (§2.2). The Doctor's plugin report names, per plugin, the confinement it runs under. | An earlier draft refused custom and direct code plugins on Windows and admitted official and managed ones. Rejected on evidence: `origin.sourceOrigin` alone is not evidence, because the registry file is user-writable and `src/plugins/registry.ts:300-311` checks only shape, legacy migration binds `official` by plugin id with `artifactSha256: null` (`legacy-plugins.ts:95-124`), and a removed `additional` source leaves `managed` behind, so a sound version would need the host-secret evidence chain (`grants.ts:87-106`); it would grant the official and managed sources a privilege the marketplace design forbids (§10: the badge is the only thing the official source grants; §10.5); it would refuse `orion-api` and `git` on Windows, since neither is in the official index (`marketplace.json` at `6a4d3b3df` lists `hello-world`, `local-indexer`, `meeting`, `lyra-mail`, `vega-helper`) while `orion-api` already runs out of process there (`out-of-process-plugins.ts:857`); and its rationale was false by default on every platform, because with the sandbox off macOS and Linux run a custom plugin without process confinement too. |
| 4 | A non-JS `process` entry is in the schema from protocol `1`; marketplace admission for it waits for the admission step. | The protocol is language-neutral from its first published version, and admission needs the adversarial fixture first. |
| 5 | The deprecation owner of the in-process loader is the organization owner role of `former_org` (the repository's sole maintainer) — a role, recorded as such in `TODO.md` when the wire step starts; ave has no `CODEOWNERS` file. | AGENTS.md requires a named owner and a removal condition for any coexistence (§9.3). |
| 6 | The protocol schema is canonical in the ave tree at a release tag and vendored like the rest of the contract (§6.3); its `$id` carries the app tag; `former-site.invalid` mirrors every copy `mirror.json` records from `web/public/schemas/` (published, candidate or orphan, each frozen against its own hash, §6.1), with `/1/protocol.schema.json` as a documented moving alias for editors. The validate CLI is a `tools/vendor/` bundle built from an ave entry (§10.2). | A release tag plus a sha256 in `contract/sources.json` is what the contract already pins; `tools/vendor.mjs` already holds bundles built from ave entries with a recorded bun version (`vendor.mjs:5-11`); release assets would be a second publication of the same bytes. The tag in `$id` is what keeps an additive revision (§3.3) from changing the bytes behind one identifier, since the site deploys on every `web/**` merge, not on tags. |
| 7 | Per-plugin resource limits on macOS are deferred: crash containment ships first, and the conformance suite records RSS and startup time per plugin. | No number exists to size an `RLIMIT` against. |
| 8 | **Release target (owner, 2026-09-27).** Lease ships in **0.12.0** (X). v0.11.0 ships first with its current scope (wire and alerts). Official plugins publish their alerts versions first and bump again for Lease, with no combined bump; a published artifact is never rewritten (§9.5). | Lease is a protocol boundary with its own notice, replacement and matrix gates; folding it into a release whose scope is already fixed would either skip those gates or reopen that release. The version number itself is not the gate. |
| 9 | **Installed-plugin cutover (owner).** Announced hard cutoff with pre-activation refusal: X serves protocol `2` only; a code plugin whose manifest does not declare a served `requires.hostProtocol` — including one that declares nothing — is refused before factory activation on both loader arms and for every install source, with a clear status and an update path. The rule is generic, never keyed to a plugin id or a method heuristic; `minAppVersion` is never an upper bound. §3.2's retention promise is rewritten; the cost, the notice and replacement gates and the old/new matrix with downgrade are in §6.4 and §9.3 (§9.5 for the sequence). | Retaining `1` would mean a second frozen runtime, schema set, codec, child stub and envelope policy, which the generator (`plugin-host-protocol-schema.ts:317-324`) and the single bound dispatch table (`out-of-process-plugin.ts:1423-1444`) cannot express by adding an array element; a version label that does not select an implementation is not compatibility. Omission cannot keep meaning "newest" on X because the newest is incompatible with the bearer the old bundle calls (`host-api-child.ts:342-394`; `meeting` `plugins/meeting/source/src/hostPlugin.ts:1911`). Postponing X when the gates are unmet is what protects users; a runtime fallback would hide the break. |
| 10 | **local-indexer path (owner).** The existing JS egress broker in the plugin child gains host lease attachment: broker → `hostFetch` with `auth.lease`, one lease per upstream request, acquired before the relay and released in `finally` after the buffered response body completes, the worker's abort linked to the use's signal. Plugin-owned-key mode stays. The lease-mode host-key `getSecret` fallback and the bearer-length availability check are removed from the plugin; host-side the same read is refused by the gate's `export` rule (decision 17), not by deleting entitlement rows (§4.1.6-4.1.7). No raw exception exists because a Python SDK is present. | The worker never held the shared key on the production path (`workerClient.ts:472-474`, `embedding_client.py:159-167`); the only raw reach is the JS channel callback. A maintained per-channel lease needs refresh/revoke state and would let query-time search reuse a stale scan handle; per-request is one resolve and one release notification per call, priced in §7.4 and revisited only on measurement. |
| 11 | **Sandbox location (owner).** `extensions["ai.agent-connector.ave"].sandbox`, a sibling of `requires`, `capabilities`, `networkAccess` and `alerts`; carried through the descriptor and index with equality checks, the install review and upgrade deltas, the receipt, and the official repository's checker, re-vendored. `ceilingSubtractions` keeps subtracting the closed host catalog globally; a missing declaration gets only the base envelope (§2.2). | Authority is what the marketplace pins, reviews and holds equal; a block outside the extension object would be invisible to that pipeline, and a block nested under `requires` or `capabilities` would change the meaning of two closed objects. |
| 12 | **Lease shape.** `ResolveApiKeyResult = ({ ok: true } & ApiKeyLease) \| ({ ok: true } & ApiKeyRaw) \| ResolveApiKeyDenied`; `leaseId` = wire `handleId` = subscription id, one opaque host-minted string (`lease_`/`raw_` prefixes); `release()` is an idempotent one-way notification that aborts active uses and never throws; `onClosed` accepts any number of listeners and replays to a late one; the reference runtime parks a `closed` that precedes adoption; the result axis becomes `handle-or-denied`; raw returns `key` bytes and says they cannot be recalled; `HostFetchInit.auth = { lease }` exactly, **forwarded by the dispatcher to the factory's single `hostFetch`**, turned into a credential-use context there, and absent from the transport init (§4.1.1). | One identifier removes a mapping table and lets the existing subscription release/closed notifications carry the lifetime. Stripping in the dispatcher would leave the in-process arm on a different enforcement path; the factory is the only place both arms meet. A `bearer()` thunk on the raw branch would pretend to revoke copied bytes. |
| 13 | **Lifetime.** `issuing → active → released \| revoked`, `peer-gone` only at incarnation or connection end; no wall-clock expiry; the record carries incarnation, permission epoch, secret generation and provider-configuration revision, and every use re-checks all four after each await; revocation on permission revoke, secret write/rotation/removal/withholding, active-vendor/endpoint/preset change, plugin update/disable/uninstall; active uses aborted, bytes already sent not recalled; `opts.signal` cancels the resolve request only; ≤ 32 registrations per incarnation, reserved at entry (§4.1.2). | Event-bound lifetime has no race a timer would fix; today nothing closes an issued ledger entry on any of these events (`host-api-dispatcher.ts:795-832` opens it, `host-api-factory.ts:813-816` only passes the revoke accessor into the resolver), and one host registry owned by the plugin-runtime step is the code path both arms share. |
| 14 | **Audience and scheme.** Keyed by the host's normalized source record, not the request union: `openai` → `Bearer`, `azure-foundry` → `api-key`, `claude` → `x-api-key`, each at the origin the host's own adapter uses (configured base URL, else the public default; Azure with no base URL is `endpoint-unavailable`); `gemini` and `vertex-ai` are `vendor-unsupported` for lease in 0.12.0 (Vertex authenticates with ADC, not a stored token); plugin-own keys → the plugin's allow-list. Origin match, `https` only, no path binding; empty intersection with the allow-list denies at resolve. Lease mode keeps the guard's independently approved loopback/private exceptions and adds no network rule of its own. Per hop: clear the closed `CREDENTIAL_HEADERS` (`authorization`, `proxy-authorization`, `cookie`, `api-key`, `x-api-key`, `ocp-apim-subscription-key`) on any origin change, re-check liveness, re-inject only inside the audience, otherwise refuse the redirect (§4.1.3). | The plugin's allow-list authorises the plugin's traffic, not the host's key; the current three-header strip (`host-fetch-guard.ts:475-478`) lets an `api-key` cross origins, reproduced by the cross-review. Relabelling a stored Vertex string as a token, or refusing every private target the guard already admits for the corporate Azure case, would each be a false claim about the host. A silent unauthenticated downgrade on redirect would turn an audience violation into a confusing provider error. |
| 15 | **Conflicts.** No lease: caller headers pass, so `lyra-mail` OAuth, `orion-api` cookies, plugin-key modes and the FFmpeg download keep working, and a non-vault caller `Cookie` still passes. Lease: any caller credential header, **`Cookie` included, vault-declaring or not**, is `credential-conflict`; a malformed `auth` is `credential-conflict` at every layer. Lease + host-injected partition cookie: allowed only when both grants independently cover the URL; cookie prepared, liveness re-checked, then injected (§4.1.4, full matrix there). | A blanket `Authorization` ban breaks valid non-lease callers; two reviewed grants for one URL are a stronger statement than a prohibition; leaving the non-vault caller-Cookie cell undecided would let a plugin pair its own session with the host's key. |
| 16 | **Errors.** Four thrown codes join the closed set: `lease-unavailable` (one code for unknown, foreign, raw, released, revoked and stale-epoch, no oracle; never raised by `release()`), `lease-audience-denied`, `credential-conflict`, `rate-limited` (`retryAfterMs` ≤ 5000). Resolver outcomes stay `ok: false`, with six new reasons. Audit is coalesced per `(plugin, method, code)` with a 60 s summary; transport failures get a fixed public message and a bounded `data.kind`, not a sanitiser. Broker → HTTP 403 terminal / 429 / 499 / 502; worker retries only 429 and 502-504 (§3.6, §4.1.5, §4.1.7). | Distinguishing foreign from unknown handles would let a plugin probe another's handle space; a 504-for-everything broker and a worker that retries broad `APIError` classes would turn a denied lease into repeated requests and a silent degraded search; a per-raise audit would let a refused flood do unbounded work; a regex cannot prove credential bytes are absent from arbitrary text. |
| 17 | **Raw scope and the export rule.** `secrets:raw-api-key` gates `resolveApiKey({ exposure: "raw" })` only. The shared secret gate gains an operation axis: `getSecret` is `export`, refused for the host-provider secret class for every plugin before the read; `resolveApiKey` is `lease`, which keeps the unchanged tiers including the entitlement rows (`grants.ts:41-44`) and provenance (`:87-111`, `secret-gate.ts:190-215`) for both exposures; raw adds the capability in the reviewed authority and a receipt reviewed on app version ≥ X; every denial precedes the secret read (§4.1.6). | Deleting the entitlement rows was rejected because `getSecret` and the resolver share one gate that denies a missing row before provenance, so the rows' removal would deny every host-key lease; an operation rule by secret class is generic and needs no plugin-id branch. An inert string in an old artifact was never shown as a privilege, so its bytes cannot be consent for one. |
| 18 | **Publication prerequisites advanced into Lease.** Protocol-aware catalog selection (`hostProtocol` in descriptor and index, a `host_protocol` exclusion), final-tag contract and checker sync, the protocol schema as a vendored artifact (so `orion`'s two-file inventory changes). The TS client and the validate CLI stay in Publication (§6.3, §6.4). | The `"2"` pin needs the bytes it pins and a sync must not offer what the app cannot run; the client and CLI are conveniences with no compatibility consequence. |
| 19 | **Publication sequence.** One timeline: tested candidates and the 14-day notice before the tag → app tag with the installer release held as a draft (E1) → re-vendor from the tag → publish plugins, pins and both index files → packaged matrix against the published artifacts → publish the app draft → promote the schema alias (E2, the alias moves only to a copy `mirror.json` marks published, §6.1); alerts versions first, Lease versions after, no combined bump; `vega-helper` revocation stays with 0.11.0 and a revoked plugin is outside the replacement set (§9.5, §6.4). | The draft release (`build-installers.yml:308-316`) separates tag creation from rollout, which is what lets replacements exist before an old artifact can be refused; a replacement vendored from a tag cannot be required before that tag, so the earlier "replacements before the tag" wording was circular and is withdrawn. |
| 20 | **Budgets.** The numbers of §7.4: 50/s default, `hostFetch` 20/s, `resolveApiKey` 10/s, notifications dropped and counted, 64 in flight, 256 subscriptions with per-kind caps, 32 leases; keyed by plugin id, cleanup exempt; dispatcher-only scope stated. | Sized from the configured 400 RPM indexer batch rate as an input with ~3× headroom, to be confirmed by the measured acceptance run; not from the number alone. |
| 21 | **Multipart and upload budget.** The reference runtime serialises `FormData` to bytes with a generated boundary, counting as it appends and refusing before over-allocation; the 16 MiB cap is the entire serialized body and stays; 15 MiB is `meeting`'s audio target under it with non-file fields bounded; the direct 25 MiB upload route joins the staged route's segmentation for anything that would exceed the budget, the staged 500 MiB limit stays, and both return the structured `file-too-large` result (§8). | A `FormData` body is refused by the encoder today, reproduced by the cross-review; raising the cap would move the frame and memory bounds for every member to fix one caller; lowering only the staged segment check would leave the direct route sending 25 MiB in one request. |
| 22 | **git.** The "all mediated / no ambient axis" claim is withdrawn; direct `fetch` and the `~`-expanded external `dataDirectory` are Admission prerequisites, not Lease work (§9.1, §9.2). | Source at `d71fb95` shows two global `fetch` sites and a home-relative cache; keeping `git` in process during Lease does not make those Lease's to fix, and claiming isolation from a method list would be false. |
| 23 | **Slicing.** Host PRs A, B, C, D, E1, E2 of §9.6: B independent; C ships the sandbox authority and format-2 catalog while **retaining** `PLUGIN_ENVELOPE_GRANTS` as the source for undeclared artifacts (owner: the organization owner role; removal condition: D); D is the single protocol-2 boundary that serves `2`, retires `1`, refuses undeclared and `"1"` manifests and deletes the table; E1 is the pre-tag release PR; E2 is the post-tag runbook whose gates are on the published release. | Each slice is coherent at its boundary; the places a slice could hide a break are named and forbidden: a typed `auth` field without enforcement in D, a deleted table while protocol `1` is still served in C, and a tag whose creation depends on receipts vendored from itself in E. |
| 24 | **Catalog format 2.** `marketplace.json` (`schemaVersion: 1`) is frozen at X to pre-X versions and never gains a format-2 field; `marketplace.2.json` (`schemaVersion: 2`) carries every version with `hostProtocol` and `authority.sandbox`; descriptors gain `schemaVersion: 2`; an app ≥ X reads only the format-2 file and treats a source without it as not a marketplace; older apps read only the legacy file (§6.4). | The index root, version and authority objects are closed and a package is validated whole, so any new field in the shared file drops every version of that package from every older client, which would break the "old app keeps its old versions" promise the downgrade and rollback rows depend on. A presence-declared format is deterministic; a tolerant reader or a retry is not. |
| 25 | **Approved-root withdrawal.** A resolved envelope has two inputs, manifest authority and the approved-directory ceiling; when either stops covering a running incarnation's grants the runtime retires that incarnation and its delegated workers before the change is acknowledged, marks `sandbox-grant-outside-ceiling`, and refuses a restart until the config or the ceiling changes; overlapping roots keep a grant; the boot reconciler runs before plugins load (§2.2). | The kernel envelope cannot narrow after spawn (`out-of-process-plugin.ts:682-687`) and root removal already revokes permission signals (`permission-manager.ts:1148-1155`), so an update-only rule would leave a child using a withdrawn root until its next restart. |
| 26 | **Linearised issuance.** `issuing` starts before the first authorization await: resolve the key identity, capture `{ incarnation, permissionEpoch, secretGeneration(key), providerConfigRevision }`, reserve a registration slot, run the gate and reads, then compare-and-register in one synchronous section or deny `stale-authorization` and return the slot; the store gains generation hooks at every transition of the state the resolver can see — the in-memory provider-configuration mutation before its save, the rollback after a failed save, every change of secret readability, and the completion of a secret write or delete — never only on successful commits (§4.1.2). | Counters alone do not say which snapshot a lease represents; without a reservation, concurrent resolves can all observe 31 and exceed the cap; re-reading into a new epoch would silently launder a stale authorization; the store makes a configuration visible before it is saved and restores the saved one when the save fails (`settings-store.ts:1114-1116`, `:1978-1993`), so a post-commit counter would leave a lease bound to a rolled-back endpoint usable. |

### Owner decisions still open

None. Decisions 8-11 and 22 record the owner's decisions of 2026-09-27; decisions
12-21 and 23-26 are the designer's, made so the implementer decides no security or
migration semantics, and each of the two review rounds' findings is either resolved
above or rejected in the section it names; decision 5 names a role, not a person, so
nothing waits on the owner.

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
- The real request rates behind §7.4. The 400 RPM batch setting is a configured
  input; resolve/fetch/release counts, retry amplification and concurrency under a
  scan, a caption pass and a meeting session have not been measured. The budgets are
  sized with headroom and are confirmed or changed by the acceptance run of §9.1.
- The packaged old/new matrix of §6.4 and the plugin-status update path. They are
  design requirements here; no packaged upgrade, offline refusal, downgrade or consent
  update has been run.
- The live redirect and revocation behaviour of §4.1.2-4.1.3. The cross-origin
  `api-key` retention and the `FormData` and 17 MiB rejections were reproduced against
  the exported functions with synthetic inputs; no live provider, credential or
  revocation race has been exercised.
- Whether the alerts successor artifacts named in §9.5 are published at the time the
  Lease slices start. The reviewed evidence is a development branch pin, not a
  release receipt; slice E verifies the published versions.
